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

const r = Router();
r.get("/search", requireAdmin, searchCalendarEvents);
r.get("/events", requireAdmin, getCalendarEvents);
r.post("/events", requireAdmin, createCalendarEvent);
r.get("/events/:id/available-staff", requireAdmin, getAvailableStaff);
r.get("/events/:id/conflicts", requireAdmin, checkEventConflicts);
r.post("/events/conflicts/batch", requireAdmin, checkEventConflictsBatch);
r.post("/events/conflicts/series", requireAdmin, checkSeriesConflictsPreview);
r.get("/series/:masterId/recurrence", requireAdmin, getSeriesRecurrence);
r.get("/events/:id/client-preferences", requireAdmin, getClientPreferences);
r.patch("/events/:id", requireAdmin, updateCalendarEvent);
r.delete("/events/:id", requireAdmin, deleteCalendarEvent);
export default r;