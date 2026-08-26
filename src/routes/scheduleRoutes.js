import express from "express";
import { requireAdmin } from "../middleware/requireAdmin.js";
import {
  upsertAvailability,
  listExtraAvailability,
  createExtraAvailability,
  deleteExtraAvailability,
  listTimeOff,
  createTimeOff,
  deleteTimeOff,
  checkAvailability,
  listExceptions,
  createException,
  deleteException,
} from "../controllers/scheduleController.js";

const router = express.Router();

// All routes require admin auth
router.use(requireAdmin);

// ── Availability check (used by assign-modal) ─────────────────────────────────
// Must be registered BEFORE /:id routes in the parent router to avoid conflict.
// GET /api/admin/staff/availability-check?date=YYYY-MM-DD&start_time=HH:MM&end_time=HH:MM
router.get("/availability-check", checkAvailability);

// ── Weekly recurring availability ─────────────────────────────────────────────
// PUT /api/admin/staff/:id/availability   — full replace
router.put("/:id/availability", upsertAvailability);

// ── Extra (one-off date) availability ─────────────────────────────────────────
// GET    /api/admin/staff/:id/extra-availability
// POST   /api/admin/staff/:id/extra-availability
// DELETE /api/admin/staff/:id/extra-availability/:extraId
router.get   ("/:id/extra-availability",            listExtraAvailability);
router.post  ("/:id/extra-availability",            createExtraAvailability);
router.delete("/:id/extra-availability/:extraId",   deleteExtraAvailability);

// ── Time off ─────────────────────────────────────────────────────────────────
router.get   ("/:id/time-off",             listTimeOff);
router.post  ("/:id/time-off",             createTimeOff);
router.delete("/:id/time-off/:timeOffId",  deleteTimeOff);

// ── Exceptions (partial-day or full-day absences) ─────────────────────────────
router.get   ("/:id/exceptions",                 listExceptions);
router.post  ("/:id/exceptions",                 createException);
router.delete("/:id/exceptions/:exceptionId",    deleteException);

export default router;