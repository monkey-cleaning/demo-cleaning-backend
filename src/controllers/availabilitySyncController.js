// LAB, ago 2026 — syncAvailabilityFromGoogle() se eliminó de
// calendarAvailabilitySync.js en el fork standalone (Fase 2, tarea 2.9): la
// disponibilidad ya sale de `appointments`/Supabase directo (vía
// availabilityController.bookAvailability, 2.6), no hace falta sincronizar
// desde Google Calendar. Esta ruta queda deprecada — devuelve 410 en vez de
// crashear el import o desaparecer en silencio, por si queda algún caller
// externo (Render Cron Job u otro scheduler) todavía apuntando acá.
const JOB_TOKEN = process.env.JOBS_TOKEN;

export async function syncAvailability(req, res) {
  const auth = req.get("authorization") || req.get("Authorization") || "";
  const ok = JOB_TOKEN && auth.trim() === `Bearer ${JOB_TOKEN}`;
  if (!ok) return res.status(401).json({ error: "Unauthorized" });

  return res.status(410).json({
    ok: false,
    error:
      "Este endpoint fue removido: la disponibilidad ya no se sincroniza desde Google Calendar en esta instancia. Remover cualquier Cron Job externo que apunte acá.",
  });
}