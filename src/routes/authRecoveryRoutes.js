import { Router } from "express";
import { forgotPassword, resetPassword } from "../controllers/authRecoveryController.js";

// "Forgot your password?" — sin auth (obvio: el usuario no puede loguearse
// justo por esto), compartido por admin y cleaner. Montado en /api/auth, un
// namespace nuevo que no pisa /api/admin/auth ni /api/staff/auth.
const r = Router();
r.post("/forgot-password", forgotPassword);
r.post("/reset-password", resetPassword);
export default r;
