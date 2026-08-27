// jobs/confirmationReminderJob.js
//
// Ticket: "Confirmación automática de servicios pendientes (CONFIRMAR)"
//
// Corre una vez al día. Busca en confirmation_slots los grupos que:
//   - siguen 'offered' (nadie confirmó ni se liberaron todavía)
//   - todavía no recibieron el recordatorio (reminder_sent_at IS NULL)
//   - su starts_at ya está dentro de la ventana de aviso
//     (setting confirmation_reminder_days_before, default 2 días)
//
// Usa "<=" en vez de una ventana exacta de un solo día a propósito: así,
// si el job se cae un día o un grupo se crea tarde (ya a menos de 2 días
// del servicio), el próximo run lo agarra igual — el guard real contra
// duplicados es reminder_sent_at, no la fecha exacta de corrida.
//
// Arma el payload para clientNotificationService.sendConfirmationRequestEmail
// juntando confirmation_slots + appointments (dirección, hora de fin) +
// clients (nombre, email). Si el cliente no tiene email (ej. el placeholder
// "Unknown / Pending Review"), se saltea el envío pero IGUAL marca
// reminder_sent_at — si no, el job lo reintentaría todos los días sin
// ninguna chance de que funcione. El job de release (Paso 8) igual va a
// liberar ese slot a las 24h y avisar a operaciones.

import cron from "node-cron";
import { DateTime } from "luxon";
import { supabase } from "../supabaseClient.js";
import { getRawSettings } from "../services/settingsService.js";
import { sendConfirmationRequestEmail } from "../services/clientNotificationService.js";

const TZ = process.env.BOOKING_TIMEZONE || "America/Vancouver";

// ── 1. Trae los slots 'offered' sin recordatorio, dentro de la ventana ──────
async function findSlotsNeedingReminder(reminderDaysBefore, testClientId) {
  const cutoffIso = DateTime.now()
    .setZone(TZ)
    .plus({ days: reminderDaysBefore })
    .toISO();

  let query = supabase
    .from("confirmation_slots")
    .select(
      "id, group_id, appointment_id, client_id, starts_at, token, status",
    )
    .eq("status", "offered")
    .is("reminder_sent_at", null)
    .lte("starts_at", cutoffIso)
    .order("starts_at", { ascending: true });

  if (testClientId) query = query.eq("client_id", testClientId);

  const { data, error } = await query;

  if (error) {
    console.error(
      "❌ [ConfirmationReminder] Error leyendo confirmation_slots:",
      error.message,
    );
    return [];
  }
  return data ?? [];
}

// ── 2. Batch-fetch appointments (dirección, hora de fin) y clients ──────────
async function enrichSlots(slots) {
  const appointmentIds = [
    ...new Set(slots.map((s) => s.appointment_id).filter(Boolean)),
  ];
  const clientIds = [...new Set(slots.map((s) => s.client_id).filter(Boolean))];

  const [{ data: appts }, { data: clients }] = await Promise.all([
    appointmentIds.length
      ? supabase
          .from("appointments")
          .select("id, property_address, ends_at")
          .in("id", appointmentIds)
      : Promise.resolve({ data: [] }),
    clientIds.length
      ? supabase
          .from("clients")
          .select("id, first_name, last_name, email")
          .in("id", clientIds)
      : Promise.resolve({ data: [] }),
  ]);

  const apptById = new Map((appts ?? []).map((a) => [a.id, a]));
  const clientById = new Map((clients ?? []).map((c) => [c.id, c]));

  return { apptById, clientById };
}

// ── 3. Formatea un slot para el email ────────────────────────────────────────
function formatSlotForEmail(slot, appt) {
  const start = DateTime.fromISO(slot.starts_at, { zone: TZ });
  const end = appt?.ends_at
    ? DateTime.fromISO(appt.ends_at, { zone: TZ })
    : null;

  return {
    token: slot.token,
    dateLabel: start.toFormat("cccc, LLLL d"),
    timeLabel: end
      ? `${start.toFormat("h:mm a")} – ${end.toFormat("h:mm a")}`
      : start.toFormat("h:mm a"),
    address: appt?.property_address || null,
  };
}

// ── Runner principal ─────────────────────────────────────────────────────────
export async function runConfirmationReminderJob({ testClientId } = {}) {
  try {
    const settings = await getRawSettings();
    const reminderDaysBefore = parseInt(
      settings.confirmation_reminder_days_before ?? "2",
      10,
    );

    const slots = await findSlotsNeedingReminder(
      reminderDaysBefore,
      testClientId,
    );
    if (!slots.length) {
      console.log("[ConfirmationReminder] Nada pendiente de recordatorio.");
      return { groups: 0, processed: 0, sent: 0, killSwitched: 0, skipped: 0 };
    }

    const { apptById, clientById } = await enrichSlots(slots);

    // Agrupar por group_id (todas las filas de un grupo comparten client_id)
    const byGroup = new Map();
    for (const s of slots) {
      if (!byGroup.has(s.group_id)) byGroup.set(s.group_id, []);
      byGroup.get(s.group_id).push(s);
    }

    // sent = email efectivamente entregado (sendConfirmationRequestEmail
    // devolvió true, propagado desde sendWithRetry). killSwitched = se
    // procesó el grupo, se marcó reminder_sent_at, pero el envío se cortó
    // por un guard temprano (kill switch, sin email, etc.) o falló en
    // ambos intentos de SMTP — sendConfirmationRequestEmail devolvió
    // false. skipped = cliente sin email, ni se intentó.
    let sent = 0;
    let killSwitched = 0;
    let skipped = 0;
    const attemptedSlotIds = []; // entregado o kill-switched — ambos van a reminder_sent_at
    const skippedSlotIds = [];

    for (const [groupId, groupSlots] of byGroup) {
      const client = clientById.get(groupSlots[0].client_id);
      const clientName = [client?.first_name, client?.last_name]
        .filter(Boolean)
        .join(" ")
        .trim();

      if (!client?.email) {
        console.warn(
          `⚠️ [ConfirmationReminder] Grupo ${groupId}: cliente sin email (client_id=${groupSlots[0].client_id ?? "null"}) — se marca como enviado sin mandar nada. Requiere revisión manual.`,
        );
        skipped += groupSlots.length;
        skippedSlotIds.push(...groupSlots.map((s) => s.id));
        continue;
      }

      const emailSlots = groupSlots
        .sort((a, b) => new Date(a.starts_at) - new Date(b.starts_at))
        .map((s) => formatSlotForEmail(s, apptById.get(s.appointment_id)));

      const wasSent = await sendConfirmationRequestEmail(
        { id: client.id, name: clientName, email: client.email },
        emailSlots,
      );

      if (wasSent) {
        sent += groupSlots.length;
      } else {
        killSwitched += groupSlots.length;
      }
      attemptedSlotIds.push(...groupSlots.map((s) => s.id));
    }

    const nowIso = new Date().toISOString();
    const allIds = [...attemptedSlotIds, ...skippedSlotIds];
    if (allIds.length) {
      const { error } = await supabase
        .from("confirmation_slots")
        .update({ reminder_sent_at: nowIso })
        .in("id", allIds);
      if (error) {
        console.error(
          "❌ [ConfirmationReminder] Error marcando reminder_sent_at:",
          error.message,
        );
      }
    }

    const processed = sent + killSwitched;
    console.log(
      `✅ [ConfirmationReminder] ${byGroup.size} grupo(s) procesados — ${sent} email(s) enviado(s), ` +
        `${killSwitched} cortado(s)/fallado(s) sin entrega, ${skipped} slot(s) salteados (sin email de cliente).`,
    );
    return { groups: byGroup.size, processed, sent, killSwitched, skipped };
  } catch (e) {
    console.error("❌ [ConfirmationReminder] Job failed:", e.message);
    return {
      groups: 0,
      processed: 0,
      sent: 0,
      killSwitched: 0,
      skipped: 0,
      error: e.message,
    };
  }
}

// ── Registro del cron ─────────────────────────────────────────────────────────
// Cada 6 horas (00:15, 06:15, 12:15, 18:15 Vancouver) en vez de una vez al
// día — la ventana de "2 días antes" se abre en un instante puntual
// (starts_at - reminderDaysBefore), y un chequeo diario podía tardar hasta
// ~24h en detectarla. Con 6h el margen máximo baja a ~6h. reminder_sent_at
// sigue siendo el guard contra duplicados, así que correr más seguido es
// seguro — no hay riesgo de mandar el mismo recordatorio dos veces.
export function startConfirmationReminderJob() {
  cron.schedule("15 */6 * * *", runConfirmationReminderJob, {
    timezone: TZ,
  });
  console.log(
    "🕒 [ConfirmationReminder] Cron registrado: cada 6 horas, minuto :15 (America/Vancouver)",
  );
}