// jobs/appointmentSyncJob.js
//
// Nightly cron that syncs Google Calendar service events into:
//   appointments, appointment_teams, appointment_history
//
// Schedule: every day at 01:00 AM Argentina time (UTC-3 → 06:00 UTC)
// Runs slightly before clientStatusJob (02:00 ART) to avoid DB contention.
//
// Also exposes startAppointmentSyncJob() for registration in server startup,
// and runAppointmentSyncJob() for on-demand calls (e.g. from a REST endpoint).

import cron from "node-cron";
import { syncAppointmentsFromGoogle } from "../services/appointmentSyncService.js";

// How far forward/back to sync on each run
const RANGE_DAYS = Number(process.env.APPT_SYNC_RANGE_DAYS  || 60);
const PAST_DAYS  = Number(process.env.APPT_SYNC_PAST_DAYS   || 7);

// ── On-demand runner (exported so the REST endpoint can call it too) ───────────

export async function runAppointmentSyncJob() {
  try {
    const stats = await syncAppointmentsFromGoogle({
      rangeDays: RANGE_DAYS,
      pastDays:  PAST_DAYS,
    });
    console.log("[AppointmentSyncJob] Completed:", stats);
    return stats;
  } catch (err) {
    console.error("[AppointmentSyncJob] Failed:", err.message);
    throw err;
  }
}

// ── Scheduled runner ───────────────────────────────────────────────────────────

export function startAppointmentSyncJob() {
  // "0 * * * *" = Corre cada hora exacta
  cron.schedule("0 * * * *", async () => {
    console.log("[Cron] Running nightly appointment sync…");
    await runAppointmentSyncJob();
  });

  console.log("[Cron] Appointment sync job scheduled (daily at 03:00 AM ART)");
}