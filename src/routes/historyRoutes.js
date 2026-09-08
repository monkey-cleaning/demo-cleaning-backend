import { Router } from "express";
import { requireAdmin } from "../middleware/requireAdmin.js";
import { listHistory } from "../controllers/historyController.js";

// LAB418 — GET /api/admin/history (feed global + historial por registro).
const r = Router();
r.get("/", requireAdmin, listHistory);
export default r;
