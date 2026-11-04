// jobs/coverageAlertJob.js
//
// Alerta diaria de cobertura. Versión lean adaptada de los jobs de alertas de
// Monkey Cleaning (LAB419 "next-day events with no cleaner" + el
// recurringCoverageMonitor) — sin Google Calendar: todo sale de `appointments`
// + `appointment_teams` + la recurrencia local (recurrenceService.js).
//
// Un solo mail a ops (sendCoverageAlert) con:
//
//   🔴 unassigned  — evento de servicio de MAÑANA sin ningún cleaner activo en
//                    appointment_teams. Sin attendees no hay registro de quién
//                    lo hizo → rompe la liquidación de la quincena.
//   🔴 noCoverage  — cliente con servicio regular y una serie, sin NADA futuro.
//   🟠 endingSoon  — serie con fin explícito (count/until) cerca.
//   🟡 gaps        — hueco accionable dentro de una serie viva (los salteos
//                    deliberados son informativos y no se mandan).
//   🟣 overlaps    — series vivas del mismo cliente que se pisan.
//
// Las cuatro últimas las calcula services/coverageScan.js (el mismo escaneo que
// alimenta el panel "Coverage" del admin) y respetan las supresiones: lo que el
// admin marca como "resuelto" o "silenciado" deja de llegar por mail.
//
// Reevalúa el estado cada corrida (recordatorio persistente). Cron diario ~2 h
// antes del digest.
//
// CLI:
//   node src/jobs/coverageAlertJob.js
//   node src/jobs/coverageAlertJob.js --date=2026-09-10
//   node src/jobs/coverageAlertJob.js --dry-run

import "dotenv/config";
import cron from "node-cron";
import { pathToFileURL } from "node:url";
import { DateTime } from "luxon";
import { supabase } from "../supabaseClient.js";
import { isNonServiceEventRow } from "../services/eventClassification.js";
import { scanCoverage } from "../services/coverageScan.js";
import { DIGEST_CUTOFF_HOUR } from "../services/employeeNotificationService.js";
import { sendCoverageAlert } from "../services/opsNotificationService.js";

import { TZ } from "../config/timezone.js";
const ALERT_HOUR = Math.min(23, Math.max(0, DIGEST_CUTOFF_HOUR - 2));

// ── (a) eventos de mañana sin cleaner ──────────────────────────────────────
async function findUnassignedTomorrow(dateIso) {
  const { data: rows, error } = await supabase
    .from("appointments")
    .select(
      "id, gcal_summary, color_id, special_instructions, property_address, starts_at, ends_at, status, " +
        "appointment_teams(employee_id, employees(is_active))",
    )
    .eq("scheduled_date", dateIso)
    .neq("status", "cancelled");
  if (error) throw new Error(`unassigned query: ${error.message}`);

  const out = [];
  for (const row of rows ?? []) {
    if (isNonServiceEventRow(row)) continue;
    const hasActiveCleaner = (row.appointment_teams ?? []).some(
      (t) => t.employees?.is_active,
    );
    if (hasActiveCleaner) continue;
    const start = row.starts_at
      ? DateTime.fromISO(row.starts_at, { zone: TZ })
      : null;
    const end = row.ends_at ? DateTime.fromISO(row.ends_at, { zone: TZ }) : null;
    out.push({
      timeLabel:
        start && end
          ? `${start.toFormat("h:mm a")} – ${end.toFormat("h:mm a")}`
          : start
            ? start.toFormat("h:mm a")
            : "all day",
      summary: row.gcal_summary || "(no title)",
      address: row.property_address || "",
      teamHint: (row.appointment_teams ?? []).length
        ? "team rows exist but none is an active cleaner"
        : "",
      _sortKey: start ? start.toMillis() : 0,
    });
  }
  return out.sort((a, b) => a._sortKey - b._sortKey);
}

// Forma que espera el mail (tablas planas).
const emailNoCoverage = (f) => ({
  client: f.name,
  completed: f.completed150d,
  lastService: f.lastService || "?",
});
const emailEndingSoon = (f) => ({
  client: f.name,
  cadence: f.rrule,
  remaining: f.remaining,
  lastDate: f.lastInstance,
});
const emailGap = (f) => ({
  client: f.name,
  series: f.seriesTitle || "(no title)",
  missingDate: f.missing.join(", "),
  kind: "HOLE",
  actionable: f.actionable,
});
const emailOverlap = (f) => ({
  client: f.name,
  detail:
    `${f.series.length} live series, each ${f.series[0]?.rrule || "?"}, ` +
    (f.effectiveEveryDays
      ? `together every ~${f.effectiveEveryDays} days`
      : "on nearly the same days"),
  series: f.series.map((s) => `${s.title?.trim() || "?"} (next ${s.nextDates.join(", ")})`).join(" | "),
});

/**
 * @param {{ date?: string, dryRun?: boolean }} opts
 *   date   — día objetivo para la señal (a), YYYY-MM-DD. Default: mañana.
 *   dryRun — arma el análisis y loguea pero no manda mail.
 */
export async function runCoverageAlertJob({ date, dryRun = false } = {}) {
  const nowVan = DateTime.now().setZone(TZ);
  const targetIso = date || nowVan.plus({ days: 1 }).toISODate();
  const dateLabel = DateTime.fromISO(targetIso, { zone: TZ }).toFormat(
    "cccc, LLLL d",
  );

  try {
    const [unassigned, scan] = await Promise.all([
      findUnassignedTomorrow(targetIso),
      scanCoverage(),
    ]);
    const noCoverage = scan.noCoverage.map(emailNoCoverage);
    const endingSoon = scan.endingSoon.map(emailEndingSoon);
    const gaps = scan.midGaps.filter((g) => g.actionable).map(emailGap);
    const overlaps = scan.overlaps.map(emailOverlap);

    const counts = {
      unassigned: unassigned.length,
      noCoverage: noCoverage.length,
      endingSoon: endingSoon.length,
      gaps: gaps.length,
      overlaps: overlaps.length,
    };
    console.log(
      `[CoverageAlert] ${targetIso} — ${Object.entries(counts).map(([k, v]) => `${k}=${v}`).join(" ")} suppressed=${scan.suppressed.length}`,
    );
    for (const u of unassigned) console.log(`   🔴 ${u.timeLabel}  ${u.summary}`);
    for (const f of scan.noCoverage) console.log(`   🔴 ${f.name} — no future service, last ${f.lastService}`);
    for (const f of scan.endingSoon) console.log(`   🟠 ${f.name} — ${f.remaining} left, last ${f.lastInstance}`);
    for (const f of scan.midGaps.filter((g) => g.actionable)) console.log(`   🟡 ${f.name} — ${f.missing.join(", ")}`);
    for (const f of scan.overlaps) console.log(`   🟣 ${f.name} — ${f.series.length} overlapping series`);

    const total = Object.values(counts).reduce((a, b) => a + b, 0);
    if (dryRun) {
      console.log("[CoverageAlert] (dry-run) no se manda mail.");
      return { date: targetIso, ...counts, dryRun: true };
    }
    if (total === 0) return { date: targetIso, ...counts };

    await sendCoverageAlert({
      dateLabel,
      unassigned: unassigned.map(({ _sortKey, ...r }) => r),
      noCoverage,
      endingSoon,
      gaps,
      overlaps,
    });
    console.log(`✅ [CoverageAlert] alerta enviada — ${total} item(s).`);
    return { date: targetIso, ...counts };
  } catch (e) {
    console.error("❌ [CoverageAlert] job failed:", e.message);
    return { date: targetIso, error: e.message };
  }
}

export function startCoverageAlertJob() {
  cron.schedule(`0 ${ALERT_HOUR} * * *`, () => runCoverageAlertJob(), {
    timezone: TZ,
  });
  console.log(
    `🕒 [CoverageAlert] Cron registrado: diario ${ALERT_HOUR}:00 (${TZ})`,
  );
}

// ── CLI ────────────────────────────────────────────────────────────────────
const isDirectRun =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isDirectRun) {
  const args = {};
  for (const raw of process.argv.slice(2)) {
    const [k, v] = raw.replace(/^--/, "").split("=");
    if (k === "date") args.date = v;
    else if (k === "dry-run" || k === "dryRun") args.dryRun = true;
  }
  runCoverageAlertJob(args)
    .then((r) => process.exit(r?.error ? 2 : 0))
    .catch((err) => {
      console.error("[CoverageAlert] ERROR:", err.message);
      process.exit(2);
    });
}
