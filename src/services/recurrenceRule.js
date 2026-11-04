// services/recurrenceRule.js
//
// LAB617 (portado de Monkey Cleaning) — validación de las reglas de recurrencia
// de los eventos del calendario.
//
// Lo que el panel puede pedir:
//   - "Weekly"                     → WEEKLY, interval 1
//   - "Every 2 weeks"              → WEEKLY, interval 2
//   - "Monthly" (cada 4 semanas)   → WEEKLY, interval 4   (mismo día de la
//                                    semana, NO el mismo número de día del mes)
//   - Custom:
//       · cada N semanas, en uno o varios días de la semana
//         → WEEKLY, interval N, byDay ["MO","WE"]
//       · cada N meses, el mismo número de día
//         → MONTHLY, interval N
//       · cada N meses, el "primer lunes", "último viernes", etc.
//         → MONTHLY, interval N, monthly {type:"nthWeekday", nth:1|2|3|4|-1, weekday:"MO"}
//
// Contrato del input (compatible hacia atrás con el viejo
// { freq: WEEKLY|BIWEEKLY|MONTHLY, interval?, count?, until? }):
//   {
//     freq: "WEEKLY" | "BIWEEKLY" | "MONTHLY",
//     interval?: number,                       // cada N semanas / N meses
//     byDay?: ["MO","WE", ...],                // solo WEEKLY
//     monthly?: { type: "dayOfMonth" }         // solo MONTHLY (default)
//             | { type: "nthWeekday", nth, weekday },
//     count?: number,  until?: ISO string,
//     endless?: true                           // "Never": sin count ni until
//   }
//
// A diferencia de Monkey, acá NO se arma un string RRULE para Google: la regla
// se guarda como JSON (ver recurrenceService.js). Vive en su propio módulo para
// poder testearlo sin levantar la base. El frontend tiene su espejo
// (src/lib/recurrence.ts): si cambia la lógica de acá, cambiarla allá también.
import { DateTime } from "luxon";
import { TZ } from "../config/timezone.js";

export const WEEKDAYS = ["MO", "TU", "WE", "TH", "FR", "SA", "SU"];
const WEEKDAY_NAMES = {
  MO: "Monday", TU: "Tuesday", WE: "Wednesday", TH: "Thursday",
  FR: "Friday", SA: "Saturday", SU: "Sunday",
};
const NTH_NAMES = { 1: "first", 2: "second", 3: "third", 4: "fourth", "-1": "last" };

const MAX_WEEKLY_INTERVAL = 52;
const MAX_MONTHLY_INTERVAL = 24;
const MAX_COUNT = 1000;

// Error de input del usuario → el controller lo devuelve como 400 (no 500).
export class RecurrenceInputError extends Error {
  constructor(message) {
    super(message);
    this.name = "RecurrenceInputError";
    this.status = 400;
  }
}

// ── normalizeRecurrenceInput ─────────────────────────────────────────────────
// Valida y lleva cualquier input (nuevo o legacy) a una forma canónica:
//   { freq: "WEEKLY"|"MONTHLY", interval, byDay: string[]|null,
//     monthly: null | {type:"dayOfMonth"} | {type:"nthWeekday",nth,weekday},
//     count: number|null, until: string|null, endless: boolean }
export function normalizeRecurrenceInput(input) {
  if (!input || typeof input !== "object") {
    throw new RecurrenceInputError("Recurrence must be an object.");
  }
  let { freq } = input;
  let interval = input.interval;

  if (freq === "BIWEEKLY") {
    freq = "WEEKLY";
    interval = 2;
  }
  if (freq !== "WEEKLY" && freq !== "MONTHLY") {
    throw new RecurrenceInputError(`Unsupported recurrence frequency: ${freq}`);
  }

  interval = interval === undefined || interval === null ? 1 : Number(interval);
  const maxInterval = freq === "WEEKLY" ? MAX_WEEKLY_INTERVAL : MAX_MONTHLY_INTERVAL;
  if (!Number.isInteger(interval) || interval < 1 || interval > maxInterval) {
    throw new RecurrenceInputError(
      `"Repeat every" must be a whole number between 1 and ${maxInterval} ` +
        `${freq === "WEEKLY" ? "weeks" : "months"}.`,
    );
  }

  let byDay = null;
  let monthly = null;

  if (freq === "WEEKLY") {
    if (input.monthly) {
      throw new RecurrenceInputError("A weekly pattern can't have a monthly option.");
    }
    if (input.byDay !== undefined && input.byDay !== null) {
      if (!Array.isArray(input.byDay) || input.byDay.length === 0) {
        throw new RecurrenceInputError("Pick at least one day of the week.");
      }
      const days = input.byDay.map((d) => String(d).toUpperCase());
      const bad = days.find((d) => !WEEKDAYS.includes(d));
      if (bad) throw new RecurrenceInputError(`Invalid day of the week: ${bad}`);
      // únicos y en orden lunes→domingo, para que la regla sea determinística
      byDay = WEEKDAYS.filter((d) => days.includes(d));
    }
  } else {
    if (input.byDay !== undefined && input.byDay !== null) {
      throw new RecurrenceInputError(
        'Days of the week only apply to weekly patterns. For "first Monday" use the monthly option.',
      );
    }
    const m = input.monthly;
    if (!m || m.type === "dayOfMonth") {
      monthly = { type: "dayOfMonth" };
    } else if (m.type === "nthWeekday") {
      const nth = Number(m.nth);
      const weekday = String(m.weekday ?? "").toUpperCase();
      if (![1, 2, 3, 4, -1].includes(nth)) {
        throw new RecurrenceInputError("Position in the month must be first, second, third, fourth or last.");
      }
      if (!WEEKDAYS.includes(weekday)) {
        throw new RecurrenceInputError(`Invalid day of the week: ${m.weekday}`);
      }
      monthly = { type: "nthWeekday", nth, weekday };
    } else {
      throw new RecurrenceInputError(`Unsupported monthly option: ${m.type}`);
    }
  }

  let count = null;
  if (input.count !== undefined && input.count !== null && input.count !== "") {
    count = Number(input.count);
    if (!Number.isInteger(count) || count < 1 || count > MAX_COUNT) {
      throw new RecurrenceInputError(`Number of occurrences must be between 1 and ${MAX_COUNT}.`);
    }
  }
  let until = null;
  if (input.until) {
    if (!DateTime.fromISO(String(input.until), { zone: TZ }).isValid) {
      throw new RecurrenceInputError("The end date is not valid.");
    }
    until = String(input.until);
  }

  // `endless: true` = "Never" (sin COUNT ni UNTIL), como en Google Calendar. Es un
  // opt-in explícito: sin fin ni `endless` la serie se sigue cortando al año.
  const endless = input.endless === true;
  if (endless && (count || until)) {
    throw new RecurrenceInputError("A series that never ends can't also have an end date or a number of occurrences.");
  }

  return { freq, interval, byDay, monthly, count, until, endless };
}

// ── ¿la fecha de inicio cae en la regla? ─────────────────────────────────────
// Una serie cuyo primer evento no calza con BYDAY quedaría "torcida" (p. ej. un
// evento un miércoles en una regla "lunes y viernes"). Mejor un error claro que
// ese estado raro. `startDate` = "yyyy-mm-dd" (día de pared, en la zona del negocio).
function describeDate(d) {
  return d.setLocale("en").toFormat("cccc, LLL d");
}

export function assertRuleFitsStart(input, startDate) {
  const r = normalizeRecurrenceInput(input);
  const d = DateTime.fromISO(String(startDate).slice(0, 10), { zone: "utc" });
  if (!d.isValid) throw new RecurrenceInputError("The start date is not valid.");
  const wd = WEEKDAYS[d.weekday - 1];

  if (r.freq === "WEEKLY" && r.byDay && !r.byDay.includes(wd)) {
    throw new RecurrenceInputError(
      `The start date (${describeDate(d)}) isn't one of the selected days ` +
        `(${r.byDay.map((x) => WEEKDAY_NAMES[x]).join(", ")}). ` +
        "Change the start date or the days of the week.",
    );
  }
  if (r.freq === "MONTHLY" && r.monthly.type === "nthWeekday") {
    const { nth, weekday } = r.monthly;
    const idx = Math.ceil(d.day / 7);
    const isLast = d.day + 7 > d.daysInMonth;
    const ok = wd === weekday && (nth === -1 ? isLast : nth === idx);
    if (!ok) {
      throw new RecurrenceInputError(
        `The start date (${describeDate(d)}) isn't the ${NTH_NAMES[nth]} ` +
          `${WEEKDAY_NAMES[weekday]} of its month. Change the start date or the monthly option.`,
      );
    }
  }
  if (r.until) {
    const u = DateTime.fromISO(r.until, { zone: TZ }).toISODate();
    if (u < d.toISODate()) {
      throw new RecurrenceInputError("The end date is before the start date.");
    }
  }
}
