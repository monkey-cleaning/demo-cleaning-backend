// jobs/eTransferSyncJob.js
//
// Nightly cron that pulls Interac e-Transfer notifications from Gmail,
// matches them against open invoices, and upserts into the `etransfers` table.
//
// Schedule: every day at 02:00 AM Argentina time (UTC-3 → 05:00 UTC)
// Runs after appointmentSyncJob (01:00 ART) to avoid DB contention.
//
// Exports:
//   startEtransferSyncJob()  — registers the cron (call once at server startup)
//   runEtransferSyncJob()    — on-demand runner (REST endpoint, manual trigger)

import cron from "node-cron";
import { syncEtransfers } from "../services/eTransferSyncService.js";

// How far back to pull from Gmail on each nightly run.
// Keep this short (e.g. 7 days) for speed; the initial backfill uses a longer window.
const NIGHTLY_LOOKBACK_DAYS = Number(process.env.ETRANSFER_LOOKBACK_DAYS || 7);

// ── On-demand runner ──────────────────────────────────────────────────────────

/**
 * Runs the full e-transfer sync pipeline.
 *
 * @param {{ fromDate?: Date|string, dryRun?: boolean }} opts
 *   fromDate — override lookback window (useful for backfills)
 *   dryRun   — log what would be upserted without writing to DB
 */
export async function runEtransferSyncJob({ fromDate, dryRun = false } = {}) {
  const since = fromDate
    ? new Date(fromDate)
    : new Date(Date.now() - NIGHTLY_LOOKBACK_DAYS * 86_400_000);

  console.log(`[EtransferSyncJob] Starting sync from ${since.toISOString().slice(0, 10)}…`);

  try {
    const stats = await syncEtransfers({ fromDate: since, dryRun });
    console.log("[EtransferSyncJob] Completed:", stats);
    return stats;
  } catch (err) {
    console.error("[EtransferSyncJob] Failed:", err.message);
    throw err;
  }
}

// ── Scheduled runner ──────────────────────────────────────────────────────────

export function startEtransferSyncJob() {
  // "0 5 * * *" = 05:00 UTC = 02:00 AM Argentina (UTC-3)
  cron.schedule("0 5 * * *", async () => {
    console.log("[Cron] Running nightly e-transfer sync…");
    try {
      await runEtransferSyncJob();
    } catch (err) {
      // Don't let a sync failure crash the process — just log it.
      console.error("[Cron] e-transfer sync error:", err.message);
    }
  });

  console.log("[Cron] e-Transfer sync job scheduled (daily at 02:00 AM ART)");
}