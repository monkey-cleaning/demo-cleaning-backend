// jobs/surveyRequestJob.js
//
// Encuesta de satisfacción post-servicio (filtro 1–5 + Google Review).
// Portado de Monkey Cleaning (LAB413), adaptado al modelo de este fork.
//
// Corre a la mañana siguiente (~09:00 Vancouver). Busca appointments que:
//   - NO están cancelados
//   - terminaron (`ends_at`) dentro de las últimas SURVEY_LOOKBACK_HOURS
//     (ventana amplia a propósito: el guard real contra duplicados es
//     clients.survey_sent, no la fecha exacta)
//   - no son del cliente placeholder
// y por cada CLIENTE que todavía no fue encuestado nunca (survey_sent = false)
// y tiene email:
//   1. genera un token
//   2. manda sendSurveyRequestEmail (directo, con retry)
//   3. SOLO si el envío devolvió true → marca clients.survey_sent = true +
//      survey_sent_at + survey_token + survey_appointment_id
//
// Si el envío falla, NO se marca → se reintenta a la mañana siguiente.
//
// NOTA vs Monkey: allá se filtraba por `status='completed'` + `completed_at`.
// Este fork no escribe ese estado (era el sync horario de Google Calendar), así
// que "servicio prestado" = appointment no cancelado con `ends_at` ya pasado.
//
// SEGURIDAD: mergear/deployar esto no manda nada. El cron queda COMENTADO en
// index.js y los emails están detrás de SURVEY_EMAILS_ENABLED (default off).
// Para probar:
//   node src/jobs/surveyRequestJob.js --dry-run   → lista destinatarios, no envía
//   SURVEY_EMAILS_ENABLED=true SURVEY_TEST_EMAIL=you@x.com node src/jobs/surveyRequestJob.js

import cron from "node-cron";
import crypto from "crypto";
import { pathToFileURL } from "url";
import { DateTime } from "luxon";
import { supabase } from "../supabaseClient.js";
import { sendSurveyRequestEmail } from "../services/clientNotificationService.js";

const TZ = process.env.BOOKING_TIMEZONE || "America/Vancouver";
const LOG = "[surveyRequestJob]";

// Cliente "Unassigned / pending review" — todo appointment sin cliente real.
const PLACEHOLDER_CLIENT_ID = "00000000-0000-0000-0000-000000000001";

// Ventana de servicios prestados a considerar. Amplia para tolerar un run
// perdido; el guard contra reenvío es survey_sent, así que no hay riesgo de
// duplicar.
const LOOKBACK_HOURS = Number(process.env.SURVEY_LOOKBACK_HOURS || 48);

// Allowlist opcional (env SURVEY_ONLY_CLIENT_IDS, uuids separados por coma). Si
// está seteada, el job SOLO encuesta a esos clientes — todo el resto se ignora.
// Sirve para probar en local sin tocar clientes reales y para un rollout por
// tandas. Vacía = comportamiento normal (todos los clientes elegibles).
const ONLY_CLIENT_IDS = (process.env.SURVEY_ONLY_CLIENT_IDS || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

/**
 * @param {{ dryRun?: boolean }} opts
 */
export async function runSurveyRequestJob({ dryRun = false } = {}) {
  console.log(
    `${LOG} Starting at ${DateTime.now().setZone(TZ).toISO()}${dryRun ? " (DRY RUN)" : ""}`,
  );

  try {
    const nowIso = new Date().toISOString();
    const cutoffIso = DateTime.now()
      .setZone(TZ)
      .minus({ hours: LOOKBACK_HOURS })
      .toUTC()
      .toISO();

    if (ONLY_CLIENT_IDS.length) {
      console.log(
        `${LOG} SURVEY_ONLY_CLIENT_IDS activo — solo se consideran ${ONLY_CLIENT_IDS.length} cliente(s): ${ONLY_CLIENT_IDS.join(", ")}`,
      );
    }

    // ── 1. Servicios prestados recientes ──────────────────────────────────
    let apptQuery = supabase
      .from("appointments")
      .select("id, client_id, ends_at, scheduled_date")
      .neq("status", "cancelled")
      .not("ends_at", "is", null)
      .lte("ends_at", nowIso)
      .gte("ends_at", cutoffIso)
      .neq("client_id", PLACEHOLDER_CLIENT_ID)
      .order("ends_at", { ascending: true });

    if (ONLY_CLIENT_IDS.length) {
      apptQuery = apptQuery.in("client_id", ONLY_CLIENT_IDS);
    }

    const { data: appts, error: apptErr } = await apptQuery;

    if (apptErr) throw apptErr;

    if (!appts?.length) {
      console.log(
        `${LOG} No hay servicios prestados en la ventana. Nada que hacer.`,
      );
      return { candidates: 0, sent: 0, skipped: 0, failed: 0 };
    }

    // Primera cita prestada gana por cliente (para survey_appointment_id).
    const firstApptByClient = new Map();
    for (const a of appts) {
      if (a.client_id && !firstApptByClient.has(a.client_id)) {
        firstApptByClient.set(a.client_id, a);
      }
    }

    // ── 2. Traer esos clientes ────────────────────────────────────────────
    const clientIds = [...firstApptByClient.keys()];
    const { data: clients, error: clientErr } = await supabase
      .from("clients")
      .select("id, first_name, last_name, email, survey_sent")
      .in("id", clientIds);

    if (clientErr) throw clientErr;

    const clientById = new Map((clients ?? []).map((c) => [c.id, c]));

    let sent = 0;
    let skipped = 0;
    let failed = 0;
    let candidates = 0;

    // ── 3. Por cliente ────────────────────────────────────────────────────
    for (const [clientId, appt] of firstApptByClient) {
      const client = clientById.get(clientId);
      const name = [client?.first_name, client?.last_name]
        .filter(Boolean)
        .join(" ")
        .trim();

      if (!client) {
        console.warn(
          `${LOG} ⚠️  client_id ${clientId} sin fila en clients — se salta.`,
        );
        skipped++;
        continue;
      }
      if (client.survey_sent) {
        skipped++;
        continue;
      }
      if (!client.email) {
        console.warn(
          `${LOG} ⚠️  Cliente ${clientId} (${name || "sin nombre"}) sin email — no se puede encuestar.`,
        );
        skipped++;
        continue;
      }

      candidates++;
      const token = crypto.randomUUID();

      if (dryRun) {
        console.log(
          `${LOG} [dry-run] encuestaría a ${name || "(sin nombre)"} <${client.email}> ` +
            `por appointment ${appt.id} (${appt.scheduled_date ?? "?"})`,
        );
        continue;
      }

      const emailSent = await sendSurveyRequestEmail(
        { name, email: client.email },
        token,
      );

      if (!emailSent) {
        // Puede ser kill-switch (SURVEY_EMAILS_ENABLED != true) o fallo real de
        // SMTP. En ambos casos NO marcamos survey_sent — se reintenta mañana.
        console.warn(
          `${LOG} ⚠️  No se envió la encuesta a ${client.email} — no se marca survey_sent (se reintenta).`,
        );
        failed++;
        continue;
      }

      const markIso = new Date().toISOString();
      const { error: markErr } = await supabase
        .from("clients")
        .update({
          survey_sent: true,
          survey_sent_at: markIso,
          survey_token: token,
          survey_appointment_id: appt.id,
          updated_at: markIso,
        })
        .eq("id", clientId)
        .eq("survey_sent", false);

      if (markErr) {
        console.error(
          `${LOG} ❌ Email enviado a ${client.email} pero falló el UPDATE de survey_sent (token ${token}):`,
          markErr.message,
        );
        failed++;
        continue;
      }

      console.log(
        `${LOG} ✅ Encuesta enviada a ${client.email} (cliente ${clientId}).`,
      );
      sent++;
    }

    console.log(
      `${LOG} Finalizado — candidatos: ${candidates}, enviados: ${sent}, salteados: ${skipped}, fallidos: ${failed}`,
    );
    return { candidates, sent, skipped, failed };
  } catch (err) {
    console.error(`${LOG} ❌ Error fatal:`, err.message);
    return { candidates: 0, sent: 0, skipped: 0, failed: 0, error: err.message };
  }
}

// ── Registro del cron ────────────────────────────────────────────────────────
// La LLAMADA a esta función en index.js queda COMENTADA hasta que se aprueben
// los copys. Con SURVEY_EMAILS_ENABLED != "true" tampoco enviaría nada.
export function startSurveyRequestJob() {
  cron.schedule("0 9 * * *", () => runSurveyRequestJob(), { timezone: TZ });
  console.log(`${LOG} Cron registrado: diario 09:00 (${TZ})`);
}

// ── Invocación directa: node src/jobs/surveyRequestJob.js [--dry-run] ─────────
const isDirectRun =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isDirectRun) {
  const dryRun = process.argv.includes("--dry-run");
  runSurveyRequestJob({ dryRun })
    .then((r) => {
      console.log(`${LOG} Resultado:`, r);
      process.exit(0);
    })
    .catch((e) => {
      console.error(`${LOG} Script failed:`, e);
      process.exit(1);
    });
}
