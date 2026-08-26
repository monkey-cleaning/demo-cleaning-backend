import { Router } from "express";
import { getRobotsTxt, getSitemapXml } from "../controllers/seoController.js";

const r = Router();

r.get("/robots.txt", getRobotsTxt);
r.get("/sitemap.xml", getSitemapXml);

export default r;