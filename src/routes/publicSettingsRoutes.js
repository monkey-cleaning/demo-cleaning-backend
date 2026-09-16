// Contacto y redes sociales públicos del sitio (Footer, /contact-us, CTA de
// WhatsApp). Sin requireAdmin: la consume el sitio público, no el admin panel.
// Montar en index.js FUERA del grupo /api/admin:
//
//   import publicSettingsRoutes from "./routes/publicSettingsRoutes.js";
//   app.use("/api/public", publicSettingsRoutes);

import { Router } from "express";
import { getSiteSettings } from "../controllers/publicSettingsController.js";

const r = Router();

r.get("/site-settings", getSiteSettings);

export default r;
