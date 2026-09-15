// controllers/publicSurveyController.js
//
// Encuesta de satisfacción post-servicio (filtro 1–5 + Google Review).
// Portado de Monkey Cleaning (LAB413 + su refactor "move client pages to
// frontend, defer thank-you emails to a next-morning nudge").
//
// API JSON pública, sin auth (montada en /api/public, ver publicSurveyRoutes.js).
// El cliente ya NO ve HTML servido por el backend: cae en la página React
// `SurveyPage` del frontend, que consume estos endpoints. El token es
// `clients.survey_token`, generado por jobs/surveyRequestJob.js.
//
// Reglas de negocio:
//   - Nota 5  → se guarda; el frontend ofrece el link a Google Reviews. El
//               click pasa por GET /go-review (graba survey_review_clicked_at)
//               y recién ahí redirige a Google.
//   - Nota 1–4 → se guarda; el frontend muestra un textarea. El comentario va a
//               clients.survey_feedback + alerta a operaciones
//               (opsNotificationService.sendSurveyFeedbackAlert). NUNCA Google.
//   - Los emails de "gracias/recordatorio" NO salen desde acá: los manda al día
//     siguiente jobs/surveyNudgeJob.js, y solo si el cliente no completó el
//     flujo (no clickeó review / no dejó comentario).
//
// Ningún paso secundario (alerta a ops) es fatal: la respuesta al cliente
// nunca se rompe por eso — mismo criterio que publicConfirmationController.js.

import { supabase } from "../supabaseClient.js";
import { getGoogleReviewUrl } from "../services/settingsService.js";
import { sendSurveyFeedbackAlert } from "../services/opsNotificationService.js";

const CLIENT_COLUMNS =
  "id, first_name, last_name, email, survey_token, survey_rating, " +
  "survey_feedback, survey_responded_at, survey_review_clicked_at";

function clientName(c) {
  return [c?.first_name, c?.last_name].filter(Boolean).join(" ").trim();
}

async function findClientByToken(token) {
  const { data, error } = await supabase
    .from("clients")
    .select(CLIENT_COLUMNS)
    .eq("survey_token", token)
    .maybeSingle();
  if (error) {
    console.error(
      "❌ [PublicSurvey] Error leyendo clients por survey_token:",
      error.message,
    );
    return { client: null, error };
  }
  return { client: data, error: null };
}

// Forma común de la respuesta de estado que consume el frontend.
// `alreadyResponded` = la nota ya estaba guardada ANTES de este request (para
// distinguir "recién calificó" de "reabrió el link"); el frontend branchea
// por rating/hasFeedback/hasClickedReview.
function statePayload(client, { alreadyResponded, ...extra } = {}) {
  return {
    ok: true,
    name: clientName(client) || null,
    rating: client.survey_rating ?? null,
    alreadyResponded:
      alreadyResponded ?? Boolean(client.survey_responded_at),
    hasFeedback: Boolean(client.survey_feedback),
    hasClickedReview: Boolean(client.survey_review_clicked_at),
    ...extra,
  };
}

// ── GET /api/public/survey/:token ────────────────────────────────────────────
// Estado actual (para el caso "ya respondió" / retorno desde el email de nudge).
export async function getSurveyState(req, res) {
  try {
    const { client, error } = await findClientByToken(req.params.token);
    if (error) return res.status(500).json({ ok: false, error: "server_error" });
    if (!client) return res.status(404).json({ ok: false, error: "not_found" });

    const reviewUrl = client.survey_rating === 5 ? await getGoogleReviewUrl() : null;
    return res.json(statePayload(client, { reviewUrl: reviewUrl || null }));
  } catch (e) {
    console.error("❌ [PublicSurvey] getSurveyState failed:", e.message);
    return res.status(500).json({ ok: false, error: "server_error" });
  }
}

// ── POST /api/public/survey/:token/:rating ───────────────────────────────────
// Graba la nota (idempotente). No manda emails.
export async function submitRating(req, res) {
  const { token } = req.params;
  const rating = Number.parseInt(req.params.rating, 10);

  try {
    if (!Number.isInteger(rating) || rating < 1 || rating > 5) {
      return res.status(400).json({ ok: false, error: "invalid_rating" });
    }

    const { client, error } = await findClientByToken(token);
    if (error) return res.status(500).json({ ok: false, error: "server_error" });
    if (!client) return res.status(404).json({ ok: false, error: "not_found" });

    // Ya respondió — devolvemos el estado guardado sin pisar la nota.
    if (client.survey_responded_at) {
      const reviewUrl =
        client.survey_rating === 5 ? await getGoogleReviewUrl() : null;
      return res.json(
        statePayload(client, { alreadyResponded: true, reviewUrl: reviewUrl || null }),
      );
    }

    const nowIso = new Date().toISOString();
    const { data: updated, error: updErr } = await supabase
      .from("clients")
      .update({
        survey_rating: rating,
        survey_responded_at: nowIso,
        updated_at: nowIso,
      })
      .eq("survey_token", token)
      .is("survey_responded_at", null)
      .select(CLIENT_COLUMNS);
    if (updErr) {
      console.error("❌ [PublicSurvey] Error grabando survey_rating:", updErr.message);
      return res.status(500).json({ ok: false, error: "server_error" });
    }

    // Carrera: otra pestaña grabó primero entre el SELECT y el UPDATE.
    if (!updated?.length) {
      const { client: fresh } = await findClientByToken(token);
      const c = fresh || client;
      const reviewUrl = c.survey_rating === 5 ? await getGoogleReviewUrl() : null;
      return res.json(
        statePayload(c, { alreadyResponded: true, reviewUrl: reviewUrl || null }),
      );
    }

    const saved = updated[0];
    console.log(`✅ [PublicSurvey] Cliente ${saved.id} puntuó ${rating}/5.`);

    const reviewUrl = rating === 5 ? await getGoogleReviewUrl() : null;
    return res.json(
      statePayload(saved, { alreadyResponded: false, reviewUrl: reviewUrl || null }),
    );
  } catch (e) {
    console.error("❌ [PublicSurvey] submitRating failed:", e.message);
    return res.status(500).json({ ok: false, error: "server_error" });
  }
}

// ── POST /api/public/survey/:token/feedback ──────────────────────────────────
// Body JSON { comment }. Guarda el comentario + alerta a ops.
export async function submitFeedback(req, res) {
  const { token } = req.params;
  const comment = String(req.body?.comment ?? "").trim().slice(0, 4000);

  try {
    if (!comment) {
      return res.status(400).json({ ok: false, error: "empty_comment" });
    }

    const { client, error } = await findClientByToken(token);
    if (error) return res.status(500).json({ ok: false, error: "server_error" });
    if (!client) return res.status(404).json({ ok: false, error: "not_found" });

    const nowIso = new Date().toISOString();
    const { error: updErr } = await supabase
      .from("clients")
      .update({ survey_feedback: comment, updated_at: nowIso })
      .eq("survey_token", token);
    if (updErr) {
      console.error("❌ [PublicSurvey] Error guardando survey_feedback:", updErr.message);
      return res.status(500).json({ ok: false, error: "server_error" });
    }

    console.log(`✅ [PublicSurvey] Feedback guardado para cliente ${client.id}.`);

    // Alerta a operaciones — no fatal.
    sendSurveyFeedbackAlert({
      client: { id: client.id, name: clientName(client), email: client.email },
      rating: client.survey_rating ?? null,
      feedback: comment,
    }).catch((e) =>
      console.error("⚠️ [PublicSurvey] sendSurveyFeedbackAlert:", e.message),
    );

    return res.json({ ok: true });
  } catch (e) {
    console.error("❌ [PublicSurvey] submitFeedback failed:", e.message);
    return res.status(500).json({ ok: false, error: "server_error" });
  }
}

// ── GET /api/public/survey/:token/go-review ──────────────────────────────────
// Graba el click y redirige a la ficha de Google Reviews. Es una navegación
// real del browser (no fetch) — por eso responde con 302, no JSON.
export async function goReview(req, res) {
  const { token } = req.params;
  const fallback = (
    process.env.FRONTEND_URL || "https://demo-cleaning-frontend.onrender.com"
  ).replace(/\/$/, "");
  try {
    const { client } = await findClientByToken(token);
    const reviewUrl = (await getGoogleReviewUrl()) || fallback;

    if (client && !client.survey_review_clicked_at) {
      const nowIso = new Date().toISOString();
      const { error: updErr } = await supabase
        .from("clients")
        .update({ survey_review_clicked_at: nowIso, updated_at: nowIso })
        .eq("survey_token", token)
        .is("survey_review_clicked_at", null);
      if (updErr) {
        console.error(
          "⚠️ [PublicSurvey] No se pudo grabar survey_review_clicked_at:",
          updErr.message,
        );
      } else {
        console.log(`✅ [PublicSurvey] Cliente ${client.id} abrió el link de review.`);
      }
    }

    return res.redirect(302, reviewUrl);
  } catch (e) {
    console.error("❌ [PublicSurvey] goReview failed:", e.message);
    return res.redirect(302, fallback);
  }
}
