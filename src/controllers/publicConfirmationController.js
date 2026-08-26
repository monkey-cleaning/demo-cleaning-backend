// controllers/publicConfirmationController.js
//
// Ticket: "Confirmación automática de servicios pendientes (CONFIRMAR)" — Paso 6
//
// Público, sin auth (montado fuera de /api/admin, sin requireAdmin — ver
// routes/publicConfirmationRoutes.js). Es el destino del link que
// clientNotificationService.sendConfirmationRequestEmail manda al cliente:
// un token único por confirmation_slot (uno por horario ofrecido), así que
// "confirmar" es simplemente "abrir el link del horario que querés".
//
// Flujo:
//   1. Busca el slot por token.
//   2. Si no existe, ya está resuelto (confirmed/released), o su horario ya
//      pasó → página de resultado explicando por qué no se puede confirmar.
//   3. Si es válido: marca este slot 'confirmed', actualiza el appointment
//      vinculado a 'confirmed', limpia "CONFIRMAR" del título en GCal
//      (sendUpdates:"none"), y libera automáticamente el/los otro(s) slot(s)
//      'offered' del mismo group_id — cancelando su evento en GCal y su
//      appointment.
//   4. Devuelve una página HTML simple (sin JS, sin login) con el resultado.
//
// Nunca lanza por un paso secundario: si no se pudo liberar el slot hermano
// en GCal, se loguea pero NO se le muestra un error al cliente — ya vio
// "confirmado", eso no puede fallar por un problema en la limpieza del otro
// slot (mismo principio que notifyCancellationIfNeeded en
// calendarController.js: las rutas de notificación/limpieza nunca son fatales).

import { getCalendarClient } from "../services/googleCalendarClient.js";
import { supabase } from "../supabaseClient.js";
import { DateTime } from "luxon";
import { CALENDAR_ID, TEAMS_CONFIG } from "./calendarController.js";
import { invalidateCache, cacheKey } from "../services/calendarCache.js";
import { getTeamColorId } from "../services/eventClassification.js";
import { resyncSlotWithCalendar } from "../services/confirmationSlotSyncService.js";

const TZ = process.env.BOOKING_TIMEZONE || "America/Vancouver";

// Quita la palabra "CONFIRMAR" (y los espacios sobrantes que deja) del
// título. Espejo del regex de isPendingConfirmation en calendarController.js
// — si ese regex cambia algún día, este debe cambiar junto con él.
function stripConfirmarFromSummary(summary) {
  return String(summary || "")
    .replace(/confirmar/gi, "")
    .replace(/\s{2,}/g, " ")
    .trim();
}

function invalidateForStartsAt(startsAtIso) {
  const dt = DateTime.fromISO(startsAtIso, { zone: TZ });
  if (!dt.isValid) return;
  invalidateCache(cacheKey(dt.year, dt.month));
}

// ── Página HTML de resultado (sin JS, sin dependencias externas) ────────────
function resultPage({ title, message, tone = "success" }) {
  const accent =
    tone === "success" ? "#0b8043" : tone === "warning" ? "#f6c026" : "#e11d48";
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Monkey Cleaning</title>
</head>
<body style="margin:0;padding:0;background:#f8fafc;font-family:Arial,Helvetica,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="padding:40px 16px;">
    <tr><td align="center">
      <table width="100%" style="max-width:480px;background:#ffffff;border-radius:12px;overflow:hidden;border:1px solid #e2e8f0;">
        <tr><td style="background:#0d1b3e;padding:20px 24px;">
          <span style="color:#fff;font-size:18px;font-weight:700;">Monkey Cleaning</span>
        </td></tr>
        <tr><td style="padding:32px 24px;border-top:4px solid ${accent};">
          <h1 style="margin:0 0 12px;font-size:20px;color:#0d1b3e;">${title}</h1>
          <p style="margin:0;font-size:15px;line-height:1.5;color:#334155;">${message}</p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;
}

// ── Libera un slot 'offered' hermano: cancela su evento en GCal y su appointment ─
async function releaseSiblingSlot(calendar, slot) {
  try {
    try {
      await calendar.events.delete({
        calendarId: CALENDAR_ID,
        eventId: slot.google_calendar_event_id,
        sendUpdates: "none",
      });
    } catch (delErr) {
      // 404/410 = ya no está en GCal (borrado a mano, doble-click, etc.) —
      // mismo criterio que deleteCalendarEvent en calendarController.js.
      const alreadyGone = delErr.code === 404 || delErr.code === 410;
      if (!alreadyGone) throw delErr;
    }

    if (slot.appointment_id) {
      const { error: apptErr } = await supabase
        .from("appointments")
        .update({ status: "cancelled", updated_at: new Date().toISOString() })
        .eq("id", slot.appointment_id);
      if (apptErr)
        console.error(
          `⚠️ [PublicConfirm] Error cancelando appointment hermano ${slot.appointment_id}:`,
          apptErr.message,
        );
    }

    const { error: slotErr } = await supabase
      .from("confirmation_slots")
      .update({ status: "released", resolved_at: new Date().toISOString() })
      .eq("id", slot.id);
    if (slotErr)
      console.error(
        `⚠️ [PublicConfirm] Error marcando slot hermano ${slot.id} released:`,
        slotErr.message,
      );

    invalidateForStartsAt(slot.starts_at);
  } catch (e) {
    console.error(
      `⚠️ [PublicConfirm] No se pudo liberar slot hermano ${slot.id}:`,
      e.message,
    );
  }
}

// ── GET /api/public/confirm/:token ───────────────────────────────────────────
export async function confirmSlot(req, res) {
  const { token } = req.params;

  try {
    const { data: slot, error } = await supabase
      .from("confirmation_slots")
      .select(
        "id, group_id, google_calendar_event_id, appointment_id, client_id, starts_at, token, status",
      )
      .eq("token", token)
      .maybeSingle();

    if (error) {
      console.error(
        "❌ [PublicConfirm] Error leyendo confirmation_slots:",
        error.message,
      );
      return res.status(500).send(
        resultPage({
          title: "Something went wrong",
          message:
            "We couldn't process your confirmation right now. Please give us a call and we'll sort it out.",
          tone: "error",
        }),
      );
    }

    if (!slot) {
      return res.status(404).send(
        resultPage({
          title: "Link not found",
          message:
            "This confirmation link doesn't look valid. Please give us a call and we'll help you confirm your appointment.",
          tone: "error",
        }),
      );
    }

    if (slot.status === "confirmed") {
      return res.send(
        resultPage({
          title: "Already confirmed",
          message: "This time slot was already confirmed. We'll see you then!",
          tone: "success",
        }),
      );
    }

    if (slot.status === "released") {
      return res.send(
        resultPage({
          title: "This option is no longer available",
          message:
            "This time slot was already released. Please give us a call and we'll find a new time for you.",
          tone: "warning",
        }),
      );
    }

    const calendar = getCalendarClient();

    // status === "offered" — resincronizar starts_at contra GCal antes de
    // confirmar. Cierra la ventana entre "recordatorio enviado" y "cliente
    // hace click": si el evento se reagendó después del email, se corrige
    // acá antes de evaluar vencimiento y antes de mostrar "confirmado". Por
    // decisión de negocio (no resetea el flujo, solo corrige lo mostrado).
    await resyncSlotWithCalendar(slot, calendar);

    // Validar vencimiento sobre el starts_at ya corregido — si no se
    // resincroniza primero, un evento reagendado a un horario ya pasado
    // seguiría evaluándose contra el starts_at viejo (no vencido) y
    // confirmaría algo que en la realidad ya pasó.o
    const startsAt = DateTime.fromISO(slot.starts_at, { zone: TZ });
    if (startsAt.isValid && startsAt <= DateTime.now().setZone(TZ)) {
      return res.send(
        resultPage({
          title: "This link has expired",
          message:
            "This appointment time has already passed. Please give us a call and we'll get you rebooked.",
          tone: "warning",
        }),
      );
    }

    // 1. Limpiar "CONFIRMAR" del título del evento confirmado.
    try {
      const current = await calendar.events.get({
        calendarId: CALENDAR_ID,
        eventId: slot.google_calendar_event_id,
        timezone: TZ,
      });
      const newSummary = stripConfirmarFromSummary(current.data?.summary);

      // Con color como fuente de verdad, al confirmar hay que cambiar colorId
      // de Banana (CONFIRMAR) al del equipo (si existe) o a null (neutral/sin asignar).
      let newColorId = null;
      if (slot.appointment_id) {
        const { data: appt, error: apptErr } = await supabase
          .from("appointments")
          .select("team_id")
          .eq("id", slot.appointment_id)
          .maybeSingle();

        if (appt?.team_id) {
          newColorId = getTeamColorId(appt.team_id, TEAMS_CONFIG);
        }
        // Si team_id es null, newColorId queda null (sin colorId en GCal)
      }

      await calendar.events.patch({
        calendarId: CALENDAR_ID,
        eventId: slot.google_calendar_event_id,
        requestBody: {
          summary: newSummary,
          ...(newColorId !== null
            ? { colorId: newColorId }
            : { colorId: null }),
        },
        sendUpdates: "none",
      });
    } catch (gcalErr) {
      console.error(
        `⚠️ [PublicConfirm] No se pudo limpiar el título en GCal para ${slot.google_calendar_event_id}:`,
        gcalErr.message,
      );
      // Seguimos igual — lo que importa es que Supabase quede consistente;
      // el título se puede corregir a mano si hace falta.
    }

    // 2. Marcar el slot y el appointment como confirmados.
    const nowIso = new Date().toISOString();
    const { error: slotUpdateErr } = await supabase
      .from("confirmation_slots")
      .update({ status: "confirmed", resolved_at: nowIso })
      .eq("id", slot.id);
    if (slotUpdateErr)
      console.error(
        "❌ [PublicConfirm] Error marcando slot confirmed:",
        slotUpdateErr.message,
      );

    if (slot.appointment_id) {
      const { error: apptUpdateErr } = await supabase
        .from("appointments")
        .update({ status: "confirmed", updated_at: nowIso })
        .eq("id", slot.appointment_id);
      if (apptUpdateErr)
        console.error(
          "❌ [PublicConfirm] Error marcando appointment confirmed:",
          apptUpdateErr.message,
        );
    }

    invalidateForStartsAt(slot.starts_at);

    // 3. Liberar el/los otro(s) slot(s) 'offered' del mismo grupo.
    const { data: siblings, error: siblingsErr } = await supabase
      .from("confirmation_slots")
      .select("id, google_calendar_event_id, appointment_id, starts_at, status")
      .eq("group_id", slot.group_id)
      .eq("status", "offered")
      .neq("id", slot.id);

    if (siblingsErr) {
      console.error(
        "⚠️ [PublicConfirm] Error leyendo slots hermanos:",
        siblingsErr.message,
      );
    } else if (siblings?.length) {
      for (const sibling of siblings) {
        await releaseSiblingSlot(calendar, sibling);
      }
    }

    console.log(
      `✅ [PublicConfirm] Slot ${slot.id} confirmado (group ${slot.group_id}), ${
        siblings?.length ?? 0
      } hermano(s) liberado(s).`,
    );

    const confirmedStart = DateTime.fromISO(slot.starts_at, { zone: TZ });
    const formattedTime = confirmedStart.isValid
      ? confirmedStart.toFormat("cccc, LLLL d 'at' h:mm a")
      : null;

    return res.send(
      resultPage({
        title: "You're all set!",
        message: formattedTime
          ? `Your appointment is confirmed for ${formattedTime}. We'll see you then — thanks for letting us know!`
          : "Your appointment time is confirmed. We'll see you then — thanks for letting us know!",
        tone: "success",
      }),
    );
  } catch (e) {
    console.error("❌ [PublicConfirm] confirmSlot failed:", e.message);
    return res.status(500).send(
      resultPage({
        title: "Something went wrong",
        message:
          "We couldn't process your confirmation right now. Please give us a call and we'll sort it out.",
        tone: "error",
      }),
    );
  }
}
