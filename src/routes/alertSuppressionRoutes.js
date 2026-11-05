import express from "express";
import { requireAdmin } from "../middleware/requireAdmin.js";
import {
  listSuppressions,
  createSuppression,
  deleteSuppression,
} from "../controllers/alertSuppressionController.js";

const router = express.Router();
router.use(requireAdmin);

router.get("/", listSuppressions);
router.post("/", createSuppression);
router.delete("/:id", deleteSuppression);

export default router;
