import { Router } from "express";
import { requireCleaner } from "../middleware/requireCleaner.js";
import { getStaffHoursSummary } from "../controllers/staffHoursController.js";

// LAB425 — horas por quincena, solo lectura.
const r = Router();
r.get("/summary", requireCleaner, getStaffHoursSummary);
export default r;
