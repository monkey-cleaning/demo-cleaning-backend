// services/recordHistory.js
//
// LAB418 (portado de Monkey Cleaning) — punto único para escribir el historial
// de cambios de cualquier entidad en `record_history`.
//
//   recordHistory('client', clientId, [{ field, oldValue, newValue }], { reason })
//
// El actor (`changed_by`) y el origen (`source`) salen del contexto de request
// (ver lib/actorContext.js) si no se pasan explícitos. NUNCA tira: un fallo de
// auditoría no puede romper el update de negocio.
//
// NOTA vs Monkey: se quitó hasRecentPlatformChange() (dedupe con el sync
// horario de Google Calendar) porque este fork no tiene ese sync.

import { DateTime } from "luxon";
import { supabase } from "../supabaseClient.js";
import { getActor, getSource } from "../lib/actorContext.js";

// `record_history.entity_id` es uuid. Settings no tiene uno propio (key/value),
// así que todas sus filas comparten este id fijo — `changed_field` ES la key.
export const GLOBAL_ENTITY_ID = "00000000-0000-0000-0000-000000000000";

function normVal(v) {
  if (v == null) return null;
  const s = String(v);
  return s === "" ? null : s;
}

// Normaliza un timestamp a ISO-UTC para que old_value y new_value queden en el
// mismo formato (si no, "+00:00" de Supabase vs "-07:00" de un toISO local se
// ven como un cambio que no es).
function normTs(v) {
  if (v == null || v === "") return null;
  const dt = DateTime.fromISO(String(v));
  return dt.isValid ? dt.toUTC().toISO({ suppressMilliseconds: true }) : String(v);
}

// Dos timestamps son "iguales" si representan el mismo instante.
function timesEqual(a, b) {
  if (a == null && b == null) return true;
  if (a == null || b == null) return false;
  const da = DateTime.fromISO(String(a));
  const db = DateTime.fromISO(String(b));
  if (!da.isValid || !db.isValid) return String(a) === String(b);
  return da.toMillis() === db.toMillis();
}

/**
 * Calcula qué campos cambiaron entre dos filas.
 * @param {object|null} oldRow
 * @param {object|null} newRow
 * @param {string[]} fields
 * @param {{ timestampFields?: Set<string> }} [opts]
 * @returns {{ field: string, oldValue: string|null, newValue: string|null }[]}
 */
export function diffFields(oldRow, newRow, fields, { timestampFields } = {}) {
  const tsf = timestampFields ?? new Set();
  const changes = [];
  for (const field of fields) {
    const oldV = oldRow ? oldRow[field] : undefined;
    const newV = newRow ? newRow[field] : undefined;
    if (tsf.has(field)) {
      if (timesEqual(oldV, newV)) continue;
      const o = normTs(oldV);
      const n = normTs(newV);
      if (o !== n) changes.push({ field, oldValue: o, newValue: n });
      continue;
    }
    const o = oldV == null ? "" : String(oldV);
    const n = newV == null ? "" : String(newV);
    if (o !== n)
      changes.push({ field, oldValue: o || null, newValue: n || null });
  }
  return changes;
}

/**
 * Inserta filas de historial.
 * @param {string} entityType  'appointment'|'client'|'invoice'|'employee'|'payment'|'setting'
 * @param {string} entityId
 * @param {Array<{ field?: string, changed_field?: string, oldValue?: any, old_value?: any, newValue?: any, new_value?: any }>} changes
 * @param {{ changedBy?: string, source?: string, reason?: string }} [opts]
 * @returns {Promise<number>} filas escritas
 */
export async function recordHistory(entityType, entityId, changes, opts = {}) {
  const list = Array.isArray(changes) ? changes.filter(Boolean) : [];
  if (!list.length || !entityId) return 0;

  const changedBy = opts.changedBy ?? getActor();
  const source = opts.source ?? getSource();

  const rows = list.map((c) => ({
    entity_type: entityType,
    entity_id: entityId,
    changed_field: c.field ?? c.changed_field,
    old_value: normVal(c.oldValue ?? c.old_value),
    new_value: normVal(c.newValue ?? c.new_value),
    changed_by: changedBy,
    source,
    reason: opts.reason ?? null,
  }));

  try {
    const { error } = await supabase.from("record_history").insert(rows);
    if (error) {
      console.error("⚠️  record_history insert error:", error.message);
      return 0;
    }
  } catch (e) {
    console.error("⚠️  record_history insert threw:", e.message);
    return 0;
  }
  return rows.length;
}

/**
 * Atajo: diff + insert en una llamada. Sin snapshot previo no registra nada
 * (los creates usan recordHistory() directo con una fila 'created').
 */
export async function recordEntityChange(
  entityType,
  entityId,
  oldRow,
  newRow,
  fields,
  opts = {},
) {
  if (!oldRow) return 0;
  const changes = diffFields(oldRow, newRow, fields, {
    timestampFields: opts.timestampFields,
  });
  return recordHistory(entityType, entityId, changes, opts);
}
