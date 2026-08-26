// jobs/confirmationSlotDriftAlertJob.js
//
// LAB-XXX, ago 2026
//
// Avisa a operaciones cuando confirmation_slot_drift_log tiene filas sin
// revisar. El trigger trg_sync_confirmation_slot_starts_at ya loguea ahí
// cualquier slot 'confirmed' que se movió en GCal después de que el
// cliente confirmó (ver 2026-08-16_confirmation-slot-drift_analisis.md,
// sección 7.1.1) — pero hasta este job, nada avisaba cuando aparecía una
// fila nueva. El caso cba40caf (mismo análisis, sección 6) se detectó por
// un script manual corrido a mano, no porque el sistema avisara.
//
// Corre una vez al día. Manda un digest con TODAS las filas reviewed=false,
// no solo las nuevas desde la última corrida — a propósito: mientras una
// fila siga sin marcarse reviewed=true, se sigue avisando cada día. Es un
// recordatorio persistente en vez de una notificación de una sola vez, para
// no repetir el mismo patrón de fondo (una señal que se manda una vez y se
// pierde si nadie la vio a tiempo).
//
// Marcar reviewed=true es manual (UPDATE directo en Supabase) por ahora —
// no hay UI en el admin panel todavía. Queda como pendiente aparte.

import cron from "node-cron";
import { supabase } from "../supabaseClient.js";
import { sendDriftLogAlert } from "../services/opsNotificationService.js";

const TZ = process.env.BOOKING_TIMEZONE || "America/Vancouver";

// ── 1. Trae las filas sin revisar ────────────────────────────────────────
async function findUnreviewedDrift() {
  const { data, error } = await supabase
    .from("confirmation_slot_drift_log")
    .select(
      "id, confirmation_slot_id, appointment_id, starts_at_previo, starts_at_nuevo, detected_at",
    )
    .eq("reviewed", false)
    .order("detected_at", { ascending: true });

  if (error) {
    console.error(
      "❌ [ConfirmationDriftAlert] Error leyendo confirmation_slot_drift_log:",
      error.message,
    );
    return [];
  }
  return data ?? [];
}

// ── 2. Enriquecer con cliente ────────────────────────────────────────────
// confirmation_slot_drift_log no guarda client_id directo — hay que pasar
// primero por confirmation_slots (mismo patrón que enrichSlots() en
// confirmationReminderJob.js).
async function enrichRows(rows) {
  const slotIds = [...new Set(rows.map((r) => r.confirmation_slot_id))];

  const { data: slots, error: slotsErr } = await supabase
    .from("confirmation_slots")
    .select("id, client_id, status")
    .in("id", slotIds);
  if (slotsErr) {
    console.error(
      "❌ [ConfirmationDriftAlert] Error leyendo confirmation_slots:",
      slotsErr.message,
    );
  }
  const slotById = new Map((slots ?? []).map((s) => [s.id, s]));

  const clientIds = [
    ...new Set((slots ?? []).map((s) => s.client_id).filter(Boolean)),
  ];
  const { data: clients, error: clientsErr } = clientIds.length
    ? await supabase
        .from("clients")
        .select("id, first_name, last_name")
        .in("id", clientIds)
    : { data: [] };
  if (clientsErr) {
    console.error(
      "❌ [ConfirmationDriftAlert] Error leyendo clients:",
      clientsErr.message,
    );
  }
  const clientById = new Map((clients ?? []).map((c) => [c.id, c]));

  return rows.map((r) => {
    const slot = slotById.get(r.confirmation_slot_id);
    const client = slot?.client_id ? clientById.get(slot.client_id) : null;
    return {
      ...r,
      slotStatus: slot?.status ?? null,
      clientName: client
        ? [client.first_name, client.last_name]
            .filter(Boolean)
            .join(" ")
            .trim()
        : null,
    };
  });
}

// ── Runner principal ──────────────────────────────────────────────────────
export async function runConfirmationSlotDriftAlertJob() {
  try {
    const rows = await findUnreviewedDrift();
    if (!rows.length) {
      console.log("[ConfirmationDriftAlert] Nada pendiente de revisión.");
      return { pending: 0 };
    }

    const enriched = await enrichRows(rows);
    await sendDriftLogAlert({ rows: enriched });

    console.log(
      `✅ [ConfirmationDriftAlert] Alerta enviada — ${enriched.length} fila(s) sin revisar en confirmation_slot_drift_log.`,
    );
    return { pending: enriched.length };
  } catch (e) {
    console.error("❌ [ConfirmationDriftAlert] Job failed:", e.message);
    return { pending: 0, error: e.message };
  }
}

// ── Registro del cron ─────────────────────────────────────────────────────
// Una vez al día, no cada 6h como el reminder — esto es "revisá cuando
// puedas", no una ventana que se cierra. Menos ruido mientras nadie marca
// reviewed.
export function startConfirmationSlotDriftAlertJob() {
  cron.schedule("30 8 * * *", runConfirmationSlotDriftAlertJob, {
    timezone: TZ,
  });
  console.log(
    "🕒 [ConfirmationDriftAlert] Cron registrado: diario 08:30 (America/Vancouver)",
  );
}