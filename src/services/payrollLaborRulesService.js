// services/payrollLaborRulesService.js
//
// Payroll — horas extra y pago de feriados según la Employment Standards Act
// de British Columbia. Todo es PURO (sin DB ni calendario): recibe el "libro
// diario" de un empleado (horas y plata normal por día) y devuelve lo que hay
// que SUMAR a su pago normal. Por eso `workMoney`/`travelMoney` siguen siendo
// el pago a tarifa simple y este módulo calcula solo el plus.
//
// Reglas (guías oficiales de BC, consultadas 2026-10-19):
//   * Por día: las horas 9 a 12 se pagan a 1,5× la tarifa y las que pasan de
//     12 a 2×. Aplica aunque la semana no llegue a 40 horas.
//   * Por semana (domingo a sábado): las horas por encima de 40 se pagan a
//     1,5×. Para llegar a las 40 solo cuentan las primeras 8 horas de cada
//     día, así una hora nunca es extra por día y por semana a la vez.
//   * "Horas trabajadas" = horas de trabajo + traslado entre trabajos del
//     mismo día (llegar al primer trabajo no cuenta; eso ya lo deja afuera
//     el cálculo de traslados).
//   * Feriado (ver `computeHolidayPay`): quien califica cobra el "día
//     promedio"; si además trabaja ese día, cobra 1,5× por las horas (2× pasadas
//     las 12). Quien no califica cobra el día como uno normal.
//
// Decisiones de implementación (pendientes de confirmar con Jhony, ver el
// informe de Oct Q1):
//   * El plus de horas extra se calcula sobre la tarifa de TRABAJO de la
//     cleaner, también para las horas extra que vengan de traslado.
//   * La semana se cuenta desde el domingo aunque arranque en la quincena
//     anterior (esos días solo se LEEN, nunca se vuelven a pagar), y cada hora
//     extra se paga en la quincena en que se trabajó: una quincena cerrada no
//     se modifica nunca.
//   * No se verifica la antigüedad de 30 días del feriado (no hay fecha de
//     ingreso cargada); sí los 15 días trabajados de los 30 anteriores.
import { DateTime } from "luxon";
import { bcStatutoryHoliday } from "./cleaningQuoteCalculator.js";

export const BC_RULES = Object.freeze({
  dailyRegularHours: 8,
  dailyDoubleAfterHours: 12,
  weeklyRegularHours: 40,
  overtimeMultiplier: 1.5,
  doubleMultiplier: 2,
  holidayLookbackDays: 30,
  holidayMinDaysWorked: 15,
});

const round2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;

// Fecha del domingo que abre la semana de `dateIso` (YYYY-MM-DD). La semana
// laboral de BC va de domingo a sábado, sin importar el período de pago.
export function weekStartSunday(dateIso) {
  const d = DateTime.fromISO(dateIso, { zone: "utc" });
  return d.minus({ days: d.weekday % 7 }).toISODate();
}

// Lista de { date, name } de los feriados de BC entre dos fechas (inclusive).
export function holidaysInRange(fromDate, toDate) {
  const out = [];
  let d = DateTime.fromISO(fromDate, { zone: "utc" });
  const end = DateTime.fromISO(toDate, { zone: "utc" });
  while (d <= end) {
    const iso = d.toISODate();
    const name = bcStatutoryHoliday(iso);
    if (name) out.push({ date: iso, name });
    d = d.plus({ days: 1 });
  }
  return out;
}

// Horas extra por día y por semana.
// days: [{ date, hours, holidayPaid? }] ordenados por fecha; tiene que cubrir
// desde el domingo de la semana de `fromDate` (los días anteriores a la
// quincena solo cuentan para llegar a las 40 horas). Devuelve únicamente los
// días entre `fromDate` y `toDate` que tienen horas extra.
// `holidayPaid`: el día ya se paga a 1,5× como feriado trabajado — no suma
// extra por día ni por semana (la ley no paga dos veces la misma hora), pero
// sus primeras 8 horas igual cuentan para la semana.
export function computeOvertimeHours({ days, fromDate, toDate }) {
  const out = [];
  let weekKey = null;
  let counted = 0; // horas "contables" de la semana en curso (máx. 8 por día)
  for (const day of days) {
    const key = weekStartSunday(day.date);
    if (key !== weekKey) {
      weekKey = key;
      counted = 0;
    }
    const hours = day.hours;
    const first8 = Math.min(hours, BC_RULES.dailyRegularHours);
    const roomBeforeLimit = Math.max(0, BC_RULES.weeklyRegularHours - counted);
    const weeklyHours = Math.max(0, first8 - roomBeforeLimit);
    counted += first8;

    if (day.date < fromDate || day.date > toDate || day.holidayPaid) continue;
    const dailyHours15 = Math.min(
      Math.max(0, hours - BC_RULES.dailyRegularHours),
      BC_RULES.dailyDoubleAfterHours - BC_RULES.dailyRegularHours,
    );
    const hours2 = Math.max(0, hours - BC_RULES.dailyDoubleAfterHours);
    const hours15 = dailyHours15 + weeklyHours;
    if (hours15 > 0 || hours2 > 0) {
      out.push({
        date: day.date,
        hours: round2(hours),
        hours15: round2(hours15),
        hours2: round2(hours2),
        weeklyHours: round2(weeklyHours),
      });
    }
  }
  return out;
}

// Pago extra de UN feriado para un empleado.
// ledgerByDate: Map date → { hours, workHours, money } (pago normal del día).
// Devuelve lo que se SUMA al pago normal de la quincena:
//   - trabajó y califica: día promedio + (0,5 × tarifa por cada hora hasta 12 y
//     1,0 × tarifa por cada hora pasada las 12) — las horas ya están pagadas a
//     tarifa simple en workMoney/travelMoney, acá va el resto hasta 1,5×/2×.
//   - no trabajó y califica: el día promedio.
//   - no califica: 0 (si trabajó, se le pagó como un día cualquiera).
export function computeHolidayPay({ date, name, ledgerByDate, workRate }) {
  const day = DateTime.fromISO(date, { zone: "utc" });
  let daysWorked = 0;
  let wages = 0;
  for (let i = 1; i <= BC_RULES.holidayLookbackDays; i++) {
    const entry = ledgerByDate.get(day.minus({ days: i }).toISODate());
    if (entry && entry.workHours > 0) {
      daysWorked += 1;
      wages += entry.money;
    }
  }
  const eligible = daysWorked >= BC_RULES.holidayMinDaysWorked;
  const hoursWorked = ledgerByDate.get(date)?.hours ?? 0;
  const worked = hoursWorked > 0;
  const avgDayPay = eligible ? round2(wages / daysWorked) : 0;
  let premium = 0;
  if (eligible && worked) {
    const upTo12 = Math.min(hoursWorked, BC_RULES.dailyDoubleAfterHours);
    const past12 = Math.max(0, hoursWorked - BC_RULES.dailyDoubleAfterHours);
    premium = round2(
      workRate * ((BC_RULES.overtimeMultiplier - 1) * upTo12 + (BC_RULES.doubleMultiplier - 1) * past12),
    );
  }
  return {
    date,
    name,
    eligible,
    daysWorkedInWindow: daysWorked,
    worked,
    hoursWorked: round2(hoursWorked),
    avgDayPay,
    premium,
    amount: round2(avgDayPay + premium),
  };
}

// Todo junto para un empleado.
// ledger: [{ date, workHours, travelHours, money }] — un registro por día con
//   trabajo, ya con los overrides de traslado aplicados; tiene que cubrir los
//   30 días previos a cada feriado de la quincena y desde el domingo de la
//   semana que la abre.
// Devuelve { overtime: { hours15, hours2, money, days }, holidays, holidayMoney }.
export function computeLaborPay({ ledger, fromDate, toDate, workRate, overtimeExempt = false }) {
  const rate = Number(workRate) || 0;
  const ledgerByDate = new Map();
  for (const entry of ledger) {
    ledgerByDate.set(entry.date, {
      workHours: entry.workHours,
      hours: round2(entry.workHours + entry.travelHours),
      money: entry.money,
    });
  }

  const holidays = holidaysInRange(fromDate, toDate).map((h) =>
    computeHolidayPay({ ...h, ledgerByDate, workRate: rate }),
  );
  const holidayPaidDates = new Set(holidays.filter((h) => h.eligible && h.worked).map((h) => h.date));
  const holidayMoney = round2(holidays.reduce((sum, h) => sum + h.amount, 0));

  let overtimeDays = [];
  if (!overtimeExempt) {
    const days = [...ledgerByDate.entries()]
      .map(([date, e]) => ({ date, hours: e.hours, holidayPaid: holidayPaidDates.has(date) }))
      .filter((d) => d.date >= weekStartSunday(fromDate) && d.date <= toDate)
      .sort((a, b) => a.date.localeCompare(b.date));
    overtimeDays = computeOvertimeHours({ days, fromDate, toDate });
  }
  const hours15 = round2(overtimeDays.reduce((s, d) => s + d.hours15, 0));
  const hours2 = round2(overtimeDays.reduce((s, d) => s + d.hours2, 0));
  // El plus sobre la tarifa simple ya pagada: 0,5× por hora a 1,5× y 1,0× por
  // hora a 2×.
  const money = round2(
    rate * ((BC_RULES.overtimeMultiplier - 1) * hours15 + (BC_RULES.doubleMultiplier - 1) * hours2),
  );

  return {
    overtime: { hours15, hours2, money, days: overtimeDays },
    holidays,
    holidayMoney,
  };
}
