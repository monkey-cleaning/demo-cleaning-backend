// services/convertLeadToClient.js
//
// Converts a lead row into a clients row after a booking is confirmed.
// Designed to be called from the availability/book handler right after
// the appointment is created, so the client record exists before the
// appointment FK is resolved.
//
// Rules:
//   • If a client with the same e-mail already exists → update & return it.
//   • Otherwise → insert a new client row.
//   • Always marks the lead as converted (is_converted + converted_at).
//   • Returns { client, wasExisting } so callers can log / notify as needed.

import { supabase } from "../supabaseClient.js";
import { syncAndPersistZohoId } from "./zohoService.js";

// ---------------------------------------------------------------------------
// Field mapping  lead → client
// ---------------------------------------------------------------------------

/**
 * Splits a full_name string into { first_name, last_name }.
 * "John"            → { first_name: "John",  last_name: "" }
 * "John Smith"      → { first_name: "John",  last_name: "Smith" }
 * "John Paul Smith" → { first_name: "John",  last_name: "Paul Smith" }
 */
function splitName(fullName = "") {
  const parts = fullName.trim().split(/\s+/);
  const first = parts[0] ?? "";
  const last  = parts.slice(1).join(" ");
  return { first_name: first, last_name: last };
}

/**
 * Maps a lead row (snake_case from Supabase) + optional booking overrides
 * to a clients-compatible object.
 *
 * @param {object} lead          - Row from the leads table
 * @param {object} [bookingData] - Fields from the booking form that should
 *                                 take precedence (name, phone, address, email)
 */
function mapLeadToClient(lead, bookingData = {}) {
  // Prefer booking-form values (user may have corrected them in the modal)
  const fullName = bookingData.name  || lead.full_name  || "";
  const email    = bookingData.email || lead.email       || "";
  const phone    = bookingData.phone || lead.phone       || "";
  const address  = bookingData.address || lead.address   || "";

  const { first_name, last_name } = splitName(fullName);

  return {
    first_name,
    last_name,
    email:           email   || null,
    phone:           phone   || null,
    default_address: address || null,
    source:          lead.source       || "Website Booking",
    service_type:    lead.service_type || null,
    is_recurring:    lead.cleaning_frequency
                       ? lead.cleaning_frequency.toLowerCase() !== "one-time"
                       : null,
    expected_frequency: lead.cleaning_frequency || null,
    preferred_days:     lead.preferred_days     || null,
    preferred_time:     Array.isArray(lead.preferred_time)
                          ? lead.preferred_time.join(", ")
                          : lead.preferred_time || null,
    availability_windows: lead.availability_windows || null,
    zoho_contact_id:  lead.zoho_id || null,
    notes: lead.additional_message
      ? `[Converted from lead ${lead.id}]\n${lead.additional_message}`
      : `[Converted from lead ${lead.id}]`,
    status:       "active",
    is_converted: true,
    converted_at: new Date().toISOString(),
    created_at:   new Date().toISOString(),
    updated_at:   new Date().toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Main exported function
// ---------------------------------------------------------------------------

/**
 * Converts a lead to a client record, idempotently.
 *
 * @param {string} leadId      - UUID of the lead row
 * @param {object} bookingData - { name, phone, address, email } from the form
 * @returns {Promise<{ client: object, wasExisting: boolean }>}
 */
export async function convertLeadToClient(leadId, bookingData = {}) {
  // ── 1. Fetch the lead ────────────────────────────────────────────────────
  const { data: lead, error: leadErr } = await supabase
    .from("leads")
    .select("*")
    .eq("id", leadId)
    .single();

  if (leadErr || !lead) {
    throw new Error(`Lead ${leadId} not found: ${leadErr?.message}`);
  }

  const clientFields = mapLeadToClient(lead, bookingData);
  const lookupEmail  = clientFields.email?.toLowerCase().trim();

  let client      = null;
  let wasExisting = false;

  // ── 2. Upsert by e-mail (if we have one) ─────────────────────────────────
  if (lookupEmail) {
    const { data: existing } = await supabase
      .from("clients")
      .select("id")
      .ilike("email", lookupEmail)
      .maybeSingle();

    if (existing?.id) {
      // Client already exists — update only the fields that are worth refreshing
      wasExisting = true;

      const refreshFields = {
        phone:               clientFields.phone           ?? undefined,
        default_address:     clientFields.default_address ?? undefined,
        source:              clientFields.source,
        service_type:        clientFields.service_type    ?? undefined,
        is_recurring:        clientFields.is_recurring    ?? undefined,
        expected_frequency:  clientFields.expected_frequency ?? undefined,
        preferred_days:      clientFields.preferred_days  ?? undefined,
        preferred_time:      clientFields.preferred_time  ?? undefined,
        availability_windows: clientFields.availability_windows ?? undefined,
        is_converted:        true,
        converted_at:        clientFields.converted_at,
        updated_at:          clientFields.updated_at,
        // Preserve existing notes — append conversion note if not already there
        // (handled below after fetch)
      };

      // Remove undefined keys so we don't accidentally null out existing data
      Object.keys(refreshFields).forEach(
        (k) => refreshFields[k] === undefined && delete refreshFields[k],
      );

      const { data: updated, error: updateErr } = await supabase
        .from("clients")
        .update(refreshFields)
        .eq("id", existing.id)
        .select()
        .single();

      if (updateErr) throw updateErr;
      client = updated;

      console.log(`♻️  convertLeadToClient: existing client ${client.id} updated from lead ${leadId}`);
    }
  }

  // ── 3. Insert if no existing client was found ────────────────────────────
  if (!client) {
    const { data: inserted, error: insertErr } = await supabase
      .from("clients")
      .insert(clientFields)
      .select()
      .single();

    if (insertErr) throw insertErr;
    client = inserted;

    console.log(`✅ convertLeadToClient: new client ${client.id} created from lead ${leadId}`);
  }

  // ── 4. Mark the lead as converted ────────────────────────────────────────
  const { error: markErr } = await supabase
    .from("leads")
    .update({
      status:       "converted",
      is_converted: true,           // requires column — see migration below
      converted_at: new Date().toISOString(),
      updated_at:   new Date().toISOString(),
    })
    .eq("id", leadId);

  if (markErr) {
    // Non-fatal — log but don't fail the booking
    console.warn(`⚠️  convertLeadToClient: could not mark lead ${leadId} as converted:`, markErr.message);
  }

  // ── 5. Async Zoho sync — non-blocking ────────────────────────────────────
  syncAndPersistZohoId(supabase, client).catch((err) =>
    console.warn("⚠️  convertLeadToClient: Zoho sync failed:", err.message),
  );

  return { client, wasExisting };
}