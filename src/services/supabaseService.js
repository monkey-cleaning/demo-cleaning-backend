import "dotenv/config";
import { createClient } from "@supabase/supabase-js";

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_KEY;

if (!supabaseUrl) throw new Error("Missing env SUPABASE_URL");
if (!supabaseKey) throw new Error("Missing env SUPABASE_SERVICE_KEY");

export const supabase = createClient(supabaseUrl, supabaseKey);

/* ======================================================
   LEADS
====================================================== */

export async function saveLeadToDatabase(leadData) {
  const now = new Date().toISOString();

  const leadRecord = {
    full_name: leadData.fullName,
    email: leadData.email,
    phone: leadData.phone || null,
    address: leadData.address || null,
    service_option: leadData.serviceOption || null,
    cleaning_frequency: leadData.cleaningFrequency || null,
    property_size: leadData.propertySize || null,
    bedrooms: leadData.bedrooms || null,
    full_bathrooms: leadData.fullBathrooms || null,
    half_bathrooms: leadData.halfBathrooms || null,
    pets: leadData.pets || null,
    inside_fridge: leadData.insideFridge || null,
    inside_freezer: leadData.insideFreezer || null,
    inside_oven: leadData.insideOven || null,
    inside_windows: leadData.insideWindows || null,
    deep_cleaned: leadData.deepCleaned || null,
    close_to_hiring: leadData.closeToHiring || null,
    cleaning_date: leadData.cleaningDate || null,
    service_type: leadData.serviceType || null,
    zoho_id: leadData.zoho_id || null,
    preferred_days:
      Array.isArray(leadData.preferredDays) && leadData.preferredDays.length
        ? leadData.preferredDays
        : null,
    preferred_time: leadData.preferredTime || null,
    availability_windows:
      Array.isArray(leadData.availabilityWindows) &&
      leadData.availabilityWindows.length
        ? leadData.availabilityWindows
        : null,
    estimated_total_hours: leadData.estimatedTotalHours ?? null,
    estimated_hours_per_person: leadData.estimatedHoursPerPerson ?? null,
    status:
      leadData.source === "newsletter"
        ? "newsletter"
        : leadData.source === "contact-form"
          ? "contact-form"
          : leadData.status || "pending",
  };

  // 1️⃣ Verificar si ya existe un lead con ese email
  const { data: existing, error: searchError } = await supabase
    .from("leads")
    .select("id, additional_message")
    .eq("email", leadData.email)
    .maybeSingle();

  if (searchError) throw searchError;

  if (existing) {
    // 2️⃣a EMAIL YA EXISTE → UPDATE
    const mergedMessage = mergeMessages(
      existing.additional_message,
      leadData.additionalMessage,
    );

    const { data, error } = await supabase
      .from("leads")
      .update({
        ...leadRecord,
        additional_message: mergedMessage,
        last_contact_date: now,
        updated_at: now,
      })
      .eq("id", existing.id)
      .select()
      .single();

    if (error) throw error;
    return { ...data, _wasUpdate: true };
  } else {
    // 2️⃣b EMAIL NUEVO → INSERT
    const { data, error } = await supabase
      .from("leads")
      .insert([
        {
          ...leadRecord,
          additional_message: leadData.additionalMessage || null,
          last_contact_date: now,
        },
      ])
      .select()
      .single();

    if (error) throw error;
    return { ...data, _wasUpdate: false };
  }
}

/**
 * Concatena el mensaje nuevo al historial existente sin perder información.
 */
function mergeMessages(existing, incoming) {
  if (!incoming) return existing;
  if (!existing) return incoming;
  const timestamp = new Date().toLocaleString("en-CA", {
    timeZone: "America/Vancouver",
  });
  return `${existing}\n\n--- New contact (${timestamp}) ---\n${incoming}`;
}

/* ======================================================
   ESTIMATED HOURS PER CLEANER FOR A LEAD
====================================================== */

/**
 * Devuelve estimated_hours_per_person del lead guardado en BD.
 * Si la columna es null (lead antiguo o sin cálculo), devuelve null
 * y el caller debe hacer fallback a MIN_HOURS.
 *
 * @param {string} leadId  — UUID del lead
 * @returns {number|null}
 */
export async function getLeadEstimatedHours(leadId) {
  const { data, error } = await supabase
    .from("leads")
    .select("estimated_hours_per_person")
    .eq("id", leadId)
    .maybeSingle();

  if (error) throw error;

  const hours = data?.estimated_hours_per_person;
  return hours != null ? Number(hours) : null;
}

/* ======================================================
   COLA DE EMAILS AL CLIENTE CON IDEMPOTENCIA (MVP)
====================================================== */

/**
 * Encola el email con status pending.
 */
export async function enqueueCustomerEmail({ leadId, dueAt, payload }) {
  const { data, error } = await supabase
    .from("lead_customer_emails")
    .insert([
      {
        lead_id: leadId ? String(leadId) : null,
        due_at: dueAt,
        payload,
        status: "pending",
        attempts: 0,
        locked_at: null,
        sent_at: null,
        last_error: null,
      },
    ])
    .select()
    .single();

  if (error) throw error;
  return data;
}

/**
 * Trae IDs de emails vencidos (pending y due_at <= now).
 * Sin lock — el lock se hace fila por fila en tryLockCustomerEmail.
 */
export async function fetchDueCustomerEmailIds(limit = 10) {
  const { data, error } = await supabase
    .from("lead_customer_emails")
    .select("id")
    .eq("status", "pending")
    .lte("due_at", new Date().toISOString())
    .order("due_at", { ascending: true })
    .limit(limit);

  if (error) throw error;
  return (data || []).map((r) => r.id);
}

/**
 * Intenta lockear UNA fila (CAS optimista sobre attempts).
 * Si otra instancia ya la tomó, devuelve null.
 */
export async function tryLockCustomerEmail(id) {
  // 1) Leer attempts actual (solo si sigue pending)
  const { data: current, error: fetchError } = await supabase
    .from("lead_customer_emails")
    .select("attempts")
    .eq("id", id)
    .eq("status", "pending")
    .maybeSingle();

  if (fetchError) throw fetchError;
  if (!current) return null;

  const currentAttempts = Number(current.attempts || 0);
  const nextAttempts = currentAttempts + 1;

  // 2) Tomar el lock solo si attempts no cambió (CAS)
  const { data, error } = await supabase
    .from("lead_customer_emails")
    .update({
      status: "processing",
      attempts: nextAttempts,
      locked_at: new Date().toISOString(),
      last_error: null,
    })
    .eq("id", id)
    .eq("status", "pending")
    .eq("attempts", currentAttempts)
    .select("*")
    .maybeSingle();

  if (error) throw error;
  return data ?? null;
}

/**
 * Fetch + lock de N emails (devuelve filas ya en "processing" por este worker).
 */
export async function fetchAndLockDueCustomerEmails(limit = 10) {
  const ids = await fetchDueCustomerEmailIds(limit);
  if (!ids.length) return [];

  const locked = [];
  for (const id of ids) {
    const row = await tryLockCustomerEmail(id);
    if (row) locked.push(row);
  }
  return locked;
}

export async function markCustomerEmailSent(id) {
  const { error } = await supabase
    .from("lead_customer_emails")
    .update({
      status: "sent",
      sent_at: new Date().toISOString(),
      last_error: null,
    })
    .eq("id", id);

  if (error) throw error;
}

export async function markCustomerEmailFailed(id, errMsg) {
  const { error } = await supabase
    .from("lead_customer_emails")
    .update({
      status: "failed",
      last_error: String(errMsg || "Unknown error"),
    })
    .eq("id", id);

  if (error) throw error;
}

/**
 * Libera locks viejos (job murió en "processing") y los vuelve a pending.
 */
export async function releaseStaleLocks(minutes = 10) {
  const cutoff = new Date(Date.now() - minutes * 60 * 1000).toISOString();

  const { error } = await supabase
    .from("lead_customer_emails")
    .update({
      status: "pending",
      locked_at: null,
    })
    .eq("status", "processing")
    .lt("locked_at", cutoff);

  if (error) throw error;
}

/* ======================================================
   CLIENTS — KPIs operacionales para el dashboard

/* ======================================================
   TEAM AUTO-ASSIGN — datos batch para armar formaciones semanales
====================================================== */

export async function getActiveEmployeesLite() {
  const { data, error } = await supabase
    .from("employees")
    .select("id, name, is_team_leader")
    .eq("is_active", true)
    .order("name");
  if (error) throw error;
  return data ?? [];
}

export async function getWeeklyAvailabilityForEmployees(employeeIds) {
  if (!employeeIds.length) return [];
  const { data, error } = await supabase
    .from("employee_availability")
    .select("employee_id, day_of_week, start_time, end_time")
    .in("employee_id", employeeIds);
  if (error) throw error;
  return data ?? [];
}

export async function getExtraAvailabilityInRange(
  employeeIds,
  startDate,
  endDateExclusive,
) {
  if (!employeeIds.length) return [];
  const { data, error } = await supabase
    .from("employee_extra_availability")
    .select("employee_id, date, start_time, end_time")
    .in("employee_id", employeeIds)
    .gte("date", startDate)
    .lt("date", endDateExclusive);
  if (error) throw error;
  return data ?? [];
}

export async function getTimeOffInRange(
  employeeIds,
  startDate,
  endDateExclusive,
) {
  if (!employeeIds.length) return [];
  const { data, error } = await supabase
    .from("employee_time_off")
    .select("employee_id, start_date, end_date")
    .in("employee_id", employeeIds)
    .lte("start_date", endDateExclusive)
    .gte("end_date", startDate);
  if (error) throw error;
  return data ?? [];
}

export async function getExceptionsInRange(
  employeeIds,
  startDate,
  endDateExclusive,
) {
  if (!employeeIds.length) return [];
  const { data, error } = await supabase
    .from("employee_exceptions")
    .select(
      "employee_id, exception_date, all_day, start_time, end_time, exception_type",
    )
    .in("employee_id", employeeIds)
    .gte("exception_date", startDate)
    .lt("exception_date", endDateExclusive)
    .eq("exception_type", "unavailable");
  if (error) throw error;
  return data ?? [];
}

export async function getTeamAssignmentsForDates(teamId, dates) {
  const { data, error } = await supabase
    .from("daily_team_assignments")
    .select("date, employee_id, employees(name, is_team_leader)")
    .eq("team_id", teamId)
    .in("date", dates);
  if (error) throw error;
  return data ?? [];
}

export async function getTeamDefaultSize() {
  const { data, error } = await supabase
    .from('settings')
    .select('value')
    .eq('key', 'team_default_size')
    .maybeSingle();

  if (error) throw error;
  const n = parseInt(data?.value ?? '2', 10);
  return Number.isFinite(n) && n > 0 ? n : 2;
}
