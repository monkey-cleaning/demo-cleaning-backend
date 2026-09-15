// controllers/staffCalendarController.js
// Portado de Monkey Cleaning (LAB423) — vista de calendario de SOLO LECTURA
// para cleaners. Reimplementado contra el modelo de este fork:
// `appointments` + `appointment_teams` (no hay Google Calendar).
//
// Nunca devuelve el shape completo de un evento admin: se recorta a lo que un
// cleaner necesita ver (título, horario, dirección, notas saneadas, quiénes
// más están en el evento por nombre). Sin clientId, sin equipo/color, sin
// estado de confirmación.

import { DateTime } from "luxon";
import { supabase } from "../supabaseClient.js";
import { sanitizeNotes } from "../services/employeeNotificationService.js";

const TZ = process.env.BOOKING_TIMEZONE || "America/Vancouver";

// employees.id del cleaner logueado, resuelto por su email (el del token, que
// viene de CLEANER_USERS y debe coincidir con employees.email).
async function resolveEmployeeId(email) {
  if (!email) return null;
  const { data, error } = await supabase
    .from("employees")
    .select("id")
    .eq("email", email)
    .maybeSingle();
  if (error) {
    console.warn("⚠️  staffCalendar resolveEmployeeId:", error.message);
    return null;
  }
  return data?.id ?? null;
}

function toStaffShape(row, selfId) {
  const start = DateTime.fromISO(row.starts_at, { zone: TZ });
  const end = DateTime.fromISO(row.ends_at, { zone: TZ });
  const teammates = (row.appointment_teams ?? [])
    .filter((t) => t.employees && t.employee_id !== selfId)
    .map((t) => t.employees.name)
    .filter(Boolean);

  return {
    id: row.id,
    summary: row.gcal_summary || "(no title)",
    startIso: start.toISO(),
    endIso: end.toISO(),
    isAllDay: false,
    startDate: start.toISODate(),
    durationH: end.isValid && start.isValid ? end.diff(start, "hours").hours : 0,
    location: row.property_address || null,
    notes: sanitizeNotes(row.special_instructions),
    teammates,
    isRecurring: row.series_id != null,
    // Clave para agrupar las notas de "próximo cleaner" (event_notes.series_key,
    // ver eventNotesController.js): el maestro de la serie si es recurrente, la
    // propia instancia si es un evento suelto.
    seriesKey: row.series_id ?? row.id,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/staff/calendar/events?timeMin=<ISO>&timeMax=<ISO>
// requireCleaner — solo los eventos donde el cleaner logueado está asignado.
// ─────────────────────────────────────────────────────────────────────────────
export async function getStaffCalendarEvents(req, res) {
  try {
    const { timeMin, timeMax } = req.query;
    if (!timeMin || !timeMax) {
      return res
        .status(400)
        .json({ ok: false, error: "timeMin and timeMax are required" });
    }

    const selfEmail = (req.cleaner?.email || "").toLowerCase();
    const selfId = await resolveEmployeeId(selfEmail);
    if (!selfId) {
      return res.status(403).json({
        ok: false,
        error: "This account is not linked to an employee record",
      });
    }

    const { data: rows, error } = await supabase
      .from("appointments")
      .select(
        "id, gcal_summary, special_instructions, property_address, starts_at, ends_at, scheduled_date, series_id, status, " +
          "appointment_teams(employee_id, employees(id, name))",
      )
      .gte("starts_at", timeMin)
      .lt("starts_at", timeMax)
      .neq("status", "cancelled")
      .order("starts_at", { ascending: true });
    if (error) throw error;

    const mine = (rows ?? []).filter((r) =>
      (r.appointment_teams ?? []).some((t) => t.employee_id === selfId),
    );

    const events = mine.map((r) => toStaffShape(r, selfId));
    return res.json({ ok: true, events, tz: TZ });
  } catch (e) {
    console.error("❌ getStaffCalendarEvents:", e.message);
    return res.status(500).json({ ok: false, error: e.message });
  }
}
