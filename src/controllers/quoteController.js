import { calculateQuote } from "../services/cleaningQuoteCalculator.js";
import { computeQuoteResponse } from "../services/quoteMapping.js";
import {
  saveVoiceLead,
  voiceLeadFieldsFromQuote,
} from "../services/voiceLeadService.js";
import { verifyElevenLabsSignature } from "../utils/elevenLabsSignature.js";
import { sendOpsVoiceBookingAlert } from "../services/opsNotificationService.js";

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

    // Registro de la llamada en voice_leads (no rompe la respuesta si falla).
    const saved = await saveVoiceLead(
      {
        call_sid: body.CallSid || null,
        from_phone: body.From || null,
        source: "Voice IVR",
        status: "quoted",
        ...voiceLeadFieldsFromQuote(lead, result),
      },
      { onConflict: "call_sid" },
    );
    console.log(
      `[QUOTE-VOICE] voice_lead saved | id=${saved?.id ?? "?"} | CallSid=${body.CallSid}`,
    );

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

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/quote/elevenlabs/webhook
// Post-call webhook (transcription) del agente de ElevenLabs. Persiste la fila
// final en voice_leads y, si el cliente quiso reservar o se escaló, avisa a ops.
// Portado de Monkey Cleaning (LAB290).
//
// Sin ELEVENLABS_WEBHOOK_SECRET la verificación de firma falla → 401, sin
// romper nada (no hay cron: la ruta es inerte hasta configurar el secret).
// ─────────────────────────────────────────────────────────────────────────────

function toBool(v) {
  if (typeof v === "boolean") return v;
  const s = String(v ?? "").trim().toLowerCase();
  return s === "true" || s === "yes" || s === "1";
}
function toNum(v) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : null;
}
function extrasToColumns(extras) {
  const s = String(extras ?? "").toLowerCase();
  return {
    inside_fridge: s.includes("fridge") ? "yes" : null,
    inside_freezer: s.includes("freezer") ? "yes" : null,
    inside_oven: s.includes("oven") ? "yes" : null,
  };
}

export async function elevenLabsPostCallWebhook(req, res) {
  const verdict = verifyElevenLabsSignature({
    rawBody: req.rawBody,
    signatureHeader:
      req.get("ElevenLabs-Signature") || req.get("elevenlabs-signature"),
    secret: process.env.ELEVENLABS_WEBHOOK_SECRET,
  });
  if (!verdict.ok) {
    console.warn(`[QUOTE-EL] webhook rejected: ${verdict.reason}`);
    return res.status(401).json({ error: "invalid signature" });
  }

  // Ack inmediato; el procesamiento no debe bloquear la respuesta.
  res.status(200).json({ received: true });

  try {
    const body = req.body || {};
    if (body.type && body.type !== "post_call_transcription") {
      console.log(`[QUOTE-EL] ignored type=${body.type}`);
      return;
    }

    const data = body.data || {};
    const analysis = data.analysis || {};
    const dc = analysis.data_collection_results || {};
    const val = (k) => (dc[k] && dc[k].value != null ? dc[k].value : null);

    const phoneCall = data.metadata?.phone_call || {};
    const wantsToBook = toBool(val("wants_to_book"));
    const escalated = toBool(val("escalated"));
    const status = escalated
      ? "escalated"
      : wantsToBook
        ? "booking_requested"
        : "quoted";

    const fields = {
      conversation_id: data.conversation_id ?? null,
      call_sid: phoneCall.call_sid ?? null,
      from_phone: phoneCall.external_number ?? null,
      source: "Voice AI (ElevenLabs)",
      status,
      cleaning_frequency: val("cleaning_frequency"),
      bedrooms: val("bedrooms"),
      full_bathrooms: val("full_bathrooms"),
      half_bathrooms: val("half_bathrooms"),
      property_size: val("property_size"),
      ...extrasToColumns(val("extras")),
      estimated_total_cad: toNum(val("quoted_total_cad")),
      estimated_total_hours: toNum(val("quoted_labor_hours")),
      wants_to_book: wantsToBook,
      escalated,
      escalation_reason: val("escalation_reason"),
      caller_name: val("caller_name"),
      callback_number: val("callback_number"),
      transcript_summary: analysis.transcript_summary ?? null,
      caller_notes: val("caller_notes"),
      raw: body,
    };

    const saved = await saveVoiceLead(fields, { onConflict: "conversation_id" });

    console.log(
      `[QUOTE-EL] ${new Date().toISOString()} | conv=${data.conversation_id} | status=${status} | total=$${val("quoted_total_cad")} | book=${wantsToBook} | escalated=${escalated}`,
    );

    if (wantsToBook || escalated) {
      await sendOpsVoiceBookingAlert({
        conversationId: data.conversation_id,
        fromPhone: phoneCall.external_number,
        callbackNumber: val("callback_number"),
        callerName: val("caller_name"),
        status,
        escalationReason: val("escalation_reason"),
        quote: {
          total: val("quoted_total_cad"),
          hours: val("quoted_labor_hours"),
          frequency: val("cleaning_frequency"),
          bedrooms: val("bedrooms"),
          fullBathrooms: val("full_bathrooms"),
        },
        summary: analysis.transcript_summary,
        notes: val("caller_notes"),
        leadId: saved?.id ?? null,
      });
    }
  } catch (e) {
    console.error("[QUOTE-EL] post-call processing error:", e);
  }
}
