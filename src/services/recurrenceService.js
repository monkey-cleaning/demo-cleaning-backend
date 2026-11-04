// services/recurrenceService.js
//
// Reemplaza a buildRRule/parseRRule de calendarController.js (que generaban
// y parseaban RRULE en formato Google para mandárselo a la API). Acá no hay
// API externa que hable RRULE — se guarda la recurrencia como JSON simple
// en appointments.recurrence_rule (misma columna, texto) y se expande con
// rrule.js localmente.
//
// LAB617: el JSON ahora puede llevar `byDay` (varios días de la semana),
// `monthly` ("primer lunes", "último viernes"…) y `endless` ("Never"). Los
// registros viejos { freq, interval, count, until } siguen siendo válidos.
//
// Hora local ("flotante"): rrule.js trabaja con instantes UTC. Si se le pasa el
// DTSTART real, el día de la semana se evalúa en UTC y una visita de la tarde
// (02:00 UTC del día siguiente) caería en otro día; además cada instancia
// conservaría el offset congelado a través de un cambio de horario. Por eso se
// expande en "reloj de pared": la hora local del negocio se codifica como si
// fuera UTC, se corre rrule, y cada resultado se vuelve a convertir a instante
// real con la zona del negocio.

import { DateTime } from "luxon";
import pkg from "rrule";
import { TZ } from "../config/timezone.js";
import {
  normalizeRecurrenceInput,
  assertRuleFitsStart,
  RecurrenceInputError,
  WEEKDAYS,
} from "./recurrenceRule.js";

const { RRule } = pkg;

export { RecurrenceInputError, assertRuleFitsStart };

const FREQ_MAP = { WEEKLY: RRule.WEEKLY, MONTHLY: RRule.MONTHLY };
const RRULE_DAYS = [RRule.MO, RRule.TU, RRule.WE, RRule.TH, RRule.FR, RRule.SA, RRule.SU];
const rruleDay = (code) => RRULE_DAYS[WEEKDAYS.indexOf(code)];

// Input del panel (nuevo o legacy) → string JSON para appointments.recurrence_rule.
// Valida y normaliza (lanza RecurrenceInputError, que el controller devuelve
// como 400). BIWEEKLY se guarda como WEEKLY + interval:2.
export function serializeRecurrence(input) {
  const r = normalizeRecurrenceInput(input);
  return JSON.stringify({
    freq: r.freq,
    interval: r.interval,
    byDay: r.byDay,
    monthly: r.monthly,
    count: r.count,
    until: r.until,
    endless: r.endless,
  });
}

export function deserializeRecurrence(json) {
  if (!json) return null;
  try {
    return JSON.parse(json);
  } catch {
    return null;
  }
}

// Codifica un instante como "reloj de pared" del negocio dentro de un Date UTC.
function toWallClock(dt) {
  const l = dt.setZone(TZ);
  return new Date(Date.UTC(l.year, l.month - 1, l.day, l.hour, l.minute, l.second));
}

// Inverso: un Date "reloj de pared" → el instante real en la zona del negocio.
function fromWallClock(date) {
  return DateTime.fromObject(
    {
      year: date.getUTCFullYear(),
      month: date.getUTCMonth() + 1,
      day: date.getUTCDate(),
      hour: date.getUTCHours(),
      minute: date.getUTCMinutes(),
      second: date.getUTCSeconds(),
    },
    { zone: TZ },
  ).toJSDate();
}

// Reconstruye el objeto RRule de rrule.js a partir de lo guardado + el
// DTSTART real de la serie (siempre el de la fila maestro).
function toRRuleInstance(recurrence, dtstartIso) {
  const { freq, interval, byDay, monthly, count, until, endless } = recurrence;
  const start = DateTime.fromISO(dtstartIso, { zone: TZ });

  const options = {
    freq: FREQ_MAP[freq] ?? RRule.WEEKLY,
    interval: interval ?? 1,
    dtstart: toWallClock(start),
  };
  if (freq === "WEEKLY" && byDay?.length) {
    options.byweekday = byDay.map(rruleDay);
  }
  if (freq === "MONTHLY" && monthly?.type === "nthWeekday") {
    options.byweekday = [rruleDay(monthly.weekday).nth(monthly.nth)];
  }

  if (count) {
    options.count = count;
  } else if (until) {
    options.until = toWallClock(DateTime.fromISO(until, { zone: TZ }).endOf("day"));
  } else if (!endless) {
    // Sin count NI until (ni "Never"): tope por defecto de 1 año, contado desde
    // el inicio de la serie, con el día aniversario completo — nunca
    // recurrencia infinita por accidente.
    options.until = toWallClock(start.plus({ years: 1 }).endOf("day"));
  }
  return new RRule(options);
}

// Devuelve un array de fechas (Date de JS, instantes reales) para cada
// ocurrencia de la serie entre dtstartIso y el tope (until/count/1 año
// default). materializationCapMonths es un tope defensivo: una serie "Never"
// (o con un `until` muy lejano) nunca genera de una sola vez más que eso.
export function expandRecurrenceDates(
  recurrence,
  dtstartIso,
  { materializationCapMonths = 18 } = {},
) {
  const rule = toRRuleInstance(recurrence, dtstartIso);
  const hardCap = toWallClock(
    DateTime.fromISO(dtstartIso, { zone: TZ }).plus({ months: materializationCapMonths }),
  );
  return rule.all((date) => date <= hardCap).map(fromWallClock);
}

// Patrón "crudo" de una serie (sin fin), para heredarlo al hacer split de
// serie en scope=following: conserva byDay/monthly, que antes se perdían.
export function extractPattern(recurrence) {
  return {
    freq: recurrence.freq,
    interval: recurrence.interval ?? 1,
    byDay: recurrence.byDay ?? null,
    monthly: recurrence.monthly ?? null,
  };
}

// Compat: antes devolvía solo freq/interval.
export function extractFreqInterval(recurrence) {
  return { freq: recurrence.freq, interval: recurrence.interval ?? 1 };
}

// Lo guardado → la forma que consume el panel (GET /series/:id/recurrence).
// `preset` es lo que el selector "Repeats" muestra sin abrir el modal Custom.
export function describeRecurrence(raw) {
  const freq = raw.freq === "MONTHLY" ? "MONTHLY" : "WEEKLY";
  const interval = Number(raw.interval) || 1;
  const byDay = raw.byDay?.length ? raw.byDay : null;
  const monthly = freq === "MONTHLY" ? (raw.monthly ?? { type: "dayOfMonth" }) : null;

  let preset = "CUSTOM";
  if (freq === "WEEKLY" && (!byDay || byDay.length === 1) && [1, 2, 4].includes(interval)) {
    preset = interval === 1 ? "WEEKLY" : interval === 2 ? "BIWEEKLY" : "EVERY_4_WEEKS";
  }

  const endType = raw.until ? "until" : raw.count ? "count" : "never";
  return {
    freq: freq === "WEEKLY" && interval === 2 ? "BIWEEKLY" : freq,
    preset,
    supported: true,
    interval,
    byDay,
    monthly,
    endType,
    count: raw.count ?? null,
    until: raw.until ?? null,
  };
}
