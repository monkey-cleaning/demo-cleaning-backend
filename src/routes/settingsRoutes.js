import express from "express";
import { requireAdmin } from "../middleware/requireAdmin.js";
import { getSettings, updateSettings } from "../controllers/settingsController.js";

const router = express.Router();

router.use(requireAdmin);

router.get("/", getSettings);
router.patch("/", updateSettings);

export default router;