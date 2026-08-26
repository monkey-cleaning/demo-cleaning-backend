// jobs/confirmationPairingJob.js
//
// Ticket: "Confirmación automática de servicios pendientes (CONFIRMAR)"
//
// Cada ~15 min:
//   1. Busca en GCal eventos con "CONFIRMAR" en el título que todavía no
//      tienen fila en confirmation_slots.
//   2. Resuelve su client_id leyendo `appointments` (NO reimplementa el
//      matcher de 4 niveles de appointmentSyncService.js — ese job ya corre
//      sobre estos mismos eventos porque "confirmar" no está en
//      SKIP_KEYWORDS, así que appointments.client_id ya viene resuelto).
//      Si un evento todavía no fue sincronizado, se salta y se reintenta
//      en la próxima pasada — no se marca como error.
//   3. Agrupa por client_id: dos eventos creados dentro de la ventana de
//      gracia (setting confirmation_pairing_grace_minutes) → mismo group_id
//      (caso "2 horarios ofrecidos"). Un evento solo, una vez pasada la
//      ventana de gracia sin aparecer un segundo → group_id propio (caso
//      "confirmar sí/no").
//   4. Inserta las filas en confirmation_slots con token único por slot.
//
// NOTA sobre paths: este archivo asume que jobs/ es hermano de controllers/
// y services/ (mismo nivel que dailyDigestJob.js). Si tu estructura real es
// distinta, son los únicos 3 imports a ajustar.

import cron from "node-cron";
import crypto from "crypto";
import { DateTime } from "luxon";
import { getCalendarClient } from "../services/googleCalendarClient.js";
import { supabase } from "../supabaseClient.js";
import { getRawSettings } from "../services/settingsService.js";
import {
  isPendingConfirmation,
  CALENDAR_ID,
} from "../controllers/calendarController.js";

const TZ = process.env.BOOKING_TIMEZONE || "America/Vancouver";

// Cuánto adelante mirar en GCal. 60 días alcanza y sobra: estos eventos se
// resuelven en días (recordatorio a 2 días, release a 24h), no meses.
const LOOKAHEAD_DAYS = 60;

// ── 1. Trae de GCal los eventos "CONFIRMAR" que todavía no tienen slot ──────
async function findUnpairedConfirmarEvents() {
  const calendar = getCalendarClient();
  const now = DateTime.now().setZone(TZ);
  const timeMin = now.toISO();
  const timeMax = now.plus({ days: LOOKAHEAD_DAYS }).toISO();

  let events = [];
  let pageToken;
  do {
    const resp = await calendar.events.list({
      calendarId: CALENDAR_ID,
      timeMin,
      timeMax,
      singleEvents: true,
      orderBy: "startTime",
      maxResults: 250,
      pageToken,
      timeZone: TZ,
      fields:
        "items(id,summary,colorId,start,end,created,status),nextPageToken",
    });
    events = events.concat(resp.data.items || []);
    pageToken = resp.data.nextPageToken;
  } while (pageToken);

  const candidates = events.filter(
    (e) => e.status !== "cancelled" && isPendingConfirmation(e),
  );
  if (!candidates.length) return [];

  const gcalIds = candidates.map((e) => e.id);
  const { data: existingSlots, error } = await supabase
    .from("confirmation_slots")
    .select("google_calendar_event_id")
    .in("google_calendar_event_id", gcalIds);

  if (error) {
    console.error(
      "❌ [ConfirmationPairing] Error leyendo confirmation_slots existentes:",
      error.message,
    );
    return [];
  }

  const already = new Set(
    (existingSlots ?? []).map((s) => s.google_calendar_event_id),
  );
  return candidates.filter((e) => !already.has(e.id));
}

// ── 2. Resuelve client_id + appointment_id desde appointments ya sincronizado ─
async function resolveFromAppointments(gcalIds) {
  const map = new Map(); // gcalEventId → { clientId, appointmentId }
  if (!gcalIds.length) return map;

  const { data, error } = await supabase
    .from("appointments")
    .select("google_calendar_event_id, client_id, id")
    .in("google_calendar_event_id", gcalIds);

  if (error) {
    console.error(
      "❌ [ConfirmationPairing] Error leyendo appointments:",
      error.message,
    );
    return map;
  }

  for (const row of data ?? []) {
    if (row.client_id) {
      map.set(row.google_calendar_event_id, {
        clientId: row.client_id,
        appointmentId: row.id,
      });
    }
  }
  return map;
}

// ── 3. Agrupa por client_id, empareja por cercanía de creación ──────────────
// Algoritmo greedy: dentro de cada cliente, mientras queden ≥2 eventos sin
// agrupar, toma los dos más próximos en el tiempo. Si la distancia entre sus
// timestamps `created` está dentro de la ventana de gracia → van juntos. Si
// no, el primero (el más viejo) se resuelve como grupo de 1 SIEMPRE QUE ya
// haya pasado la ventana de gracia desde que se creó (si todavía no pasó,
// se deja para la próxima corrida, por si su par aparece).
function buildGroups(eventsByClient, graceMinutes, nowMs) {
  const groups = []; // [{ clientId, events: [gcalEvent, ...] }]

  for (const [clientId, evts] of eventsByClient) {
    const pending = [...evts].sort(
      (a, b) => new Date(a.created) - new Date(b.created),
    );

    while (pending.length > 0) {
      if (pending.length === 1) {
        const only = pending[0];
        const ageMinutes = (nowMs - new Date(only.created).getTime()) / 60000;
        if (ageMinutes >= graceMinutes) {
          groups.push({ clientId, events: [only] });
          pending.shift();
        } else {
          // Todavía puede aparecer un segundo evento — se deja para la
          // próxima pasada del job sin tocarlo.
          pending.shift();
        }
        continue;
      }

      const [first, second] = pending;
      const gapMinutes =
        Math.abs(new Date(second.created) - new Date(first.created)) / 60000;

      if (gapMinutes <= graceMinutes) {
        groups.push({ clientId, events: [first, second] });
        pending.splice(0, 2);
      } else {
        // El segundo está demasiado lejos en el tiempo del primero como para
        // ser su par — el primero se resuelve solo (si ya pasó su propia
        // ventana de gracia; si no, se lo deja para la próxima corrida).
        const ageMinutes = (nowMs - new Date(first.created).getTime()) / 60000;
        if (ageMinutes >= graceMinutes) {
          groups.push({ clientId, events: [first] });
        }
        pending.shift();
      }
    }
  }

  return groups;
}

// ── 4. Inserta confirmation_slots para cada grupo resuelto ──────────────────
async function insertGroups(groups, resolvedMap) {
  const rows = [];

  for (const { events } of groups) {
    const groupId = crypto.randomUUID();
    for (const e of events) {
      const resolved = resolvedMap.get(e.id);
      if (!resolved) continue; // no debería pasar (ya se filtró antes), defensivo

      const startIso = e.start?.dateTime || e.start?.date;
      rows.push({
        group_id: groupId,
        google_calendar_event_id: e.id,
        appointment_id: resolved.appointmentId,
        client_id: resolved.clientId,
        starts_at: DateTime.fromISO(startIso, { zone: TZ }).toISO(),
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
// se pasa, el job igual busca "CONFIRMAR" en TODO el calendario (no hay
// forma barata de filtrar eso antes), pero solo arma grupos/inserta slots
// para ese client_id puntual, dejando cualquier otro evento CONFIRMAR real
// intacto (ni se toca, ni se lee dos veces, simplemente no se procesa en
// esta corrida). El cron de producción (startConfirmationPairingJob) llama
// a esto sin argumentos, así que su comportamiento no cambia.
export async function runConfirmationPairingJob({ testClientId } = {}) {
  try {
    const settings = await getRawSettings();
    const graceMinutes = parseInt(
      settings.confirmation_pairing_grace_minutes ?? "60",
      10,
    );

    const unpaired = await findUnpairedConfirmarEvents();
    if (!unpaired.length) {
      console.log("[ConfirmationPairing] Nada nuevo para emparejar.");
      return { groups: 0, slots: 0 };
    }

    const gcalIds = unpaired.map((e) => e.id);
    const resolvedMap = await resolveFromAppointments(gcalIds);

    // Solo eventos que YA tienen client_id resuelto en appointments —
    // el resto se reintenta en la próxima corrida.
    let resolvable = unpaired.filter((e) => resolvedMap.has(e.id));
    const skipped = unpaired.length - resolvable.length;
    if (skipped > 0) {
      console.log(
        `[ConfirmationPairing] ${skipped} evento(s) CONFIRMAR sin client_id resuelto todavía — se reintentan en la próxima corrida.`,
      );
    }

    if (testClientId) {
      const before = resolvable.length;
      resolvable = resolvable.filter(
        (e) => resolvedMap.get(e.id).clientId === testClientId,
      );
      console.log(
        `[ConfirmationPairing] testClientId=${testClientId} — ${resolvable.length}/${before} evento(s) en scope para esta corrida.`,
      );
    }

    if (!resolvable.length) return { groups: 0, slots: 0 };

    const eventsByClient = new Map();
    for (const e of resolvable) {
      const clientId = resolvedMap.get(e.id).clientId;
      if (!eventsByClient.has(clientId)) eventsByClient.set(clientId, []);
      eventsByClient.get(clientId).push(e);
    }

    const nowMs = Date.now();
    const groups = buildGroups(eventsByClient, graceMinutes, nowMs);
    const inserted = await insertGroups(groups, resolvedMap);

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
