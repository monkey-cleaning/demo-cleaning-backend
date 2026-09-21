import {
  getBlogModeSnapshot,
  getEffectiveBlogMode,
} from "../services/blogModeService.js";

/**
 * Tras requireSeoBlogPlatformToken.
 * Si el modo efectivo no es 'auto', deja el snapshot en req.blogMode para que
 * el handler decida (draft unpublish permitido; create/publish → 409).
 */
export async function attachBlogMode(req, _res, next) {
  try {
    req.blogMode = await getBlogModeSnapshot();
    next();
  } catch (err) {
    console.error("[blog] attachBlogMode:", err.message);
    next(err);
  }
}

/**
 * Soft-gate para POST ingest: si no es auto, solo permite despublicar
 * (status draft + external_id existente). El handler hace el chequeo fino;
 * este middleware solo adjunta el modo.
 *
 * Alias semántico usado en la ruta de ingest.
 */
export async function loadBlogModeForIngest(req, res, next) {
  return attachBlogMode(req, res, next);
}

/**
 * Rechaza con 409 si efectivo !== 'auto'. Usar en rutas que requieren auto
 * estricto (hoy no se usa en POST porque draft unpublish es excepción).
 */
export async function requireEffectiveAutoBlog(req, res, next) {
  try {
    const snap = req.blogMode || (await getBlogModeSnapshot());
    req.blogMode = snap;
    if (snap.effective_mode !== "auto") {
      return res.status(409).json({
        success: false,
        code: "blog_auto_disabled",
        mode: snap.effective_mode,
      });
    }
    next();
  } catch (err) {
    console.error("[blog] requireEffectiveAutoBlog:", err.message);
    return res.status(500).json({ success: false, error: "Internal error" });
  }
}

export { getEffectiveBlogMode };
