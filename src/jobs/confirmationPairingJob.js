// jobs/confirmationPairingJob.js
//
// Ticket: "Confirmación automática de servicios pendientes (CONFIRMAR)"
//
// Post-standalone: ya no hay GCal, así que la señal "CONFIRMAR" en el
// título de un evento (que ops agregaba a mano en Google Calendar) deja de
// existir. En su lugar, se usa lo que ya es nativo de Supabase:
// appointments.status = 'pending' ES esa misma señal — un turno recién
// creado que todavía no pasó por confirmSlot() (que lo marca 'confirmed').
//
// ⚠️ Decisión asumida (avisar si no es la correcta): con esto, TODO
// appointment en 'pending' es candidato al flujo de confirmación — no solo
// los que ops flageaba a mano en GCal. Si el MVP necesita que solo algunos
// turnos disparen este flujo, hace falta un flag explícito en `appointments`
// (y un control en el admin panel para setearlo) — no está en el alcance de
// este archivo.
//
// Cada ~15 min:
//   1. Busca en `appointments` los que están 'pending' y todavía no tienen
//      fila en confirmation_slots (sin necesidad de resolver nada — el
//      client_id ya viene directo de la fila, appointments.client_id es
//      NOT NULL).
//   2. Agrupa por client_id: dos appointments creados dentro de la ventana
//      de gracia (setting confirmation_pairing_grace_minutes) → mismo
//      group_id (caso "2 horarios ofrecidos"). Un appointment solo, una vez
//      pasada la ventana de gracia sin aparecer un segundo → group_id
//      propio (caso "confirmar sí/no").
//   3. Inserta las filas en confirmation_slots con token único por slot,
//      con starts_at calculado desde scheduled_date + scheduled_start_time.
//
// NOTA sobre paths: este archivo asume que jobs/ es hermano de controllers/
// y services/ (mismo nivel que dailyDigestJob.js). Si tu estructura real es
// distinta, son los únicos imports a ajustar.

import cron from "node-cron";
import crypto from "crypto";
import { DateTime } from "luxon";
import { supabase } from "../supabaseClient.js";
import { getRawSettings } from "../services/settingsService.js";

const TZ = process.env.BOOKING_TIMEZONE || "America/Vancouver";

// Cuánto adelante mirar. 60 días alcanza y sobra: estos casos se resuelven
// en días (recordatorio a 2 días, release a 24h), no meses.
const LOOKAHEAD_DAYS = 60;

// ── 1. Trae appointments 'pending' que todavía no tienen slot ──────────────
async function findUnpairedPendingAppointments() {
  const today = DateTime.now().setZone(TZ).toISODate();
  const maxDate = DateTime.now()
    .setZone(TZ)
    .plus({ days: LOOKAHEAD_DAYS })
    .toISODate();

  const { data: pending, error } = await supabase
    .from("appointments")
    .select("id, client_id, created_at, scheduled_date, scheduled_start_time")
    .eq("status", "pending")
    .gte("scheduled_date", today)
    .lte("scheduled_date", maxDate);

  if (error) {
    console.error(
      "❌ [ConfirmationPairing] Error leyendo appointments pending:",
      error.message,
    );
    return [];
  }

  const candidates = pending ?? [];
  if (!candidates.length) return [];

  const apptIds = candidates.map((a) => a.id);
  const { data: existingSlots, error: slotsErr } = await supabase
    .from("confirmation_slots")
    .select("appointment_id")
    .in("appointment_id", apptIds);

  if (slotsErr) {
    console.error(
      "❌ [ConfirmationPairing] Error leyendo confirmation_slots existentes:",
      slotsErr.message,
    );
    return [];
  }

  const already = new Set(
    (existingSlots ?? []).map((s) => s.appointment_id),
  );
  return candidates.filter((a) => !already.has(a.id));
}

// ── 2. Agrupa por client_id, empareja por cercanía de creación ─────────────
// Algoritmo greedy: dentro de cada cliente, mientras queden ≥2 appointments
// sin agrupar, toma los dos más próximos en el tiempo (created_at). Si la
// distancia entre sus timestamps está dentro de la ventana de gracia → van
// juntos. Si no, el primero (el más viejo) se resuelve como grupo de 1
// SIEMPRE QUE ya haya pasado la ventana de gracia desde que se creó (si
// todavía no pasó, se deja para la próxima corrida, por si su par aparece).
function buildGroups(apptsByClient, graceMinutes, nowMs) {
  const groups = []; // [{ clientId, appts: [appointment, ...] }]

  for (const [clientId, appts] of apptsByClient) {
    const pending = [...appts].sort(
      (a, b) => new Date(a.created_at) - new Date(b.created_at),
    );

    while (pending.length > 0) {
      if (pending.length === 1) {
        const only = pending[0];
        const ageMinutes =
          (nowMs - new Date(only.created_at).getTime()) / 60000;
        if (ageMinutes >= graceMinutes) {
          groups.push({ clientId, appts: [only] });
          pending.shift();
        } else {
          // Todavía puede aparecer un segundo — se deja para la próxima
          // pasada del job sin tocarlo.
          pending.shift();
        }
        continue;
      }

      const [first, second] = pending;
      const gapMinutes =
        Math.abs(new Date(second.created_at) - new Date(first.created_at)) /
        60000;

      if (gapMinutes <= graceMinutes) {
        groups.push({ clientId, appts: [first, second] });
        pending.splice(0, 2);
      } else {
        // El segundo está demasiado lejos en el tiempo del primero como
        // para ser su par — el primero se resuelve solo (si ya pasó su
        // propia ventana de gracia; si no, se lo deja para la próxima
        // corrida).
        const ageMinutes =
          (nowMs - new Date(first.created_at).getTime()) / 60000;
        if (ageMinutes >= graceMinutes) {
          groups.push({ clientId, appts: [first] });
        }
        pending.shift();
      }
    }
  }

  return groups;
}

// ── 3. Inserta confirmation_slots para cada grupo resuelto ──────────────────
function computeStartsAt(appt) {
  return DateTime.fromISO(
    `${appt.scheduled_date}T${appt.scheduled_start_time}`,
    { zone: TZ },
  ).toISO();
}

async function insertGroups(groups) {
  const rows = [];

  for (const { clientId, appts } of groups) {
    const groupId = crypto.randomUUID();
    for (const appt of appts) {
      rows.push({
        group_id: groupId,
        appointment_id: appt.id,
        client_id: clientId,
        starts_at: computeStartsAt(appt),
        token: crypto.randomBytes(24).toString("hex"),
        status: "offered",
      });
    }
  }

  if (!rows.length) return 0;

  const { error } = await supabase.from("confirmation_slots").insert(rows);
  if (error) {
    console.error("❌ [ConfirmationPairing] Insert error:", error.message);
    return 0;
  }
  return rows.length;
}

// ── Runner principal (exportado para poder correrlo a mano al testear) ──────
// `testClientId` es opcional — solo para verificación end-to-end manual: si
// se pasa, solo arma grupos/inserta slots para ese client_id puntual,
// dejando cualquier otro appointment pending intacto. El cron de
// producción (startConfirmationPairingJob) llama a esto sin argumentos.
export async function runConfirmationPairingJob({ testClientId } = {}) {
  try {
    const settings = await getRawSettings();
    const graceMinutes = parseInt(
      settings.confirmation_pairing_grace_minutes ?? "60",
      10,
    );

    let unpaired = await findUnpairedPendingAppointments();
    if (!unpaired.length) {
      console.log("[ConfirmationPairing] Nada nuevo para emparejar.");
      return { groups: 0, slots: 0 };
    }

    if (testClientId) {
      const before = unpaired.length;
      unpaired = unpaired.filter((a) => a.client_id === testClientId);
      console.log(
        `[ConfirmationPairing] testClientId=${testClientId} — ${unpaired.length}/${before} appointment(s) en scope para esta corrida.`,
      );
    }

    if (!unpaired.length) return { groups: 0, slots: 0 };

    const apptsByClient = new Map();
    for (const a of unpaired) {
      if (!apptsByClient.has(a.client_id)) apptsByClient.set(a.client_id, []);
      apptsByClient.get(a.client_id).push(a);
    }

    const nowMs = Date.now();
    const groups = buildGroups(apptsByClient, graceMinutes, nowMs);
    const inserted = await insertGroups(groups);

    console.log(
      `✅ [ConfirmationPairing] ${groups.length} grupo(s) formado(s), ${inserted} slot(s) insertado(s).`,
    );
    return { groups: groups.length, slots: inserted };
  } catch (e) {
    console.error("❌ [ConfirmationPairing] Job failed:", e.message);
    return { groups: 0, slots: 0, error: e.message };
  }
}

// ── Registro del cron (llamar desde index.js, junto al resto de los jobs) ────
export function startConfirmationPairingJob() {
  cron.schedule("*/15 * * * *", runConfirmationPairingJob, {
    timezone: TZ,
  });
  console.log(
    "🕒 [ConfirmationPairing] Cron registrado: cada 15 min (*/15 * * * *)",
  );
}