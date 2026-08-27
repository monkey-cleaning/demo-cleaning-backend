// POST /api/jobs/availability/sync
//
// Regenera `cleaning_availability` a partir de `appointments`. Requiere header
// Authorization: Bearer <JOBS_TOKEN>.
//
// Historia: esta ruta llamaba a syncAvailabilityFromGoogle(), que se eliminó al
// desacoplar de Google Calendar (Fase 2.9). Quedó como stub 410 y la tabla dejó
// de poblarse — nada la reemplazaba, así que /available se quedó sin horarios.
// Ahora ejecuta availabilityGeneratorService.generateAvailability(), que hace lo
// mismo leyendo la ocupación de `appointments` en vez de la API de Calendar.
//
// Query params opcionales:
//   ?rangeDays=30   horizonte en días (1-90, default 30)
//   ?dryRun=1       calcula y reporta sin escribir

import { generateAvailability } from "../services/availabilityGeneratorService.js";

const JOB_TOKEN = process.env.JOBS_TOKEN;

export async function syncAvailability(req, res) {
  const auth = req.get("authorization") || req.get("Authorization") || "";
  const ok = JOB_TOKEN && auth.trim() === `Bearer ${JOB_TOKEN}`;
  if (!ok) return res.status(401).json({ error: "Unauthorized" });

  const parsedRange = parseInt(req.query.rangeDays, 10);
  const rangeDays =
    Number.isInteger(parsedRange) && parsedRange >= 1 && parsedRange <= 90
      ? parsedRange
      : 30;

  const dryRun = req.query.dryRun === "1" || req.query.dryRun === "true";

  try {
    const result = await generateAvailability({ rangeDays, dryRun });
    return res.json(result);
  } catch (err) {
    console.error("❌ [availability/sync] Falló la generación:", err);
    return res.status(500).json({ ok: false, error: err.message });
  }
}
