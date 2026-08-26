// jobs/followUpQuoteJob.js
//
// El cron que dispara este job está definido en index.js, NO acá adentro.
// Este archivo solo exporta la función runFollowUpQuoteJob() que ejecuta
// la lógica una vez; index.js decide cuándo llamarla.
//
// Busca leads residenciales cuya cotización se envió hace ≥48h, que siguen
// sin convertirse, y encola un correo de seguimiento en lead_customer_emails
// con due_at = 08:00 AM del mismo día (zona BOOKING_TZ).
//
// Idempotencia: leads.follow_up_sent_at se escribe en cuanto se encola.
// Si el job corre dos veces, el segundo pase no encuentra nada elegible.
//
// NOTA IMPORTANTE: este job NO usa el embedded-join de Supabase
// (`lead_customer_emails!inner`) porque ese patrón requiere una FK
// constraint declarada en la base entre lead_customer_emails.lead_id (text)
// y leads.id (uuid). Si esa FK no existe, la query falla en silencio
// (cae al catch genérico) y el job no encola nada sin avisar claramente.
// Por eso se resuelve el filtro en dos pasos explícitos en JS.

import { supabase } from "../supabaseClient.js";
import { buildFollowUpEmail } from "../services/clientQuoteEmailService.js";
import { DateTime } from "luxon";

const TZ  = process.env.BOOKING_TIMEZONE || "America/Vancouver";
const LOG = "[followUpQuoteJob]";

// Statuses que indican que el lead sigue "abierto"
const OPEN_STATUSES = ["pending", "synced", "new"];

export async function runFollowUpQuoteJob() {
  console.log(`${LOG} Starting at ${DateTime.now().setZone(TZ).toISO()}`);

  try {
    // ── 1. Corte de 48h ─────────────────────────────────────────────────────
    const cutoff = DateTime.now().setZone(TZ).minus({ hours: 48 }).toISO();

    // ── 2. Paso A: traer leads "abiertos" sin follow-up enviado ────────────
    const { data: openLeads, error: leadsErr } = await supabase
      .from("leads")
      .select("id, full_name, email, status")
      .in("status", OPEN_STATUSES)
      .is("follow_up_sent_at", null)
      .eq("is_converted", false)
      .not("email", "is", null);

    if (leadsErr) throw leadsErr;

    if (!openLeads?.length) {
      console.log(`${LOG} No hay leads abiertos sin follow-up. Nada que hacer.`);
      return;
    }

    console.log(`${LOG} ${openLeads.length} lead(s) abiertos sin follow-up — verificando cotización enviada hace ≥48h...`);

    // ── 3. Paso B: de esos, cuáles tienen una cotización 'sent' hace ≥48h ──
    //
    // lead_customer_emails.lead_id es TEXT — comparamos contra el id (uuid)
    // convertido a string explícitamente para evitar problemas de tipo.
    const leadIds = openLeads.map((l) => l.id.toString());

    const { data: sentEmails, error: emailsErr } = await supabase
      .from("lead_customer_emails")
      .select("lead_id, sent_at, status")
      .in("lead_id", leadIds)
      .eq("status", "sent")
      .lte("sent_at", cutoff);

    if (emailsErr) throw emailsErr;

    if (!sentEmails?.length) {
      console.log(`${LOG} Ninguno de los leads abiertos tiene cotización enviada hace ≥48h.`);
      return;
    }

    // Set de lead_ids elegibles (puede haber duplicados si un lead tiene
    // varias cotizaciones enviadas — con uno alcanza)
    const eligibleIds = new Set(sentEmails.map((e) => e.lead_id));

    const batch = openLeads.filter((l) => eligibleIds.has(l.id.toString()));

    console.log(`${LOG} ${batch.length} lead(s) elegibles para follow-up.`);
    if (batch.length === 0) return;

    // ── 4. due_at = 08:00 AM Vancouver HOY ─────────────────────────────────
    const eightAM = DateTime.now()
      .setZone(TZ)
      .set({ hour: 8, minute: 0, second: 0, millisecond: 0 });

    const nowVancouver = DateTime.now().setZone(TZ);
    const dueAt = eightAM < nowVancouver
      ? nowVancouver.plus({ minutes: 2 }).toISO()
      : eightAM.toISO();

    // ── 5. Encolar ──────────────────────────────────────────────────────────
    let enqueued = 0;
    let failed   = 0;

    for (const lead of batch) {
      try {
        const { subject, html } = buildFollowUpEmail({
          lead,
          leadId: lead.id,
        });

        const { error: insertErr } = await supabase
          .from("lead_customer_emails")
          .insert({
            lead_id:    lead.id.toString(),   // la tabla espera TEXT
            due_at:     dueAt,
            status:     "pending",
            attempts:   0,
            payload:    {
              to:      lead.email,
              subject,
              html,
              type:    "follow_up_48h",
            },
            created_at: new Date().toISOString(),
          });

        if (insertErr) throw insertErr;

        const { error: markErr } = await supabase
          .from("leads")
          .update({
            follow_up_sent_at: new Date().toISOString(),
            updated_at:        new Date().toISOString(),
          })
          .eq("id", lead.id);

        if (markErr) {
          console.warn(
            `${LOG} ⚠️  No se pudo marcar follow_up_sent_at para lead ${lead.id}:`,
            markErr.message,
          );
        }

        console.log(
          `${LOG} ✅ Encolado follow-up lead ${lead.id} (${lead.email}) → due_at ${dueAt}`,
        );
        enqueued++;

      } catch (err) {
        console.error(`${LOG} ❌ Error con lead ${lead.id}:`, err.message);
        failed++;
      }
    }

    console.log(`${LOG} Finalizado — encolados: ${enqueued}, fallidos: ${failed}`);

  } catch (err) {
    console.error(`${LOG} ❌ Error fatal:`, err.message);
  }
}