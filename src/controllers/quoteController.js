import { calculateQuote } from "../services/cleaningQuoteCalculator.js";
import { supabase } from "../services/supabaseService.js";

const WEBHOOK_TOKEN = process.env.ELEVENLABS_WEBHOOK_TOKEN;

const FREQUENCY_MAP = {
  Weekly: "Weekly",
  Biweekly: "Biweekly",
  "Bi-weekly": "Biweekly",
  Monthly: "Monthly",
  "One Time Cleaning": "One Time Cleaning",
  "Move In/Out": "One Time Cleaning",
  "Move In/Move Out": "One Time Cleaning",
};

function normalizeFrequency(freq) {
  const key = String(freq || "").trim();
  return FREQUENCY_MAP[key] || key;
}

const REQUIRED_FIELDS = ["cleaning_frequency", "bedrooms", "full_bathrooms"];

export async function calculateQuoteEndpoint(req, res) {
  try {
    const auth = req.get("authorization") || req.get("Authorization") || "";
    const ok = WEBHOOK_TOKEN && auth.trim() === `Bearer ${WEBHOOK_TOKEN}`;
    if (!ok) return res.status(401).json({ error: "Unauthorized" });

    const body = req.body || {};

    const missing = REQUIRED_FIELDS.filter(
      (f) => body[f] === undefined || body[f] === null || body[f] === "",
    );
    if (missing.length > 0) {
      return res
        .status(400)
        .json({ error: `${missing.join(", ")} is required` });
    }

    const lead = {
      cleaningFrequency: normalizeFrequency(body.cleaning_frequency),
      bedrooms: body.bedrooms,
      fullBathrooms: body.full_bathrooms,
      halfBathrooms: body.half_bathrooms,
      propertySize: body.property_size,
      insideFridge: body.inside_fridge,
      insideFreezer: body.inside_freezer,
      insideOven: body.inside_oven,
    };

    const result = calculateQuote(lead);

    console.log(
      `[QUOTE] ${new Date().toISOString()} | Frequency: ${lead.cleaningFrequency} | Bedrooms: ${lead.bedrooms} | Result: $${result.totalAmount} CAD`,
    );

    return res.status(200).json({
      calc_type: result.tier,
      hourly_rate_cad: result.ratePerHour,
      total_labor_hours: result.totalLaborHours,
      clock_hours_for_two_people: result.clockHoursForTwoPeople,
      estimated_total_cad: result.totalAmount,
    });
  } catch (e) {
    console.error("[QUOTE] error:", e);
    return res.status(500).json({ error: "Internal error calculating quote" });
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
