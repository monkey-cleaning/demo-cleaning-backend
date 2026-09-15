import { Router } from "express";
import { requireAdmin } from "../middleware/requireAdmin.js";
import {
  getCalendarEvents,
  createCalendarEvent,
  updateCalendarEvent,
  deleteCalendarEvent,
  checkEventConflicts,
  checkEventConflictsBatch,
  checkSeriesConflictsPreview,
  getSeriesRecurrence,
  getAvailableStaff,
  getClientPreferences,
} from "../controllers/calendarController.js";
import { searchAppointmentsByTitle as searchCalendarEvents } from "../controllers/appointmentController.js";
import { recordHistory } from "../services/recordHistory.js";
import { listEventNotes } from "../controllers/eventNotesController.js";

const r = Router();

// LAB418 — auditoría de las ediciones/borrados de eventos hechos desde el
// calendario admin. updateCalendarEvent maneja scopes single/all/following con
// varias ramas de salida; en vez de instrumentar cada una, se registra una
// fila de historial cuando la respuesta sale 2xx. El diff fino de campos lo
// cubre el otro camino (PATCH /api/admin/appointments/:id).
function auditCalendarWrite(verb) {
  return (req, res, next) => {
    const id = req.params.id;
    const done = res.json.bind(res);
    res.json = (body) => {
      if (id && res.statusCode < 400 && body?.ok !== false) {
        const scope = req.body?.scope || req.query?.scope || "single";
        recordHistory("appointment", id, [
          {
            field: verb,
            oldValue: null,
            newValue: `via calendar (scope: ${scope})`,
          },
        ]).catch(() => {});
      }
      return done(body);
    };
    next();
  };
}

r.get("/search", requireAdmin, searchCalendarEvents);
// Notas de cleaners sobre un evento/serie — solo lectura acá: las escribe el
// cleaner desde /api/staff/calendar/events/notes (eventNotesController.js).
r.get("/events/notes", requireAdmin, listEventNotes);
r.get("/events", requireAdmin, getCalendarEvents);
r.post("/events", requireAdmin, createCalendarEvent);
r.get("/events/:id/available-staff", requireAdmin, getAvailableStaff);
r.get("/events/:id/conflicts", requireAdmin, checkEventConflicts);
r.post("/events/conflicts/batch", requireAdmin, checkEventConflictsBatch);
r.post("/events/conflicts/series", requireAdmin, checkSeriesConflictsPreview);
r.get("/series/:masterId/recurrence", requireAdmin, getSeriesRecurrence);
r.get("/events/:id/client-preferences", requireAdmin, getClientPreferences);
r.patch(
  "/events/:id",
  requireAdmin,
  auditCalendarWrite("edited"),
  updateCalendarEvent,
);
r.delete(
  "/events/:id",
  requireAdmin,
  auditCalendarWrite("deleted"),
  deleteCalendarEvent,
);
export default r;
