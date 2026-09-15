// Webhooks de Twilio para el número de recordatorios SMS.
//
//   POST /api/sms/incoming  — un cliente respondió al número
//   POST /api/sms/status    — status callback de entrega de un recordatorio
//
// Montado FUERA de /api/admin y sin requireAdmin: lo llama Twilio, no el panel.
// La autenticación es la firma X-Twilio-Signature (validateRequest).
//
// Twilio POSTea application/x-www-form-urlencoded → req.body lo llena el
// express.urlencoded() global de index.js.
//
// Portado de Monkey Cleaning (feat/sms).

import twilio from "twilio";
import { supabase } from "../supabaseClient.js";
import {
  recordInboundSms,
  recordDeliveryStatus,
} from "../services/smsWebhookService.js";
import {
  sendOpsInboundSmsAlert,
  sendOpsSmsDeliveryFailureAlert,
} from "../services/opsNotificationService.js";

const AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN;
const SKIP_VALIDATION = process.env.SMS_WEBHOOK_SKIP_VALIDATION === "true";

// URL pública exacta que Twilio usó para firmar el request. Twilio firma el
// string completo (esquema + host + path, sin query salvo que la pongas vos en
// la config del webhook). Detrás del proxy de Render, req.protocol/host ya
// vienen bien por `app.set("trust proxy", 1)`, pero dejamos PUBLIC_BACKEND_URL
// como override porque es lo que ya se usa para los links de confirmación.
function publicUrl(req) {
  const base = (process.env.PUBLIC_BACKEND_URL || "").replace(/\/$/, "");
  if (base) return `${base}${req.originalUrl}`;
  return `${req.protocol}://${req.get("host")}${req.originalUrl}`;
}

function validateTwilio(req) {
  if (SKIP_VALIDATION) return true;
  if (!AUTH_TOKEN) {
    console.warn(
      "[SmsWebhook] TWILIO_AUTH_TOKEN no está seteado — no se puede validar la firma, se rechaza el webhook.",
    );
    return false;
  }
  const signature = req.get("X-Twilio-Signature") || "";
  const url = publicUrl(req);
  const ok = twilio.validateRequest(AUTH_TOKEN, signature, url, req.body || {});
  if (!ok) {
    console.warn(
      `[SmsWebhook] firma inválida para ${url} (sig="${signature.slice(0, 12)}...")`,
    );
  }
  return ok;
}

// TwiML vacío: le dice a Twilio "recibido, no respondas nada".
const EMPTY_TWIML = '<?xml version="1.0" encoding="UTF-8"?><Response></Response>';

export async function handleInboundSms(req, res) {
  if (!validateTwilio(req)) return res.status(403).send("Invalid signature");

  // Contestamos a Twilio primero: el trabajo pesado (matching + email) no debe
  // demorar la respuesta ni hacer que Twilio reintente.
  res.type("text/xml").send(EMPTY_TWIML);

  const payload = req.body || {};
  try {
    const { client, appointment, duplicate } = await recordInboundSms(payload);
    if (duplicate) return;

    console.log(
      `[SmsWebhook] inbound SMS from ${payload.From} | client=${client?.id || "none"} | "${(payload.Body || "").slice(0, 80)}"`,
    );

    await sendOpsInboundSmsAlert({
      from: payload.From,
      body: payload.Body,
      receivedAt: new Date().toISOString(),
      client,
      appointment,
    });
  } catch (err) {
    console.error("[SmsWebhook] handleInboundSms failed:", err.message);
  }
}

export async function handleStatusCallback(req, res) {
  if (!validateTwilio(req)) return res.status(403).send("Invalid signature");

  res.status(204).end();

  const payload = req.body || {};
  try {
    const { reminder, deliveryStatus, isFailure } =
      await recordDeliveryStatus(payload);

    if (!reminder) return;
    console.log(
      `[SmsWebhook] delivery status "${deliveryStatus}" for reminder ${reminder.id} (appt ${reminder.appointment_id})`,
    );
    if (!isFailure) return;

    // Enriquecemos la alerta con cliente + turno, sin romper si algo falta.
    let client = null;
    let appointment = null;
    try {
      if (reminder.client_id) {
        const { data } = await supabase
          .from("clients")
          .select("id, first_name, last_name")
          .eq("id", reminder.client_id)
          .maybeSingle();
        client = data || null;
      }
      if (reminder.appointment_id) {
        const { data } = await supabase
          .from("appointments")
          .select("id, starts_at, timezone, property_address, status")
          .eq("id", reminder.appointment_id)
          .maybeSingle();
        appointment = data || null;
      }
    } catch (e) {
      console.warn("[SmsWebhook] no se pudo enriquecer la alerta:", e.message);
    }

    await sendOpsSmsDeliveryFailureAlert({
      phone: reminder.phone_number,
      deliveryStatus,
      errorCode: payload.ErrorCode || null,
      client,
      appointment,
    });
  } catch (err) {
    console.error("[SmsWebhook] handleStatusCallback failed:", err.message);
  }
}
