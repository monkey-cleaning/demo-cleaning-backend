import {
  ALLOWED_MIME,
  MAX_IMAGE_BYTES,
  SLOT_RE,
  listSiteImages,
  resetSiteImage,
  setSiteImage,
} from "../services/siteImagesService.js";

/** GET /api/site-images (público) y /api/admin/site-images */
export async function getSiteImages(_req, res) {
  try {
    return res.json({ images: await listSiteImages() });
  } catch (e) {
    console.error("❌ getSiteImages:", e.message);
    // El front cae a las imágenes por defecto si no hay overrides.
    return res.status(500).json({ error: "Could not load site images" });
  }
}

/** PUT /api/admin/site-images/:slot — body = bytes crudos de la imagen. */
export async function putSiteImage(req, res) {
  const { slot } = req.params;
  if (!SLOT_RE.test(slot)) {
    return res.status(400).json({ error: "Invalid slot" });
  }
  const mime = (req.headers["content-type"] || "").split(";")[0].trim();
  if (!ALLOWED_MIME.includes(mime)) {
    return res
      .status(415)
      .json({ error: `Unsupported type. Allowed: ${ALLOWED_MIME.join(", ")}` });
  }
  if (!Buffer.isBuffer(req.body) || req.body.length === 0) {
    return res.status(400).json({ error: "Empty image body" });
  }
  try {
    await setSiteImage(slot, req.body, mime);
    return res.json({ images: await listSiteImages() });
  } catch (e) {
    console.error("❌ putSiteImage:", e.message);
    return res.status(500).json({ error: "Could not save image" });
  }
}

/** DELETE /api/admin/site-images/:slot — vuelve a la imagen por defecto. */
export async function deleteSiteImage(req, res) {
  const { slot } = req.params;
  if (!SLOT_RE.test(slot)) {
    return res.status(400).json({ error: "Invalid slot" });
  }
  try {
    await resetSiteImage(slot);
    return res.json({ images: await listSiteImages() });
  } catch (e) {
    console.error("❌ deleteSiteImage:", e.message);
    return res.status(500).json({ error: "Could not reset image" });
  }
}

export { MAX_IMAGE_BYTES };
