// jobs/coverageAlertJob.js
//
// Alerta diaria de cobertura. Versión lean adaptada de los jobs de alertas de
// Monkey Cleaning (LAB419 "next-day events with no cleaner" + el
// recurringCoverageMonitor) — sin Google Calendar: todo sale de `appointments`
// + `appointment_teams` + la recurrencia local (recurrenceService.js).
//
// Tres señales, en un solo mail a ops (sendCoverageAlert):
//
//   🔴 unassigned  — evento de servicio de MAÑANA sin ningún cleaner activo en
//                    appointment_teams. Sin attendees no hay registro de quién
//                    lo hizo → rompe la liquidación de la quincena.
//   🟠 endingSoon  — serie recurrente viva cuyo fin real (count/until del RRULE)
//                    cae dentro de COVERAGE_ENDING_SOON_DAYS o le quedan
//                    <= COVERAGE_ENDING_SOON_TURNS ocurrencias. Series infinitas
//                    (sin count ni until) se ignoran.
//   🟡 gaps        — una fecha que el RRULE dice que debería tener un
//                    appointment de esa serie y NO existe fila (borrado por
//                    accidente en el medio → accionable si es pronto), o la
//                    instancia está cancelada (salteo deliberado → solo se
//                    reporta si hay 2+ seguidos).
//
// Reevalúa el estado cada corrida (recordatorio persistente, sin tabla de
// estado). Cron diario ~2 h antes del digest, detrás de una guarda para no
// correr en cada import.
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
import {
  deserializeRecurrence,
  expandRecurrenceDates,
} from "../services/recurrenceService.js";
import { DIGEST_CUTOFF_HOUR } from "../services/employeeNotificationService.js";
import { sendCoverageAlert } from "../services/opsNotificationService.js";

const TZ = process.env.BOOKING_TIMEZONE || "America/Vancouver";
const ALERT_HOUR = Math.min(23, Math.max(0, DIGEST_CUTOFF_HOUR - 2));

const ENDING_SOON_TURNS = Number(process.env.COVERAGE_ENDING_SOON_TURNS || 3);
const ENDING_SOON_DAYS = Number(process.env.COVERAGE_ENDING_SOON_DAYS || 21);
const HORIZON_DAYS = Number(process.env.COVERAGE_HORIZON_DAYS || 90);
const ACTIONABLE_DAYS = Number(process.env.COVERAGE_ACTIONABLE_DAYS || 35);

const iso = (dt) => dt.toISODate();
const clientName = (c) =>
  [c?.first_name, c?.last_name].filter(Boolean).join(" ").trim() ||
  "(unnamed client)";

function cadenceLabel(rec) {
  if (!rec) return "?";
  if (rec.freq === "MONTHLY") return rec.interval > 1 ? `every ${rec.interval} months` : "monthly";
  const days = 7 * (rec.interval || 1);
  if (days === 7) return "weekly";
  if (days === 14) return "biweekly";
  return `every ${days} days`;
}

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

// ── (b) + (c) sobre series vivas ───────────────────────────────────────────
async function scanSeries(nowVan) {
  const { data: masters, error } = await supabase
    .from("appointments")
    .select(
      "id, gcal_summary, recurrence_rule, starts_at, scheduled_date, status, client_id, clients(first_name, last_name)",
    )
    .eq("is_series_master", true)
    .not("recurrence_rule", "is", null)
    .neq("status", "cancelled");
  if (error) throw new Error(`series query: ${error.message}`);

  const endingSoon = [];
  const gaps = [];
  const horizonEnd = nowVan.plus({ days: HORIZON_DAYS });
  const actionableEnd = nowVan.plus({ days: ACTIONABLE_DAYS });

  for (const m of masters ?? []) {
    const rec = deserializeRecurrence(m.recurrence_rule);
    if (!rec) continue;
    const dtstartIso = m.starts_at || `${m.scheduled_date}T00:00:00`;

    let allDates;
    try {
      allDates = expandRecurrenceDates(rec, dtstartIso).map((d) =>
        DateTime.fromJSDate(d).setZone(TZ),
      );
    } catch {
      continue;
    }
    const future = allDates.filter((d) => d.startOf("day") >= nowVan.startOf("day"));
    const label = clientName(m.clients);

    // (b) endingSoon — solo series con fin explícito (count o until)
    const hasExplicitEnd = rec.count != null || rec.until != null;
    if (hasExplicitEnd && future.length > 0) {
      const last = future[future.length - 1];
      if (future.length <= ENDING_SOON_TURNS || last <= nowVan.plus({ days: ENDING_SOON_DAYS })) {
        endingSoon.push({
          client: label,
          cadence: cadenceLabel(rec),
          remaining: future.length,
          lastDate: iso(last),
        });
      }
    }

    // (c) gaps — fechas esperadas dentro del horizonte sin fila (o canceladas)
    const expectedInHorizon = future.filter((d) => d <= horizonEnd);
    if (!expectedInHorizon.length) continue;

    const { data: instances } = await supabase
      .from("appointments")
      .select("scheduled_date, status")
      .eq("series_id", m.id)
      .gte("scheduled_date", iso(nowVan))
      .lte("scheduled_date", iso(horizonEnd));
    const byDate = new Map(
      (instances ?? []).map((r) => [r.scheduled_date, r.status]),
    );

    let consecutiveCancelled = 0;
    for (const d of expectedInHorizon) {
      const key = iso(d);
      const st = byDate.get(key);
      if (st === undefined) {
        gaps.push({
          client: label,
          series: m.gcal_summary || "(no title)",
          missingDate: key,
          kind: "HOLE",
          actionable: d <= actionableEnd,
        });
        consecutiveCancelled = 0;
      } else if (st === "cancelled") {
        consecutiveCancelled++;
        if (consecutiveCancelled >= 2) {
          gaps.push({
            client: label,
            series: m.gcal_summary || "(no title)",
            missingDate: key,
            kind: "SKIP x" + consecutiveCancelled,
            actionable: false,
          });
        }
      } else {
        consecutiveCancelled = 0;
      }
    }
  }

  return { endingSoon, gaps };
}

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
    const [unassigned, series] = await Promise.all([
      findUnassignedTomorrow(targetIso),
      scanSeries(nowVan),
    ]);
    const { endingSoon, gaps } = series;

    console.log(
      `[CoverageAlert] ${targetIso} — unassigned=${unassigned.length} endingSoon=${endingSoon.length} gaps=${gaps.length}`,
    );
    for (const u of unassigned) console.log(`   🔴 ${u.timeLabel}  ${u.summary}`);
    for (const e of endingSoon)
      console.log(`   🟠 ${e.client} — ${e.remaining} left, last ${e.lastDate}`);
    for (const g of gaps)
      console.log(`   🟡 ${g.client} — ${g.missingDate} ${g.kind}${g.actionable ? " (act now)" : ""}`);

    const total = unassigned.length + endingSoon.length + gaps.length;
    if (dryRun) {
      console.log("[CoverageAlert] (dry-run) no se manda mail.");
      return { date: targetIso, unassigned: unassigned.length, endingSoon: endingSoon.length, gaps: gaps.length, dryRun: true };
    }
    if (total === 0) return { date: targetIso, unassigned: 0, endingSoon: 0, gaps: 0 };

    await sendCoverageAlert({
      dateLabel,
      unassigned: unassigned.map(({ _sortKey, ...r }) => r),
      endingSoon,
      gaps,
    });
    console.log(`✅ [CoverageAlert] alerta enviada — ${total} item(s).`);
    return { date: targetIso, unassigned: unassigned.length, endingSoon: endingSoon.length, gaps: gaps.length };
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
