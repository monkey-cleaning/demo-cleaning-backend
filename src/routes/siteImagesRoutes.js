import express from "express";
import { requireAdmin } from "../middleware/requireAdmin.js";
import {
  MAX_IMAGE_BYTES,
  deleteSiteImage,
  getSiteImages,
  putSiteImage,
} from "../controllers/siteImagesController.js";

// Público: el front pinta las imágenes de la landing con esto.
export const publicSiteImagesRouter = express.Router();
publicSiteImagesRouter.get("/", getSiteImages);

// Admin: subir / restaurar default.
export const adminSiteImagesRouter = express.Router();
adminSiteImagesRouter.use(requireAdmin);
adminSiteImagesRouter.get("/", getSiteImages);
adminSiteImagesRouter.put(
  "/:slot",
  // express.json (global) solo consume application/json; esto toma image/*.
  express.raw({ type: "image/*", limit: MAX_IMAGE_BYTES }),
  putSiteImage,
);
adminSiteImagesRouter.delete("/:slot", deleteSiteImage);
