// services/teamAutoAssignService.js
//
// REIMPLEMENTADO para el MVP Standalone (Demo Cleaning Co.) — sin Google Calendar.
//
// Portado del teamAutoAssignService.js original de Monkey Cleaning (que fue
// eliminado en la Fase 2 por depender 100% de la API de GCal). Cambios respecto
// del original:
//   - listWeekEvents(calendar, ...) (GCal)  →  query directa a `appointments`.
//   - detectTeamFromEvent(e)                →  detectTeam(row) de calendarController.
//   - syncAttendeesToGCal(...) (patches a GCal + rate-limit + backoff)
//                                          →  syncTeamsToAppointments(...): escribe
//                                             appointment_teams (vía
//                                             syncAppointmentTeams) y taggea el
//                                             turno (gcal_summary / color_id /
//                                             team_id) para los auto-asignados.
//
// TODA la lógica de disponibilidad (covers / isBlocked / isAvailableForEvent),
// la formación de referencia (últimas 4 semanas) y el fresh_build se portan
// sin cambios — ya eran Supabase puro.

import { DateTime } from "luxon";
import { supabase } from "../supabaseClient.js";
import {
  initTeamsConfig,
  TEAMS_CONFIG,
  detectTeam,
  syncAppointmentTeams,
} from "../controllers/calendarController.js";
import { getTeamColorId, isLunchEvent } from "./eventClassification.js";
import {
  getActiveEmployeesLite,
  getWeeklyAvailabilityForEmployees,
  getExtraAvailabilityInRange,
  getTimeOffInRange,
  getExceptionsInRange,
  getTeamAssignmentsForDates,
  getTeamDefaultSize,
} from "./supabaseService.js";

const TZ = process.env.BOOKING_TIMEZONE || "America/Vancouver";
const LOOKBACK_WEEKS = 4;

// ── withTeamTag — copia de calendarController.js (mantener sincronizado) ─────
function withTeamTag(summary, teamId) {
  if (!teamId) return summary;
  const m = teamId.match(/team_(\d+)/);
  if (!m) return summary;
  const num = m[1];
  if (/#\s*\d+/.test(summary || "")) {
    return (summary || "").replace(/#\s*\d+/, `#${num}`);
  }
  return `${summary || ""} #${num}`.trim();
}

// ── Runner con concurrencia limitada ───────────────────────────────────────
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

// true si [availStart,availEnd) cubre completamente [needStart,needEnd).
// Comparación de strings "HH:MM:SS" — válido porque el formato es fijo/zero-padded.
function covers(availStart, availEnd, needStart, needEnd) {
  return availStart <= needStart && availEnd >= needEnd;
}

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/admin/staff/team-assignments/auto-suggestions
//
// Genera, para cada día de [weekStart, weekStart+7) y cada team activo con
// turnos ese día, una formación sugerida (solo lectura — no escribe nada).
// ─────────────────────────────────────────────────────────────────────────────
export async function generateWeeklySuggestions({ weekStart }) {
  await initTeamsConfig();
  const allTeamIds = Object.keys(TEAMS_CONFIG);

  const start = DateTime.fromISO(weekStart, { zone: TZ }).startOf("day");
  const end = start.plus({ days: 7 });

  // ── Turnos de la semana, directo de Supabase ─────────────────────────────
  const { data: appts, error: apptErr } = await supabase
    .from("appointments")
    .select("id, gcal_summary, color_id, team_id, starts_at, ends_at, status")
    .gte("starts_at", start.toUTC().toISO())
    .lt("starts_at", end.toUTC().toISO())
    .neq("status", "cancelled");
  if (apptErr) throw apptErr;

  // ── Agrupar turnos por día+team ─────────────────────────────────────────
  const eventsByDayTeam = new Map(); // `${dateKey}|${teamId}` → events[]
  for (const row of appts ?? []) {
    // Lunch no genera formación propia — se resuelve en el apply (adyacencia).
    if (isLunchEvent(row.gcal_summary)) continue;

    const team = detectTeam(row); // null si no-servicio / pending-confirm / individual
    if (!team || !allTeamIds.includes(team)) continue;
    if (!row.starts_at || !row.ends_at) continue;

    const s = DateTime.fromISO(row.starts_at, { zone: TZ });
    const en = DateTime.fromISO(row.ends_at, { zone: TZ });
    const dateKey = s.toISODate();
    const key = `${dateKey}|${team}`;

    if (!eventsByDayTeam.has(key)) eventsByDayTeam.set(key, []);
    eventsByDayTeam.get(key).push({
      id: row.id,
      summary: row.gcal_summary || "",
      startIso: s.toISO(),
      endIso: en.toISO(),
      startTime: s.toFormat("HH:mm:ss"),
      endTime: en.toFormat("HH:mm:ss"),
    });
  }

  // Solo se usa cuando no hay formación de referencia en las últimas 4 semanas.
  const defaultTeamSize = await getTeamDefaultSize();

  // ── Disponibilidad de toda la semana, en batch ───────────────────────────
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

  // ── Formación de referencia (hasta 4 semanas atrás) ──────────────────────
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
      if (dayTeamEvents.length === 0) continue;

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

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/admin/staff/team-assignments/auto-apply
//
// assignments: [{ date, team_id, employee_ids: string[] }]
//
// 1. Reemplaza por completo las filas de daily_team_assignments de cada
//    (date, team_id).
// 2. Propaga a appointment_teams: por cada turno de esos días cuyo equipo
//    (detectTeam) esté en el batch, reescribe sus cleaners. Los turnos sin
//    equipo determinado se asignan al equipo libre de ese horario y se les
//    taggea título/color/team_id; los "Lunch" heredan el equipo del turno
//    adyacente.
// ─────────────────────────────────────────────────────────────────────────────
const APPLY_CONCURRENCY = 8;

export async function applyWeeklyAssignments(assignments) {
  // ── 1. daily_team_assignments ───────────────────────────────────────────
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

  // ── 2. appointment_teams ───────────────────────────────────────────────
  let appointmentSync = [];
  try {
    appointmentSync = await syncTeamsToAppointments(assignments);
  } catch (e) {
    console.warn(
      "[applyWeeklyAssignments] syncTeamsToAppointments falló — appointment_teams puede quedar desactualizado:",
      e.message,
    );
  }

  return { ok: true, results, appointmentSync };
}

// ─────────────────────────────────────────────────────────────────────────────
// Reemplazo standalone de syncAttendeesToGCal: en vez de patchear eventos de
// Google, escribe appointment_teams y taggea la fila de appointments.
// ─────────────────────────────────────────────────────────────────────────────
async function syncTeamsToAppointments(assignments) {
  if (!assignments?.length) return [];
  await initTeamsConfig();
  const allTeamIds = Object.keys(TEAMS_CONFIG);

  // date → Map(team_id → employee_ids[])
  const byDate = new Map();
  for (const a of assignments) {
    if (!byDate.has(a.date)) byDate.set(a.date, new Map());
    byDate.get(a.date).set(a.team_id, a.employee_ids ?? []);
  }
  const dates = [...byDate.keys()].sort();

  // Resolver is_team_leader de todos los empleados involucrados (para ordenar
  // líder primero, igual que hace syncAppointmentTeams con el role).
  const allEmpIds = [
    ...new Set(assignments.flatMap((a) => a.employee_ids ?? [])),
  ];
  const leaderById = new Map();
  if (allEmpIds.length) {
    const { data: emps, error } = await supabase
      .from("employees")
      .select("id, is_team_leader")
      .in("id", allEmpIds);
    if (error) {
      console.error("[syncTeamsToAppointments] employees lookup:", error.message);
    } else {
      for (const e of emps ?? []) leaderById.set(e.id, !!e.is_team_leader);
    }
  }

  function employeeIdsForTeam(date, teamId) {
    const ids = byDate.get(date)?.get(teamId) ?? [];
    return [...ids].sort(
      (a, b) => (leaderById.get(a) ? 0 : 1) - (leaderById.get(b) ? 0 : 1),
    );
  }

  // ── Turnos de la semana cubierta ───────────────────────────────────────
  const rangeStart = DateTime.fromISO(dates[0], { zone: TZ }).startOf("day");
  const rangeEnd = DateTime.fromISO(dates[dates.length - 1], { zone: TZ }).plus({
    days: 1,
  });
  const { data: appts, error: apptErr } = await supabase
    .from("appointments")
    .select("id, gcal_summary, color_id, team_id, starts_at, ends_at, status")
    .gte("starts_at", rangeStart.toUTC().toISO())
    .lt("starts_at", rangeEnd.toUTC().toISO())
    .neq("status", "cancelled");
  if (apptErr) throw apptErr;

  const apptsByDate = new Map();
  for (const row of appts ?? []) {
    if (!row.starts_at) continue;
    const dateKey = DateTime.fromISO(row.starts_at, { zone: TZ }).toISODate();
    if (!apptsByDate.has(dateKey)) apptsByDate.set(dateKey, []);
    apptsByDate.get(dateKey).push(row);
  }

  // ── Resolver, por día, el equipo de cada turno ─────────────────────────
  const jobs = []; // { apptId, date, teamId, tag?: {summary,colorId} }
  const skipped = [];

  for (const date of dates) {
    const teamMap = byDate.get(date);
    const dayAppts = apptsByDate.get(date) ?? [];

    const eventsByTeam = new Map(); // teamId → [{ startMs, endMs }]
    const determined = [];
    const undetermined = [];
    const lunches = [];

    for (const row of dayAppts) {
      if (!row.starts_at || !row.ends_at) continue;
      const startMs = DateTime.fromISO(row.starts_at, { zone: TZ }).toMillis();
      const endMs = DateTime.fromISO(row.ends_at, { zone: TZ }).toMillis();
      const entry = { row, startMs, endMs };

      if (isLunchEvent(row.gcal_summary)) {
        lunches.push(entry);
        continue;
      }
      const team = detectTeam(row);
      if (!team) continue; // no-servicio / pending-confirm / individual → no tocar

      if (allTeamIds.includes(team)) {
        determined.push({ ...entry, teamId: team });
        if (!eventsByTeam.has(team)) eventsByTeam.set(team, []);
        eventsByTeam.get(team).push({ startMs, endMs });
      } else {
        undetermined.push(entry);
      }
    }

    const resolvedTeamByApptId = new Map();
    for (const { row, teamId } of determined)
      resolvedTeamByApptId.set(row.id, teamId);

    // Turnos con equipo determinado (color / "#N")
    for (const { row, teamId } of determined) {
      if (!teamMap.has(teamId)) continue; // ese team no vino en el batch → no tocar
      jobs.push({ apptId: row.id, date, teamId });
    }

    // Turnos SIN equipo → equipo libre en ese horario puntual
    undetermined.sort((a, b) => a.startMs - b.startMs);
    for (const { row, startMs, endMs } of undetermined) {
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
      }
      if (!freeTeamId || !teamMap.has(freeTeamId)) {
        skipped.push({
          date,
          apptId: row.id,
          teamId: null,
          ok: false,
          error: "sin equipo libre en ese horario — requiere asignación manual",
        });
        continue;
      }
      resolvedTeamByApptId.set(row.id, freeTeamId);
      if (!eventsByTeam.has(freeTeamId)) eventsByTeam.set(freeTeamId, []);
      eventsByTeam.get(freeTeamId).push({ startMs, endMs });
      jobs.push({
        apptId: row.id,
        date,
        teamId: freeTeamId,
        tag: {
          summary: withTeamTag(row.gcal_summary || "", freeTeamId),
          colorId: getTeamColorId(freeTeamId, TEAMS_CONFIG),
        },
      });
    }

    // "Lunch" → equipo del turno adyacente (siguiente, o anterior si es el último)
    const others = [...determined, ...undetermined].sort(
      (a, b) => a.startMs - b.startMs,
    );
    for (const { row, startMs, endMs } of lunches) {
      const next = others.find(
        (o) => o.startMs >= endMs && resolvedTeamByApptId.has(o.row.id),
      );
      const prev = [...others]
        .reverse()
        .find((o) => o.endMs <= startMs && resolvedTeamByApptId.has(o.row.id));
      const teamId = next
        ? resolvedTeamByApptId.get(next.row.id)
        : prev
          ? resolvedTeamByApptId.get(prev.row.id)
          : null;
      if (!teamId || !teamMap.has(teamId)) {
        skipped.push({
          date,
          apptId: row.id,
          teamId: null,
          ok: false,
          error: "no se pudo determinar el equipo del turno adyacente al lunch",
        });
        continue;
      }
      jobs.push({
        apptId: row.id,
        date,
        teamId,
        tag: {
          summary: withTeamTag(row.gcal_summary || "", teamId),
          colorId: getTeamColorId(teamId, TEAMS_CONFIG),
        },
      });
    }
  }

  // ── Ejecutar los jobs ──────────────────────────────────────────────────
  const settled = await runWithConcurrency(jobs, APPLY_CONCURRENCY, async (job) => {
    if (job.tag) {
      const patch = { team_id: job.teamId };
      if (job.tag.summary) patch.gcal_summary = job.tag.summary;
      if (job.tag.colorId) patch.color_id = job.tag.colorId;
      const { error } = await supabase
        .from("appointments")
        .update({ ...patch, updated_at: new Date().toISOString() })
        .eq("id", job.apptId);
      if (error) throw error;
    }
    await syncAppointmentTeams(
      job.apptId,
      employeeIdsForTeam(job.date, job.teamId),
    );
    return { date: job.date, apptId: job.apptId, teamId: job.teamId, ok: true };
  });

  const jobResults = settled.map((r, i) =>
    r.status === "fulfilled"
      ? r.value
      : {
          date: jobs[i].date,
          apptId: jobs[i].apptId,
          teamId: jobs[i].teamId,
          ok: false,
          error: r.reason?.message ?? String(r.reason),
        },
  );

  return [...jobResults, ...skipped];
}
