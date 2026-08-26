import { syncAvailabilityFromGoogle } from "../services/calendarAvailabilitySync.js";

const JOB_TOKEN = process.env.JOBS_TOKEN;

export async function syncAvailability(req, res) {
  try {
    const auth = req.get("authorization") || req.get("Authorization") || "";
    const ok = JOB_TOKEN && auth.trim() === `Bearer ${JOB_TOKEN}`;
    if (!ok) return res.status(401).json({ error: "Unauthorized" });

    const rangeDays = Number(req.query.rangeDays || 30);
    const result = await syncAvailabilityFromGoogle({ rangeDays: Number.isFinite(rangeDays) ? rangeDays : 30 });

    return res.json({ ok: true, ...result, now: new Date().toISOString() });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message });
  }
}