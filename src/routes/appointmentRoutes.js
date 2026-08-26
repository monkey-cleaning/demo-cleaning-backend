import express from "express";
import { requireAdmin } from "../middleware/requireAdmin.js";
import {
  getWeeklySummary,
  listAppointments,
  getAppointment,
  createAppointment,
  updateAppointment,
  deleteAppointment,
} from "../controllers/appointmentController.js";

const router = express.Router();

// All routes require admin auth
router.use(requireAdmin);

// Batch summary — MUST be registered before /:id to avoid route conflict
router.get("/weekly-summary", getWeeklySummary);

// CRUD
router.get("/",      listAppointments);
router.post("/",     createAppointment);
router.get("/:id",   getAppointment);
router.patch("/:id", updateAppointment);
router.delete("/:id", deleteAppointment);

export default router;