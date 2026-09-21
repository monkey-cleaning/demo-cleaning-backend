import {
  BLOG_MODES,
  getBlogModeSnapshot,
  updateBlogMode,
} from "../services/blogModeService.js";

/**
 * GET /api/admin/settings/blog
 */
export async function getBlogSettings(req, res) {
  try {
    const snap = await getBlogModeSnapshot();
    return res.json({
      ok: true,
      blog_mode: snap.blog_mode,
      effective_mode: snap.effective_mode,
      auto_addon_status: snap.auto_addon_status,
      entitled: snap.entitled,
    });
  } catch (e) {
    console.error("❌ getBlogSettings:", e.message);
    return res.status(500).json({ ok: false, error: e.message });
  }
}

/**
 * PUT /api/admin/settings/blog
 * Body: { blog_mode } — cualquier otro campo se ignora.
 */
export async function updateBlogSettings(req, res) {
  try {
    const blogMode = req.body?.blog_mode;
    if (!BLOG_MODES.includes(blogMode)) {
      return res.status(400).json({
        ok: false,
        error: `blog_mode must be one of: ${BLOG_MODES.join(", ")}`,
      });
    }

    const snap = await updateBlogMode(blogMode);
    return res.json({
      ok: true,
      blog_mode: snap.blog_mode,
      effective_mode: snap.effective_mode,
      auto_addon_status: snap.auto_addon_status,
      entitled: snap.entitled,
    });
  } catch (e) {
    console.error("❌ updateBlogSettings:", e.message);
    return res.status(500).json({ ok: false, error: e.message });
  }
}
