import express from "express";
import { getSiteConfig } from "../controllers/siteConfigController.js";

const router = express.Router();

router.get("/", getSiteConfig);

export default router;
