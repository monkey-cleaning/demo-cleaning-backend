import { DateTime } from "luxon";
import { getCalendarClient } from "./googleCalendarClient.js";
import {
  detectTeamFromEvent,
  loadTeamsFromDB,
  getAllTeamIds,
  TZ,
} from "./calendarAvailabilitySync.js";
import { getTeamColorId, isLunchEvent } from "./eventClassification.js";
import {
  supabase,
  getActiveEmployeesLite,
  getWeeklyAvailabilityForEmployees,
  getExtraAvailabilityInRange,
  getTimeOffInRange,
  getExceptionsInRange,
  getTeamAssignmentsForDates,
  getTeamDefaultSize,
} from "./supabaseService.js";
import { syncAppointmentTeamsBatch } from "../controllers/calendarController.js";

const LOOKBACK_WEEKS = 4;

// ── withTeamTag (duplicado de calendarController.js) ──────────────────────
// LAB-233: mantener esto sincronizado con la versión de calendarController.js.
// Se usa acá para taggear el título con "#N" cuando un evento sin equipo
// determinado se asigna automáticamente al equipo libre — así detectTeam()
// lo reconoce correctamente de ahí en adelante, sin depender del selector manual.
function withTeamTag(summary, teamId) {
  if (!teamId) return summary;
  const m = teamId.match(/team_(\d+)/);
  if (!m) return summary;
  const num = m[1];
  if (/#\s*\d+/.test(summary)) {
    return summary.replace(/#\s*\d+/, `#${num}`);
  }
  return `${summary} #${num}`;
}

// ── Runner con concurrencia limitada, compartido por applyWeeklyAssignments
// (escrituras a Supabase) y syncAttendeesToGCal (patches a GCal) ────────────
async function runWithConcurrency(items, limit, worker) {
  const results = new Array(items.length);
  let next = 0;
  async function runNext() {
    const i = next++;
    if (i >= items.length) return;
    try {
      results[i] = { status: "fulfilled", value: await worker(items[i], i) };
    } catch (err) {
      results[i] = { status: "rejected", reason: err };
    }
    return runNext();
  }
  const workers = Array.from(
    { length: Math.min(limit, items.length) },
    runNext,
  );
  await Promise.all(workers);
  return results;
}

function getCalendarId() {
  const ids = (process.env.TEAM_CALENDAR_IDS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (ids.length < 1) throw new Error("Missing TEAM_CALENDAR_IDS env");
  return ids[0];
}

async function listWeekEvents(calendar, calendarId, timeMinIso, timeMaxIso) {
  const r = await calendar.events.list({
    calendarId,
    timeMin: timeMinIso,
    timeMax: timeMaxIso,
    singleEvents: true,
    orderBy: "startTime",
    maxResults: 2500,
    fields: "items(id,summary,status,start,end,colorId,attendees(email))",
  });
  return (r.data.items || []).filter((e) => e.status !== "cancelled");
}

// true si [availStart,availEnd) cubre completamente [needStart,needEnd).
// Comparación de strings "HH:MM:SS" — válido porque el formato es fijo/zero-padded.
function covers(availStart, availEnd, needStart, needEnd) {
  return availStart <= needStart && availEnd >= needEnd;
}

// true si el set de attendees actual en GCal ya coincide con el deseado
// (comparación por email, case-insensitive).
function attendeesUnchanged(currentAttendees, desiredAttendees) {
  const c = new Set(
    (currentAttendees || [])
      .map((a) => (a.email || "").toLowerCase())
      .filter(Boolean),
  );
  const d = new Set(
    (desiredAttendees || [])
      .map((a) => (a.email || "").toLowerCase())
      .filter(Boolean),
  );
  if (c.size !== d.size) return false;
  for (const email of c) if (!d.has(email)) return false;
  return true;
}

/**
 * Genera, para cada día de [weekStart, weekStart+7) y cada team activo con
 * eventos ese día, una formación sugerida (solo lectura — no escribe nada).
 *
 * @param {{ weekStart: string }} params — "YYYY-MM-DD", se asume lunes de la semana.
 */
export async function generateWeeklySuggestions({ weekStart }) {
  await loadTeamsFromDB();
  const allTeamIds = getAllTeamIds();

  const start = DateTime.fromISO(weekStart, { zone: TZ }).startOf("day");
  const end = start.plus({ days: 7 });
  const toIso = (dt) => dt.toUTC().toISO({ suppressMilliseconds: true });

  const calendar = getCalendarClient();
  const calendarId = getCalendarId();
  const events = await listWeekEvents(
    calendar,
    calendarId,
    toIso(start),
    toIso(end),
  );

  // Solo se usa cuando no hay formación de referencia en las últimas 4 semanas.
  const defaultTeamSize = await getTeamDefaultSize();

  // ── Agrupar eventos por día+team, usando el mismo detector que el sync ────
  const eventsByDayTeam = new Map(); // `${dateKey}|${teamId}` → events[]
  for (const e of events) {
    const { team } = detectTeamFromEvent(e);
    if (!team || team === "ignore" || !allTeamIds.includes(team)) continue;

    const startStr = e.start?.dateTime || e.start?.date;
    const endStr = e.end?.dateTime || e.end?.date;
    if (!startStr || !endStr) continue;

    const s = DateTime.fromISO(startStr, { zone: TZ });
    const en = DateTime.fromISO(endStr, { zone: TZ });
    const dateKey = s.toISODate();
    const key = `${dateKey}|${team}`;

    if (!eventsByDayTeam.has(key)) eventsByDayTeam.set(key, []);
    eventsByDayTeam.get(key).push({
      id: e.id,
      summary: e.summary || "",
      startIso: s.toISO(),
      endIso: en.toISO(),
      startTime: s.toFormat("HH:mm:ss"),
      endTime: en.toFormat("HH:mm:ss"),
    });
  }

  // ── Disponibilidad de toda la semana, en batch ────────────────────────────
  const employees = await getActiveEmployeesLite();
  const empIds = employees.map((e) => e.id);

  const [weeklyAvail, extraAvail, timeOffs, exceptions] = await Promise.all([
    getWeeklyAvailabilityForEmployees(empIds),
    getExtraAvailabilityInRange(empIds, start.toISODate(), end.toISODate()),
    getTimeOffInRange(empIds, start.toISODate(), end.toISODate()),
    getExceptionsInRange(empIds, start.toISODate(), end.toISODate()),
  ]);

  const weeklyByEmpDay = new Map();
  for (const a of weeklyAvail) {
    const k = `${a.employee_id}|${a.day_of_week}`;
    if (!weeklyByEmpDay.has(k)) weeklyByEmpDay.set(k, []);
    weeklyByEmpDay.get(k).push(a);
  }
  const extraByEmpDate = new Map();
  for (const a of extraAvail) {
    const k = `${a.employee_id}|${a.date}`;
    if (!extraByEmpDate.has(k)) extraByEmpDate.set(k, []);
    extraByEmpDate.get(k).push(a);
  }
  const timeOffByEmp = new Map();
  for (const t of timeOffs) {
    if (!timeOffByEmp.has(t.employee_id)) timeOffByEmp.set(t.employee_id, []);
    timeOffByEmp.get(t.employee_id).push(t);
  }
  const exceptionsByEmpDate = new Map();
  for (const ex of exceptions) {
    const k = `${ex.employee_id}|${ex.exception_date}`;
    if (!exceptionsByEmpDate.has(k)) exceptionsByEmpDate.set(k, []);
    exceptionsByEmpDate.get(k).push(ex);
  }

  function isBlocked(empId, dateKey, startTime, endTime) {
    const offs = timeOffByEmp.get(empId) || [];
    if (offs.some((o) => o.start_date <= dateKey && o.end_date >= dateKey))
      return true;

    const excs = exceptionsByEmpDate.get(`${empId}|${dateKey}`) || [];
    return excs.some((ex) => {
      if (ex.all_day) return true;
      if (!ex.start_time || !ex.end_time) return false;
      return ex.start_time < endTime && ex.end_time > startTime; // overlap
    });
  }

  function isAvailableForEvent(empId, dateKey, dow, startTime, endTime) {
    if (isBlocked(empId, dateKey, startTime, endTime)) return false;

    const weekly = weeklyByEmpDay.get(`${empId}|${dow}`) || [];
    if (
      weekly.some((w) => covers(w.start_time, w.end_time, startTime, endTime))
    )
      return true;

    const extra = extraByEmpDate.get(`${empId}|${dateKey}`) || [];
    return extra.some((x) =>
      covers(x.start_time, x.end_time, startTime, endTime),
    );
  }

  function isAvailableForAllEvents(empId, dateKey, dow, dayTeamEvents) {
    return dayTeamEvents.every((ev) =>
      isAvailableForEvent(empId, dateKey, dow, ev.startTime, ev.endTime),
    );
  }

  // ── Formación de referencia (hasta 4 semanas atrás) ───────────────────────
  const referenceCache = new Map();

  async function getReferenceFormation(teamId, dateKey) {
    const cacheKey = `${teamId}|${dateKey}`;
    if (referenceCache.has(cacheKey)) return referenceCache.get(cacheKey);

    const candidateDates = Array.from({ length: LOOKBACK_WEEKS }, (_, i) =>
      DateTime.fromISO(dateKey, { zone: TZ })
        .minus({ weeks: i + 1 })
        .toISODate(),
    );

    const rows = await getTeamAssignmentsForDates(teamId, candidateDates);
    let result = null;
    for (const d of candidateDates) {
      const forDate = rows.filter((r) => r.date === d);
      if (forDate.length > 0) {
        result = {
          referenceDate: d,
          employees: forDate.map((r) => ({
            employee_id: r.employee_id,
            name: r.employees?.name ?? "—",
            is_team_leader: r.employees?.is_team_leader ?? false,
          })),
        };
        break;
      }
    }
    referenceCache.set(cacheKey, result);
    return result;
  }

  // ── Generar sugerencias día por día, team por team ───────────────────────
  const days = Array.from({ length: 7 }, (_, i) => start.plus({ days: i }));
  const results = [];

  // Prefetch en paralelo de las formaciones de referencia para todos los
  // pares (team, día) que tienen eventos. getReferenceFormation cachea por
  // `teamId|dateKey`, así que esto solo evita que las hasta ~21 consultas
  // corran una atrás de la otra; el loop de abajo las lee ya resueltas.
  const prefetchPairs = [];
  for (const day of days) {
    const dateKey = day.toISODate();
    for (const teamId of allTeamIds) {
      const dayTeamEvents = eventsByDayTeam.get(`${dateKey}|${teamId}`) || [];
      if (dayTeamEvents.length > 0) prefetchPairs.push({ teamId, dateKey });
    }
  }
  await Promise.all(
    prefetchPairs.map(({ teamId, dateKey }) =>
      getReferenceFormation(teamId, dateKey),
    ),
  );

  for (const day of days) {
    const dateKey = day.toISODate();
    const dow = day.weekday % 7; // luxon 1..7(lun..dom) → 0..6 estilo getDay() (0=dom)
    const usedToday = new Set();

    for (const teamId of allTeamIds) {
      const dayTeamEvents = eventsByDayTeam.get(`${dateKey}|${teamId}`) || [];
      if (dayTeamEvents.length === 0) continue; // sin eventos ese día → no hace falta formación

      const reference = await getReferenceFormation(teamId, dateKey);
      const manualReasons = [];
      let kept = [];
      let vacancies = [];
      let source;

      if (reference) {
        source = "reference";
        for (const refEmp of reference.employees) {
          const alreadyUsedToday = usedToday.has(refEmp.employee_id);
          if (
            !alreadyUsedToday &&
            isAvailableForAllEvents(
              refEmp.employee_id,
              dateKey,
              dow,
              dayTeamEvents,
            )
          ) {
            kept.push(refEmp);
            usedToday.add(refEmp.employee_id);
          } else {
            vacancies.push({
              previous_employee_id: refEmp.employee_id,
              previous_name: refEmp.name,
              reason: alreadyUsedToday
                ? "already_assigned_other_team"
                : "unavailable_for_event",
            });
          }
        }
        if (vacancies.length > 0) manualReasons.push("vacancy");
      } else {
        source = "fresh_build";
        const candidates = employees.filter(
          (e) =>
            !usedToday.has(e.id) &&
            isAvailableForAllEvents(e.id, dateKey, dow, dayTeamEvents),
        );
        const picked = candidates.slice(0, defaultTeamSize);
        kept = picked.map((e) => ({
          employee_id: e.id,
          name: e.name,
          is_team_leader: e.is_team_leader,
        }));
        picked.forEach((e) => usedToday.add(e.id));
        if (kept.length < defaultTeamSize)
          manualReasons.push("insufficient_coverage");
      }

      if (!kept.some((e) => e.is_team_leader))
        manualReasons.push("missing_team_leader");

      results.push({
        date: dateKey,
        team_id: teamId,
        source,
        referenceDate: reference?.referenceDate ?? null,
        events: dayTeamEvents.map((e) => ({
          id: e.id,
          summary: e.summary,
          startIso: e.startIso,
          endIso: e.endIso,
        })),
        kept,
        vacancies,
        needsManual: manualReasons.length > 0,
        manualReasons,
      });
    }
  }

  return {
    ok: true,
    weekStart: start.toISODate(),
    weekEnd: end.toISODate(),
    days: results,
  };
}

/**
 * Aplica las formaciones ya editadas/confirmadas por el admin. Por cada
 * (date, team_id) reemplaza por completo las filas existentes de
 * daily_team_assignments con la lista final de employee_ids.
 *
 * Además, sincroniza los "attendees" de cada evento de GCal ese día:
 *   - Eventos con equipo determinado por "#N" en el título → attendees =
 *     empleados confirmados para ese (date, team_id).
 *   - Eventos SIN equipo determinado → se asignan al "equipo libre" de ese
 *     día (el team configurado que no tiene ningún evento con "#N" ese día),
 *     se les taggea el título con withTeamTag() y se les setean los attendees
 *     correspondientes.
 *
 * @param {Array<{ date: string, team_id: string, employee_ids: string[] }>} assignments
 */
// Cuántas escrituras (date, team_id) corren en simultáneo contra Supabase.
// Cada assignment es independiente (date+team_id distintos), así que no hay
// riesgo de pisarse entre sí corriendo en paralelo.
const APPLY_CONCURRENCY = 8;

export async function applyWeeklyAssignments(assignments) {
  async function writeAssignment(a) {
    const { error: delError } = await supabase
      .from("daily_team_assignments")
      .delete()
      .eq("date", a.date)
      .eq("team_id", a.team_id);
    if (delError) throw delError;

    if (a.employee_ids?.length) {
      const rows = a.employee_ids.map((employee_id) => ({
        date: a.date,
        team_id: a.team_id,
        employee_id,
      }));
      const { error: insError } = await supabase
        .from("daily_team_assignments")
        .insert(rows);
      if (insError) throw insError;
    }

    return { date: a.date, team_id: a.team_id, ok: true };
  }

  const settled = await runWithConcurrency(
    assignments,
    APPLY_CONCURRENCY,
    writeAssignment,
  );

  const results = settled.map((r, i) =>
    r.status === "fulfilled"
      ? r.value
      : {
          date: assignments[i].date,
          team_id: assignments[i].team_id,
          ok: false,
          error: r.reason?.message ?? String(r.reason),
        },
  );

  const gcalResults = await syncAttendeesToGCal(assignments);

  return { ok: true, results, gcalResults };
}

// ─────────────────────────────────────────────────────────────────────────────
// Escribe attendees + tag de equipo en los eventos de GCal de la semana
// cubierta por `assignments`, agrupando por fecha para minimizar llamadas.
// ─────────────────────────────────────────────────────────────────────────────
async function syncAttendeesToGCal(assignments) {
  if (!assignments?.length) return [];

  await loadTeamsFromDB();
  const allTeamIds = getAllTeamIds();

  // date → Map(team_id → employee_ids[])
  const byDate = new Map();
  for (const a of assignments) {
    if (!byDate.has(a.date)) byDate.set(a.date, new Map());
    byDate.get(a.date).set(a.team_id, a.employee_ids ?? []);
  }
  const dates = [...byDate.keys()].sort();

  // Resolver empleados → email de una sola vez para toda la semana
  const allEmpIds = [
    ...new Set(assignments.flatMap((a) => a.employee_ids ?? [])),
  ];
  const empMap = new Map();
  if (allEmpIds.length) {
    const { data: emps, error } = await supabase
      .from("employees")
      .select("id, name, email, is_team_leader")
      .in("id", allEmpIds);
    if (error) {
      console.error(
        "[syncAttendeesToGCal] employees lookup error:",
        error.message,
      );
    } else {
      for (const e of emps ?? []) empMap.set(e.id, e);
    }
  }

  // employee_ids en el orden que espera syncAppointmentTeams (líder primero,
  // igual que el resto del sistema hace en appointment_teams.role).
  function employeeIdsForTeam(date, teamId) {
    const ids = byDate.get(date)?.get(teamId) ?? [];
    return [...ids].sort((a, b) => {
      const aLeader = empMap.get(a)?.is_team_leader ? 0 : 1;
      const bLeader = empMap.get(b)?.is_team_leader ? 0 : 1;
      return aLeader - bLeader;
    });
  }

  function attendeesForTeam(date, teamId) {
    const ids = byDate.get(date)?.get(teamId) ?? [];
    const missing = [];
    const attendees = ids.flatMap((id) => {
      const emp = empMap.get(id);
      if (!emp?.email) {
        missing.push(id);
        return [];
      }
      return [{ email: emp.email }];
    });
    if (missing.length) {
      console.warn(
        `[syncAttendeesToGCal] ${date}|${teamId}: sin email, no invitados:`,
        missing,
      );
    }
    return attendees;
  }

  const calendar = getCalendarClient();
  const calendarId = getCalendarId();

  // ── UNA sola llamada a GCal para toda la semana cubierta por `assignments` ──
  const rangeStart = DateTime.fromISO(dates[0], { zone: TZ }).startOf("day");
  const rangeEnd = DateTime.fromISO(dates[dates.length - 1], { zone: TZ }).plus(
    { days: 1 },
  );
  const toIso = (dt) => dt.toUTC().toISO({ suppressMilliseconds: true });

  let weekEvents;
  try {
    weekEvents = await listWeekEvents(
      calendar,
      calendarId,
      toIso(rangeStart),
      toIso(rangeEnd),
    );
  } catch (e) {
    return dates.map((date) => ({
      date,
      ok: false,
      error: `fetch events failed: ${e.message}`,
    }));
  }

  const eventsByDate = new Map();
  for (const e of weekEvents) {
    const startStr = e.start?.dateTime || e.start?.date;
    if (!startStr) continue;
    const dateKey = DateTime.fromISO(startStr, { zone: TZ }).toISODate();
    if (!eventsByDate.has(dateKey)) eventsByDate.set(dateKey, []);
    eventsByDate.get(dateKey).push(e);
  }

  const isLunch = isLunchEvent;

  // ── Fase 1: resolver en memoria el equipo de cada evento (sin red) ──────────
  const patchJobs = [];
  const skipped = [];
  const skippedNoop = [];

  for (const date of dates) {
    const teamMap = byDate.get(date);
    const dayEvents = eventsByDate.get(date) ?? [];

    const eventsByTeam = new Map(); // teamId → [{ startMs, endMs }]
    const determined = [];
    const undetermined = [];
    const lunches = [];

    for (const e of dayEvents) {
      const startStr = e.start?.dateTime || e.start?.date;
      const endStr = e.end?.dateTime || e.end?.date;
      if (!startStr || !endStr) {
        console.warn(
          `[syncAttendeesToGCal] ${date}: evento ${e.id} sin start/end, se ignora`,
        );
        continue;
      }
      const startMs = DateTime.fromISO(startStr, { zone: TZ }).toMillis();
      const endMs = DateTime.fromISO(endStr, { zone: TZ }).toMillis();
      const entry = { event: e, startMs, endMs };

      // "Lunch" tiene prioridad sobre cualquier clasificación de
      // detectTeamFromEvent — ese detector puede marcarlo como "ignore"
      // (no-servicio, no bloquea disponibilidad), pero acá SÍ queremos
      // asignarle equipo.
      if (isLunch(e.summary)) {
        lunches.push(entry);
        continue;
      }

      const { team } = detectTeamFromEvent(e);
      if (team === "ignore") continue; // no-servicio (Flamingo), no tocar

      if (team && allTeamIds.includes(team)) {
        determined.push({ ...entry, teamId: team });
        if (!eventsByTeam.has(team)) eventsByTeam.set(team, []);
        eventsByTeam.get(team).push({ startMs, endMs });
      } else {
        undetermined.push(entry);
      }
    }

    const resolvedTeamByEventId = new Map();
    for (const { event, teamId } of determined)
      resolvedTeamByEventId.set(event.id, teamId);

    // Eventos con "#N" en el título
    for (const { event, teamId } of determined) {
      if (!teamMap.has(teamId)) continue; // no vino en este batch → no tocar
      const attendees = attendeesForTeam(date, teamId);
      const job = {
        eventId: event.id,
        date,
        teamId,
        attendees,
        employeeIds: employeeIdsForTeam(date, teamId),
      };
      // Este branch nunca cambia el summary, solo attendees.
      if (attendeesUnchanged(event.attendees, attendees)) {
        skippedNoop.push(job);
      } else {
        patchJobs.push(job);
      }
    }

    // Eventos sin "#N" → equipo libre en ese horario puntual
    undetermined.sort((a, b) => a.startMs - b.startMs);
    for (const { event, startMs, endMs } of undetermined) {
      const candidates = allTeamIds.filter((t) => {
        const busy = eventsByTeam.get(t) ?? [];
        return !busy.some((b) => startMs < b.endMs && b.startMs < endMs);
      });

      let freeTeamId = null;
      if (candidates.length === 1) {
        freeTeamId = candidates[0];
      } else if (candidates.length > 1) {
        candidates.sort(
          (a, b) =>
            (eventsByTeam.get(a)?.length ?? 0) -
            (eventsByTeam.get(b)?.length ?? 0),
        );
        freeTeamId = candidates[0];
        console.warn(
          `[syncAttendeesToGCal] ${date} evento ${event.id}: ${candidates.length} equipos libres en ese horario (${candidates.join(", ")}) — se usa "${freeTeamId}".`,
        );
      }

      if (!freeTeamId) {
        skipped.push({
          date,
          eventId: event.id,
          teamId: null,
          ok: false,
          error:
            "Ambos equipos tienen conflicto en ese horario — requiere asignación manual",
        });
        continue;
      }

      resolvedTeamByEventId.set(event.id, freeTeamId);
      if (!eventsByTeam.has(freeTeamId)) eventsByTeam.set(freeTeamId, []);
      eventsByTeam.get(freeTeamId).push({ startMs, endMs });

      const newSummary = withTeamTag(event.summary || "", freeTeamId);
      const attendees = attendeesForTeam(date, freeTeamId);
      const colorId = getTeamColorId(freeTeamId);
      const job = {
        eventId: event.id,
        date,
        teamId: freeTeamId,
        summary: newSummary,
        colorId,
        attendees,
        employeeIds: employeeIdsForTeam(date, freeTeamId),
        autoTagged: true,
      };
      const summaryUnchanged = newSummary === (event.summary || "");
      const colorUnchanged =
        !colorId || String(event.colorId ?? "") === colorId;
      if (
        summaryUnchanged &&
        colorUnchanged &&
        attendeesUnchanged(event.attendees, attendees)
      ) {
        skippedNoop.push(job);
      } else {
        patchJobs.push(job);
      }
    }

    // "Lunch" → mismo equipo que el evento que le sigue enseguida (o el anterior si es el último del día)
    const others = [...determined, ...undetermined].sort(
      (a, b) => a.startMs - b.startMs,
    );
    for (const { event, startMs, endMs } of lunches) {
      const next = others.find(
        (o) => o.startMs >= endMs && resolvedTeamByEventId.has(o.event.id),
      );
      const prev = [...others]
        .reverse()
        .find(
          (o) => o.endMs <= startMs && resolvedTeamByEventId.has(o.event.id),
        );
      const teamId = next
        ? resolvedTeamByEventId.get(next.event.id)
        : prev
          ? resolvedTeamByEventId.get(prev.event.id)
          : null;

      if (!teamId) {
        skipped.push({
          date,
          eventId: event.id,
          teamId: null,
          ok: false,
          error:
            "No se pudo determinar el equipo del evento adyacente al lunch",
        });
        continue;
      }

      const newSummary = withTeamTag(event.summary || "", teamId);
      const attendees = attendeesForTeam(date, teamId);
      const colorId = getTeamColorId(teamId);
      const job = {
        eventId: event.id,
        date,
        teamId,
        summary: newSummary,
        colorId,
        attendees,
        employeeIds: employeeIdsForTeam(date, teamId),
        autoTagged: true,
        isLunch: true,
      };
      const summaryUnchanged = newSummary === (event.summary || "");
      const colorUnchanged =
        !colorId || String(event.colorId ?? "") === colorId;
      if (
        summaryUnchanged &&
        colorUnchanged &&
        attendeesUnchanged(event.attendees, attendees)
      ) {
        skippedNoop.push(job);
      } else {
        patchJobs.push(job);
      }
    }
  }

  const patchTelemetry = { totalRateLimitHits: 0 };

  async function patchWithRetry(params, retries = 4) {
    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        return await calendar.events.patch(params);
      } catch (e) {
        const isRateLimit =
          /rate limit/i.test(e.message) || e.code === 403 || e.code === 429;
        if (!isRateLimit || attempt === retries) throw e;
        patchTelemetry.totalRateLimitHits += 1;
        const backoffMs = 700 * (attempt + 1) + Math.random() * 500;
        await new Promise((r) => setTimeout(r, backoffMs));
      }
    }
  }

  // ── Fase 2: todos los patches a GCal en paralelo ─────────────────────────────
  // (LAB-233 perf) Antes: cada job encadenaba, DESPUÉS de su patch, un
  // syncAppointmentTeams individual (select+delete+insert por evento) dentro
  // del propio worker → esos 3 round-trips a Supabase se serializaban con la
  // llamada a GCal y multiplicaban por N eventos. Ahora el patch a GCal SOLO
  // patchea, y el write a appointment_teams se hace en un batch único después
  // (fase 3), 3 round-trips totales sin importar cuántos eventos haya.
  const CONCURRENCY = 8; // ajustar si sigue habiendo rate limit, o si vemos que 5 es muy conservador
  const patchPhaseStart = Date.now();
  const patched = await runWithConcurrency(patchJobs, CONCURRENCY, (job) =>
    patchWithRetry({
      calendarId,
      eventId: job.eventId,
      requestBody: {
        ...(job.summary ? { summary: job.summary } : {}),
        ...(job.colorId ? { colorId: job.colorId } : {}),
        attendees: job.attendees,
      },
      sendUpdates: "none",
    }),
  );

  console.log(
    `[syncAttendeesToGCal] ${patchJobs.length} patches reales, ` +
      `${skippedNoop.length} sin cambios (omitidos), ` +
      `${patchTelemetry.totalRateLimitHits} rate-limit hits, ` +
      `${Date.now() - patchPhaseStart}ms total`,
  );

  // ── Fase 3: appointment_teams en UN batch para todos los patches OK ──────────
  const successfulJobs = patchJobs
    .filter((_job, i) => patched[i].status === "fulfilled")
    .concat(skippedNoop);
  if (successfulJobs.length) {
    try {
      await syncAppointmentTeamsBatch(
        successfulJobs.map((job) => ({
          gcalEventId: job.eventId,
          employeeIds: job.employeeIds,
        })),
      );
    } catch (e) {
      console.warn(
        "[syncAttendeesToGCal] syncAppointmentTeamsBatch falló — appointment_teams puede quedar desactualizado:",
        e.message,
      );
    }
  }

  const results = patched.map((r, i) => {
    const job = patchJobs[i];
    return r.status === "fulfilled"
      ? {
          date: job.date,
          eventId: job.eventId,
          teamId: job.teamId,
          ok: true,
          autoTagged: job.autoTagged,
          isLunch: job.isLunch,
        }
      : {
          date: job.date,
          eventId: job.eventId,
          teamId: job.teamId,
          ok: false,
          error: r.reason?.message ?? String(r.reason),
        };
  });

  const noopResults = skippedNoop.map((job) => ({
    date: job.date,
    eventId: job.eventId,
    teamId: job.teamId,
    ok: true,
    autoTagged: job.autoTagged,
    isLunch: job.isLunch,
    skippedNoChange: true,
  }));

  return [...results, ...noopResults, ...skipped];
}
