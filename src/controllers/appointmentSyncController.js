// POST /api/admin/appointments/sync
// Triggers an on-demand run of the appointment sync job.
// Protected by requireAdmin (same as all other admin routes).

import { runAppointmentSyncJob } from "../jobs/appointmentSyncJob.js";

export async function triggerAppointmentSync(req, res) {
  try {
    const stats = await runAppointmentSyncJob();
    return res.json({ ok: true, ...stats, syncedAt: new Date().toISOString() });
  } catch (err) {
    console.error("[AppointmentSyncController]", err.message);
    return res.status(500).json({ ok: false, error: err.message });
  }
}