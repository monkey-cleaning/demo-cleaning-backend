// config/timezone.js
//
// Única fuente de verdad de la zona horaria del negocio. Antes cada archivo
// declaraba la suya (`process.env.BOOKING_TIMEZONE || "America/Vancouver"`),
// así que cambiar la regla de zona significaba tocar ~40 archivos.
//
// ── Por qué existe el respaldo (nov 2026) ────────────────────────────────────
// British Columbia adopta hora de verano permanente: America/Vancouver queda en
// UTC-7 TODO el año desde 2026-11-01. Las reglas nuevas llegan en tzdata >=
// 2026b. Un Node con datos viejos (anterior a 22.23.3 / 24.16.0) sigue
// calculando UTC-8 en invierno, mientras los navegadores actualizados usan
// UTC-7: el mismo evento difiere una hora entre servidor y pantalla.
//
// Si el runtime NO tiene las reglas nuevas, se calcula con "Etc/GMT+7" (UTC-7
// fijo, el signo de Etc/GMT está invertido a propósito), correcto para
// cualquier fecha desde 2026-03-09. Si las tiene, no cambia nada. La decisión
// se toma midiendo el comportamiento real, no comparando versiones.
// Solo aplica a America/Vancouver: otra zona configurada se respeta tal cual.
//
// ── Dos nombres, dos usos ────────────────────────────────────────────────────
//   TZ        zona para CALCULAR: luxon `zone:`, Intl `timeZone:`, crons y
//             process.env.TZ. Puede ser el respaldo.
//   TZ_LABEL  etiqueta IANA configurada, para GUARDAR en la base
//             (`appointments.timezone`): es una etiqueta, no un cálculo.

import "dotenv/config";
import { DateTime } from "luxon";

const CONFIGURED = process.env.BOOKING_TIMEZONE || "America/Vancouver";

// Un día de pleno invierno, bien después del 2026-11-01.
const PROBE = "2026-12-01T12:00:00";
const FIXED_UTC_MINUS_7 = "Etc/GMT+7";

function resolveCalculationZone(name) {
  if (name !== "America/Vancouver") return name;
  const probe = DateTime.fromISO(PROBE, { zone: name });
  return probe.isValid && probe.offset === -420 ? name : FIXED_UTC_MINUS_7;
}

export const TZ_LABEL = CONFIGURED;
export const TZ = resolveCalculationZone(CONFIGURED);
export const TZ_IS_FALLBACK = TZ !== CONFIGURED;

// Se fija acá (y no en index.js) para que valga antes de que se evalúe
// cualquier otro módulo: los imports ESM se evalúan antes que el cuerpo de
// index.js.
process.env.TZ = TZ;

export function describeTimezone() {
  return {
    node: process.version,
    tzdata: process.versions.tz,
    configured: CONFIGURED,
    calculationZone: TZ,
    fallback: TZ_IS_FALLBACK,
    vancouverOffsetDec2026: DateTime.fromISO(PROBE, { zone: CONFIGURED }).offset / 60,
  };
}

const info = describeTimezone();
if (TZ_IS_FALLBACK) {
  console.warn(
    `⚠️  [Timezone] Este Node (${info.node}, tzdata ${info.tzdata}) todavía calcula ` +
      `${CONFIGURED} con UTC${info.vancouverOffsetDec2026} en diciembre. Se usa ${TZ} (UTC-7 fijo). ` +
      "Subí Node a >= 22.23.3 (o 24.16+) para volver a las reglas oficiales.",
  );
} else {
  console.log(
    `🕒 [Timezone] ${TZ} OK (Node ${info.node}, tzdata ${info.tzdata}, dic-2026 = UTC${info.vancouverOffsetDec2026})`,
  );
}
