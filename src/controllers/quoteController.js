import { calculateQuote } from "../services/cleaningQuoteCalculator.js";
import { computeQuoteResponse } from "../services/quoteMapping.js";
import { supabase } from "../services/supabaseService.js";

const WEBHOOK_TOKEN = process.env.ELEVENLABS_WEBHOOK_TOKEN;

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/quote/calculate
// Tool webhook del agente de ElevenLabs (cotización en vivo). Solo calcula: no
// toca la BD ni manda mails. La validación/mapeo vive en services/quoteMapping.js.
//
// Antes esta función leía result.tier / result.ratePerHour / result.totalLaborHours
// / result.clockHoursForTwoPeople — campos que cleaningQuoteCalculator.js NUNCA
// devolvió (devuelve calcType / hourlyRate / totalHrs / hrsPerPerson / totalAmount),
// así que el agente recibía undefined para todo salvo el total. Portado de
// Monkey Cleaning (LAB290) que arregló exactamente este bug.
// ─────────────────────────────────────────────────────────────────────────────
export async function calculateQuoteEndpoint(req, res) {
  try {
    const auth = req.get("authorization") || req.get("Authorization") || "";
    const ok = WEBHOOK_TOKEN && auth.trim() === `Bearer ${WEBHOOK_TOKEN}`;
    if (!ok) return res.status(401).json({ error: "Unauthorized" });

    const { httpStatus, payload, lead, result } = computeQuoteResponse(
      req.body || {},
    );

    if (httpStatus === 200) {
      console.log(
        `[QUOTE] ${new Date().toISOString()} | ${lead.cleaningFrequency} | ${lead.bedrooms} | ${lead.fullBathrooms} | $${result.totalAmount} CAD @ $${result.hourlyRate}/h | ${result.totalHrs}h`,
      );
    } else {
      console.warn(
        `[QUOTE] ${httpStatus} ${payload.code || ""} ${payload.error || ""}`,
      );
    }

    return res.status(httpStatus).json(payload);
  } catch (e) {
    console.error("[QUOTE] error:", e);
    return res
      .status(500)
      .json({ error: "Internal error calculating quote", code: "INTERNAL" });
  }
}

// ─────────────────────────────────────────────────────────────
// Twilio Voice IVR (digit_freq, digit_bedrooms, etc.)
// ─────────────────────────────────────────────────────────────

// Mapeo de dígitos capturados por Twilio Studio (voz o teclado, ya normalizados
// a "1"-"5" por los widgets set_freq_*, set_bed_*, etc.) → strings que espera
// cleaningQuoteCalculator.js
const VOICE_FREQUENCY_MAP = {
  1: "Weekly",
  2: "Biweekly",
  3: "Monthly",
  4: "One Time Cleaning",
};

const VOICE_BEDROOMS_MAP = {
  1: "Studio",
  2: "One Bedroom",
  3: "Two Bedrooms",
  4: "Three Bedrooms",
  5: "Four Bedrooms",
};

const VOICE_BATHROOMS_MAP = {
  1: "1 Bathroom",
  2: "2 Bathrooms",
  3: "3 Bathrooms",
  4: "4+ Bathrooms",
};

const VOICE_REQUIRED_FIELDS = [
  "digit_freq",
  "digit_bedrooms",
  "digit_bathrooms",
];

/**
 * POST /api/quote/voice
 * Llamado por el Studio Flow "Quote Bot".
 * Calcula la cotización + guarda un registro en voice_leads.
 */
export async function calculateQuoteVoiceEndpoint(req, res) {
  try {
    const body = req.body || {};

    const missing = VOICE_REQUIRED_FIELDS.filter((f) => !body[f]);
    if (missing.length > 0) {
      console.warn(
        `[QUOTE-VOICE] Missing fields: ${missing.join(", ")} | CallSid: ${body.CallSid}`,
      );
      return res.status(400).json({ error: `Missing: ${missing.join(", ")}` });
    }

    const cleaningFrequency =
      VOICE_FREQUENCY_MAP[String(body.digit_freq).trim()];
    const bedrooms = VOICE_BEDROOMS_MAP[String(body.digit_bedrooms).trim()];
    const fullBathrooms =
      VOICE_BATHROOMS_MAP[String(body.digit_bathrooms).trim()];

    if (!cleaningFrequency || !bedrooms || !fullBathrooms) {
      console.warn(
        `[QUOTE-VOICE] Invalid digit selection | freq=${body.digit_freq} bed=${body.digit_bedrooms} bath=${body.digit_bathrooms} | CallSid: ${body.CallSid}`,
      );
      return res.status(400).json({ error: "Invalid digit selection" });
    }

    const lead = {
      cleaningFrequency,
      bedrooms,
      fullBathrooms,
      insideFridge: body.digit_extra_fridge === "1" ? "yes" : undefined,
      insideFreezer: body.digit_extra_freezer === "1" ? "yes" : undefined,
      insideOven: body.digit_extra_oven === "1" ? "yes" : undefined,
    };

    const result = calculateQuote(lead);

    // ────────────────────────────────────────────────
    // Guardar en voice_leads
    // ────────────────────────────────────────────────
    try {
      const voiceLeadPayload = {
        call_sid: body.CallSid || null,
        from_phone: body.From || null,
        cleaning_frequency: cleaningFrequency,
        bedrooms,
        full_bathrooms: fullBathrooms,
        inside_fridge: body.digit_extra_fridge === "1" ? "yes" : null,
        inside_freezer: body.digit_extra_freezer === "1" ? "yes" : null,
        inside_oven: body.digit_extra_oven === "1" ? "yes" : null,
        estimated_total_cad: result.totalAmount,
        estimated_total_hours: result.totalHrs,
        hourly_rate_cad: result.hourlyRate ?? result.ratePerHour ?? null,
        calc_type: result.calcType ?? result.tier ?? null,
        status: "quoted",
        source: "Voice IVR",
      };

      const { data: saved, error: dbError } = await supabase
        .from("voice_leads")
        .upsert(voiceLeadPayload, { onConflict: "call_sid" })
        .select()
        .single();

      if (dbError) {
        console.error(
          "[QUOTE-VOICE] Error saving voice_lead:",
          dbError.message,
        );
        // No rompemos la llamada por esto: igual devolvemos la cotización
      } else {
        console.log(
          `[QUOTE-VOICE] voice_lead saved | id=${saved?.id} | CallSid=${body.CallSid}`,
        );
      }
    } catch (dbErr) {
      console.error("[QUOTE-VOICE] Unexpected DB error:", dbErr.message);
    }

    // ────────────────────────────────────────────────
    // Respuesta para Twilio Studio
    // ────────────────────────────────────────────────
    console.log(
      `[QUOTE-VOICE] ${new Date().toISOString()} | CallSid: ${body.CallSid} | From: ${body.From} | Frequency: ${cleaningFrequency} | Bedrooms: ${bedrooms} | Bathrooms: ${fullBathrooms} | Total: $${result.totalAmount} CAD | Hours: ${result.totalHrs}h`,
    );

    const frequencyLabel =
      cleaningFrequency === "One Time Cleaning"
        ? "one time service"
        : `${cleaningFrequency.toLowerCase()} cleaning`;

    const message = `Your estimate is $${result.totalAmount} CAD for ${result.totalHrs} hours of work. This is before applicable taxes.`;
    const details = `Based on ${frequencyLabel}, ${bedrooms.toLowerCase()} and ${fullBathrooms.toLowerCase()}.`;

    return res.status(200).json({
      message,
      details,
      price: result.totalAmount,
      hours: result.totalHrs,
      calc_type: result.calcType,
      hourly_rate_cad: result.hourlyRate,
    });
  } catch (e) {
    console.error("[QUOTE-VOICE] error:", e);
    return res.status(500).json({ error: "Internal error calculating quote" });
  }
}
