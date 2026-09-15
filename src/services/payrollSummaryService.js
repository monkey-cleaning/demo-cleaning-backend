// services/payrollSummaryService.js
// LAB428 (portado de Monkey Cleaning) — resumen por quincena (eventos, horas,
// traslado, dinero) para la pestaña "Payroll".
//
// Reimplementado contra el modelo de este fork: el original de Monkey usa
// getEventsForRange() (Google Calendar) + event.attendees; acá la fuente es
// appointments + appointment_teams, mismo criterio que staffHoursController.js
// ("horas ya prestadas" = appointment no cancelado con ends_at ya pasado).
//
// El gating de plata NO vive acá adentro como un flag — computePayrollSummary
// siempre calcula todo; es el CALLER (payrollController.js, según el rol) el
// que decide si pasa `employeeIds` acotado (staff, un solo empleado) y si
// aplica stripMoney() antes de responder.
//
// Fórmula de traslado (igual que Monkey): para cada empleado, por cada día
// calendario, la suma de los huecos entre eventos CONSECUTIVOS de ese día —
// sin contar el tiempo antes del primer evento ni después del último. Un
// "Lunch" u otro bloqueo interno en medio de dos jobs se DESCUENTA (corta el
// hueco en dos tramos más chicos, no se lo saltea) porque ocupa tiempo real
// del calendario aunque no sea trabajo facturable.

import { DateTime } from "luxon";
import { supabase } from "../supabaseClient.js";
import { isNonServiceEventRow, isLunchEvent } from "./eventClassification.js";

const TZ = process.env.BOOKING_TIMEZONE || "America/Vancouver";

const round2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;

// ── quincenaRange ────────────────────────────────────────────────────────────
// Generaliza getQuincenalRange (staffHoursController.js) a CUALQUIER
// quincena, no solo current/previous — necesario para navegar el histórico.
// half:1 → día 1-15; half:2 → día 16-fin de mes (inclusive).
export function quincenaRange({ year, month, half }) {
  const from =
    half === 1
      ? DateTime.fromObject({ year, month, day: 1 }, { zone: TZ })
      : DateTime.fromObject({ year, month, day: 16 }, { zone: TZ });
  const toInclusive =
    half === 1
      ? DateTime.fromObject({ year, month, day: 15 }, { zone: TZ })
      : from.endOf("month").startOf("day");

  const label = `Q${half} ${from.toFormat("LLL yyyy")}`;
  return { from, toInclusive, label };
}

function durationH(row) {
  const s = DateTime.fromISO(row.starts_at, { zone: TZ });
  const e = DateTime.fromISO(row.ends_at, { zone: TZ });
  if (!s.isValid || !e.isValid) return 0;
  return e.diff(s, "hours").hours;
}

// ── aggregateEmployeePayroll ─────────────────────────────────────────────────
// Función pura (sin DB) — recibe YA filtradas las filas de `appointments`
// donde el empleado está en appointment_teams y el servicio ya terminó
// (rawRows). Calcula:
//   - workRows: rawRows menos isNonServiceEventRow menos Lunch (por keyword).
//   - workHours / eventCount sobre workRows.
//   - travelHours sobre rawRows, agrupado por scheduled_date.
// No aplica rates acá — eso lo hace el caller (necesita el employee).
export function aggregateEmployeePayroll(rawRows) {
  const workRows = rawRows.filter(
    (r) => !isNonServiceEventRow(r) && !isLunchEvent(r.gcal_summary),
  );

  const workHours = round2(workRows.reduce((s, r) => s + durationH(r), 0));

  // Traslado: agrupar por día calendario, ordenar por hora de inicio, sumar
  // huecos entre consecutivos. Sin evento antes del primero del día ni
  // después del último → cumple "sin tiempo al inicio ni al final".
  const byDay = new Map();
  for (const r of rawRows) {
    const day = r.scheduled_date;
    if (!byDay.has(day)) byDay.set(day, []);
    byDay.get(day).push(r);
  }

  let travelHours = 0;
  for (const dayRows of byDay.values()) {
    if (dayRows.length < 2) continue;
    const sorted = [...dayRows].sort((a, b) =>
      String(a.starts_at).localeCompare(String(b.starts_at)),
    );
    for (let i = 1; i < sorted.length; i++) {
      const prevEnd = DateTime.fromISO(sorted[i - 1].ends_at, { zone: TZ });
      const nextStart = DateTime.fromISO(sorted[i].starts_at, { zone: TZ });
      const gapH = nextStart.diff(prevEnd, "hours").hours;
      if (gapH > 0) travelHours += gapH; // clamp: eventos solapados no restan
    }
  }
  travelHours = round2(travelHours);

  return {
    eventCount: workRows.length,
    workHours,
    travelHours,
    events: workRows
      .map((r) => ({
        id: r.id,
        summary: r.gcal_summary || "(no title)",
        startIso: DateTime.fromISO(r.starts_at, { zone: TZ }).toISO(),
        endIso: DateTime.fromISO(r.ends_at, { zone: TZ }).toISO(),
        durationH: durationH(r),
        location: r.property_address || null,
        isRecurring: r.series_id != null,
      }))
      .sort((a, b) => a.startIso.localeCompare(b.startIso)),
  };
}

// ── computePayrollSummary ────────────────────────────────────────────────────
// `employeeIds` opcional: si se pasa, solo se calculan ESOS empleados — usado
// por el endpoint de staff para no traer (ni siquiera a memoria del proceso)
// los datos de otros compañeros. Si se omite, todos los activos (admin).
export async function computePayrollSummary({ year, month, half, employeeIds }) {
  const { from, toInclusive, label } = quincenaRange({ year, month, half });
  const timeMin = from.toISO();
  // timeMax exclusivo — el día siguiente al último de la quincena a las
  // 00:00 cubre el último día completo (mismo patrón que staffHoursController).
  const timeMax = toInclusive.plus({ days: 1 }).toISO();
  const nowIso = DateTime.now().setZone(TZ).toISO();

  let empQuery = supabase
    .from("employees")
    .select("id, name, email, hourly_work_rate, hourly_travel_rate")
    .eq("is_active", true)
    .order("name");
  if (employeeIds?.length) empQuery = empQuery.in("id", employeeIds);

  const { data: employees, error: empErr } = await empQuery;
  if (empErr) throw new Error(`payroll employees: ${empErr.message}`);

  const { data: allRows, error: apptErr } = await supabase
    .from("appointments")
    .select(
      "id, gcal_summary, color_id, scheduled_date, starts_at, ends_at, status, property_address, series_id, appointment_teams(employee_id)",
    )
    .gte("starts_at", timeMin)
    .lt("starts_at", timeMax)
    .neq("status", "cancelled");
  if (apptErr) throw new Error(`payroll appointments: ${apptErr.message}`);

  const rows = (employees ?? []).map((emp) => {
    const myRows = (allRows ?? []).filter(
      (r) =>
        (r.appointment_teams ?? []).some((t) => t.employee_id === emp.id) &&
        r.ends_at &&
        r.ends_at <= nowIso, // solo servicios ya prestados
    );

    const agg = aggregateEmployeePayroll(myRows);
    const workMoney = round2(agg.workHours * Number(emp.hourly_work_rate || 0));
    const travelMoney = round2(
      agg.travelHours * Number(emp.hourly_travel_rate || 0),
    );

    return {
      employeeId: emp.id,
      name: emp.name,
      eventCount: agg.eventCount,
      workHours: agg.workHours,
      travelHours: agg.travelHours,
      workMoney,
      travelMoney,
      totalMoney: round2(workMoney + travelMoney),
      events: agg.events,
    };
  });

  const totals = rows.reduce(
    (acc, r) => ({
      employeeCount: acc.employeeCount + 1,
      eventCount: acc.eventCount + r.eventCount,
      workHours: round2(acc.workHours + r.workHours),
      travelHours: round2(acc.travelHours + r.travelHours),
      workMoney: round2(acc.workMoney + r.workMoney),
      travelMoney: round2(acc.travelMoney + r.travelMoney),
      totalMoney: round2(acc.totalMoney + r.totalMoney),
    }),
    {
      employeeCount: 0,
      eventCount: 0,
      workHours: 0,
      travelHours: 0,
      workMoney: 0,
      travelMoney: 0,
      totalMoney: 0,
    },
  );

  return {
    ok: true,
    period: {
      year,
      month,
      half,
      label,
      from: from.toISODate(),
      to: toInclusive.toISODate(),
    },
    employees: rows,
    totals,
    tz: TZ,
  };
}

// ── stripMoney ────────────────────────────────────────────────────────────
// Borra todo campo de plata de la respuesta antes de mandarla a un cleaner.
// Los campos se OMITEN (delete), no se mandan como null — así un frontend
// que itere Object.keys() no encuentra ni rastro de la key.
export function stripMoney(summary) {
  const strip = (obj) => {
    const { workMoney, travelMoney, totalMoney, ...rest } = obj;
    return rest;
  };
  return {
    ...summary,
    employees: summary.employees.map(strip),
    totals: strip(summary.totals),
  };
}
