import { supabase } from "./supabaseService.js";

// Una fila de `voice_leads` por llamada telefónica de cotización.
//   - Studio Flow "Quote Bot"  → source "Voice IVR",            key call_sid
//   - Agente de ElevenLabs     → source "Voice AI (ElevenLabs)", key conversation_id
//
// Portado de Monkey Cleaning (LAB290). Antes esto estaba embebido en
// quoteController.calculateQuoteVoiceEndpoint; se extrajo para que el webhook
// post-llamada de ElevenLabs lo reutilice.

const VOICE_LEAD_COLUMNS = new Set([
  "call_sid",
  "conversation_id",
  "from_phone",
  "source",
  "status",
  "cleaning_frequency",
  "bedrooms",
  "full_bathrooms",
  "half_bathrooms",
  "property_size",
  "inside_fridge",
  "inside_freezer",
  "inside_oven",
  "estimated_total_cad",
  "estimated_total_hours",
  "hourly_rate_cad",
  "calc_type",
  "wants_to_book",
  "escalated",
  "escalation_reason",
  "caller_name",
  "callback_number",
  "transcript_summary",
  "caller_notes",
  "raw",
]);

/**
 * Upsert de una fila en `voice_leads`. Nunca tira: loguea y devuelve null ante
 * error (una llamada no se rompe porque falló el registro).
 *
 * @param {Record<string, unknown>} fields  campos a escribir (se filtran a columnas conocidas; undefined se ignora)
 * @param {{ onConflict?: "call_sid" | "conversation_id" }} [opts]
 * @returns {Promise<object|null>} la fila guardada, o null
 */
export async function saveVoiceLead(fields, { onConflict = "call_sid" } = {}) {
  const payload = {};
  for (const [k, v] of Object.entries(fields || {})) {
    if (VOICE_LEAD_COLUMNS.has(k) && v !== undefined) payload[k] = v;
  }
  payload.updated_at = new Date().toISOString();

  try {
    const hasKey = payload[onConflict] != null && payload[onConflict] !== "";
    const query = hasKey
      ? supabase.from("voice_leads").upsert(payload, { onConflict })
      : supabase.from("voice_leads").insert(payload);

    const { data, error } = await query.select().single();
    if (error) {
      console.error(`[voiceLeadService] save error: ${error.message}`);
      return null;
    }
    return data;
  } catch (e) {
    console.error(`[voiceLeadService] unexpected: ${e.message}`);
    return null;
  }
}

/**
 * Mapea un `lead` + el resultado de calculateQuote() a columnas de voice_leads.
 * @param {object} lead    forma interna { cleaningFrequency, bedrooms, fullBathrooms, ... }
 * @param {object} result  retorno de calculateQuote()
 */
export function voiceLeadFieldsFromQuote(lead = {}, result = {}) {
  return {
    cleaning_frequency: lead.cleaningFrequency ?? null,
    bedrooms: lead.bedrooms ?? null,
    full_bathrooms: lead.fullBathrooms ?? null,
    half_bathrooms: lead.halfBathrooms ?? null,
    property_size: lead.propertySize ?? null,
    inside_fridge: yesNoOrNull(lead.insideFridge),
    inside_freezer: yesNoOrNull(lead.insideFreezer),
    inside_oven: yesNoOrNull(lead.insideOven),
    estimated_total_cad: result.totalAmount ?? null,
    estimated_total_hours: result.totalHrs ?? null,
    hourly_rate_cad: result.hourlyRate ?? null,
    calc_type: result.calcType ?? null,
  };
}

function yesNoOrNull(v) {
  const s = String(v ?? "").trim().toLowerCase();
  if (s === "yes") return "yes";
  if (s === "no") return "no";
  return null;
}
