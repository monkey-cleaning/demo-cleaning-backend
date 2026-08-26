// services/eventClassification.js
//
// Fuente única de verdad para clasificar eventos de GCal: equipo, pendiente
// de confirmación, o "no es un servicio de limpieza".
//
// Reemplaza el esquema anterior basado en texto del título ("#N", "CONFIRMAR",
// "*") por un esquema basado en `colorId` del evento. Un evento tiene un solo
// color → los tres estados (team_1, team_2, CONFIRMAR, no-servicio) son
// mutuamente excluyentes entre sí. Ver memoria del cambio (LAB — color-based
// detection, ago 2026) para el contexto completo.
//
// EXCEPCIÓN: "lunch" NO se clasifica por color acá. Sigue siendo detectado
// por keyword de texto en calendarAvailabilitySync.js (BLOCK_BOTH_KEYWORDS),
// porque un lunch puede llevar el color de un equipo (agrupación visual) sin
// que eso lo saque de la exclusión de disponibilidad. isNonServiceEvent() de
// este módulo NO cubre lunch — quien la llama para calcular disponibilidad
// tiene que seguir chequeando lunch por separado.
//
// Antes de usar isNonServiceEvent / isPendingConfirmation / detectTeamByColor
// hay que llamar una vez a loadClassificationConfig() (falla silenciosa a
// los defaults de abajo si no se pudo leer settings — igual criterio que
// TEAMS_CONFIG en calendarController.js / calendarAvailabilitySync.js).

import { supabase } from "../supabaseClient.js";

let CONFIRMAR_COLOR_ID = "5"; // Banana — fallback si falla la carga de settings
let NON_SERVICE_COLOR_ID = "4"; // Flamingo — fallback si falla la carga de settings
let INDIVIDUAL_COLOR_ID = "9"; // Blueberry/Indigo — fallback si falla la carga de settings

// ── loadClassificationConfig ────────────────────────────────────────────────
// Lee confirmar_color_id / non_service_color_id de la tabla settings. Llamar
// al boot de cada proceso que use este módulo (mismo patrón que
// loadTeamsFromDB en calendarAvailabilitySync.js).
export async function loadClassificationConfig() {
  const { data, error } = await supabase
    .from("settings")
    .select("key, value")
    .in("key", [
      "confirmar_color_id",
      "non_service_color_id",
      "individual_color_id",
    ]);

  if (error) {
    console.warn(
      "⚠️ [eventClassification] No se pudo cargar config desde settings, uso fallback:",
      error.message,
    );
    return;
  }

  for (const row of data ?? []) {
    if (row.key === "confirmar_color_id" && row.value) {
      CONFIRMAR_COLOR_ID = String(row.value);
    }
    if (row.key === "non_service_color_id" && row.value) {
      NON_SERVICE_COLOR_ID = String(row.value);
    }
    if (row.key === "individual_color_id" && row.value) {
      INDIVIDUAL_COLOR_ID = String(row.value);
    }
  }

  console.log(
    `✅ [eventClassification] Config cargada — confirmar=${CONFIRMAR_COLOR_ID}, non_service=${NON_SERVICE_COLOR_ID}`,
  );
}

export function getConfirmarColorId() {
  return CONFIRMAR_COLOR_ID;
}

export function getNonServiceColorId() {
  return NON_SERVICE_COLOR_ID;
}

export function getIndividualColorId() {
  return INDIVIDUAL_COLOR_ID;
}

// ── isIndividualAssignment ──────────────────────────────────────────────────
// Evento Indigo: un solo cleaner asignado, NO se resuelve a equipo. El
// cleaner puede pertenecer a un team_X en otro horario del mismo día — por
// eso esto es una categoría aparte, no un "team" más. No confundir con
// isNonServiceEvent (eso es "no es limpieza"); esto SÍ es limpieza, solo que
// individual en vez de por equipo.
export function isIndividualAssignment(e) {
  return String(e?.colorId ?? "") === INDIVIDUAL_COLOR_ID;
}

// ── isNonServiceEvent ────────────────────────────────────────────────────────
// Recibe el EVENTO completo (no el summary) — necesita e.colorId.
// NO cubre lunch (ver nota de cabecera): un lunch coloreado como equipo no
// entra acá, y eso es intencional.
export function isNonServiceEvent(e) {
  return String(e?.colorId ?? "") === NON_SERVICE_COLOR_ID;
}

// ── isPendingConfirmation ────────────────────────────────────────────────────
// Recibe el EVENTO completo (no el summary) — necesita e.colorId.
export function isPendingConfirmation(e) {
  return String(e?.colorId ?? "") === CONFIRMAR_COLOR_ID;
}

// ── isLunchEvent ─────────────────────────────────────────────────────────
// Lunch sigue detectándose por texto, no por color (ver nota de cabecera).
// Acá centralizamos el keyword-check para no seguir duplicándolo — hoy
// vive por separado en calendarAvailabilitySync.js (BLOCK_BOTH_KEYWORDS) y
// como función local en teamAutoAssignService.js. Ninguno de los dos se
// migra en este cambio (fuera de alcance), pero cualquier código nuevo
// (LAB275 — cálculo del buffer de traslado) usa esta versión.
export function isLunchEvent(summary) {
  return /^lunch(\s*#\s*\d+)?$/i.test((summary ?? "").trim());
}

// ── detectTeamByColor ────────────────────────────────────────────────────────
// Recibe el EVENTO completo y el TEAMS_CONFIG del caller (no lo importa acá
// a propósito: TEAMS_CONFIG hoy se carga por duplicado en
// calendarController.js y calendarAvailabilitySync.js — deuda técnica previa,
// fuera de alcance de este cambio). Devuelve el teamId (ej. "team_1") o null.
export function detectTeamByColor(e, TEAMS_CONFIG) {
  const colorId = String(e?.colorId ?? "");
  if (!colorId || !TEAMS_CONFIG) return null;
  return (
    Object.keys(TEAMS_CONFIG).find((tid) =>
      TEAMS_CONFIG[tid]?.colorIds?.includes(colorId),
    ) ?? null
  );
}

// ── getTeamColorId ────────────────────────────────────────────────────────
// Inverso de detectTeamByColor: dado un teamId, devuelve el primer colorId
// asociado. Se usa en teamAutoAssignService.js para escribir el color a GCal
// cuando auto-asigna un equipo a un evento.
export function getTeamColorId(teamId, TEAMS_CONFIG) {
  return TEAMS_CONFIG?.[teamId]?.colorIds?.[0] ?? null;
}
