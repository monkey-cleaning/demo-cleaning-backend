// controllers/calendarController.js
//
// REESCRITO para el MVP Standalone (Demo Cleaning Co.) — sin Google Calendar.
// appointments es la ÚNICA fuente de verdad. Se eliminó por completo:
//   - la capa de cache (calendarCache.js), syncToken, prefetching, debounce
//     (mapWithConcurrency/inFlightFetches) — existían para paliar latencia/
//     rate-limits de la API externa, que ya no existe.
//   - fetchFromGCal/fetchIncremental y todo el flujo de sync
//     appointments-como-espejo-de-Google.
// Recurrencia: instancias materializadas (una fila por ocurrencia) usando
// recurrenceService.js (rrule.js) en vez de calendar.events.instances().
// Los 3 scopes (single/all/following) se resuelven contra series_id/
// is_series_master, ya no contra el DTSTART real que devolvía Google.
//
// Lo que SÍ se mantiene casi sin cambios (ya era lógica de negocio pura,
// no dependía de la API): findLunchMinutesBetween ya no puede leer del
// cache mensual de GCal — se simplificó a consultar appointments
// directamente (ver más abajo). getConflictsForEvent/getAvailableStaff
// siguen prácticamente iguales, solo cambia la clave de búsqueda
// (appointments.id en vez de google_calendar_event_id).

import { supabase } from "../supabaseClient.js";
import { getOperationalSettings } from "../services/settingsService.js";
import { getTravelTimeMinutes } from "../services/distanceService.js";
import { DateTime } from "luxon";
import {
  serializeRecurrence,
  deserializeRecurrence,
  expandRecurrenceDates,
  extractFreqInterval,
} from "../services/recurrenceService.js";
import {
  sendUrgentAssignmentEmail,
  sendCancellationEmail,
  sanitizeNotes,
  DIGEST_CUTOFF_HOUR,
} from "../services/employeeNotificationService.js";
import {
  findTeamOverlaps,
  findOverCapacity,
} from "../services/conflictDetection.js";
import {
  isNonServiceEventRow,
  isPendingConfirmationRow,
  detectTeamByColorRow,
  isIndividualAssignmentRow,
  loadClassificationConfig,
  isLunchEventSummary,
} from "../services/eventClassification.js";

const TZ = process.env.BOOKING_TIMEZONE || "America/Vancouver";

// ── Teams config — igual que antes, sin cambios (ya leía de DB) ─────────────
let TEAMS_CONFIG = {};

export async function initTeamsConfig() {
  const teamsTable = process.env.TEAMS_TABLE_NAME || "teams";
  const { data, error } = await supabase
    .from(teamsTable)
    .select("id, label, color, color_ids, emojis, none_color")
    .eq("is_active", true);

  if (error || !data?.length) {
    console.warn(
      "⚠️ No se pudo cargar teams desde DB, usando fallback hardcodeado.",
      error?.message,
    );
    TEAMS_CONFIG = {
      team_1: {
        colorIds: ["10"],
        emojis: ["🟢"],
        noneColor: false,
        label: "Team 1",
        color: "#0b8043",
      },
      team_2: {
        colorIds: ["3"],
        emojis: ["🟣"],
        noneColor: false,
        label: "Team 2",
        color: "#7b2d8b",
      },
      team_3: {
        colorIds: [],
        emojis: [],
        noneColor: false,
        label: "Team 3",
        color: "#f5511d",
      },
    };
    return;
  }

  TEAMS_CONFIG = Object.fromEntries(
    data.map((t) => [
      t.id,
      {
        label: t.label,
        color: t.color,
        colorIds: t.color_ids ?? [],
        emojis: t.emojis ?? [],
        noneColor: t.none_color ?? false,
      },
    ]),
  );
  console.log("✅ TEAMS_CONFIG cargado desde DB:", Object.keys(TEAMS_CONFIG));
}

// ── Team membership: email → teamId — igual que antes, sin cambios ─────────
let TEAM_MEMBERS_MAP = {};

export async function initTeamMembersMap(date = null) {
  const targetDate = date ?? DateTime.now().setZone(TZ).toISODate();
  const { data, error } = await supabase
    .from("daily_team_assignments")
    .select("team_id, employees(email)")
    .eq("date", targetDate);

  if (error) {
    console.warn(
      "⚠️ No se pudo cargar TEAM_MEMBERS_MAP desde DB:",
      error.message,
    );
    return;
  }

  TEAM_MEMBERS_MAP = {};
  for (const row of data ?? []) {
    const email = row.employees?.email?.toLowerCase();
    if (email) TEAM_MEMBERS_MAP[email] = row.team_id;
  }
}

initTeamsConfig();
initTeamMembersMap();
loadClassificationConfig();

function colorIdForTeam(teamId) {
  return TEAMS_CONFIG[teamId]?.colorIds?.[0] ?? null;
}

const GCAL_COLOR_HEX = {
  1: "#7986cb",
  2: "#33b679",
  3: "#8e24aa",
  4: "#e67c73",
  5: "#f6bf26",
  6: "#f5511d",
  7: "#039be5",
  8: "#616161",
  9: "#3f51b5",
  10: "#0b8043",
  11: "#d60000",
};

function teamIdFromColorId(colorId) {
  return colorId
    ? (Object.keys(TEAMS_CONFIG).find((tid) =>
        TEAMS_CONFIG[tid]?.colorIds?.includes(String(colorId)),
      ) ?? null)
    : null;
}

// ── detectTeam: ahora recibe una FILA de appointments, no un evento GCal ───
// eventClassification.js tiene las variantes "Row" que leen color_id /
// gcal_summary / special_instructions de la fila en vez de e.colorId /
// e.summary / e.description del objeto de Google.
//
// Fallback a row.team_id: bookAvailability() (booking público, 2.6) y
// confirmationPairingJob.js (2.3) asignan team_id directo — nunca pasan por
// un color picker, así que su color_id siempre queda NULL. Sin este
// fallback, detectTeamByColorRow devuelve null para esos turnos y
// aparecían "sin equipo" en cualquier vista que dependa de detectTeam().
export function detectTeam(row) {
  if (
    isNonServiceEventRow(row) ||
    isPendingConfirmationRow(row) ||
    isIndividualAssignmentRow(row)
  )
    return null;
  return detectTeamByColorRow(row, TEAMS_CONFIG) ?? row.team_id ?? null;
}

export { isPendingConfirmationRow as isPendingConfirmation };

// ── withTeamTag: se mantiene igual (agrega "#N" al título si falta) ────────
function withTeamTag(summary, teamId) {
  if (!teamId) return summary;
  const m = teamId.match(/team_(\d+)/);
  if (!m) return summary;
  const num = m[1];
  if (/#\s*\d+/.test(summary || "")) {
    return summary.replace(/#\s*\d+/, `#${num}`);
  }
  return `${summary || ""} #${num}`.trim();
}

// ── Notificaciones — ahora reciben una FILA de appointments + la lista de
// empleados asignados (de appointment_teams), no attendees de GCal.
async function notifyUrgentAssignmentIfNeeded(
  apptRow,
  assignedEmployees,
  changeMap = new Map(),
) {
  if (isNonServiceEventRow(apptRow)) return;
  if (!apptRow.starts_at || !assignedEmployees?.length) return;

  const nowVan = DateTime.now().setZone(TZ);
  const apptStart = DateTime.fromISO(apptRow.starts_at, { zone: TZ });
  const isToday = apptStart.toISODate() === nowVan.toISODate();
  const pastDigestCutoff = nowVan.hour >= DIGEST_CUTOFF_HOUR;
  if (!isToday || !pastDigestCutoff) return;

  const notes = sanitizeNotes(apptRow.special_instructions);
  const endIso = apptRow.ends_at;

  await Promise.all(
    assignedEmployees.map((emp) => {
      const change = changeMap.get(emp.email?.toLowerCase()) || {};
      const task = {
        startTime: apptStart.toFormat("h:mm a"),
        endTime: endIso
          ? DateTime.fromISO(endIso, { zone: TZ }).toFormat("h:mm a")
          : null,
        summary: apptRow.gcal_summary || "Cleaning service",
        address: apptRow.property_address || "",
        notes,
        changeType: change.changeType,
        previousTimeLabel: change.previousTimeLabel,
      };
      return sendUrgentAssignmentEmail(emp, task);
    }),
  );
}

async function notifyCancellationIfNeeded(apptRow, assignedEmployees) {
  if (isNonServiceEventRow(apptRow)) return;
  if (!apptRow.starts_at || !assignedEmployees?.length) return;

  const nowVan = DateTime.now().setZone(TZ);
  const apptStart = DateTime.fromISO(apptRow.starts_at, { zone: TZ });
  const isToday = apptStart.toISODate() === nowVan.toISODate();
  const pastDigestCutoff = nowVan.hour >= DIGEST_CUTOFF_HOUR;
  if (!isToday || !pastDigestCutoff) return;

  const task = {
    startTime: apptStart.toFormat("h:mm a"),
    endTime: apptRow.ends_at
      ? DateTime.fromISO(apptRow.ends_at, { zone: TZ }).toFormat("h:mm a")
      : null,
    summary: apptRow.gcal_summary || "Cleaning service",
    address: apptRow.property_address || "",
  };
  await Promise.all(
    assignedEmployees.map((emp) => sendCancellationEmail(emp, task)),
  );
}

// ── releaseConfirmationSlotIfOffered — ahora por appointment_id, no por
// google_calendar_event_id (ver migración: confirmation_slots.appointment_id
// ya existía, se usa esa relación en vez de la FK removida). ───────────────
async function releaseConfirmationSlotIfOffered(appointmentIds) {
  const ids = Array.isArray(appointmentIds) ? appointmentIds : [appointmentIds];
  if (!ids.length) return;
  try {
    const { data, error } = await supabase
      .from("confirmation_slots")
      .update({ status: "released", resolved_at: new Date().toISOString() })
      .in("appointment_id", ids)
      .eq("status", "offered")
      .select("id");
    if (error) {
      console.error("⚠️  releaseConfirmationSlotIfOffered:", error.message);
      return;
    }
    if (data?.length) {
      console.log(`♻️  [ConfirmationSlot] ${data.length} slot(s) released.`);
    }
  } catch (e) {
    console.error("⚠️  releaseConfirmationSlotIfOffered failed:", e.message);
  }
}

// ── mapRow: fila de appointments → shape que consume el Frontend ───────────
// Reemplaza a mapEvent(). Mismo shape de salida (misma forma que ya
// esperaba AdminCalendarPage.tsx / useOperationalData.ts) para minimizar
// cambios del lado del Frontend.
function mapRow(row, assignedCleanerNames = []) {
  const start = DateTime.fromISO(row.starts_at, { zone: TZ });
  const end = DateTime.fromISO(row.ends_at, { zone: TZ });
  const teamId = detectTeam(row);
  const teamCfg = teamId ? TEAMS_CONFIG[teamId] : null;

  return {
    id: row.id,
    summary: row.gcal_summary || "(No title)",
    isNonService: isNonServiceEventRow(row),
    isIndividualAssignment: isIndividualAssignmentRow(row),
    description: row.special_instructions || null,
    location: row.property_address || null,
    colorId: row.color_id || null,
    color: GCAL_COLOR_HEX[String(row.color_id)] ?? "#6b7280",
    teamId,
    teamLabel: teamCfg?.label || null,
    assignedCleaners: assignedCleanerNames,
    isAllDay: false,
    startIso: start.toISO(),
    endIso: end.toISO(),
    startDate: start.toISODate(),
    startHour: start.hour + start.minute / 60,
    endHour: end.hour + end.minute / 60,
    durationH: end.diff(start, "hours").hours,
    clientId: row.client_id ?? null,
    // seriesId reemplaza a recurringEventId — apunta al maestro de la serie
    // (o es igual a row.id si esta fila ES el maestro).
    seriesId: row.series_id ?? null,
    isSeriesMaster: row.is_series_master ?? false,
    recurrence: row.recurrence_rule
      ? deserializeRecurrence(row.recurrence_rule)
      : null,
    createdIso: row.created_at || null,
    confirmationStatus: row.confirmationStatus ?? null, // adjuntado por el caller
  };
}

// ── Helper: nombres de cleaners asignados a un appointment (appointment_teams) ─
async function getAssignedEmployeesForAppointments(appointmentIds) {
  if (!appointmentIds.length) return new Map();
  const { data, error } = await supabase
    .from("appointment_teams")
    .select("appointment_id, employees(id, name, email)")
    .in("appointment_id", appointmentIds);
  if (error) {
    console.error("⚠️ getAssignedEmployeesForAppointments:", error.message);
    return new Map();
  }
  const map = new Map();
  for (const row of data ?? []) {
    if (!row.employees) continue;
    if (!map.has(row.appointment_id)) map.set(row.appointment_id, []);
    map.get(row.appointment_id).push(row.employees);
  }
  return map;
}

// ── syncAppointmentTeams / syncAppointmentTeamsBatch — sin cambios de fondo,
// solo ya no dependen de resolver google_calendar_event_id → id primero
// (ahora el id que llega YA es el id de appointments). ─────────────────────
export async function syncAppointmentTeams(appointmentId, employeeIds = []) {
  await supabase
    .from("appointment_teams")
    .delete()
    .eq("appointment_id", appointmentId);

  if (!employeeIds.length) return;

  const rows = employeeIds.map((empId, idx) => ({
    appointment_id: appointmentId,
    employee_id: empId,
    role: idx === 0 ? "leader" : "member",
  }));
  const { error } = await supabase.from("appointment_teams").insert(rows);
  if (error)
    console.error("⚠️  syncAppointmentTeams insert error:", error.message);
}

async function syncDailyTeamAssignments(apptRow, resolvedTeamId, employeeIds) {
  if (!resolvedTeamId || !employeeIds?.length) return [];
  const date = DateTime.fromISO(apptRow.starts_at, { zone: TZ }).toISODate();

  const { data: employees, error: empErr } = await supabase
    .from("employees")
    .select("id, email")
    .in("id", employeeIds);
  if (empErr || !employees?.length) return [];

  for (const emp of employees) {
    const { data: existing } = await supabase
      .from("daily_team_assignments")
      .select("id, team_id")
      .eq("date", date)
      .eq("employee_id", emp.id)
      .maybeSingle();

    if (existing) {
      if (existing.team_id === resolvedTeamId) continue;
      await supabase
        .from("daily_team_assignments")
        .delete()
        .eq("id", existing.id);
    }
    await supabase
      .from("daily_team_assignments")
      .insert({ date, team_id: resolvedTeamId, employee_id: emp.id });
  }
  return employees.map((e) => e.id);
}

// ─────────────────────────────────────────────────────────────────────────
// GET /api/calendar/events?timeMin=&timeMax=
// Reemplaza a getEventsForMonth + fetchFromGCal + cache. Consulta directa,
// sin cache — Supabase es lo suficientemente rápido para el volumen de un
// MVP demo; si hiciera falta paginar/cachear en el futuro, se agrega acá.
// ─────────────────────────────────────────────────────────────────────────
// ── getEventsForRange: helper plano (sin req/res) que devuelve los eventos
// mapeados para un rango [timeMin, timeMax). Extraído de getCalendarEvents
// para que otros controllers (dashboardController.js) puedan reusar la
// misma query/mapeo sin pegarle a la ruta HTTP. Reemplaza a la vieja
// getEventsForMonth(year, month), que leía del cache mensual de GCal.
export async function getEventsForRange(timeMin, timeMax) {
  const { data: rows, error } = await supabase
    .from("appointments")
    .select("*")
    .neq("status", "cancelled")
    .gte("starts_at", timeMin)
    .lt("starts_at", timeMax)
    .order("starts_at");

  if (error) throw error;

  const apptIds = (rows ?? []).map((r) => r.id);
  const [cleanersByAppt, slotsByAppt] = await Promise.all([
    getAssignedEmployeesForAppointments(apptIds),
    getConfirmationStatusByAppointment(apptIds),
  ]);

  return (rows ?? []).map((row) =>
    mapRow(
      { ...row, confirmationStatus: slotsByAppt.get(row.id) ?? null },
      (cleanersByAppt.get(row.id) ?? []).map((e) => e.name),
    ),
  );
}

export async function getCalendarEvents(req, res) {
  try {
    const { timeMin, timeMax } = req.query;
    if (!timeMin || !timeMax) {
      return res
        .status(400)
        .json({ error: "timeMin and timeMax are required" });
    }
    const events = await getEventsForRange(timeMin, timeMax);
    return res.json({ ok: true, events, tz: TZ });
  } catch (e) {
    console.error("❌ getCalendarEvents:", e.message);
    return res.status(500).json({ ok: false, error: e.message });
  }
}
async function getConfirmationStatusByAppointment(appointmentIds) {
  if (!appointmentIds.length) return new Map();
  const { data, error } = await supabase
    .from("confirmation_slots")
    .select("appointment_id, status")
    .in("appointment_id", appointmentIds);
  if (error) return new Map();
  return new Map((data ?? []).map((s) => [s.appointment_id, s.status]));
}

// ─────────────────────────────────────────────────────────────────────────
// Helper: materializa las instancias de una serie recurrente en appointments.
// Reemplaza a syncRecurringSeries (que le pedía a Google events.instances()).
// La primera instancia = la fila maestro ya insertada (masterRow); esta
// función inserta el RESTO de las ocurrencias como filas nuevas con
// series_id = masterRow.id.
//
// Mismo criterio que el original: el equipo asignado (employeeIds) solo se
// aplica a la primera ocurrencia — el resto queda sin asignar para
// AssignModal/auto-assign, ya que los cleaners de una visita futura pueden
// no ser los mismos.
// ─────────────────────────────────────────────────────────────────────────
async function materializeSeries(masterRow, recurrence, baseFields) {
  const dates = expandRecurrenceDates(recurrence, masterRow.starts_at);
  // dates[0] corresponde a la primera ocurrencia = masterRow, ya insertada.
  const rest = dates.slice(1);
  if (!rest.length) return [masterRow];

  const durationMs =
    DateTime.fromISO(masterRow.ends_at).toMillis() -
    DateTime.fromISO(masterRow.starts_at).toMillis();

  const rows = rest.map((date) => {
    const startsAt = DateTime.fromJSDate(date).toUTC().toISO();
    const endsAt = DateTime.fromJSDate(date)
      .toUTC()
      .plus({ milliseconds: durationMs })
      .toISO();
    const startDt = DateTime.fromISO(startsAt, { zone: TZ });
    const endDt = DateTime.fromISO(endsAt, { zone: TZ });
    return {
      ...baseFields,
      starts_at: startsAt,
      ends_at: endsAt,
      scheduled_date: startDt.toISODate(),
      scheduled_start_time: startDt.toFormat("HH:mm:ss"),
      scheduled_end_time: endDt.toFormat("HH:mm:ss"),
      is_series_master: false,
      series_id: masterRow.id,
      status: "pending",
    };
  });

  const { data: inserted, error } = await supabase
    .from("appointments")
    .insert(rows)
    .select();
  if (error) {
    console.error("⚠️ materializeSeries insert error:", error.message);
    return [masterRow];
  }
  return [masterRow, ...(inserted ?? [])];
}

// ─────────────────────────────────────────────────────────────────────────
// POST /api/calendar/events
// Body: { summary, startIso, endIso, description?, location?, colorId?,
//         clientId?, serviceType?, value?, employeeIds?, recurrence? }
// ─────────────────────────────────────────────────────────────────────────
export async function createCalendarEvent(req, res) {
  try {
    const {
      summary,
      startIso,
      endIso,
      description,
      location,
      colorId,
      clientId,
      serviceType,
      value,
      employeeIds = [],
      recurrence,
    } = req.body;

    if (!summary || !startIso || !endIso) {
      return res
        .status(400)
        .json({ error: "summary, startIso and endIso are required" });
    }

    const teamIdFromColor = teamIdFromColorId(colorId);
    const startDt = DateTime.fromISO(startIso, { zone: TZ });
    const endDt = DateTime.fromISO(endIso, { zone: TZ });

    const baseFields = {
      client_id: clientId ?? null,
      scheduled_date: startDt.toISODate(),
      scheduled_start_time: startDt.toFormat("HH:mm:ss"),
      scheduled_end_time: endDt.toFormat("HH:mm:ss"),
      starts_at: startDt.toISO(),
      ends_at: endDt.toISO(),
      timezone: TZ,
      special_instructions: description || null,
      property_address: location || "",
      gcal_summary: withTeamTag(summary, teamIdFromColor),
      color_id: colorId || null,
      team_id: teamIdFromColor,
      ...(serviceType && { service_type: serviceType }),
      ...(value && { value }),
    };

    let recurrenceRuleJson = null;
    if (recurrence) {
      recurrenceRuleJson = serializeRecurrence(recurrence);
    }

    const { data: masterRow, error: insertErr } = await supabase
      .from("appointments")
      .insert({
        ...baseFields,
        is_series_master: !!recurrence,
        recurrence_rule: recurrenceRuleJson,
        status: "pending",
      })
      .select()
      .single();

    if (insertErr) throw insertErr;

    // El maestro se auto-referencia como series_id — así "traer toda la
    // serie" es siempre "series_id = X", sin distinguir casos.
    if (recurrence) {
      await supabase
        .from("appointments")
        .update({ series_id: masterRow.id })
        .eq("id", masterRow.id);
      masterRow.series_id = masterRow.id;
    }

    if (employeeIds.length) {
      await syncAppointmentTeams(masterRow.id, employeeIds);
      await syncDailyTeamAssignments(masterRow, teamIdFromColor, employeeIds);
    }

    if (recurrence) {
      await materializeSeries(masterRow, recurrence, baseFields);
    }

    console.log(`✅ Created appointment: ${masterRow.id} — "${summary}"`);

    return res.status(201).json({ ok: true, event: mapRow(masterRow) });
  } catch (e) {
    console.error("❌ createCalendarEvent:", e.message);
    return res.status(500).json({ ok: false, error: e.message });
  }
}

// ─────────────────────────────────────────────────────────────────────────
// PATCH /api/calendar/events/:id
// Body: { summary?, startIso?, endIso?, description?, location?, colorId?,
//         clientId?, serviceType?, value?, employeeIds?, recurrence?, scope }
//
// scope="single"    → edita solo esta fila.
// scope="all"       → edita todas las filas de la serie (series_id = maestro),
//                      preservando la fecha de cada una y aplicando el mismo
//                      delta de horario a todas (mismo criterio que el
//                      original: no se permite cambiar el día de la semana
//                      con "all").
// scope="following" → trunca la serie vieja en esta fecha (cancela las filas
//                      futuras) y crea una serie NUEVA a partir de acá,
//                      heredando freq/interval de la vieja.
// ─────────────────────────────────────────────────────────────────────────
export async function updateCalendarEvent(req, res) {
  try {
    const { id } = req.params;
    const {
      summary,
      startIso,
      endIso,
      description,
      location,
      colorId,
      clientId,
      serviceType,
      value,
      employeeIds,
      recurrence,
      scope = "single",
    } = req.body;

    const { data: existing, error: fetchErr } = await supabase
      .from("appointments")
      .select("*")
      .eq("id", id)
      .single();
    if (fetchErr || !existing) {
      return res
        .status(404)
        .json({ ok: false, error: "Appointment not found" });
    }

    const isPartOfSeries = !!existing.series_id;
    if (recurrence !== undefined) {
      if (scope === "following") {
        return res.status(400).json({
          ok: false,
          error:
            'Changing recurrence isn\'t supported with "This and following events". Choose "All recurring events" instead.',
        });
      }
      if (isPartOfSeries && scope !== "all") {
        return res.status(400).json({
          ok: false,
          error:
            'To change how often this event repeats, choose "All recurring events".',
        });
      }
    }

    const resolvedColorId =
      colorId === undefined ? existing.color_id : colorId || null;
    const teamIdFromColor = teamIdFromColorId(resolvedColorId);

    // ── scope="following": split de la serie ──────────────────────────────
    if (scope === "following") {
      if (!startIso) {
        return res.status(400).json({
          ok: false,
          error: 'startIso is required for scope="following".',
        });
      }
      const masterId = existing.series_id;
      const { data: masterRow, error: masterErr } = await supabase
        .from("appointments")
        .select("*")
        .eq("id", masterId)
        .single();
      if (masterErr || !masterRow) {
        return res
          .status(400)
          .json({ ok: false, error: "Series master not found" });
      }

      const isFirstOccurrence = existing.id === masterRow.id;

      // Truncar/cancelar la serie vieja desde esta fecha en adelante
      // (excluyendo esta fila, que pasa a ser el arranque de la nueva serie).
      const splitDate = existing.scheduled_date;
      await supabase
        .from("appointments")
        .update({ status: "cancelled", updated_at: new Date().toISOString() })
        .eq("series_id", masterId)
        .gte("scheduled_date", splitDate)
        .neq("id", existing.id);

      const oldRecurrence = deserializeRecurrence(masterRow.recurrence_rule);
      if (!oldRecurrence) {
        return res
          .status(400)
          .json({
            ok: false,
            error: "Could not read the series' recurrence rule.",
          });
      }
      const { freq, interval } = extractFreqInterval(oldRecurrence);
      const newRecurrence = {
        freq,
        interval,
        count: null,
        until: oldRecurrence.until,
      };

      const newStartDt = DateTime.fromISO(startIso, { zone: TZ });
      const durationMin = endIso
        ? DateTime.fromISO(endIso, { zone: TZ }).diff(newStartDt, "minutes")
            .minutes
        : DateTime.fromISO(existing.ends_at).diff(
            DateTime.fromISO(existing.starts_at),
            "minutes",
          ).minutes;
      const newEndDt = newStartDt.plus({ minutes: durationMin });

      const baseFields = {
        client_id: clientId ?? existing.client_id,
        timezone: TZ,
        special_instructions: description ?? existing.special_instructions,
        property_address: location ?? existing.property_address,
        gcal_summary: withTeamTag(
          summary ?? existing.gcal_summary,
          teamIdFromColor,
        ),
        color_id: resolvedColorId,
        team_id: teamIdFromColor,
        ...(serviceType && { service_type: serviceType }),
        ...(value && { value }),
      };

      const { data: newMaster, error: newMasterErr } = await supabase
        .from("appointments")
        .insert({
          ...baseFields,
          starts_at: newStartDt.toISO(),
          ends_at: newEndDt.toISO(),
          scheduled_date: newStartDt.toISODate(),
          scheduled_start_time: newStartDt.toFormat("HH:mm:ss"),
          scheduled_end_time: newEndDt.toFormat("HH:mm:ss"),
          is_series_master: true,
          recurrence_rule: serializeRecurrence(newRecurrence),
          status: "pending",
        })
        .select()
        .single();
      if (newMasterErr) throw newMasterErr;

      await supabase
        .from("appointments")
        .update({ series_id: newMaster.id })
        .eq("id", newMaster.id);
      newMaster.series_id = newMaster.id;

      // La fila "existing" (la ocurrencia que se estaba editando) queda
      // reemplazada por newMaster — se cancela para no duplicar el día.
      if (!isFirstOccurrence) {
        await supabase
          .from("appointments")
          .update({ status: "cancelled", updated_at: new Date().toISOString() })
          .eq("id", existing.id);
      }

      if (employeeIds !== undefined) {
        await syncAppointmentTeams(newMaster.id, employeeIds);
        await syncDailyTeamAssignments(newMaster, teamIdFromColor, employeeIds);
      }

      await materializeSeries(newMaster, newRecurrence, baseFields);

      return res.status(200).json({ ok: true, event: mapRow(newMaster) });
    }

    // ── scope="all": aplica a toda la serie ────────────────────────────────
    if (scope === "all" && isPartOfSeries) {
      const masterId = existing.series_id;
      const { data: seriesRows, error: seriesErr } = await supabase
        .from("appointments")
        .select("*")
        .eq("series_id", masterId)
        .neq("status", "cancelled");
      if (seriesErr) throw seriesErr;

      let timeDeltaMin = null;
      if (startIso) {
        const masterRow = seriesRows.find((r) => r.id === masterId) ?? existing;
        const anchorStart = DateTime.fromISO(masterRow.starts_at, { zone: TZ });
        const newStart = DateTime.fromISO(startIso, { zone: TZ });
        if (anchorStart.weekday !== newStart.weekday) {
          return res.status(400).json({
            ok: false,
            error:
              "Changing the day of the week for the whole series isn't supported with 'All recurring events'. Use 'This and following events' instead.",
          });
        }
        timeDeltaMin = newStart.diff(
          anchorStart.set({
            year: newStart.year,
            month: newStart.month,
            day: newStart.day,
          }),
          "minutes",
        ).minutes;
      }

      const durationMin =
        endIso && startIso
          ? DateTime.fromISO(endIso, { zone: TZ }).diff(
              DateTime.fromISO(startIso, { zone: TZ }),
              "minutes",
            ).minutes
          : null;

      let updatedRecurrenceJson = existing.recurrence_rule;
      if (recurrence !== undefined) {
        updatedRecurrenceJson = serializeRecurrence(recurrence);
      }

      const updatedRows = [];
      for (const row of seriesRows) {
        const rowStart = DateTime.fromISO(row.starts_at, { zone: TZ });
        const newRowStart =
          timeDeltaMin !== null
            ? rowStart.plus({ minutes: timeDeltaMin })
            : rowStart;
        const newRowEnd =
          durationMin !== null
            ? newRowStart.plus({ minutes: durationMin })
            : DateTime.fromISO(row.ends_at, { zone: TZ }).plus({
                minutes: timeDeltaMin ?? 0,
              });

        const patch = {
          special_instructions: description ?? row.special_instructions,
          property_address: location ?? row.property_address,
          gcal_summary: withTeamTag(
            summary ?? row.gcal_summary,
            teamIdFromColor,
          ),
          color_id: resolvedColorId,
          team_id: teamIdFromColor,
          starts_at: newRowStart.toISO(),
          ends_at: newRowEnd.toISO(),
          scheduled_start_time: newRowStart.toFormat("HH:mm:ss"),
          scheduled_end_time: newRowEnd.toFormat("HH:mm:ss"),
          updated_at: new Date().toISOString(),
          ...(row.id === masterId
            ? { recurrence_rule: updatedRecurrenceJson }
            : {}),
          ...(clientId !== undefined ? { client_id: clientId } : {}),
          ...(serviceType ? { service_type: serviceType } : {}),
          ...(value ? { value } : {}),
        };
        const { data: updatedRow, error: updErr } = await supabase
          .from("appointments")
          .update(patch)
          .eq("id", row.id)
          .select()
          .single();
        if (updErr) {
          console.error(`⚠️ update scope=all row ${row.id}:`, updErr.message);
          continue;
        }
        updatedRows.push(updatedRow);
      }

      // El equipo (employeeIds), igual que el comportamiento original, solo
      // se toca en la ocurrencia puntual que el admin tenía abierta —
      // scope="all" no reasigna cleaners de toda la serie.
      if (employeeIds !== undefined) {
        await syncAppointmentTeams(existing.id, employeeIds);
        await syncDailyTeamAssignments(existing, teamIdFromColor, employeeIds);
      }

      const updatedExisting =
        updatedRows.find((r) => r.id === existing.id) ?? existing;
      return res.json({ ok: true, event: mapRow(updatedExisting) });
    }

    // ── scope="single" (default) — o "all" sobre un evento suelto ──────────
    const startDt = startIso ? DateTime.fromISO(startIso, { zone: TZ }) : null;
    const endDt = endIso ? DateTime.fromISO(endIso, { zone: TZ }) : null;

    const patch = {
      special_instructions: description ?? existing.special_instructions,
      property_address: location ?? existing.property_address,
      gcal_summary: withTeamTag(
        summary ?? existing.gcal_summary,
        teamIdFromColor,
      ),
      color_id: resolvedColorId,
      team_id: teamIdFromColor,
      updated_at: new Date().toISOString(),
      ...(clientId !== undefined ? { client_id: clientId } : {}),
      ...(serviceType ? { service_type: serviceType } : {}),
      ...(value ? { value } : {}),
      ...(startDt
        ? {
            starts_at: startDt.toISO(),
            scheduled_date: startDt.toISODate(),
            scheduled_start_time: startDt.toFormat("HH:mm:ss"),
          }
        : {}),
      ...(endDt
        ? {
            ends_at: endDt.toISO(),
            scheduled_end_time: endDt.toFormat("HH:mm:ss"),
          }
        : {}),
      // Convertir un evento suelto en recurrente desde scope="single"/"all"
      // sin serie previa — mismo caso que el original contemplaba.
      ...(recurrence !== undefined
        ? {
            is_series_master: true,
            recurrence_rule: serializeRecurrence(recurrence),
          }
        : {}),
    };

    const { data: updated, error: updErr } = await supabase
      .from("appointments")
      .update(patch)
      .eq("id", id)
      .select()
      .single();
    if (updErr) throw updErr;

    if (recurrence !== undefined && !updated.series_id) {
      await supabase
        .from("appointments")
        .update({ series_id: updated.id })
        .eq("id", updated.id);
      updated.series_id = updated.id;
      await materializeSeries(updated, recurrence, patch);
    }

    let cleanersChanged = false;
    let finalEmployees = [];
    if (employeeIds !== undefined) {
      const before = await getAssignedEmployeesForAppointments([id]);
      const beforeIds = new Set((before.get(id) ?? []).map((e) => e.id));
      cleanersChanged =
        beforeIds.size !== employeeIds.length ||
        employeeIds.some((eid) => !beforeIds.has(eid));

      await syncAppointmentTeams(id, employeeIds);
      await syncDailyTeamAssignments(updated, teamIdFromColor, employeeIds);
      const after = await getAssignedEmployeesForAppointments([id]);
      finalEmployees = after.get(id) ?? [];
    } else {
      const current = await getAssignedEmployeesForAppointments([id]);
      finalEmployees = current.get(id) ?? [];
    }

    await releaseConfirmationSlotIfOffered(id);

    const timeChanged = !!(startDt || endDt);
    const shouldNotify =
      finalEmployees.length > 0 && (cleanersChanged || timeChanged);
    if (shouldNotify) {
      await notifyUrgentAssignmentIfNeeded(updated, finalEmployees);
    }

    return res.json({
      ok: true,
      event: mapRow(
        updated,
        finalEmployees.map((e) => e.name),
      ),
    });
  } catch (e) {
    console.error("❌ updateCalendarEvent:", e.message);
    return res.status(500).json({ ok: false, error: e.message });
  }
}

// ─────────────────────────────────────────────────────────────────────────
// DELETE /api/calendar/events/:id?scope=single|all|following
// ─────────────────────────────────────────────────────────────────────────
export async function deleteCalendarEvent(req, res) {
  try {
    const { id } = req.params;
    const { scope = "single" } = req.query;

    const { data: existing, error: fetchErr } = await supabase
      .from("appointments")
      .select("*")
      .eq("id", id)
      .single();
    if (fetchErr || !existing) {
      return res
        .status(404)
        .json({ ok: false, error: "Appointment not found" });
    }

    let targetIds = [id];
    if (scope === "all" && existing.series_id) {
      const { data: seriesRows } = await supabase
        .from("appointments")
        .select("id")
        .eq("series_id", existing.series_id);
      targetIds = (seriesRows ?? []).map((r) => r.id);
    } else if (scope === "following" && existing.series_id) {
      const { data: seriesRows } = await supabase
        .from("appointments")
        .select("id")
        .eq("series_id", existing.series_id)
        .gte("scheduled_date", existing.scheduled_date);
      targetIds = (seriesRows ?? []).map((r) => r.id);
    }

    const employeesBefore = await getAssignedEmployeesForAppointments([id]);

    await releaseConfirmationSlotIfOffered(targetIds);

    if (scope === "single") {
      await notifyCancellationIfNeeded(existing, employeesBefore.get(id) ?? []);
    }

    const { error } = await supabase
      .from("appointments")
      .update({ status: "cancelled", updated_at: new Date().toISOString() })
      .in("id", targetIds);
    if (error)
      console.error("⚠️  deleteCalendarEvent update error:", error.message);

    const { error: releaseErr } = await supabase
      .from("cleaning_availability")
      .update({
        status: "available",
        appointment_id: null,
        booked_name: null,
        booked_phone: null,
        booked_email: null,
        booked_address: null,
        booked_at: null,
      })
      .in("appointment_id", targetIds);
    if (releaseErr)
      console.error(
        "⚠️  deleteCalendarEvent: liberando slots:",
        releaseErr.message,
      );

    console.log(`🗑️  Deleted appointment(s): ${targetIds.join(", ")}`);
    return res.json({ ok: true });
  } catch (e) {
    console.error("❌ deleteCalendarEvent:", e.message);
    return res.status(500).json({ ok: false, error: e.message });
  }
}

// ─────────────────────────────────────────────────────────────────────────
// GET /api/calendar/series/:masterId/recurrence
// ─────────────────────────────────────────────────────────────────────────
export async function getSeriesRecurrence(req, res) {
  try {
    const { masterId } = req.params;
    const { data: master, error } = await supabase
      .from("appointments")
      .select("recurrence_rule")
      .eq("id", masterId)
      .single();
    if (error || !master?.recurrence_rule) {
      return res
        .status(404)
        .json({ ok: false, error: "This event has no recurrence rule." });
    }
    return res.json({
      ok: true,
      recurrence: deserializeRecurrence(master.recurrence_rule),
    });
  } catch (e) {
    console.error("❌ getSeriesRecurrence:", e.message);
    return res.status(500).json({ ok: false, error: e.message });
  }
}

// ─────────────────────────────────────────────────────────────────────────
// getConflictsForEvent — sin cambios de lógica, solo la clave de búsqueda
// pasa a ser appointments.id directo (ya no hace falta resolver
// google_calendar_event_id → appointment primero).
// ─────────────────────────────────────────────────────────────────────────
async function getConflictsForEvent(
  id,
  startIso,
  endIso,
  { checkDistance = true } = {},
) {
  const newStart = DateTime.fromISO(startIso, { zone: TZ });
  const newEnd = DateTime.fromISO(endIso, { zone: TZ });
  const dayOfWeek = newStart.weekday % 7;
  const dateStr = newStart.toISODate();

  const {
    serviceBufferMinutes,
    travelTimeBufferMinutes,
    distanceValidationEnabled,
  } = await getOperationalSettings();
  const bufferedStart = newStart.minus({ minutes: serviceBufferMinutes });
  const bufferedEnd = newEnd.plus({ minutes: serviceBufferMinutes });

  const { data: appt } = await supabase
    .from("appointments")
    .select("id, property_address")
    .eq("id", id)
    .maybeSingle();
  if (!appt) return [];

  const targetAddress = appt.property_address || "";

  const { data: teams } = await supabase
    .from("appointment_teams")
    .select("employee_id, employees(id, name, email)")
    .eq("appointment_id", appt.id);
  if (!teams || teams.length === 0) return [];

  const conflictResults = await Promise.all(
    teams.map(async (team) => {
      const empId = team.employee_id;
      const empName = team.employees?.name ?? empId;
      const reasons = [];

      const [{ data: avail }, { data: extraSlots }] = await Promise.all([
        supabase
          .from("employee_availability")
          .select("start_time, end_time")
          .eq("employee_id", empId)
          .eq("day_of_week", dayOfWeek)
          .maybeSingle(),
        supabase
          .from("employee_extra_availability")
          .select("start_time, end_time")
          .eq("employee_id", empId)
          .eq("date", dateStr)
          .maybeSingle(),
      ]);
      const effectiveAvail = extraSlots ?? avail;

      if (!effectiveAvail) {
        reasons.push({
          type: "schedule",
          message: `not scheduled on ${newStart.toFormat("cccc")}`,
        });
      } else {
        const availStart = DateTime.fromISO(
          `${dateStr}T${effectiveAvail.start_time}`,
          { zone: TZ },
        );
        const availEnd = DateTime.fromISO(
          `${dateStr}T${effectiveAvail.end_time}`,
          { zone: TZ },
        );
        if (
          newStart.toMillis() < availStart.toMillis() ||
          newEnd.toMillis() > availEnd.toMillis()
        ) {
          reasons.push({
            type: "schedule",
            message: `outside working hours (${effectiveAvail.start_time.slice(0, 5)}–${effectiveAvail.end_time.slice(0, 5)})`,
          });
        }
      }

      const { data: timeOff } = await supabase
        .from("employee_time_off")
        .select("start_date, end_date, reason")
        .eq("employee_id", empId)
        .lte("start_date", dateStr)
        .gte("end_date", dateStr)
        .limit(1);
      if (timeOff?.length) {
        reasons.push({
          type: "schedule",
          message: `on time off${timeOff[0].reason ? ` (${timeOff[0].reason})` : ""}`,
        });
      }

      const { data: otherAppts } = await supabase
        .from("appointment_teams")
        .select(
          "appointment_id, appointments!inner(id, starts_at, ends_at, status, property_address)",
        )
        .eq("employee_id", empId)
        .eq("appointments.scheduled_date", dateStr)
        .neq("appointment_id", appt.id)
        .neq("appointments.status", "cancelled");

      if (otherAppts) {
        for (const other of otherAppts) {
          const oa = other.appointments;
          if (!oa?.starts_at || !oa?.ends_at) continue;
          const oStart = DateTime.fromISO(oa.starts_at, { zone: TZ });
          const oEnd = DateTime.fromISO(oa.ends_at, { zone: TZ });

          if (newStart < oEnd && newEnd > oStart) {
            reasons.push({
              type: "timing",
              message: `already assigned to another service at ${oStart.toFormat("h:mm a")}`,
            });
            break;
          }
          if (!(bufferedStart < oEnd && bufferedEnd > oStart)) continue;

          if (
            !checkDistance ||
            !distanceValidationEnabled ||
            !oa.property_address ||
            !targetAddress
          ) {
            reasons.push({
              type: "timing",
              message: `less than ${serviceBufferMinutes}min before/after another service at ${oStart.toFormat("h:mm a")}`,
            });
            break;
          }

          const gapMinutes =
            oEnd <= newStart
              ? newStart.diff(oEnd, "minutes").minutes
              : oStart.diff(newEnd, "minutes").minutes;
          const [earlierEnd, laterStart] =
            oEnd <= newStart ? [oEnd, newStart] : [newEnd, oStart];
          const lunchMinutes = await findLunchMinutesBetween(
            team.employees?.email,
            earlierEnd,
            laterStart,
          );

          if (lunchMinutes === null) {
            reasons.push({
              type: "timing",
              message: `less than ${serviceBufferMinutes}min before/after another service at ${oStart.toFormat("h:mm a")}`,
            });
            break;
          }
          const travelMinutes = await getTravelTimeMinutes(
            oa.property_address,
            targetAddress,
          );
          if (travelMinutes === null) {
            reasons.push(
              `less than ${serviceBufferMinutes}min before/after another service at ${oStart.toFormat("h:mm a")}`,
            );
            break;
          }
          const threshold =
            travelMinutes + travelTimeBufferMinutes + lunchMinutes;
          if (gapMinutes < threshold) {
            reasons.push({
              type: "timing",
              message:
                lunchMinutes > 0
                  ? `only ${Math.round(gapMinutes)}min available, ~${travelMinutes}min travel + ${lunchMinutes}min lunch needed to/from service at ${oStart.toFormat("h:mm a")}`
                  : `only ${Math.round(gapMinutes)}min available, ~${travelMinutes}min travel needed to/from service at ${oStart.toFormat("h:mm a")}`,
            });
            break;
          }
        }
      }
      return reasons.length > 0
        ? { employeeId: empId, name: empName, reasons }
        : null;
    }),
  );
  return conflictResults.filter(Boolean);
}

// findLunchMinutesBetween: ya no puede leer del cache mensual de GCal (no
// existe más) — consulta appointments directo por eventos de tipo lunch
// dentro de la ventana. isLunchEventSummary reemplaza a isLunchEvent(e.summary).
async function findLunchMinutesBetween(employeeEmail, earlierEnd, laterStart) {
  if (!employeeEmail) return null;
  const { data: candidateRows, error } = await supabase
    .from("appointment_teams")
    .select("appointments!inner(starts_at, ends_at, gcal_summary)")
    .eq("employees.email", employeeEmail)
    .gte("appointments.starts_at", earlierEnd.toISO())
    .lte("appointments.ends_at", laterStart.toISO());
  if (error) return null;

  const lunch = (candidateRows ?? [])
    .map((r) => r.appointments)
    .find((a) => isLunchEventSummary(a.gcal_summary));
  if (!lunch) return 0;

  const lStart = DateTime.fromISO(lunch.starts_at, { zone: TZ });
  const lEnd = DateTime.fromISO(lunch.ends_at, { zone: TZ });
  return Math.round(lEnd.diff(lStart, "minutes").minutes);
}

export async function checkEventConflicts(req, res) {
  try {
    const { id } = req.params;
    const { startIso, endIso } = req.query;
    if (!startIso || !endIso) {
      return res
        .status(400)
        .json({ error: "startIso and endIso are required" });
    }
    const conflicts = await getConflictsForEvent(id, startIso, endIso);
    return res.json({ ok: true, conflicts });
  } catch (e) {
    console.error("❌ checkEventConflicts:", e.message);
    return res.status(500).json({ ok: false, error: e.message });
  }
}

export async function checkEventConflictsBatch(req, res) {
  try {
    const { events } = req.body ?? {};
    if (!Array.isArray(events) || events.length === 0) {
      return res
        .status(400)
        .json({ ok: false, error: "events array is required" });
    }
    if (events.length > 200) {
      return res
        .status(400)
        .json({ ok: false, error: "events array too large (max 200)" });
    }
    const results = await Promise.allSettled(
      events.map((e) =>
        getConflictsForEvent(e.id, e.startIso, e.endIso, {
          checkDistance: false,
        }),
      ),
    );
    const conflictsByEventId = {};
    results.forEach((r, i) => {
      conflictsByEventId[events[i].id] =
        r.status === "fulfilled" ? r.value : [];
    });
    return res.json({ ok: true, conflictsByEventId });
  } catch (e) {
    console.error("❌ checkEventConflictsBatch:", e.message);
    return res.status(500).json({ ok: false, error: e.message });
  }
}

// ─────────────────────────────────────────────────────────────────────────
// checkSeriesConflictsPreview — antes leía "en vivo desde Google Calendar"
// (fetchFromGCal); ahora lee directo de appointments para la ventana.
// ─────────────────────────────────────────────────────────────────────────
export async function checkSeriesConflictsPreview(req, res) {
  try {
    const { slots = [], colorId, excludeEventId, excludeSeriesId } = req.body;
    if (!slots.length) return res.json({ ok: true, conflicts: [] });

    const teamId = teamIdFromColorId(colorId);
    if (!teamId) return res.json({ ok: true, conflicts: [] });

    const starts = slots.map((s) => s.startIso).sort();
    const ends = slots.map((s) => s.endIso).sort();
    const minDate = DateTime.fromISO(starts[0], { zone: TZ })
      .startOf("day")
      .toISO();
    const maxDate = DateTime.fromISO(ends[ends.length - 1], { zone: TZ })
      .endOf("day")
      .toISO();

    const { maxSimultaneousTeams } = await getOperationalSettings();

    const { data: rows, error } = await supabase
      .from("appointments")
      .select(
        "id, series_id, gcal_summary, starts_at, ends_at, color_id, special_instructions",
      )
      .neq("status", "cancelled")
      .gte("starts_at", minDate)
      .lte("ends_at", maxDate);
    if (error) throw error;

    const candidateEvents = slots.map((s, i) => ({
      id: `candidate-${i}`,
      summary: "(new series)",
      teamId,
      startIso: s.startIso,
      endIso: s.endIso,
    }));
    const existingEvents = (rows ?? [])
      .map((r) => ({ ...r, teamId: detectTeam(r) }))
      .filter((r) => r.teamId && !isNonServiceEventRow(r))
      .filter(
        (r) =>
          r.id !== excludeEventId &&
          (!excludeSeriesId || r.series_id !== excludeSeriesId),
      )
      .map((r) => ({
        id: r.id,
        teamId: r.teamId,
        summary: r.gcal_summary,
        startIso: DateTime.fromISO(r.starts_at, { zone: TZ }).toISO(),
        endIso: DateTime.fromISO(r.ends_at, { zone: TZ }).toISO(),
      }));

    const allEvents = [...candidateEvents, ...existingEvents];
    const overlaps = findTeamOverlaps(allEvents).filter((o) =>
      o.eventId.startsWith("candidate-"),
    );
    const overCap = findOverCapacity(allEvents, maxSimultaneousTeams).filter(
      (f) => f.eventId.startsWith("candidate-"),
    );

    const conflicts = [
      ...overlaps.map((o) => ({
        dateIso: candidateEvents.find((c) => c.id === o.eventId).startIso,
        type: "team_overlap",
        detail: `Also booked: "${o.conflictingSummary}"`,
      })),
      ...overCap.map((f) => ({
        dateIso: candidateEvents.find((c) => c.id === f.eventId).startIso,
        type: "over_capacity",
        detail: `${f.simultaneousCount} simultaneous services, only ${f.maxTeams} team(s) available`,
      })),
    ];
    return res.json({ ok: true, conflicts });
  } catch (e) {
    console.error("❌ checkSeriesConflictsPreview:", e.message);
    return res.status(500).json({ ok: false, error: e.message });
  }
}

// ─────────────────────────────────────────────────────────────────────────
// getAvailableStaff — sin cambios de fondo, solo ya no hace falta pegarle a
// GCal para leer el evento (se lee directo de appointments, un solo query
// en vez de un round-trip a la API externa).
// ─────────────────────────────────────────────────────────────────────────
export async function getAvailableStaff(req, res) {
  try {
    const { id } = req.params;

    const [{ data: apptRow, error: apptErr }, settings] = await Promise.all([
      supabase.from("appointments").select("*").eq("id", id).single(),
      getOperationalSettings(),
    ]);
    if (apptErr || !apptRow) {
      return res
        .status(404)
        .json({ ok: false, error: "Appointment not found" });
    }

    const {
      serviceBufferMinutes,
      maxSimultaneousTeams,
      keepStablePair,
      travelTimeBufferMinutes,
      distanceValidationEnabled,
    } = settings;

    const eventStart = DateTime.fromISO(apptRow.starts_at, { zone: TZ });
    const eventEnd = DateTime.fromISO(apptRow.ends_at, { zone: TZ });
    const dateStr = eventStart.toISODate();
    const dayOfWeek = eventStart.weekday % 7;
    const startTimeStr = eventStart.toFormat("HH:mm:ss");
    const endTimeStr = eventEnd.toFormat("HH:mm:ss");
    const bufferedStart = eventStart.minus({ minutes: serviceBufferMinutes });
    const bufferedEnd = eventEnd.plus({ minutes: serviceBufferMinutes });

    const clientId = apptRow.client_id ?? null;

    const { data: allEmployees, error: empErr } = await supabase
      .from("employees")
      .select("id, name, email, is_team_leader, hourly_work_rate")
      .eq("is_active", true)
      .order("name");
    if (empErr) throw empErr;

    const { data: avail, error: availErr } = await supabase
      .from("employee_availability")
      .select("employee_id")
      .eq("day_of_week", dayOfWeek)
      .lte("start_time", startTimeStr)
      .gte("end_time", endTimeStr);
    if (availErr) throw availErr;
    const availIds = new Set((avail ?? []).map((a) => a.employee_id));

    const { data: extraAvailRaw, error: extraErr } = await supabase
      .from("employee_extra_availability")
      .select("employee_id, start_time, end_time")
      .eq("date", dateStr);
    if (extraErr) throw extraErr;
    const extraAvailIds = new Set(
      (extraAvailRaw ?? [])
        .filter((ea) => {
          const slotStart = DateTime.fromISO(`${dateStr}T${ea.start_time}`, {
            zone: TZ,
          });
          const slotEnd = DateTime.fromISO(`${dateStr}T${ea.end_time}`, {
            zone: TZ,
          });
          return (
            eventStart.toMillis() >= slotStart.toMillis() &&
            eventEnd.toMillis() <= slotEnd.toMillis()
          );
        })
        .map((ea) => ea.employee_id),
    );
    const combinedAvailIds = new Set([...availIds, ...extraAvailIds]);

    const { data: timeOff, error: toErr } = await supabase
      .from("employee_time_off")
      .select("employee_id")
      .lte("start_date", dateStr)
      .gte("end_date", dateStr);
    if (toErr) throw toErr;
    const offIds = new Set((timeOff ?? []).map((t) => t.employee_id));

    const { data: busyTeams, error: busyErr } = await supabase
      .from("appointment_teams")
      .select(
        "employee_id, appointments!inner(starts_at, ends_at, id, status, property_address)",
      )
      .neq("appointments.id", id)
      .neq("appointments.status", "cancelled");
    if (busyErr) throw busyErr;

    const busyEmployeeIds = [
      ...new Set((busyTeams ?? []).map((bt) => bt.employee_id)),
    ];
    const { data: busyEmployeesData } = busyEmployeeIds.length
      ? await supabase
          .from("employees")
          .select("id, email")
          .in("id", busyEmployeeIds)
      : { data: [] };
    const emailByEmployeeId = Object.fromEntries(
      (busyEmployeesData ?? []).map((e) => [e.id, e.email]),
    );

    const busyIds = new Set();
    const targetAddress = apptRow.property_address || "";
    for (const bt of busyTeams ?? []) {
      const oa = bt.appointments;
      if (!oa?.starts_at || !oa?.ends_at) continue;
      const oStart = DateTime.fromISO(oa.starts_at, { zone: TZ });
      const oEnd = DateTime.fromISO(oa.ends_at, { zone: TZ });

      if (eventStart < oEnd && eventEnd > oStart) {
        busyIds.add(bt.employee_id);
        continue;
      }
      if (!(bufferedStart < oEnd && bufferedEnd > oStart)) continue;
      if (
        !distanceValidationEnabled ||
        !oa.property_address ||
        !targetAddress
      ) {
        busyIds.add(bt.employee_id);
        continue;
      }

      const gapMinutes =
        oEnd <= eventStart
          ? eventStart.diff(oEnd, "minutes").minutes
          : oStart.diff(eventEnd, "minutes").minutes;
      const [earlierEnd, laterStart] =
        oEnd <= eventStart ? [oEnd, eventStart] : [eventEnd, oStart];
      const lunchMinutes = await findLunchMinutesBetween(
        emailByEmployeeId[bt.employee_id],
        earlierEnd,
        laterStart,
      );
      if (lunchMinutes === null) {
        busyIds.add(bt.employee_id);
        continue;
      }

      const travelMinutes = await getTravelTimeMinutes(
        oa.property_address,
        targetAddress,
      );
      if (travelMinutes === null) {
        busyIds.add(bt.employee_id);
        continue;
      }

      if (gapMinutes < travelMinutes + travelTimeBufferMinutes + lunchMinutes) {
        busyIds.add(bt.employee_id);
      }
    }

    const available = (allEmployees ?? [])
      .filter(
        (e) =>
          combinedAvailIds.has(e.id) && !offIds.has(e.id) && !busyIds.has(e.id),
      )
      .map((e) => ({
        id: e.id,
        name: e.name,
        email: String(e.email ?? "").toLowerCase(),
        is_team_leader: e.is_team_leader ?? false,
        teamId: TEAM_MEMBERS_MAP[String(e.email ?? "").toLowerCase()] ?? null,
      }));

    const { data: concurrentAppts } = await supabase
      .from("appointments")
      .select("id, starts_at, ends_at, appointment_teams(employee_id)")
      .eq("scheduled_date", dateStr)
      .neq("id", id)
      .neq("status", "cancelled");

    let simultaneousTeamCount = 0;
    for (const ca of concurrentAppts ?? []) {
      if (!ca.starts_at || !ca.ends_at) continue;
      if (!ca.appointment_teams?.length) continue;
      const cStart = DateTime.fromISO(ca.starts_at, { zone: TZ });
      const cEnd = DateTime.fromISO(ca.ends_at, { zone: TZ });
      if (eventStart < cEnd && eventEnd > cStart) simultaneousTeamCount++;
    }
    const atCapacity = simultaneousTeamCount >= maxSimultaneousTeams;

    let preferredEmployeeId = null;
    if (clientId) {
      const { data: freq } = await supabase
        .from("appointment_teams")
        .select("employee_id, appointments!inner(client_id)")
        .eq("appointments.client_id", clientId);
      if (freq?.length) {
        const counts = {};
        for (const f of freq)
          counts[f.employee_id] = (counts[f.employee_id] ?? 0) + 1;
        preferredEmployeeId =
          Object.entries(counts).sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
      }
    }

    available.sort((a, b) => {
      if (a.id === preferredEmployeeId) return -1;
      if (b.id === preferredEmployeeId) return 1;
      if (a.is_team_leader && !b.is_team_leader) return -1;
      if (!a.is_team_leader && b.is_team_leader) return 1;
      return a.name.localeCompare(b.name);
    });

    const { data: todayAppts } = await supabase
      .from("appointments")
      .select(
        "id, starts_at, appointment_teams(employee_id, employees(id, name, is_team_leader))",
      )
      .eq("scheduled_date", dateStr)
      .neq("id", id)
      .neq("status", "cancelled");

    const todayPairs = [];
    for (const ta of todayAppts ?? []) {
      const members = (ta.appointment_teams ?? [])
        .filter((t) => t.employees)
        .map((t) => ({
          id: t.employees.id,
          name: t.employees.name,
          is_team_leader: t.employees.is_team_leader ?? false,
        }));
      if (members.length > 0) {
        todayPairs.push({
          appointmentId: ta.id,
          startsAt: ta.starts_at,
          members,
        });
      }
    }
    const seenPairs = new Set();
    const uniqueTodayPairs = todayPairs.filter((p) => {
      const key = p.members
        .map((m) => m.id)
        .sort()
        .join(",");
      if (seenPairs.has(key)) return false;
      seenPairs.add(key);
      return true;
    });

    const currentAssigned = await getAssignedEmployeesForAppointments([id]);
    const currentAttendees = (currentAssigned.get(id) ?? []).map((emp) => ({
      id: emp.id,
      name: emp.name,
      email: String(emp.email ?? "").toLowerCase(),
      is_team_leader: false,
      teamId: TEAM_MEMBERS_MAP[String(emp.email ?? "").toLowerCase()] ?? null,
      outsideWorkHours: !combinedAvailIds.has(emp.id),
      busy: busyIds.has(emp.id),
    }));

    return res.json({
      ok: true,
      available: atCapacity ? [] : available,
      currentAttendees,
      preferredEmployeeId,
      todayPairs: uniqueTodayPairs,
      keepStablePair,
      atCapacity,
      simultaneousTeamCount,
      maxSimultaneousTeams,
      serviceBufferMinutes,
    });
  } catch (e) {
    console.error("❌ getAvailableStaff:", e.message);
    return res.status(500).json({ ok: false, error: e.message });
  }
}

export { TEAMS_CONFIG, TEAM_MEMBERS_MAP };

export async function getClientPreferences(req, res) {
  try {
    const { id } = req.params;
    const { data: appt } = await supabase
      .from("appointments")
      .select("client_id")
      .eq("id", id)
      .maybeSingle();
    if (!appt?.client_id) {
      return res.json({
        ok: true,
        clientId: null,
        preferred_days: null,
        preferred_time: null,
      });
    }
    const { data: client } = await supabase
      .from("clients")
      .select(
        "id, first_name, last_name, preferred_days, preferred_time, availability_windows",
      )
      .eq("id", appt.client_id)
      .single();
    return res.json({
      ok: true,
      clientId: client?.id ?? null,
      clientName:
        [client?.first_name, client?.last_name].filter(Boolean).join(" ") ||
        null,
      preferred_days: client?.preferred_days ?? null,
      preferred_time: client?.preferred_time ?? null,
      availability_windows: client?.availability_windows ?? null,
    });
  } catch (e) {
    console.error("❌ getClientPreferences:", e.message);
    return res.status(500).json({ ok: false, error: e.message });
  }
}

// ── ELIMINADOS respecto al original (ya no aplican sin Google Calendar) ───
// - getCalendarCacheStats / forceResync: eran endpoints de debug del cache
//   in-memory, que ya no existe.
// - CALENDAR_ID / getCalendarClient: no hay más API externa a la que apuntar.
