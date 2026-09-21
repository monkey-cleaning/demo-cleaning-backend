import { getBlogModeSnapshot } from "../services/blogModeService.js";

/**
 * GET /api/site-config
 * Público — sin datos sensibles. El front usa blogEnabled para nav / rutas.
 */
export async function getSiteConfig(_req, res) {
  try {
    const snap = await getBlogModeSnapshot();
    return res.json({
      blogEnabled: snap.effective_mode !== "off",
      blogMode: snap.effective_mode,
    });
  } catch (e) {
    console.error("❌ getSiteConfig:", e.message);
    // Misma política que blogModeService: sin lectura fiable → off
    return res.json({
      blogEnabled: false,
      blogMode: "off",
    });
  }
}
