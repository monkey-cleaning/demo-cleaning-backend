// Nightly cron — updates client statuses based on days since last_activity_at.
// Schedule: every day at 02:00 AM Vancouver time.

import cron from "node-cron";
import { runStatusRefreshJob } from "../controllers/clientController.js";

export function startClientStatusJob() {
  cron.schedule(
    "0 2 * * *",
    async () => {
      console.log("[Cron] Running nightly client status refresh…");
      await runStatusRefreshJob();
    },
    { timezone: "America/Vancouver" },
  );
  console.log(
    "[Cron] Client status job scheduled (daily at 02:00 AM Vancouver time)",
  );
}
