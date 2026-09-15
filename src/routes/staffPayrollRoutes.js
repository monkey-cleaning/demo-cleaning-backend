import { Router } from "express";
import { requireCleaner } from "../middleware/requireCleaner.js";
import { getStaffPayrollSummary } from "../controllers/payrollController.js";

// LAB428 — resumen quincenal (eventos/horas/traslado) del cleaner logueado,
// solo lectura, protegido por requireCleaner. Nunca incluye plata.
const r = Router();
r.get("/summary", requireCleaner, getStaffPayrollSummary);
export default r;
