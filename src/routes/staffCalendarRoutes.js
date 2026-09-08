import { Router } from "express";
import { requireCleaner } from "../middleware/requireCleaner.js";
import { getStaffCalendarEvents } from "../controllers/staffCalendarController.js";

// LAB423 — namespace separado de /api/calendar (admin): solo lectura.
const r = Router();
r.get("/events", requireCleaner, getStaffCalendarEvents);
export default r;
