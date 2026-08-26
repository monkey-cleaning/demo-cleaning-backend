import twilio from "twilio";
import { supabase } from "../supabaseClient.js";

const twilioClient = twilio(
  process.env.TWILIO_ACCOUNT_SID,
  process.env.TWILIO_AUTH_TOKEN,
);
const FROM_NUMBER = process.env.TWILIO_PHONE_NUMBER;
const MESSAGING_SERVICE_SID = process.env.TWILIO_MESSAGING_SERVICE_SID;

const REMINDER_STATUSES = ["pending", "confirmed"];

// clients.phone viene como "778-977-2870" (NANP, sin código de país)
function toE164(rawPhone) {
  if (!rawPhone) return null;
  if (rawPhone.startsWith("+")) return rawPhone;
  const digits = rawPhone.replace(/\D/g, "");
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  return null;
}

const INVALID_ADDRESS_VALUES = new Set(["", "tbd", "n/a", "pending"]);

function hasValidAddress(address) {
  return !!address && !INVALID_ADDRESS_VALUES.has(address.trim().toLowerCase());
}

// "760 Enterprise Crescent, Victoria, BC, V8Z 6R4" -> "760 Enterprise Crescent"
function shortAddress(fullAddress) {
  return fullAddress?.split(",")[0]?.trim() || fullAddress;
}

function buildReminderMessage(appointment, client) {
  // starts_at es timestamptz; formateamos en la timezone propia del appointment (America/Vancouver)
  const localTime = new Date(appointment.starts_at).toLocaleString("en-US", {
    timeZone: appointment.timezone || "America/Vancouver",
    weekday: "long",
    day: "numeric",
    month: "long",
    hour: "2-digit",
    minute: "2-digit",
  });

  return `Hi ${client.first_name}! 👋 Your cleaning day is almost here! ✨

Just a friendly reminder that we’ll be at ${shortAddress(appointment.property_address)} tomorrow at ${localTime}. We can’t wait to leave your home feeling fresh, clean, and sparkling! 🐒💚

Questions or need anything before then? Just email us at contact@monkeycleaning.com.`;
}

async function findUpcomingAppointmentsNeedingReminder() {
  const windowStart = new Date(
    Date.now() + 23.5 * 60 * 60 * 1000,
  ).toISOString();
  const windowEnd = new Date(Date.now() + 24.5 * 60 * 60 * 1000).toISOString();

  let query = supabase
    .from("appointments")
    .select(
      "id, starts_at, timezone, property_address, client_id, clients(id, first_name, phone, mobile)",
    )
    .gte("starts_at", windowStart)
    .lte("starts_at", windowEnd)
    .in("status", REMINDER_STATUSES);

  // filtro de testing: solo procesa un client_id específico si está seteado
  if (process.env.SMS_TEST_CLIENT_ID) {
    query = query.eq("client_id", process.env.SMS_TEST_CLIENT_ID);
  }

  const { data: appointments, error } = await query;

  if (error) throw error;
  if (!appointments?.length) return [];

  const { data: alreadySent } = await supabase
    .from("sms_reminders")
    .select("appointment_id")
    .in(
      "appointment_id",
      appointments.map((a) => a.id),
    );

  const sentIds = new Set((alreadySent || []).map((r) => r.appointment_id));
  return appointments.filter(
    (a) => !sentIds.has(a.id) && (a.clients?.mobile || a.clients?.phone),
  );
}

async function sendReminder(appointment) {
  const client = appointment.clients;
  const rawPhone = client.mobile || client.phone;
  const phone = toE164(rawPhone);
  const addressOk = hasValidAddress(appointment.property_address);

  const { data: reminder, error: insertError } = await supabase
    .from("sms_reminders")
    .insert({
      appointment_id: appointment.id,
      client_id: client.id,
      phone_number: phone || rawPhone,
      status: phone && addressOk ? "pending" : "failed",
      error_message: !phone
        ? "invalid_phone_format"
        : !addressOk
          ? "invalid_address"
          : null,
    })
    .select()
    .single();

  if (insertError) {
    // UNIQUE violation -> ya se procesó este appointment, lo ignoramos
    console.warn(
      `Reminder skip for appointment ${appointment.id}:`,
      insertError.message,
    );
    return;
  }

  if (!phone || !addressOk) return;

  try {
    const message = await twilioClient.messages.create({
      body: buildReminderMessage(appointment, client),
      ...(MESSAGING_SERVICE_SID
        ? { messagingServiceSid: MESSAGING_SERVICE_SID }
        : { from: FROM_NUMBER }),
      to: phone,
    });

    await supabase
      .from("sms_reminders")
      .update({
        status: "sent",
        twilio_sid: message.sid,
        sent_at: new Date().toISOString(),
      })
      .eq("id", reminder.id);
  } catch (err) {
    await supabase
      .from("sms_reminders")
      .update({ status: "failed", error_message: err.message })
      .eq("id", reminder.id);
    console.error(
      `Failed to send SMS reminder for appointment ${appointment.id}:`,
      err.message,
    );
  }
}

async function processReminders() {
  const appointments = await findUpcomingAppointmentsNeedingReminder();
  console.log(`Processing ${appointments.length} SMS reminders`);

  for (const appointment of appointments) {
    await sendReminder(appointment);
  }
}

export { processReminders, sendReminder };
