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
import {
  listChecklist,
  addChecklistItem,
  updateChecklistItem,
  archiveChecklistItem,
  listGeneralChecklist,
  addGeneralChecklistItem,
  updateGeneralChecklistItem,
  archiveGeneralChecklistItem,
  reorderGeneralChecklist,
} from "../controllers/eventChecklistController.js";
import {
  listCentralSubmissions,
  countUnreviewedCentralSubmissions,
  setCentralSubmissionReviewed,
} from "../controllers/centralSubmissionsController.js";
import { listChecklistActivity } from "../controllers/checklistActivityController.js";

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
// LAB457 — el admin arma la lista de indicaciones; el check-off y las fotos
// los hace el cleaner desde /api/staff/calendar/events/checklist.
r.get("/events/checklist", requireAdmin, listChecklist);
r.post("/events/checklist", requireAdmin, addChecklistItem);
r.patch("/events/checklist/:itemId", requireAdmin, updateChecklistItem);
r.delete("/events/checklist/:itemId", requireAdmin, archiveChecklistItem);
// LAB462 — checklist general (aplica a todas las limpiezas). "order" va antes
// de "/:itemId" para que Express no lo tome como un id.
r.get("/checklist/general", requireAdmin, listGeneralChecklist);
r.post("/checklist/general", requireAdmin, addGeneralChecklistItem);
r.put("/checklist/general/order", requireAdmin, reorderGeneralChecklist);
r.patch("/checklist/general/:itemId", requireAdmin, updateGeneralChecklistItem);
r.delete("/checklist/general/:itemId", requireAdmin, archiveGeneralChecklistItem);
// LAB458 — qué marcaron y subieron los cleaners, por visita.
r.get("/events/checklist-activity", requireAdmin, listChecklistActivity);
// LAB462 — "Other photos": fotos + comentario que mandan los cleaners.
r.get("/central-submissions", requireAdmin, listCentralSubmissions);
r.get("/central-submissions/unreviewed-count", requireAdmin, countUnreviewedCentralSubmissions);
r.patch("/central-submissions/:id", requireAdmin, setCentralSubmissionReviewed);
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
