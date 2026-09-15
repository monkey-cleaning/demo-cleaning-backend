// jobs/surveyNudgeJob.js
//
// LAB413 — Recordatorio (nudge) de la encuesta post-servicio.
// Portado de Monkey Cleaning tal cual (lógica pura sobre `clients`, sin nada
// específico de Google Calendar).
//
// Corre a la mañana siguiente (~09:00 Vancouver). El cliente ya calificó en la
// página del frontend, pero no completó el flujo:
//   - nota 5 y nunca abrió el link de Google Reviews  → sendSurveyReviewNudgeEmail
//   - nota 1–4 y nunca dejó un comentario             → sendSurveyFeedbackNudgeEmail
//
// Una sola insistencia por cliente: el guard es survey_review_nudge_at /
// survey_feedback_nudge_at (se setea solo si el email salió OK).
//
// Solo mira respuestas de días ANTERIORES (survey_responded_at < inicio de hoy
// en Vancouver) — así "la mañana siguiente" es literal y nunca molesta a alguien
// que calificó hace un rato y todavía puede completar el flujo.
//
// SEGURIDAD: la LLAMADA en index.js queda COMENTADA. Con SURVEY_EMAILS_ENABLED
// != "true" tampoco envía nada. Respeta SURVEY_ONLY_CLIENT_IDS.
// Para probar:
//   node src/jobs/surveyNudgeJob.js --dry-run

import cron from "node-cron";
import { pathToFileURL } from "url";
import { DateTime } from "luxon";
import { supabase } from "../supabaseClient.js";
import {
  sendSurveyReviewNudgeEmail,
  sendSurveyFeedbackNudgeEmail,
} from "../services/clientNotificationService.js";

const TZ = process.env.BOOKING_TIMEZONE || "America/Vancouver";
const LOG = "[surveyNudgeJob]";

const ONLY_CLIENT_IDS = (process.env.SURVEY_ONLY_CLIENT_IDS || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

function clientName(c) {
  return [c?.first_name, c?.last_name].filter(Boolean).join(" ").trim();
}

/**
 * @param {{ dryRun?: boolean }} opts
 */
export async function runSurveyNudgeJob({ dryRun = false } = {}) {
  console.log(
    `${LOG} Starting at ${DateTime.now().setZone(TZ).toISO()}${dryRun ? " (DRY RUN)" : ""}`,
  );

  try {
    const startOfTodayIso = DateTime.now()
      .setZone(TZ)
      .startOf("day")
      .toUTC()
      .toISO();

    if (ONLY_CLIENT_IDS.length) {
      console.log(
        `${LOG} SURVEY_ONLY_CLIENT_IDS activo — solo se consideran ${ONLY_CLIENT_IDS.length} cliente(s).`,
      );
    }

    // Candidatos: calificaron un día anterior y NO recibieron todavía su nudge.
    let query = supabase
      .from("clients")
      .select(
        "id, first_name, last_name, email, survey_token, survey_rating, " +
          "survey_feedback, survey_responded_at, survey_review_clicked_at, " +
          "survey_review_nudge_at, survey_feedback_nudge_at",
      )
      .not("survey_responded_at", "is", null)
      .lt("survey_responded_at", startOfTodayIso)
      .or("survey_review_nudge_at.is.null,survey_feedback_nudge_at.is.null");

    if (ONLY_CLIENT_IDS.length) query = query.in("id", ONLY_CLIENT_IDS);

    const { data: rows, error } = await query;
    if (error) throw error;

    let reviewSent = 0;
    let feedbackSent = 0;
    let skipped = 0;
    let failed = 0;

    for (const c of rows ?? []) {
      const name = clientName(c);

      const wantsReviewNudge =
        c.survey_rating === 5 &&
        !c.survey_review_clicked_at &&
        !c.survey_review_nudge_at;

      const wantsFeedbackNudge =
        c.survey_rating != null &&
        c.survey_rating >= 1 &&
        c.survey_rating <= 4 &&
        !c.survey_feedback &&
        !c.survey_feedback_nudge_at;

      if (!wantsReviewNudge && !wantsFeedbackNudge) {
        skipped++;
        continue;
      }
      if (!c.email) {
        console.warn(`${LOG} ⚠️  Cliente ${c.id} (${name || "sin nombre"}) sin email — se salta.`);
        skipped++;
        continue;
      }

      const kind = wantsReviewNudge ? "review" : "feedback";

      if (dryRun) {
        console.log(
          `${LOG} [dry-run] nudge ${kind} → ${name || "(sin nombre)"} <${c.email}> (nota ${c.survey_rating})`,
        );
        continue;
      }

      const ok = wantsReviewNudge
        ? await sendSurveyReviewNudgeEmail({ name, email: c.email }, c.survey_token)
        : await sendSurveyFeedbackNudgeEmail(
            { name, email: c.email },
            c.survey_token,
            c.survey_rating,
          );

      if (!ok) {
        console.warn(
          `${LOG} ⚠️  No se envió el nudge ${kind} a ${c.email} — no se marca (se reintenta).`,
        );
        failed++;
        continue;
      }

      const col = wantsReviewNudge ? "survey_review_nudge_at" : "survey_feedback_nudge_at";
      const nowIso = new Date().toISOString();
      const { error: markErr } = await supabase
        .from("clients")
        .update({ [col]: nowIso, updated_at: nowIso })
        .eq("id", c.id)
        .is(col, null);

      if (markErr) {
        console.error(
          `${LOG} ❌ Nudge ${kind} enviado a ${c.email} pero falló el UPDATE de ${col}:`,
          markErr.message,
        );
        failed++;
        continue;
      }

      console.log(`${LOG} ✅ Nudge ${kind} enviado a ${c.email} (cliente ${c.id}).`);
      if (wantsReviewNudge) reviewSent++;
      else feedbackSent++;
    }

    console.log(
      `${LOG} Finalizado — review: ${reviewSent}, feedback: ${feedbackSent}, salteados: ${skipped}, fallidos: ${failed}`,
    );
    return { reviewSent, feedbackSent, skipped, failed };
  } catch (err) {
    console.error(`${LOG} ❌ Error fatal:`, err.message);
    return { reviewSent: 0, feedbackSent: 0, skipped: 0, failed: 0, error: err.message };
  }
}

// ── Registro del cron ────────────────────────────────────────────────────────
// LAB413: la LLAMADA en index.js queda COMENTADA hasta aprobar los copys.
export function startSurveyNudgeJob() {
  cron.schedule("0 9 * * *", () => runSurveyNudgeJob(), { timezone: TZ });
  console.log(`${LOG} Cron registrado: diario 09:00 (${TZ})`);
}

// ── Invocación directa: node src/jobs/surveyNudgeJob.js [--dry-run] ───────────
const isDirectRun =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isDirectRun) {
  const dryRun = process.argv.includes("--dry-run");
  runSurveyNudgeJob({ dryRun })
    .then((r) => {
      console.log(`${LOG} Resultado:`, r);
      process.exit(0);
    })
    .catch((e) => {
      console.error(`${LOG} Script failed:`, e);
      process.exit(1);
    });
}
