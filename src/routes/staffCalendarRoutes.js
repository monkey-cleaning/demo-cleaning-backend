import { Router } from "express";
import { requireCleaner } from "../middleware/requireCleaner.js";
import { getStaffCalendarEvents } from "../controllers/staffCalendarController.js";
import { listEventNotes, addEventNote } from "../controllers/eventNotesController.js";
import {
  listChecklist,
  setChecklistCompletion,
  getChecklistPhotoUploadUrl,
  attachChecklistPhoto,
  deleteChecklistPhoto,
} from "../controllers/eventChecklistController.js";
import {
  getCentralPhotoUploadUrl,
  createCentralSubmission,
  listCentralSubmissionsForEvent,
} from "../controllers/centralSubmissionsController.js";

// LAB423 — namespace separado de /api/calendar (admin): solo lectura,
// protegido por requireCleaner en vez de requireAdmin.
// /events/notes es la única parte de este namespace que escribe algo: notas
// de un cleaner sobre un evento/serie (ver eventNotesController.js).
const r = Router();
r.get("/events", requireCleaner, getStaffCalendarEvents);
r.get("/events/notes", requireCleaner, listEventNotes);
r.post("/events/notes", requireCleaner, addEventNote);
// LAB457 — checklist compartido por todo el equipo asignado a la visita.
r.get("/events/checklist", requireCleaner, listChecklist);
r.patch("/events/checklist/:itemId/completion", requireCleaner, setChecklistCompletion);
r.post("/events/checklist/:itemId/photo-upload-url", requireCleaner, getChecklistPhotoUploadUrl);
r.patch("/events/checklist/:itemId/photo", requireCleaner, attachChecklistPhoto);
r.delete("/events/checklist/:itemId/photos/:photoId", requireCleaner, deleteChecklistPhoto);
// LAB462 — fotos + comentario a la oficina, fuera del checklist.
r.get("/events/central", requireCleaner, listCentralSubmissionsForEvent);
r.post("/events/central/photo-upload-url", requireCleaner, getCentralPhotoUploadUrl);
r.post("/events/central", requireCleaner, createCentralSubmission);
export default r;
