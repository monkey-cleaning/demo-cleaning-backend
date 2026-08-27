// services/recurrenceService.js
//
// Reemplaza a buildRRule/parseRRule de calendarController.js (que generaban
// y parseaban RRULE en formato Google para mandárselo a la API). Acá no hay
// API externa que hable RRULE — se guarda la recurrencia como JSON simple
// en appointments.recurrence_rule (misma columna, texto) y se expande con
// rrule.js localmente.
//
// NOTA (simplificación de tiempo, MVP): rrule.js trabaja con instantes UTC
// (Date de JS). Para una demo con recurrencia semanal/mensual esto es
// correcto en la enorme mayoría de los casos; el mismo tipo de bug de "offset
// congelado en cambio de DST" que tenía el código original con Google puede
// reaparecer acá en el borde exacto de un cambio de horario. No se resuelve
// en este ticket — si aparece en producción real, se resuelve calculando
// cada instancia en la zona horaria local en vez de UTC puro.

import { DateTime } from "luxon";
import pkg from "rrule";
const { RRule } = pkg;

const FREQ_MAP = { WEEKLY: RRule.WEEKLY, MONTHLY: RRule.MONTHLY };

// { freq, interval, count, until } → string JSON para guardar en
// appointments.recurrence_rule (freq ya normalizado, sin "BIWEEKLY" —
// se guarda como WEEKLY + interval:2, mismo criterio que el código viejo).
export function serializeRecurrence({ freq, interval, count, until }) {
  const normFreq = freq === "BIWEEKLY" ? "WEEKLY" : freq;
  const normInterval = freq === "BIWEEKLY" ? 2 : (interval ?? 1);
  if (!FREQ_MAP[normFreq]) {
    throw new Error(`Unsupported recurrence frequency: ${freq}`);
  }
  return JSON.stringify({
    freq: normFreq,
    interval: normInterval,
    count: count ?? null,
    until: until ?? null,
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

// Reconstruye el objeto RRule de rrule.js a partir de lo guardado + el
// DTSTART real de la serie (siempre el de la fila maestro).
function toRRuleInstance({ freq, interval, count, until }, dtstartIso) {
  return new RRule({
    freq: FREQ_MAP[freq] ?? RRule.WEEKLY,
    interval: interval ?? 1,
    count: count ?? undefined,
    // Si no hay count NI until, tope por defecto de 1 año — mismo criterio
    // de seguridad que tenía buildRRule original (nunca recurrencia infinita
    // sin límite explícito).
    until: until
      ? new Date(until)
      : count
        ? undefined
        : DateTime.fromISO(dtstartIso).plus({ years: 1 }).toJSDate(),
    dtstart: new Date(dtstartIso),
  });
}

// Devuelve un array de fechas (Date de JS, en UTC) para cada ocurrencia de
// la serie entre dtstartIso y el tope (until/count/1 año default).
// materializationCapMonths: tope defensivo extra (mismo espíritu que el
// "instancesTimeMax" del código original) para nunca generar de una sola vez
// una cantidad desmedida de filas si alguien manda un `until` muy lejano.
export function expandRecurrenceDates(
  recurrence,
  dtstartIso,
  { materializationCapMonths = 18 } = {},
) {
  const rule = toRRuleInstance(recurrence, dtstartIso);
  const hardCap = DateTime.fromISO(dtstartIso)
    .plus({ months: materializationCapMonths })
    .toJSDate();
  const allDates = rule.all((date, i) => date <= hardCap);
  return allDates;
}

// Extrae freq/interval "crudos" (para heredar el patrón al hacer split de
// serie en scope=following) — reemplaza a extractFreqInterval.
export function extractFreqInterval(recurrence) {
  return { freq: recurrence.freq, interval: recurrence.interval ?? 1 };
}
