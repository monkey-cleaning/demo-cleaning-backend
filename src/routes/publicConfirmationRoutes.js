// Ticket: "Confirmación automática de servicios pendientes (CONFIRMAR)" — Paso 6
//
// Sin requireAdmin a propósito: es el link que el cliente clickea desde el
// email, no puede requerir login. Montar en index.js FUERA del grupo
// /api/admin, ej.:
//
//   import publicConfirmationRoutes from "./routes/publicConfirmationRoutes.js";
//   app.use("/api/public", publicConfirmationRoutes);

import { Router } from "express";
import { confirmSlot } from "../controllers/publicConfirmationController.js";

const r = Router();
r.get("/confirm/:token", confirmSlot);
export default r;