import { Router } from "express";
import { requireAdmin } from "../middleware/requireAdmin.js";
import { getAdminPayrollSummary } from "../controllers/payrollController.js";

// LAB428 — resumen quincenal (eventos/horas/traslado/dinero) de TODOS los
// empleados, solo lectura, protegido por requireAdmin.
const r = Router();
r.get("/summary", requireAdmin, getAdminPayrollSummary);
export default r;
