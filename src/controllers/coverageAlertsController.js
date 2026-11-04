// GET /api/admin/coverage-alerts
//
// Feeds the admin panel's "Coverage" page. Returns the monitor's current
// findings (services/coverageScan.js) flattened, with `ackTargets` for the
// "Resolved for now" / "Silence" buttons.
//
// We serve the last scan if it is recent (< STALE_MS), otherwise a fresh one;
// `?refresh=1` always rescans. If a fresh scan fails but an older one is in
// memory, it is served flagged `stale`.

import { scanCoverage, getLastScan } from "../services/coverageScan.js";

const STALE_MS = 30 * 60 * 1000; // 30 min

export function normalizeOne(f, { suppressed = false } = {}) {
  const kind = f.kind;
  const series = f.seriesId ? { id: f.seriesId, title: f.seriesTitle || null, rrule: f.rrule || null } : null;
  let headline, detail, severity;
  if (kind === "no_coverage") {
    headline = "No coverage";
    detail = `${f.completed150d} service(s) in 150 days · last ${f.lastService || "?"} · no future appointments`;
    severity = "red";
  } else if (kind === "on_demand") {
    headline = "No next appointment (on-demand)";
    detail = `${f.completed150d} service(s) in 150 days (one-off events) · last ${f.lastService || "?"}`;
    severity = "info";
  } else if (kind === "ending_soon") {
    headline = "Series ending soon";
    detail = `${f.reason || ""} · ${f.rrule || ""}`;
    severity = "amber";
  } else if (kind === "gap") {
    headline = f.type === "GAP_HOLE" ? "Gap in the series" : "Skipped appointments";
    detail =
      f.type === "GAP_HOLE"
        ? `No appointment on ${f.missing.join(", ")}` +
          (f.dates.length > f.missing.length ? ` (cancelled in between: ${f.dates.filter((d) => !f.missing.includes(d)).join(", ")})` : "")
        : `Cancelled: ${f.dates.join(", ")}`;
    severity = f.actionable ? "yellow" : "info";
  } else if (kind === "overlap") {
    headline = "Overlapping series";
    detail =
      `${f.series.length} live series, ${f.series[0]?.rrule || "?"} each, ` +
      (f.effectiveEveryDays ? `but together every ~${f.effectiveEveryDays} days` : "landing on nearly the same days") +
      " · " +
      f.series.map((x) => `${x.title?.trim() || "?"} (created ${x.created || "?"}, next ${x.nextDates.join(", ")})`).join(" | ");
    severity = "amber";
  } else {
    headline = kind || "?";
    detail = "";
    severity = "info";
  }

  const out = {
    id: `${kind}:${f.seriesId || f.series?.map((x) => x.seriesId).join("+") || f.clientId}${kind === "gap" ? `:${f.gapFrom}` : ""}`,
    kind,
    severity,
    headline,
    detail,
    actionable: kind === "gap" ? !!f.actionable : severity !== "info",
    client: { id: f.clientId, name: f.name, email: f.email || null, phone: f.phone || null, status: f.status || null },
    series,
    ackTargets: f.ackTargets || [],
  };
  if (suppressed) {
    out.suppressedBy = f.suppressedBy || null;
    out.suppressedUntil = f.suppressedUntil || null;
    out.suppressedScope = f.suppressedScope || null;
  }
  return out;
}

export function normalize(findings) {
  const active = [
    ...findings.noCoverage,
    ...findings.endingSoon,
    ...findings.midGaps,
    ...findings.overlaps,
    ...findings.onDemand,
  ].map((f) => normalizeOne(f));

  const order = { red: 0, amber: 1, yellow: 2, info: 3 };
  active.sort((a, b) => order[a.severity] - order[b.severity] || a.client.name.localeCompare(b.client.name));

  const suppressed = (findings.suppressed || []).map((f) => normalizeOne(f, { suppressed: true }));

  return {
    generatedAt: findings.generatedAt || null,
    counts: {
      no_coverage: findings.noCoverage.length,
      on_demand: findings.onDemand.length,
      ending_soon: findings.endingSoon.length,
      gap_actionable: findings.midGaps.filter((g) => g.actionable).length,
      gap_info: findings.midGaps.filter((g) => !g.actionable).length,
      overlap: findings.overlaps.length,
      suppressed: suppressed.length,
    },
    alerts: active,
    suppressed,
  };
}

export async function getCoverageAlerts(req, res) {
  const refresh = req.query.refresh === "1" || req.query.refresh === "true";
  const last = getLastScan();
  const fresh = last && Date.now() - last.at < STALE_MS;

  try {
    let findings, at;
    if (!refresh && fresh) {
      findings = last.findings;
      at = last.at;
    } else {
      findings = await scanCoverage();
      at = getLastScan()?.at ?? Date.now();
    }
    return res.json({
      ok: true,
      ageSeconds: Math.round((Date.now() - at) / 1000),
      stale: false,
      ...normalize(findings),
    });
  } catch (e) {
    if (last) {
      return res.json({
        ok: true,
        ageSeconds: Math.round((Date.now() - last.at) / 1000),
        stale: true,
        scanError: e.message,
        ...normalize(last.findings),
      });
    }
    return res.status(500).json({ ok: false, error: e.message });
  }
}
