import { getPublicSiteSettings } from "../services/settingsService.js";

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/public/site-settings
// Contacto y redes sociales públicos del sitio (Footer, /contact-us, CTA de
// WhatsApp) — sin auth, ya que el sitio público los necesita sin login.
// Solo expone las 6 keys de contacto/redes, nunca el resto de `settings`
// (parámetros operativos internos).
// ─────────────────────────────────────────────────────────────────────────────
export async function getSiteSettings(req, res) {
  try {
    const settings = await getPublicSiteSettings();
    return res.json({ ok: true, settings });
  } catch (e) {
    console.error("❌ getSiteSettings:", e.message);
    return res.status(500).json({ ok: false, error: e.message });
  }
}
