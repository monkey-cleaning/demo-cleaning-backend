// jobs/invoiceDraftJob.js
//
// Crea el borrador de factura de cada servicio ya realizado.
//
// Sin Google Calendar no hay un "sync" que marque el servicio como completado:
// Demo nunca escribe status='completed', así que "servicio hecho" = fila no
// cancelada, de un cliente real, que no es un evento no-servicio y cuyo
// ends_at ya pasó. appointments.invoice_id hace el job idempotente.
//
// Solo mira los últimos INVOICE_DRAFT_LOOKBACK_DAYS (default 3) para no
// generar borradores del historial entero la primera vez que corre.
//
// Uso manual:  node src/jobs/invoiceDraftJob.js [--dry-run]

import cron from "node-cron";
import { pathToFileURL } from "node:url";
import { supabase } from "../supabaseClient.js";
import { isNonServiceEventRow } from "../services/eventClassification.js";
import { createDraftInvoiceForCompletedAppointment } from "../services/invoiceService.js";

const PLACEHOLDER_CLIENT_ID = "00000000-0000-0000-0000-000000000001";
const LOOKBACK_DAYS = Number(process.env.INVOICE_DRAFT_LOOKBACK_DAYS ?? 3);

export async function runInvoiceDraftJob({ dryRun = false } = {}) {
  const now = new Date();
  const since = new Date(now.getTime() - LOOKBACK_DAYS * 86400000);

  const { data: rows, error } = await supabase
    .from("appointments")
    .select(
      "id, client_id, color_id, service_type, scheduled_date, starts_at, ends_at, " +
        "clients(rate), appointment_teams(employee_id)",
    )
    .is("invoice_id", null)
    .not("client_id", "is", null)
    .neq("client_id", PLACEHOLDER_CLIENT_ID)
    .neq("status", "cancelled")
    .gte("ends_at", since.toISOString())
    .lt("ends_at", now.toISOString())
    .order("ends_at");
  if (error) {
    console.error("❌ [InvoiceDraft] query:", error.message);
    return { error: error.message };
  }

  let created = 0;
  for (const r of rows ?? []) {
    if (isNonServiceEventRow(r)) continue;
    if (dryRun) {
      console.log(`[InvoiceDraft] (dry-run) ${r.id} ${r.scheduled_date}`);
      created++;
      continue;
    }
    try {
      const inv = await createDraftInvoiceForCompletedAppointment({
        appointmentId: r.id,
        clientId: r.client_id,
        serviceType: r.service_type,
        scheduledDate: r.scheduled_date,
        startsAt: r.starts_at,
        endsAt: r.ends_at,
        attendeeCount: Math.max(1, (r.appointment_teams ?? []).length),
        clientRate: r.clients?.rate ?? null,
      });
      if (inv) created++;
    } catch (e) {
      console.error(`❌ [InvoiceDraft] ${r.id}:`, e.message);
    }
  }
  console.log(`🧾 [InvoiceDraft] ${created} borrador(es) ${dryRun ? "(dry-run) " : ""}de ${(rows ?? []).length} candidato(s)`);
  return { candidates: (rows ?? []).length, created };
}

export function startInvoiceDraftJob() {
  // Cada hora al minuto 10: un servicio terminado pasa a borrador en ≤1 h.
  cron.schedule("10 * * * *", () => runInvoiceDraftJob(), {
    timezone: process.env.TZ || "America/Vancouver",
  });
  console.log("🧾 [InvoiceDraft] job programado (cada hora)");
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  runInvoiceDraftJob({ dryRun: process.argv.includes("--dry-run") }).then(() => process.exit(0));
}
