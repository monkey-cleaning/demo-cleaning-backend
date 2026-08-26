// jobs/dailyDigestJob.js
//
// Morning cron that replaces Google Calendar's per-invite emails with ONE
// consolidated route-sheet email per cleaner (LAB — "Silenciar emails
// automáticos de Google Calendar y agrupar notificaciones").
//
// Schedule: every day at 06:00 AM America/Vancouver (DIGEST_CUTOFF_HOUR,
// shared with services/employeeNotificationService.js so the same-day
// urgent-alert cutoff in calendarController.js can't drift out of sync).
//
// Unlike jobs/eTransferSyncJob.js (fixed "05:00 UTC" trick — safe there
// because Argentina has no DST), this uses node-cron's `timezone` option
// directly, since Vancouver crosses PST/PDT twice a year.
//
// Exports:
//   startDailyDigestJob()  — registers the cron (call once at server startup)
//   runDailyDigestJob()    — on-demand runner (REST endpoint, manual trigger, tests)

import cron from "node-cron";
import { DateTime } from "luxon";
import { supabase } from "../services/supabaseService.js";
import {
  sendDailyDigestEmail,
  isNotificationExcluded,
  sanitizeNotes,
  DIGEST_CUTOFF_HOUR,
} from "../services/employeeNotificationService.js";

const TZ = process.env.BOOKING_TIMEZONE || "America/Vancouver";

/**
 * Runs the full digest pipeline for a given day.
 *
 * @param {{ date?: string, dryRun?: boolean }} opts
 *   date   — override target date (YYYY-MM-DD), defaults to "today" in TZ
 *   dryRun — log what would be sent without emailing anyone
 */
export async function runDailyDigestJob({ date, dryRun = false } = {}) {
  const targetDate = date || DateTime.now().setZone(TZ).toISODate();
  console.log(`[DailyDigest] Building route sheets for ${targetDate}…`);

  try {
    // NOTE: verify this embed against the real schema before shipping —
    // if `clients` isn't auto-detected off appointments.client_id, use
    // `clients!appointments_client_id_fkey(first_name, last_name)` instead
    // (same caveat applies to any ambiguous FK in Supabase's PostgREST embed).
    const { data: rows, error } = await supabase
      .from("appointments")
      .select(
        "id, scheduled_start_time, scheduled_end_time, property_address, service_type, special_instructions, " +
          "clients(first_name, last_name), " +
          "appointment_teams(employees(id, name, email))",
      )
      .eq("scheduled_date", targetDate)
      .neq("status", "cancelled")
      .order("scheduled_start_time", { ascending: true });

    if (error) throw new Error(error.message);

    // Group tasks by employee_id — one cleaner can be on several jobs today.
    const byEmployee = new Map();
    for (const appt of rows ?? []) {
      const clientName =
        [appt.clients?.first_name, appt.clients?.last_name]
          .filter(Boolean)
          .join(" ") || "Client";

      const task = {
        startTime: appt.scheduled_start_time,
        endTime: appt.scheduled_end_time,
        clientName,
        address: appt.property_address,
        serviceType: appt.service_type,
        notes: sanitizeNotes(appt.special_instructions),
      };

      for (const member of appt.appointment_teams ?? []) {
        const emp = member.employees;
        if (!emp?.email) continue; // can't email without an address on file
        if (!byEmployee.has(emp.id)) {
          byEmployee.set(emp.id, { employee: emp, tasks: [] });
        }
        byEmployee.get(emp.id).tasks.push(task);
      }
    }

    let sent = 0;
    for (const { employee, tasks } of byEmployee.values()) {
      if (!tasks.length) continue; // DoD #2: no tasks → no email
      if (isNotificationExcluded(employee.email)) {
        console.log(
          `[DailyDigest] Excluded — ${employee.name} <${employee.email}> won't be emailed (NOTIFICATION_EXCLUDED_EMAILS)`,
        );
        continue;
      }
      if (dryRun) {
        console.log(
          `[DailyDigest] (dry-run) would email ${employee.name} <${employee.email}> — ${tasks.length} task(s)`,
        );
        continue;
      }
      await sendDailyDigestEmail(employee, tasks);
      sent++;
    }

    console.log(
      `[DailyDigest] ✅ Completed — ${sent} digest(s) sent for ${byEmployee.size} cleaner(s) with tasks (${targetDate}).`,
    );
    return { date: targetDate, cleanersWithTasks: byEmployee.size, sent };
  } catch (err) {
    console.error("[DailyDigest] ❌ Failed:", err.message);
    throw err;
  }
}

// ── Scheduled runner ──────────────────────────────────────────────────────────

export function startDailyDigestJob() {
  cron.schedule(
    `0 ${DIGEST_CUTOFF_HOUR} * * *`,
    async () => {
      console.log("[Cron] Running daily digest…");
      try {
        await runDailyDigestJob();
      } catch (err) {
        // Don't let a send failure crash the process — just log it.
        console.error("[Cron] daily digest error:", err.message);
      }
    },
    { timezone: TZ },
  );

  console.log(
    `[Cron] Daily digest job scheduled (daily at ${DIGEST_CUTOFF_HOUR}:00 AM ${TZ})`,
  );
}