// services/confirmationSlotSyncService.js
//
// LAB-XXX, ago 2026
//
// Resincroniza confirmation_slots.starts_at contra el horario real del
// evento en GCal (event.start.dateTime). confirmationPairingJob.js escribe
// starts_at una sola vez, al crear el slot. Si el evento se reagenda en
// GCal después (a mano, o por una serie recurrente que se resincroniza),
// confirmation_slots queda con una foto vieja indefinidamente — no hay
// ningún otro proceso que lo revisite. Ver
// 2026-08-16_confirmation-slot-drift_analisis.md para el análisis completo
// (incluye por qué el sufijo _YYYYMMDDTHHMMSSZ del google_calendar_event_id
// NO sirve para detectar esto — queda anclado al horario original de la
// ocurrencia dentro de la recurrencia, no al horario actual).
//
// Compartido por los dos puntos de mayor riesgo del flujo CONFIRMAR:
//   - jobs/confirmationReminderJob.js: justo antes de mandar el email
//     recordatorio (batch — varios slots a la vez).
//   - controllers/publicConfirmationController.js: justo antes de marcar
//     el slot como confirmado (un slot puntual) — cierra la ventana entre
//     "recordatorio enviado" y "cliente hace click", que puede seguir
//     moviéndose después del email.
//
// Por decisión de negocio: un cambio de horario/día de un evento CONFIRMAR
// NO resetea el flujo (mismo token, mismo group_id, no dispara un aviso
// nuevo) — alcanza con corregir la fecha/hora mostrada.
//
// Deliberadamente NO vive en confirmationPairingJob.js (ese es el lado de
// ESCRITURA inicial, sin lógica de comparación hoy) ni en
// calendarController.js (controller CRUD de admin, no dueño del ciclo de
// vida de confirmation_slots, ya cargado de responsabilidades — ver
// inventario de call sites en 2026-07-30_color-based-detection_analisis.md).
// Consume CALENDAR_ID de calendarController.js igual que ya lo hacen los
// otros dos archivos — no lo duplica.

import { DateTime } from "luxon";
import { supabase } from "../supabaseClient.js";
import { CALENDAR_ID } from "../controllers/calendarController.js";

const TZ = process.env.BOOKING_TIMEZONE || "America/Vancouver";

// ── Lógica compartida: compara UN slot contra GCal, corrige in-memory ───────
// y agrega a `updates` si hubo drift. No persiste en Supabase — eso lo
// hacen los dos wrappers de abajo, cada uno con su propio patrón de
// llamada (batch vs. single).
async function resyncOne(slot, calendar, updates) {
  try {
    const { data: event } = await calendar.events.get({
      calendarId: CALENDAR_ID,
      eventId: slot.google_calendar_event_id,
      timeZone: TZ,
    });

    // GCal puede devolver el evento con status "cancelled" en vez de un
    // 404/410 al hacer .get() sobre una instancia cancelada de una serie.
    // No se bloquea el flujo por esto — se loguea y se sigue con el valor
    // guardado, mismo criterio que el catch de abajo.
    if (event.status === "cancelled") {
      console.warn(
        `⚠️ [ConfirmationSlotSync] Evento ${slot.google_calendar_event_id} (slot ${slot.id}) aparece cancelado en GCal — se sigue con starts_at guardado.`,
      );
      return;
    }

    const realStartIso = event.start?.dateTime || event.start?.date;
    if (!realStartIso) return;

    const real = DateTime.fromISO(realStartIso, { zone: TZ });
    const stored = DateTime.fromISO(slot.starts_at, { zone: TZ });
    if (!real.isValid || real.toMillis() === stored.toMillis()) return;

    console.warn(
      `⚠️ [ConfirmationSlotSync] Drift detectado en slot ${slot.id} (event ${slot.google_calendar_event_id}): ` +
        `starts_at guardado=${slot.starts_at} vs GCal real=${real.toISO()} — corrigiendo.`,
    );

    slot.starts_at = real.toISO(); // in-memory: el resto de la corrida del caller usa el valor correcto
    updates.push({ id: slot.id, starts_at: slot.starts_at });
  } catch (e) {
    // 404/410 = evento cancelado/borrado a mano en GCal — no fatal, mismo
    // criterio que releaseSlot() / releaseSiblingSlot() en el resto del
    // pipeline. Se sigue con el valor guardado.
    const gone = e.code === 404 || e.code === 410;
    console.warn(
      `⚠️ [ConfirmationSlotSync] No se pudo resincronizar slot ${slot.id} contra GCal${
        gone ? " (evento ya no existe)" : ""
      }: ${e.message}`,
    );
  }
}

// ── Resincroniza un array de slots (in-place) contra GCal ───────────────────
// Uso: confirmationReminderJob.js, que trae varios slots juntos (todos los
// que entran en la ventana del reminder en esta corrida). Recibe `calendar`
// por parámetro (no lo crea acá) para que el caller reuse la misma
// instancia en el resto de su flujo.
export async function resyncSlotsWithCalendar(slots, calendar) {
  if (!slots?.length) return { updated: 0 };

  const updates = [];
  for (const slot of slots) {
    await resyncOne(slot, calendar, updates);
  }

  if (!updates.length) return { updated: 0 };

  for (const u of updates) {
    const { error } = await supabase
      .from("confirmation_slots")
      .update({ starts_at: u.starts_at })
      .eq("id", u.id);
    if (error)
      console.error(
        `❌ [ConfirmationSlotSync] Error persistiendo starts_at corregido para slot ${u.id}:`,
        error.message,
      );
  }
  console.log(
    `[ConfirmationSlotSync] ${updates.length} slot(s) resincronizado(s) contra GCal.`,
  );
  return { updated: updates.length };
}

// ── Resincroniza UN slot puntual (in-place) contra GCal ──────────────────────
// Uso: publicConfirmationController.js, en el momento exacto de confirmar
// — un solo slot, no un batch.
export async function resyncSlotWithCalendar(slot, calendar) {
  const updates = [];
  await resyncOne(slot, calendar, updates);
  if (!updates.length) return { updated: false };

  const { error } = await supabase
    .from("confirmation_slots")
    .update({ starts_at: updates[0].starts_at })
    .eq("id", updates[0].id);
  if (error)
    console.error(
      `❌ [ConfirmationSlotSync] Error persistiendo starts_at corregido para slot ${updates[0].id}:`,
      error.message,
    );
  return { updated: true };
}