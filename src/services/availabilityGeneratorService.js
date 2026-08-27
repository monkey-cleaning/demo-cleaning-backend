// ─────────────────────────────────────────────────────────────────────────────
// availabilityGeneratorService.js
//
// Reemplazo local de syncAvailabilityFromGoogle() (calendarAvailabilitySync.js),
// que construía `cleaning_availability` como "ventana laboral menos eventos
// ocupados de Google Calendar". Al desacoplar de GCal (Fase 2.9) esa función
// quedó muerta y nada la reemplazó, así que la tabla dejó de poblarse: sin
// filas acá, GET /api/availability devuelve [] y /available no ofrece horarios.
//
// Misma idea, otra fuente: la ocupación sale de `appointments` (única fuente de
// verdad del fork) en vez de la API de Calendar. El resto de la geometría se
// porta tal cual del original, porque el resto del sistema depende de ella:
//
//   · Slots de BOOKING_SLOT_MINUTES (90) que arrancan cada SLOT_STEP_MINUTES
//     (15). Son ventanas deslizantes SOLAPADAS, no segmentos contiguos.
//     groupSlotsIntoWindows() en availabilityService.js las vuelve a fusionar
//     en la ventana libre real, y findCoveringSlotIds() marca como "booked"
//     sólo las que toca la reserva.
//   · Los 90 min no son decorativos: la tabla tiene
//     CONSTRAINT min_duration CHECK (end_at - start_at >= 5400s),
//     así que cualquier slot más corto es rechazado por Postgres.
//
// Se ejecuta vía POST /api/jobs/availability/sync (Bearer JOBS_TOKEN) y desde
// el cron diario de index.js.
// ─────────────────────────────────────────────────────────────────────────────

import { DateTime } from "luxon";
import { supabase } from "./supabaseService.js";
import { getWorkWindow, getOperationalSettings } from "./settingsService.js";

const TZ = process.env.BOOKING_TIMEZONE || "America/Vancouver";

// La tabla exige >= 90 min por fila (min_duration). Si alguien baja la env por
// error, clampeamos en vez de generar miles de filas que Postgres va a rechazar.
const MIN_SLOT_MINUTES = 90;
const RAW_SLOT_MINUTES = Number(process.env.BOOKING_SLOT_MINUTES || 90);
const BOOKING_SLOT_MINUTES = Math.max(MIN_SLOT_MINUTES, RAW_SLOT_MINUTES);
const SLOT_STEP_MINUTES = Number(process.env.SLOT_STEP_MINUTES || 15);

// Ventana libre mínima para molestarse en generar slots.
const MIN_SLOT_HOURS = BOOKING_SLOT_MINUTES / 60;

// Estados de appointment que NO ocupan al equipo.
const NON_BLOCKING_STATUSES = new Set(["cancelled"]);

// Supabase se pone lento con upserts gigantes; 30 días x 3 teams son ~4k filas.
const UPSERT_CHUNK = 500;

function toIso(dt) {
  return dt.toUTC().toISO({ suppressMilliseconds: true });
}

// ── Helpers de intervalos (portados de calendarAvailabilitySync.js) ──────────
// Diferencia con el original: la ventana laboral se pasa por parámetro en vez
// de vivir en `let WORK_START_HOUR` a nivel de módulo. Ese estado mutable hacía
// que el resultado dependiera de si alguien había llamado antes a
// loadOperationalConfigFromDB(); acá no hay forma de usarlo sin inicializar.

function clampToWorkWindow(day, dt, workStartHour, workEndHour) {
  const start = day.set({
    hour: workStartHour,
    minute: 0,
    second: 0,
    millisecond: 0,
  });
  const end = day.set({
    hour: workEndHour,
    minute: 0,
    second: 0,
    millisecond: 0,
  });
  if (dt < start) return start;
  if (dt > end) return end;
  return dt;
}

function mergeIntervals(intervals) {
  if (!intervals.length) return [];
  const sorted = [...intervals].sort(
    (a, b) => a.start.toMillis() - b.start.toMillis(),
  );
  const merged = [{ ...sorted[0] }];
  for (let i = 1; i < sorted.length; i++) {
    const last = merged[merged.length - 1];
    const cur = sorted[i];
    if (cur.start <= last.end) {
      last.end = DateTime.max(last.end, cur.end);
    } else {
      merged.push({ ...cur });
    }
  }
  return merged;
}

/**
 * Ventanas libres de un día, recortadas a la jornada y filtradas por duración
 * mínima útil.
 */
function computeFreeWindowsForDay(
  day,
  busyIntervals,
  workStartHour,
  workEndHour,
) {
  day = day.setZone(TZ);

  const workStart = day.set({
    hour: workStartHour,
    minute: 0,
    second: 0,
    millisecond: 0,
  });
  const workEnd = day.set({
    hour: workEndHour,
    minute: 0,
    second: 0,
    millisecond: 0,
  });

  const clipped = busyIntervals
    .map((i) => ({
      start: clampToWorkWindow(day, i.start, workStartHour, workEndHour),
      end: clampToWorkWindow(day, i.end, workStartHour, workEndHour),
    }))
    .filter((i) => i.end > i.start);

  const merged = mergeIntervals(clipped);

  const free = [];
  let cursor = workStart;

  for (const b of merged) {
    if (b.start > cursor) free.push({ start: cursor, end: b.start });
    cursor = DateTime.max(cursor, b.end);
  }

  if (cursor < workEnd) free.push({ start: cursor, end: workEnd });

  return free.filter(
    (f) => f.end.diff(f.start, "hours").hours >= MIN_SLOT_HOURS,
  );
}

/**
 * Convierte una ventana libre en slots reservables solapados.
 */
function windowToBookableSlots(freeWindow, workEndHour) {
  const slots = [];
  const duration = { minutes: BOOKING_SLOT_MINUTES };
  const step = { minutes: SLOT_STEP_MINUTES };

  const dayEnd = freeWindow.start
    .setZone(TZ)
    .set({ hour: workEndHour, minute: 0, second: 0, millisecond: 0 });

  let cursor = freeWindow.start;

  while (
    cursor.plus(duration) <= freeWindow.end &&
    cursor.plus(duration) <= dayEnd
  ) {
    slots.push({ start: cursor, end: cursor.plus(duration) });
    cursor = cursor.plus(step);
  }

  return slots;
}

// ── Carga de datos ───────────────────────────────────────────────────────────

async function loadActiveTeams() {
  const { data, error } = await supabase
    .from("teams")
    .select("id")
    .eq("is_active", true);

  if (error) throw error;

  const ids = (data ?? []).map((t) => t.id).filter(Boolean);
  if (!ids.length) throw new Error("No hay teams activos en la tabla teams");
  return ids.sort();
}

function overlaps(a, b) {
  return a.start < b.end && a.end > b.start;
}

/**
 * Elige el equipo que se va a comer un turno sin asignar: el primero, en orden
 * estable de `teams`, que no tenga nada solapado en ese intervalo.
 *
 * El orden estable importa: el generador se re-corre entero todos los días, y
 * si la elección variara entre corridas la disponibilidad publicada saltaría de
 * un equipo a otro sin que cambie ningún dato.
 *
 * "Libre" acá es a nivel EQUIPO, no de slot: el equipo no tiene ningún otro
 * turno que se pise con este intervalo. No mira `cleaning_availability` — esa
 * tabla se está reconstruyendo justamente ahora, a partir de lo que devuelva
 * esta función.
 *
 * Si ningún equipo está libre, cae al primero. Ojo: eso NO es un no-op. Los
 * equipos pueden estar ocupados sólo parcialmente (todos con algo entre 09:00
 * y 11:00, y el huérfano yendo de 10:00 a 14:00), y en ese caso el tramo que
 * sobra — 11:00 a 14:00 — queda bloqueado en team_1 y libre en el resto. Es
 * deliberado: el turno existe y alguien lo tiene que cubrir, así que se anota
 * en un solo equipo en vez de repartirse o desaparecer.
 *
 * Si algún día molesta que siempre caiga en team_1, la alternativa es elegir
 * el de menor solape en vez del primero, para minimizar la disponibilidad que
 * se pierde. Hoy no hay ningún turno sin `team_id` en la base, así que no vale
 * la complejidad.
 *
 * Exportada para tests: es la única decisión no trivial del generador y no se
 * puede ejercitar con los datos reales (hoy no hay turnos sin `team_id`).
 */
export function pickFreeTeam(teams, busy, dayKey, interval) {
  for (const team of teams) {
    const intervals = busy.get(`${team}|${dayKey}`) || [];
    if (!intervals.some((i) => overlaps(i, interval))) return { team, free: true };
  }
  return { team: teams[0], free: false };
}

/**
 * Ocupación por equipo y día, derivada de `appointments`.
 *
 * Cada turno se extiende `bufferMinutes` al final: es el traslado del equipo,
 * el mismo colchón que bookAvailability() reserva al bloquear los slots. Sin
 * esto el generador volvería a ofrecer el hueco que la reserva ya consumió.
 *
 * Un turno sin `team_id` ocupa UN solo equipo: el primero que esté libre en ese
 * intervalo. El original bloqueaba a todos ("block_both") porque no podía saber
 * quién iba a tomar un evento de Calendar sin color; acá el turno lo va a
 * cubrir un equipo y sólo uno, así que bloquear a los tres tira disponibilidad
 * real a la basura.
 *
 * Se procesan en dos pasadas — primero los turnos con equipo asignado, después
 * los huérfanos — para que la elección se haga sabiendo quién está realmente
 * ocupado y no dependa del orden en que Postgres devolvió las filas.
 *
 * @returns {Map<string, Array<{start: DateTime, end: DateTime}>>} clave "team|YYYY-MM-DD"
 */
async function loadBusyByTeamAndDay(startRange, endRange, teams, bufferMinutes) {
  const { data, error } = await supabase
    .from("appointments")
    .select(
      "id, team_id, status, scheduled_date, scheduled_start_time, scheduled_end_time, starts_at, ends_at",
    )
    .gte("scheduled_date", startRange.toISODate())
    .lte("scheduled_date", endRange.toISODate());

  if (error) throw error;

  const busy = new Map();
  let skipped = 0;

  const push = (team, dayKey, interval) => {
    const key = `${team}|${dayKey}`;
    if (!busy.has(key)) busy.set(key, []);
    busy.get(key).push(interval);
  };

  // ── Parseo ─────────────────────────────────────────────────────────────────
  const assigned = [];
  const orphans = [];

  for (const appt of data ?? []) {
    if (NON_BLOCKING_STATUSES.has(appt.status)) {
      skipped++;
      continue;
    }

    // starts_at/ends_at son timestamptz y no dependen de interpretar una hora
    // local; cuando faltan, recomponemos desde scheduled_date + horas en TZ.
    const start = appt.starts_at
      ? DateTime.fromISO(appt.starts_at, { zone: "utc" }).setZone(TZ)
      : DateTime.fromISO(
          `${appt.scheduled_date}T${appt.scheduled_start_time}`,
          { zone: TZ },
        );

    let end = appt.ends_at
      ? DateTime.fromISO(appt.ends_at, { zone: "utc" }).setZone(TZ)
      : DateTime.fromISO(`${appt.scheduled_date}T${appt.scheduled_end_time}`, {
          zone: TZ,
        });

    if (!start.isValid || !end.isValid || end <= start) {
      console.warn(
        `⚠️ [availabilityGenerator] Appointment ${appt.id} con horario inválido, ignorado`,
      );
      skipped++;
      continue;
    }

    end = end.plus({ minutes: bufferMinutes });

    const entry = { id: appt.id, dayKey: start.toISODate(), start, end };

    if (appt.team_id) assigned.push({ ...entry, team: appt.team_id });
    else orphans.push(entry);
  }

  // ── Pasada 1: turnos con equipo asignado ───────────────────────────────────
  for (const a of assigned) push(a.team, a.dayKey, { start: a.start, end: a.end });

  // ── Pasada 2: turnos huérfanos → primer equipo libre ───────────────────────
  // Orden estable por hora de inicio (desempatando por id) para que dos
  // corridas del generador sobre los mismos datos repartan igual.
  orphans.sort(
    (x, y) => x.start.toMillis() - y.start.toMillis() || String(x.id).localeCompare(String(y.id)),
  );

  let orphansPlaced = 0;
  let orphansForced = 0;

  for (const o of orphans) {
    const interval = { start: o.start, end: o.end };
    const { team, free } = pickFreeTeam(teams, busy, o.dayKey, interval);

    push(team, o.dayKey, interval);

    if (free) {
      orphansPlaced++;
    } else {
      orphansForced++;
      console.warn(
        `⚠️ [availabilityGenerator] Appointment ${o.id} (${o.dayKey}) sin team_id y ` +
          `ningún equipo libre en ese horario; anotado en ${team}`,
      );
    }
  }

  console.log(
    `📅 [availabilityGenerator] appointments: ${assigned.length} con equipo, ` +
      `${orphans.length} sin team_id (${orphansPlaced} al primer equipo libre, ` +
      `${orphansForced} sin equipo libre), ${skipped} ignorados ` +
      `(cancelados/inválidos), buffer=${bufferMinutes}min`,
  );

  return busy;
}

// ── Orquestador ──────────────────────────────────────────────────────────────

/**
 * Regenera la disponibilidad futura.
 *
 * Sólo toca filas con status "available": las reservadas/completadas/canceladas
 * se respetan, y los slots generados que colisionen con una de ellas se
 * descartan antes del insert. Es idempotente — correrlo dos veces seguidas deja
 * la tabla igual.
 *
 * @param {object}  opts
 * @param {number}  [opts.rangeDays=30]  horizonte en días desde hoy
 * @param {boolean} [opts.dryRun=false]  calcula y reporta sin escribir
 */
export async function generateAvailability({
  rangeDays = 30,
  dryRun = false,
} = {}) {
  const startedAt = Date.now();

  const { workStartHour, workEndHour } = await getWorkWindow();
  const { serviceBufferMinutes } = await getOperationalSettings();
  const teams = await loadActiveTeams();

  const now = DateTime.now().setZone(TZ);
  const startRange = now.startOf("day");
  const endRange = now.plus({ days: rangeDays }).endOf("day");

  console.log(
    `🧮 [availabilityGenerator] ${startRange.toISODate()} → ${endRange.toISODate()} | ` +
      `teams=[${teams.join(", ")}] | jornada ${workStartHour}:00-${workEndHour}:00 | ` +
      `slot=${BOOKING_SLOT_MINUTES}m step=${SLOT_STEP_MINUTES}m buffer=${serviceBufferMinutes}m` +
      (dryRun ? " | DRY RUN" : ""),
  );

  if (RAW_SLOT_MINUTES < MIN_SLOT_MINUTES) {
    console.warn(
      `⚠️ [availabilityGenerator] BOOKING_SLOT_MINUTES=${RAW_SLOT_MINUTES} es menor al ` +
        `mínimo que acepta la tabla (${MIN_SLOT_MINUTES}); usando ${BOOKING_SLOT_MINUTES}.`,
    );
  }

  const busy = await loadBusyByTeamAndDay(
    startRange,
    endRange,
    teams,
    serviceBufferMinutes,
  );

  // ── Generar ────────────────────────────────────────────────────────────────
  const rows = [];
  const perTeam = Object.fromEntries(teams.map((t) => [t, 0]));

  let day = startRange;
  while (day <= endRange) {
    const dayKey = day.toISODate();

    for (const team of teams) {
      const intervals = busy.get(`${team}|${dayKey}`) || [];
      const windows = computeFreeWindowsForDay(
        day,
        intervals,
        workStartHour,
        workEndHour,
      );
      for (const w of windows) {
        for (const slot of windowToBookableSlots(w, workEndHour)) {
          rows.push({
            team,
            start_at: toIso(slot.start),
            end_at: toIso(slot.end),
            status: "available",
          });
          perTeam[team]++;
        }
      }
    }

    day = day.plus({ days: 1 });
  }

  // ── Dedupe interno ─────────────────────────────────────────────────────────
  const seen = new Set();
  const deduped = [];
  for (const r of rows) {
    const key = `${r.team}|${r.start_at}|${r.end_at}`;
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(r);
  }

  // ── Excluir choques con filas que no son "available" ───────────────────────
  const { data: reserved, error: reservedErr } = await supabase
    .from("cleaning_availability")
    .select("team, start_at, end_at")
    .neq("status", "available")
    .gte("start_at", toIso(startRange))
    .lte("start_at", toIso(endRange));

  if (reservedErr) throw reservedErr;

  // Normalizamos los timestamps de la DB con toIso() antes de comparar: Postgres
  // los devuelve como "+00:00" y toIso() emite "Z", así que comparar los strings
  // crudos nunca daría match y el filtro sería un no-op silencioso.
  const reservedSet = new Set(
    (reserved ?? []).map(
      (r) =>
        `${r.team}|${toIso(DateTime.fromISO(r.start_at))}|${toIso(DateTime.fromISO(r.end_at))}`,
    ),
  );

  const finalRows = reservedSet.size
    ? deduped.filter((r) => !reservedSet.has(`${r.team}|${r.start_at}|${r.end_at}`))
    : deduped;

  const result = {
    ok: true,
    dryRun,
    rangeDays,
    teams,
    generated: rows.length,
    internalDups: rows.length - deduped.length,
    droppedByReserved: deduped.length - finalRows.length,
    reservedRows: reserved?.length ?? 0,
    perTeam,
    inserted: 0,
    deleted: 0,
  };

  if (dryRun) {
    console.log(
      "🔍 [availabilityGenerator] DRY RUN, no se escribió nada:",
      result,
    );
    return result;
  }

  // ── Reemplazar la disponibilidad futura ────────────────────────────────────
  // Borramos desde el inicio del día de hoy (no desde "ahora") para poder
  // re-correr el generador el mismo día sin dejar residuos de la corrida
  // anterior; getAvailability() igual descarta todo lo anterior a now + 24 h.
  const { data: deletedRows, error: deleteErr } = await supabase
    .from("cleaning_availability")
    .delete()
    .eq("status", "available")
    .gte("start_at", toIso(startRange))
    .select("id");

  if (deleteErr) throw deleteErr;
  result.deleted = deletedRows?.length ?? 0;

  for (let i = 0; i < finalRows.length; i += UPSERT_CHUNK) {
    const chunk = finalRows.slice(i, i + UPSERT_CHUNK);
    const { error } = await supabase
      .from("cleaning_availability")
      .upsert(chunk, {
        onConflict: "team,start_at,end_at",
        ignoreDuplicates: true,
      });

    if (error) throw error;
    result.inserted += chunk.length;
  }

  console.log(
    `✅ [availabilityGenerator] ${result.inserted} slots insertados, ` +
      `${result.deleted} viejos borrados, ${result.droppedByReserved} descartados por choque ` +
      `con reservas, en ${Date.now() - startedAt}ms`,
  );

  return result;
}
