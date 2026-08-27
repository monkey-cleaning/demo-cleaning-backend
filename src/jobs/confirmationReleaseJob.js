// jobs/confirmationReleaseJob.js
//
// Ticket: "Confirmación automática de servicios pendientes (CONFIRMAR)" — Paso 8
//
// Corre cada hora. Libera automáticamente los confirmation_slots que siguen
// 'offered' cuando ya falta menos de `confirmation_release_hours_before`
// horas (default 24) para el servicio y el cliente nunca confirmó.
//
// Unidad de liberación = el GRUPO, no el slot individual (Criterio de
// aceptación #5: "se liberan AMBOS espacios"). Si un grupo ofrece 2
// horarios distintos y uno de los dos ya está a menos de 24h, se liberan
// los dos — no tiene sentido dejar "vivo" el otro horario esperando una
// confirmación que evidentemente no llegó a tiempo para el primero.
// Por eso el query primero encuentra los slots que gatillan el cutoff por
// su propio starts_at, y después trae TODOS los slots 'offered' de esos
// mismos group_id (aunque el propio starts_at del hermano todavía no haya
// entrado en la ventana).
//
// Post-standalone: Supabase es la única fuente de verdad, ya no hay evento
// de GCal que cancelar antes de marcar el appointment 'cancelled' — se
// cancela directo. Por cada grupo liberado: marca el appointment vinculado
// 'cancelled', marca el slot 'released', y al final manda UNA alerta a
// operaciones por grupo (services/opsNotificationService.js).

import cron from "node-cron";
import { DateTime } from "luxon";
import { supabase } from "../supabaseClient.js";
import { getRawSettings } from "../services/settingsService.js";
import { sendOpsReleaseAlert } from "../services/opsNotificationService.js";

const TZ = process.env.BOOKING_TIMEZONE || "America/Vancouver";

// ── 1. Slots 'offered' cuyo starts_at ya entró en la ventana de release ─────
async function findTriggeringSlots(releaseHoursBefore, testClientId) {
  const cutoffIso = DateTime.now()
    .setZone(TZ)
    .plus({ hours: releaseHoursBefore })
    .toISO();

  let query = supabase
    .from("confirmation_slots")
    .select("id, group_id")
    .eq("status", "offered")
    .lte("starts_at", cutoffIso);

  if (testClientId) query = query.eq("client_id", testClientId);

  const { data, error } = await query;

  if (error) {
    console.error(
      "❌ [ConfirmationRelease] Error leyendo slots gatillantes:",
      error.message,
    );
    return [];
  }
  return data ?? [];
}

// ── 2. Trae TODOS los slots 'offered' de esos group_id (incluye hermanos) ───
async function findAllOfferedInGroups(groupIds) {
  if (!groupIds.length) return [];

  const { data, error } = await supabase
    .from("confirmation_slots")
    .select("id, group_id, appointment_id, client_id, starts_at, status")
    .in("group_id", groupIds)
    .eq("status", "offered");

  if (error) {
    console.error(
      "❌ [ConfirmationRelease] Error leyendo slots del grupo:",
      error.message,
    );
    return [];
  }
  return data ?? [];
}

// ── 3. Batch-fetch appointments + clients (mismo patrón que el reminder job) ─
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
          .select("id, first_name, last_name")
          .in("id", clientIds)
      : Promise.resolve({ data: [] }),
  ]);

  return {
    apptById: new Map((appts ?? []).map((a) => [a.id, a])),
    clientById: new Map((clients ?? []).map((c) => [c.id, c])),
  };
}

function formatSlotForAlert(slot, appt) {
  const start = DateTime.fromISO(slot.starts_at, { zone: TZ });
  const end = appt?.ends_at
    ? DateTime.fromISO(appt.ends_at, { zone: TZ })
    : null;
  return {
    dateLabel: start.toFormat("cccc, LLLL d"),
    timeLabel: end
      ? `${start.toFormat("h:mm a")} – ${end.toFormat("h:mm a")}`
      : start.toFormat("h:mm a"),
    address: appt?.property_address || null,
  };
}

// ── 4. Libera un slot: cancela appointment, marca released ─────────────────
async function releaseSlot(slot) {
  if (slot.appointment_id) {
    const { error: apptErr } = await supabase
      .from("appointments")
      .update({ status: "cancelled", updated_at: new Date().toISOString() })
      .eq("id", slot.appointment_id);
    if (apptErr)
      console.error(
        `⚠️ [ConfirmationRelease] Error cancelando appointment ${slot.appointment_id}:`,
        apptErr.message,
      );
  }

  const { error: slotErr } = await supabase
    .from("confirmation_slots")
    .update({ status: "released", resolved_at: new Date().toISOString() })
    .eq("id", slot.id);
  if (slotErr)
    console.error(
      `⚠️ [ConfirmationRelease] Error marcando slot ${slot.id} released:`,
      slotErr.message,
    );

  return { released: true };
}

// ── Runner principal ──────────────────────────────────────────────────────────
export async function runConfirmationReleaseJob({ testClientId } = {}) {
  try {
    const settings = await getRawSettings();
    const releaseHoursBefore = parseFloat(
      settings.confirmation_release_hours_before ?? "24",
    );

    const triggering = await findTriggeringSlots(
      releaseHoursBefore,
      testClientId,
    );
    if (!triggering.length) {
      console.log("[ConfirmationRelease] Nada para liberar todavía.");
      return { groups: 0, released: 0 };
    }

    const groupIds = [...new Set(triggering.map((s) => s.group_id))];
    const slots = await findAllOfferedInGroups(groupIds);
    if (!slots.length) return { groups: 0, released: 0 };

    const { apptById, clientById } = await enrichSlots(slots);

    const byGroup = new Map();
    for (const s of slots) {
      if (!byGroup.has(s.group_id)) byGroup.set(s.group_id, []);
      byGroup.get(s.group_id).push(s);
    }

    let released = 0;
    for (const [groupId, groupSlots] of byGroup) {
      for (const slot of groupSlots) {
        await releaseSlot(slot);
        released++;
      }

      const client = clientById.get(groupSlots[0].client_id);
      const clientName = [client?.first_name, client?.last_name]
        .filter(Boolean)
        .join(" ")
        .trim();
      const releasedSlots = groupSlots
        .sort((a, b) => new Date(a.starts_at) - new Date(b.starts_at))
        .map((s) => formatSlotForAlert(s, apptById.get(s.appointment_id)));

      // Nunca fatal — un fallo mandando la alerta no debe frenar el resto
      // de los grupos a liberar.
      try {
        await sendOpsReleaseAlert({
          client: { name: clientName },
          releasedSlots,
        });
      } catch (alertErr) {
        console.error(
          `⚠️ [ConfirmationRelease] Error mandando alerta de ops para grupo ${groupId}:`,
          alertErr.message,
        );
      }
    }

    console.log(
      `✅ [ConfirmationRelease] ${byGroup.size} grupo(s) procesados, ${released} slot(s) liberado(s).`,
    );
    return { groups: byGroup.size, released };
  } catch (e) {
    console.error("❌ [ConfirmationRelease] Job failed:", e.message);
    return { groups: 0, released: 0, error: e.message };
  }
}

// ── Registro del cron ─────────────────────────────────────────────────────────
export function startConfirmationReleaseJob() {
  cron.schedule("0 * * * *", runConfirmationReleaseJob, {
    timezone: TZ,
  });
  console.log(
    "🕒 [ConfirmationRelease] Cron registrado: cada hora en punto (0 * * * *)",
  );
}