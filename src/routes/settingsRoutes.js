import express from "express";
import { requireAdmin } from "../middleware/requireAdmin.js";
import { getSettings, updateSettings } from "../controllers/settingsController.js";
import {
  getBlogSettings,
  updateBlogSettings,
} from "../controllers/blogSettingsController.js";

const router = express.Router();

router.use(requireAdmin);

// Blog mode (site_settings) — antes que "/" para no capturar "blog" como key
router.get("/blog", getBlogSettings);
router.put("/blog", updateBlogSettings);

router.get("/", getSettings);
router.patch("/", updateSettings);

export default router;