import { Router } from "express";
import { requireCleaner } from "../middleware/requireCleaner.js";
import { getStaffCalendarEvents } from "../controllers/staffCalendarController.js";
import { listEventNotes, addEventNote } from "../controllers/eventNotesController.js";

// LAB423 — namespace separado de /api/calendar (admin): solo lectura,
// protegido por requireCleaner en vez de requireAdmin.
// /events/notes es la única parte de este namespace que escribe algo: notas
// de un cleaner sobre un evento/serie (ver eventNotesController.js).
const r = Router();
r.get("/events", requireCleaner, getStaffCalendarEvents);
r.get("/events/notes", requireCleaner, listEventNotes);
r.post("/events/notes", requireCleaner, addEventNote);
export default r;
