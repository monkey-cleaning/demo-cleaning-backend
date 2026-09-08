// controllers/publicSurveyController.js
//
// Encuesta de satisfacción post-servicio (filtro 1–5 + Google Review).
// Portado de Monkey Cleaning (LAB413).
//
// Público, sin auth (montado en /api/public, ver routes/publicSurveyRoutes.js).
// Destino de los links que clientNotificationService.sendSurveyRequestEmail
// pone en el email: un token único por cliente (clients.survey_token), guardado
// cuando jobs/surveyRequestJob.js envía la encuesta.
//
// Reglas de negocio:
//   - Nota 5  → página de agradecimiento con botón a Google Reviews + email de
//               agradecimiento con el link.
//   - Nota 1–4 → página con un formulario de comentario (sin JS) + email pidiendo
//                detalle. NUNCA se le muestra ni menciona Google Reviews.
//                El comentario se guarda en clients.survey_feedback y se alerta
//                a operaciones (opsNotificationService.sendSurveyFeedbackAlert).
//
// Ningún paso secundario (emails, alerta a ops) es fatal: el cliente siempre ve
// la confirmación aunque falle un envío — mismo criterio que
// publicConfirmationController.js.

import { supabase } from "../supabaseClient.js";
import { getGoogleReviewUrl } from "../services/settingsService.js";
import {
  sendSurveyReviewThankYouEmail,
  sendSurveyFeedbackThankYouEmail,
} from "../services/clientNotificationService.js";
import { sendSurveyFeedbackAlert } from "../services/opsNotificationService.js";

const BRAND = process.env.BRAND_NAME || "Demo Cleaning Co.";

const CLIENT_COLUMNS =
  "id, first_name, last_name, email, survey_token, survey_rating, survey_feedback, survey_responded_at";

function clientName(c) {
  return [c?.first_name, c?.last_name].filter(Boolean).join(" ").trim();
}

function escapeHtml(s) {
  return String(s ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

// ── Página HTML de resultado (sin JS) — adaptada de publicConfirmationController ─
function surveyPage({ title, message, tone = "success", extraHtml = "" }) {
  const accent =
    tone === "success" ? "#0b8043" : tone === "warning" ? "#f6c026" : "#e11d48";
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${escapeHtml(BRAND)}</title>
</head>
<body style="margin:0;padding:0;background:#f8fafc;font-family:Arial,Helvetica,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="padding:40px 16px;">
    <tr><td align="center">
      <table width="100%" style="max-width:480px;background:#ffffff;border-radius:12px;overflow:hidden;border:1px solid #e2e8f0;">
        <tr><td style="background:#0d1b3e;padding:20px 24px;">
          <span style="color:#fff;font-size:18px;font-weight:700;">${escapeHtml(BRAND)}</span>
        </td></tr>
        <tr><td style="padding:32px 24px;border-top:4px solid ${accent};">
          <h1 style="margin:0 0 12px;font-size:20px;color:#0d1b3e;">${title}</h1>
          <p style="margin:0;font-size:15px;line-height:1.5;color:#334155;">${message}</p>
          ${extraHtml}
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;
}

function reviewButtonHtml(reviewUrl) {
  if (!reviewUrl) return "";
  return `
    <div style="margin-top:20px;">
      <a href="${escapeHtml(reviewUrl)}"
         style="display:inline-block;padding:12px 22px;background:#0b8043;color:#ffffff;font-size:14px;font-weight:700;text-decoration:none;border-radius:8px;">
        Leave a Google review
      </a>
    </div>`;
}

// Botón que POSTea la calificación. El GET no graba nada — así un escáner de
// links de email (Outlook SafeLinks, proxy de Gmail) que prefetchea la URL no
// puede registrar una nota sin que el cliente haga clic.
function confirmRatingFormHtml(token, rating) {
  return `
    <form method="POST" action="/api/public/survey/${encodeURIComponent(token)}/${rating}" style="margin-top:20px;">
      <button type="submit"
        style="padding:12px 24px;background:#0b8043;color:#ffffff;font-size:15px;font-weight:700;border:0;border-radius:8px;cursor:pointer;">
        Submit my ${rating}-star rating
      </button>
    </form>`;
}

function feedbackFormHtml(token, currentValue = "") {
  return `
    <form method="POST" action="/api/public/survey/${encodeURIComponent(token)}/feedback" style="margin-top:20px;">
      <label for="comment" style="display:block;font-size:13px;color:#64748b;margin-bottom:6px;">
        What could we have done better?
      </label>
      <textarea id="comment" name="comment" rows="5" required
        style="width:100%;box-sizing:border-box;padding:10px 12px;font-size:14px;font-family:inherit;border:1px solid #cbd5e1;border-radius:8px;resize:vertical;">${escapeHtml(currentValue)}</textarea>
      <button type="submit"
        style="margin-top:12px;padding:11px 22px;background:#0d1b3e;color:#ffffff;font-size:14px;font-weight:700;border:0;border-radius:8px;cursor:pointer;">
        Send feedback
      </button>
    </form>`;
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

// Página para un cliente que ya respondió (compartida entre GET y POST).
async function respondedPage(client, token) {
  if (client.survey_rating === 5) {
    const reviewUrl = await getGoogleReviewUrl();
    return surveyPage({
      title: "Thanks again! 🎉",
      message:
        "We already have your rating — you rated us 5/5. If you'd still like to leave a public review, here's the link:",
      tone: "success",
      extraHtml: reviewButtonHtml(reviewUrl),
    });
  }
  return surveyPage({
    title: "We've got your feedback",
    message:
      "Thanks — we already recorded your response. If there's more you'd like to tell us, just reply to our email.",
    tone: "success",
    extraHtml: client.survey_feedback ? "" : feedbackFormHtml(token, ""),
  });
}

function ratingErrorPage(status, res, kind) {
  const map = {
    invalid: {
      title: "Invalid link",
      message:
        "This rating link doesn't look valid. Please give us a call and we'll be happy to help.",
    },
    notfound: {
      title: "Link not found",
      message:
        "This survey link doesn't look valid. Please give us a call if you'd like to share feedback.",
    },
    server: {
      title: "Something went wrong",
      message:
        "We couldn't record your rating right now. Please try again in a moment.",
    },
  };
  const { title, message } = map[kind];
  return res.status(status).send(surveyPage({ title, message, tone: "error" }));
}

// ── GET /api/public/survey/:token/:rating ────────────────────────────────────
// Solo MUESTRA la calificación elegida con un botón para confirmarla. No graba
// nada: un prefetch de un escáner de links de email no puede registrar una nota.
export async function ratingPreview(req, res) {
  const { token } = req.params;
  const rating = Number.parseInt(req.params.rating, 10);

  try {
    if (!Number.isInteger(rating) || rating < 1 || rating > 5) {
      return ratingErrorPage(400, res, "invalid");
    }

    const { client, error } = await findClientByToken(token);
    if (error) return ratingErrorPage(500, res, "server");
    if (!client) return ratingErrorPage(404, res, "notfound");

    if (client.survey_responded_at) {
      return res.send(await respondedPage(client, token));
    }

    return res.send(
      surveyPage({
        title: `You picked ${rating} out of 5`,
        message:
          rating === 5
            ? "Tap below to send it — then we'll ask if you'd share a quick Google review."
            : "Tap below to send it, and we'll ask what we could have done better.",
        tone: rating === 5 ? "success" : "warning",
        extraHtml: confirmRatingFormHtml(token, rating),
      }),
    );
  } catch (e) {
    console.error("❌ [PublicSurvey] ratingPreview failed:", e.message);
    return ratingErrorPage(500, res, "server");
  }
}

// ── POST /api/public/survey/:token/:rating ───────────────────────────────────
// Graba la calificación y dispara el flujo A (nota 5) o B (nota 1–4).
export async function submitRating(req, res) {
  const { token } = req.params;
  const rating = Number.parseInt(req.params.rating, 10);

  try {
    if (!Number.isInteger(rating) || rating < 1 || rating > 5) {
      return ratingErrorPage(400, res, "invalid");
    }

    const { client, error } = await findClientByToken(token);
    if (error) return ratingErrorPage(500, res, "server");
    if (!client) return ratingErrorPage(404, res, "notfound");

    if (client.survey_responded_at) {
      return res.send(await respondedPage(client, token));
    }

    const reviewUrl = await getGoogleReviewUrl();

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
      .select("id");
    if (updErr) {
      console.error(
        "❌ [PublicSurvey] Error grabando survey_rating:",
        updErr.message,
      );
      return ratingErrorPage(500, res, "server");
    }

    // Carrera: otra pestaña grabó primero entre el SELECT y este UPDATE.
    if (!updated?.length) {
      const { client: fresh } = await findClientByToken(token);
      return res.send(await respondedPage(fresh || client, token));
    }

    console.log(`✅ [PublicSurvey] Cliente ${client.id} puntuó ${rating}/5.`);

    if (rating === 5) {
      // Fire-and-forget: el email no puede demorar ni romper la página.
      sendSurveyReviewThankYouEmail(
        { name: clientName(client), email: client.email },
        reviewUrl,
      ).catch((e) =>
        console.error(
          "⚠️ [PublicSurvey] sendSurveyReviewThankYouEmail:",
          e.message,
        ),
      );

      return res.send(
        surveyPage({
          title: "You made our day! 🎉",
          message:
            "Thank you so much for the 5-star rating. If you have a moment, a quick Google review helps our small local team more than you know:",
          tone: "success",
          extraHtml: reviewButtonHtml(reviewUrl),
        }),
      );
    }

    // Nota 1–4 — pedir comentario, NADA de Google Reviews.
    sendSurveyFeedbackThankYouEmail(
      { name: clientName(client), email: client.email },
      token,
    ).catch((e) =>
      console.error(
        "⚠️ [PublicSurvey] sendSurveyFeedbackThankYouEmail:",
        e.message,
      ),
    );

    return res.send(
      surveyPage({
        title: "Thank you — we hear you",
        message:
          "We're sorry it wasn't a 5-star experience. We'd really like to understand what we could have done better:",
        tone: "warning",
        extraHtml: feedbackFormHtml(token, ""),
      }),
    );
  } catch (e) {
    console.error("❌ [PublicSurvey] submitRating failed:", e.message);
    return ratingErrorPage(500, res, "server");
  }
}

// ── GET /api/public/survey/:token/feedback ───────────────────────────────────
// Destino del link del email de Caso B — re-muestra el formulario.
export async function feedbackForm(req, res) {
  const { token } = req.params;
  try {
    const { client, error } = await findClientByToken(token);
    if (error || !client) {
      return res.status(error ? 500 : 404).send(
        surveyPage({
          title: error ? "Something went wrong" : "Link not found",
          message: error
            ? "We couldn't load the feedback form right now. Please try again in a moment."
            : "This feedback link doesn't look valid. You can reply to our email instead.",
          tone: "error",
        }),
      );
    }

    if (client.survey_feedback) {
      return res.send(
        surveyPage({
          title: "We've got your feedback",
          message:
            "Thanks — we already received your comment and the team is looking at it. If there's more, just reply to our email.",
          tone: "success",
        }),
      );
    }

    return res.send(
      surveyPage({
        title: "Tell us what to improve",
        message:
          "Thanks for taking the time. Anything you share goes straight to our team:",
        tone: "warning",
        extraHtml: feedbackFormHtml(token, ""),
      }),
    );
  } catch (e) {
    console.error("❌ [PublicSurvey] feedbackForm failed:", e.message);
    return res.status(500).send(
      surveyPage({
        title: "Something went wrong",
        message: "Please try again in a moment.",
        tone: "error",
      }),
    );
  }
}

// ── POST /api/public/survey/:token/feedback ──────────────────────────────────
export async function submitFeedback(req, res) {
  const { token } = req.params;
  const comment = String(req.body?.comment ?? "")
    .trim()
    .slice(0, 4000);

  try {
    if (!comment) {
      return res.status(400).send(
        surveyPage({
          title: "Nothing to send",
          message:
            "The comment was empty — please go back and add a few words.",
          tone: "warning",
        }),
      );
    }

    const { client, error } = await findClientByToken(token);
    if (error || !client) {
      return res.status(error ? 500 : 404).send(
        surveyPage({
          title: error ? "Something went wrong" : "Link not found",
          message: error
            ? "We couldn't save your feedback right now. Please try again in a moment."
            : "This feedback link doesn't look valid. You can reply to our email instead.",
          tone: "error",
        }),
      );
    }

    const nowIso = new Date().toISOString();
    const { error: updErr } = await supabase
      .from("clients")
      .update({ survey_feedback: comment, updated_at: nowIso })
      .eq("survey_token", token);
    if (updErr) {
      console.error(
        "❌ [PublicSurvey] Error guardando survey_feedback:",
        updErr.message,
      );
      return res.status(500).send(
        surveyPage({
          title: "Something went wrong",
          message:
            "We couldn't save your feedback right now. Please try again in a moment.",
          tone: "error",
        }),
      );
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

    return res.send(
      surveyPage({
        title: "Thank you — we've got it",
        message:
          "Your feedback went straight to our team. We take it seriously and we'll use it to do better next time.",
        tone: "success",
      }),
    );
  } catch (e) {
    console.error("❌ [PublicSurvey] submitFeedback failed:", e.message);
    return res.status(500).send(
      surveyPage({
        title: "Something went wrong",
        message: "Please try again in a moment.",
        tone: "error",
      }),
    );
  }
}
