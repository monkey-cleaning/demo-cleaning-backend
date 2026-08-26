// services/colorAssignmentService.js
//
// Reglas compartidas de asignación de color (colorId de GCal) entre equipos
// (`teams.color_ids`) y los 3 roles especiales que viven en `settings`
// (confirmar_color_id, non_service_color_id, individual_color_id — ver
// eventClassification.js). Un mismo colorId no puede estar en dos lugares a
// la vez: si "Team 2" y "CONFIRMAR" compartieran colorId, un evento
// pendiente de confirmar sería indistinguible de un servicio ya asignado a
// ese equipo. Centralizado acá para que settingsController.js
// (confirmar/non_service/individual) y teamAssignmentController.js
// (createTeam/updateTeam) validen contra la MISMA fuente en vez de
// reimplementar el chequeo cada uno por su lado.
//
// Uso típico:
//   import { validateColorOverrides } from "./colorAssignmentService.js";
//   const check = await validateColorOverrides({ teams: { team_4: "9" } });
//   if (!check.ok) return res.status(409).json({ ok: false, error: check.error });

import { supabase } from "../supabaseClient.js";

// Paleta fija de colorId de evento de Google Calendar (colors().get →
// paleta "event"). Recordar: el hex "oficial" que devuelve la API no
// coincide con el que se ve en el picker de la UI (tema de renderizado de
// Google, ya documentado en la migración a detección por color de ago
// 2026) — por eso acá solo exponemos id + nombre. El hex de UI (para
// badges/dots del dashboard) lo elige el admin aparte, libremente, sin
// relación con este id.
export const GCAL_COLOR_OPTIONS = [
  { id: "1", name: "Lavender" },
  { id: "2", name: "Sage" },
  { id: "3", name: "Grape" },
  { id: "4", name: "Flamingo" },
  { id: "5", name: "Banana" },
  { id: "6", name: "Tangerine" },
  { id: "7", name: "Peacock" },
  { id: "8", name: "Graphite" },
  { id: "9", name: "Blueberry" },
  { id: "10", name: "Basil" },
  { id: "11", name: "Tomato" },
];

const GCAL_COLOR_IDS = new Set(GCAL_COLOR_OPTIONS.map((c) => c.id));

// Keys en `settings` que reservan un colorId para un rol que NO es un
// equipo. Si se agrega un 4to rol especial en el futuro, solo hace falta
// sumarlo acá — el resto (validación de colisión, refresh de
// eventClassification.js) sigue funcionando sin cambios.
export const SPECIAL_COLOR_SETTING_KEYS = [
  "confirmar_color_id",
  "non_service_color_id",
  "individual_color_id",
];

export function isValidGcalColorId(colorId) {
  return GCAL_COLOR_IDS.has(String(colorId ?? ""));
}

/**
 * Snapshot del estado actual: qué colorId tiene cada equipo activo y cada
 * rol especial. owner key = `team:${teamId}` | `setting:${settingKey}`.
 */
async function getCurrentColorOwnerMap() {
  const [teamsRes, settingsRes] = await Promise.all([
    supabase.from("teams").select("id, color_ids").eq("is_active", true),
    supabase
      .from("settings")
      .select("key, value")
      .in("key", SPECIAL_COLOR_SETTING_KEYS),
  ]);

  if (teamsRes.error) throw teamsRes.error;
  if (settingsRes.error) throw settingsRes.error;

  const ownerToColorId = new Map();

  for (const t of teamsRes.data ?? []) {
    // Un equipo activo debería tener siempre exactamente un colorId (se
    // exige al crearlo) — tomamos el primero por las dudas de datos viejos
    // con más de uno.
    const cid = (t.color_ids ?? [])[0];
    if (cid) ownerToColorId.set(`team:${t.id}`, String(cid));
  }

  for (const row of settingsRes.data ?? []) {
    if (row.value) ownerToColorId.set(`setting:${row.key}`, String(row.value));
  }

  return ownerToColorId;
}

/**
 * Valida que, de aplicarse `overrides`, ningún colorId termine asignado a
 * más de un dueño (equipo o rol especial) a la vez.
 *
 * Soporta swaps: si el mismo request cambia dos roles al mismo tiempo (ej.
 * intercambiar el color de dos equipos, o mover CONFIRMAR al color que
 * dejó libre un equipo desactivado), cada override "mueve" a su dueño a la
 * posición nueva ANTES de chequear duplicados — evita el falso positivo de
 * comparar contra un estado a mitad de camino. Mismo cuidado que la
 * migración de colores de julio ("el orden importa" al hacer updates uno
 * por uno contra la DB).
 *
 * @param {{ teams?: Record<string,string>, settings?: Record<string,string> }} overrides
 *   teams: { [teamId]: colorId } — para createTeam/updateTeam
 *   settings: { [settingKey]: colorId } — para confirmar/non_service/individual
 * @returns {Promise<{ ok: true } | { ok: false, error: string }>}
 */
export async function validateColorOverrides({ teams = {}, settings = {} } = {}) {
  const allNewColorIds = [...Object.values(teams), ...Object.values(settings)];
  for (const cid of allNewColorIds) {
    if (!isValidGcalColorId(cid)) {
      return {
        ok: false,
        error: `"${cid}" no es un colorId válido de Google Calendar (1-11).`,
      };
    }
  }

  const finalByOwner = await getCurrentColorOwnerMap();
  for (const [teamId, colorId] of Object.entries(teams)) {
    finalByOwner.set(`team:${teamId}`, String(colorId));
  }
  for (const [settingKey, colorId] of Object.entries(settings)) {
    finalByOwner.set(`setting:${settingKey}`, String(colorId));
  }

  const ownersByColorId = new Map();
  for (const [ownerKey, colorId] of finalByOwner) {
    const list = ownersByColorId.get(colorId) ?? [];
    list.push(ownerKey);
    ownersByColorId.set(colorId, list);
  }

  for (const [colorId, owners] of ownersByColorId) {
    if (owners.length > 1) {
      return {
        ok: false,
        error: `El colorId "${colorId}" quedaría asignado a más de un lugar a la vez: ${owners.join(", ")}.`,
      };
    }
  }

  return { ok: true };
}