// Persistencia de los webhooks de Twilio para SMS:
//   - recordInboundSms:     un cliente respondió al número  (POST /api/sms/incoming)
//   - recordDeliveryStatus: status callback de un recordatorio (POST /api/sms/status)
//
// Portado de Monkey Cleaning (feat/sms: track delivery status and alert on
// client replies). Las alertas por email a operaciones las manda el controller
// (opsNotificationService), no este archivo — acá solo tocamos la DB, mismo
// criterio que el resto de los servicios: una notificación nunca rompe el flujo.

import { supabase } from "../supabaseClient.js";
import { toE164 } from "./smsReminderService.js";

// A partir de un número E.164 (+17789772870) arma las variantes con las que
// clients.phone / clients.mobile podrían estar guardados. Solo dígitos y guiones
// (clients.phone se guarda como "778-977-2870", ver smsReminderService.toE164)
// — sin "+", puntos, espacios ni paréntesis, que romperían el parser de filtros
// de PostgREST.
function phoneQueryCandidates(e164) {
  if (!e164) return [];
  const digits = e164.replace(/\D/g, ""); // 17789772870
  const local =
    digits.length === 11 && digits.startsWith("1") ? digits.slice(1) : digits;
  if (local.length !== 10) return [digits].filter(Boolean);
  const a = local.slice(0, 3);
  const b = local.slice(3, 6);
  const c = local.slice(6);
  return [
    digits, // 17789772870
    local, // 7789772870
    `${a}-${b}-${c}`, // 778-977-2870
    `1-${a}-${b}-${c}`, // 1-778-977-2870
  ];
}

async function matchClientByPhone(e164) {
  const candidates = phoneQueryCandidates(e164);
  if (!candidates.length) return null;

  const inList = candidates.join(",");
  const { data, error } = await supabase
    .from("clients")
    .select("id, first_name, last_name, phone, mobile")
    .or(`phone.in.(${inList}),mobile.in.(${inList})`);

  if (error) {
    console.warn("[SmsWebhook] matchClientByPhone query failed:", error.message);
    return null;
  }
  if (!data?.length) return null;

  // Confirmo normalizando a E.164 los dos lados; si ninguno matchea exacto
  // (formato raro guardado en DB) me quedo con el primero igual.
  const exact = data.find(
    (c) => toE164(c.phone) === e164 || toE164(c.mobile) === e164,
  );
  return exact || data[0];
}

// Turno del cliente más cercano a "ahora" dentro de +/- 10 días, solo para dar
// contexto en la alerta ("está respondiendo por el servicio del jueves").
async function nearestAppointment(clientId) {
  if (!clientId) return null;
  const from = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString();
  const to = new Date(Date.now() + 10 * 24 * 60 * 60 * 1000).toISOString();
  const { data } = await supabase
    .from("appointments")
    .select("id, starts_at, timezone, property_address, status")
    .eq("client_id", clientId)
    .gte("starts_at", from)
    .lte("starts_at", to)
    .order("starts_at", { ascending: true });
  if (!data?.length) return null;
  const now = Date.now();
  return data.reduce((best, a) =>
    Math.abs(new Date(a.starts_at) - now) <
    Math.abs(new Date(best.starts_at) - now)
      ? a
      : best,
  );
}

/**
 * Guarda un SMS entrante. Idempotente por MessageSid (Twilio reintenta el
 * webhook si no contesta 2xx a tiempo).
 *
 * @returns {{ inbound: object|null, client: object|null, appointment: object|null, duplicate: boolean }}
 */
export async function recordInboundSms(payload) {
  const from = payload.From || null;
  const to = payload.To || null;
  const body = payload.Body || "";
  const twilioSid = payload.MessageSid || payload.SmsSid || null;
  const numMedia = Number.parseInt(payload.NumMedia, 10) || 0;

  if (twilioSid) {
    const { data: existing } = await supabase
      .from("sms_inbound")
      .select("id")
      .eq("twilio_sid", twilioSid)
      .maybeSingle();
    if (existing) {
      return { inbound: null, client: null, appointment: null, duplicate: true };
    }
  }

  const client = await matchClientByPhone(from);
  const appointment = client ? await nearestAppointment(client.id) : null;

  const { data: inbound, error } = await supabase
    .from("sms_inbound")
    .insert({
      twilio_sid: twilioSid,
      from_number: from,
      to_number: to,
      body,
      num_media: numMedia,
      client_id: client?.id || null,
      appointment_id: appointment?.id || null,
      raw: payload,
    })
    .select()
    .single();

  if (error) {
    // UNIQUE violation -> carrera con otro reintento del webhook, lo tratamos
    // como duplicado y no alertamos dos veces.
    if (error.code === "23505") {
      return { inbound: null, client, appointment, duplicate: true };
    }
    throw error;
  }

  return { inbound, client, appointment, duplicate: false };
}

const FINAL_FAILURE_STATUSES = new Set(["undelivered", "failed"]);

/**
 * Aplica un status callback de Twilio a la fila de sms_reminders correspondiente.
 *
 * @returns {{ reminder: object|null, deliveryStatus: string, isFailure: boolean }}
 */
export async function recordDeliveryStatus(payload) {
  const twilioSid = payload.MessageSid || payload.SmsSid || null;
  const deliveryStatus = (payload.MessageStatus || payload.SmsStatus || "")
    .toLowerCase()
    .trim();
  const errorCode = payload.ErrorCode || null;

  if (!twilioSid || !deliveryStatus) {
    return { reminder: null, deliveryStatus, isFailure: false };
  }

  const { data: reminder } = await supabase
    .from("sms_reminders")
    .select("id, appointment_id, client_id, phone_number, status")
    .eq("twilio_sid", twilioSid)
    .maybeSingle();

  if (!reminder) {
    // El callback puede llegar para un SMS que no es un recordatorio (p. ej.
    // el bot de cotización). No es un error.
    return { reminder: null, deliveryStatus, isFailure: false };
  }

  const isFailure = FINAL_FAILURE_STATUSES.has(deliveryStatus);
  const patch = {
    delivery_status: deliveryStatus,
    error_code: errorCode,
    updated_at: new Date().toISOString(),
  };
  if (deliveryStatus === "delivered")
    patch.delivered_at = new Date().toISOString();
  // Solo degradamos status; nunca lo "subimos" de failed a algo mejor.
  if (isFailure && reminder.status !== "failed") {
    patch.status = "failed";
    patch.error_message = `twilio_${deliveryStatus}${errorCode ? `_${errorCode}` : ""}`;
  }

  await supabase.from("sms_reminders").update(patch).eq("id", reminder.id);

  return { reminder, deliveryStatus, isFailure };
}
