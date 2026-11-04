// services/coverageScan.js
//
// Monitor de cobertura de series recurrentes. Versión Demo del
// recurringCoverageMonitor de Monkey Cleaning: sin Google Calendar, todo sale de
// `appointments` + la recurrencia local (recurrenceService.js).
//
// Hallazgos, de más grave a menos:
//
//   🔴 no_coverage — cliente con servicio reciente (2+ en 150 días) que tuvo una
//                    serie recurrente y hoy no tiene NINGÚN evento de servicio
//                    futuro dentro del horizonte (serie rota, borrada o vencida).
//   ⚪ on_demand   — igual, pero sin serie: servicio regular por eventos sueltos
//                    ("confirmar la próxima cita"). Solo informativo.
//   🟠 ending_soon — serie con fin explícito (count/until) cerca. Las "Never"
//                    no entran: las renueva seriesRenewalJob.
//   🟡 gap         — fecha que la regla dice que debería existir y no hay fila
//                    (GAP_HOLE, accionable si es pronto) o 2+ canceladas seguidas
//                    (GAP_SKIP, informativo).
//   🟣 overlap     — el mismo cliente tiene 2+ series vivas (misma dirección,
//                    cadencia parecida) cuyos turnos se pisan o se intercalan:
//                    la frecuencia real es mayor que la de cada regla. Casi
//                    siempre es una serie nueva creada sin cortar la vieja.
//
// Cómo se silencia (en este orden):
//   1. clients.status distinto de active/at_risk/vacío  → todo el cliente
//   2. clients.postponed_until en el futuro             → hasta esa fecha
//   3. alert_suppressions (migración 20261103), sobre el cliente o la serie,
//      de todo (finding_kind null) o de un solo tipo. Con vencimiento = "resuelto
//      por ahora".
// Cada hallazgo trae `ackTargets`: lo que el panel puede silenciar.
//
// `analyzeCoverage` es puro (testeable); `scanCoverage` arma los datos.

import { DateTime } from "luxon";
import { supabase } from "../supabaseClient.js";
import { TZ } from "../config/timezone.js";
import { isNonServiceEventRow } from "./eventClassification.js";
import { deserializeRecurrence, expandRecurrenceDates } from "./recurrenceService.js";

export const ALERT_TYPE = "recurring_coverage";
export const FINDING_KINDS = ["no_coverage", "on_demand", "ending_soon", "gap", "overlap"];

const PAGE = 1000;
const LIVE_CLIENT_STATUS = new Set(["active", "at_risk", ""]);

export const DEFAULT_CONFIG = {
  lookbackDays: Number(process.env.COVERAGE_LOOKBACK_DAYS || 150),
  minServices: Number(process.env.COVERAGE_MIN_SERVICES || 2),
  horizonDays: Number(process.env.COVERAGE_HORIZON_DAYS || 90),
  endingSoonTurns: Number(process.env.COVERAGE_ENDING_SOON_TURNS || 3),
  endingSoonDays: Number(process.env.COVERAGE_ENDING_SOON_DAYS || 21),
  actionableDays: Number(process.env.COVERAGE_ACTIONABLE_DAYS || 35),
};

const iso = (dt) => dt.toISODate();
const dOnly = (s) => String(s || "").slice(0, 10);
const norm = (s) =>
  String(s || "").toLowerCase().replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim();
const clientName = (c) =>
  [c?.first_name, c?.last_name].filter(Boolean).join(" ").trim() || "(unnamed client)";

export function cadenceLabel(rec) {
  if (!rec) return "?";
  if (rec.freq === "MONTHLY") {
    const nth = rec.monthly?.type === "nthWeekday" ? " (by weekday)" : "";
    return (rec.interval > 1 ? `every ${rec.interval} months` : "monthly") + nth;
  }
  const weeks = rec.interval || 1;
  const multi = rec.byDay?.length > 1 ? ` (${rec.byDay.length} days a week)` : "";
  if (weeks === 1) return "weekly" + multi;
  if (weeks === 2) return "biweekly" + multi;
  return `every ${weeks} weeks` + multi;
}

// Días entre turnos. null si no hay una cadencia limpia (varios días por semana).
export function cadenceDays(rec) {
  if (!rec) return null;
  if (rec.freq === "MONTHLY") return 30 * (rec.interval || 1);
  if ((rec.byDay?.length ?? 0) > 1) return null;
  return 7 * (rec.interval || 1);
}

const dayNum = (dt) => Date.UTC(dt.year, dt.month - 1, dt.day) / 864e5;
const isoOfDay = (n) => new Date(n * 864e5).toISOString().slice(0, 10);
const median = (arr) => {
  const a = [...arr].sort((x, y) => x - y);
  if (!a.length) return 0;
  return a.length % 2 ? a[(a.length - 1) / 2] : (a[a.length / 2 - 1] + a[a.length / 2]) / 2;
};
const locKey = (l) => norm(String(l || "").split(",")[0]).replace(/\s/g, "");

/**
 * Análisis puro.
 *
 * @param {object} p
 * @param {import("luxon").DateTime} p.now           ahora, en la zona del negocio
 * @param {object} [p.cfg]                            DEFAULT_CONFIG
 * @param {Array}  p.masters                          maestros de serie vivos (con recurrence_rule)
 * @param {Array}  p.instances                        filas de series dentro del horizonte:
 *                                                    { series_id, scheduled_date, status }
 *                                                    (el maestro entra con series_id = su id)
 * @param {Array}  p.pastServices                     servicios no cancelados ya pasados dentro
 *                                                    del lookback: { client_id, scheduled_date, series_id, is_series_master }
 * @param {Set}    p.futureClientIds                   clientes con algún servicio futuro en el horizonte
 * @param {Array}  p.clients                          clients (id, first_name, last_name, email, phone, status, postponed_until)
 * @param {Array}  p.suppressions                     alert_suppressions (entity_type, entity_id, finding_kind, reason, expires_at)
 */
export function analyzeCoverage({
  now,
  cfg = DEFAULT_CONFIG,
  masters,
  instances,
  pastServices,
  futureClientIds,
  clients,
  suppressions,
}) {
  const today = now.startOf("day");
  const horizonEnd = today.plus({ days: cfg.horizonDays });
  const actionableEnd = today.plus({ days: cfg.actionableDays });
  const clientById = new Map(clients.map((c) => [c.id, c]));

  // ── supresiones ──────────────────────────────────────────────────────────
  const activeSupps = (suppressions ?? []).filter(
    (s) => !s.expires_at || DateTime.fromISO(s.expires_at) > now,
  );
  function matchSupp(entityType, entityId, kind) {
    return activeSupps.find(
      (s) =>
        s.entity_type === entityType &&
        s.entity_id === String(entityId) &&
        (s.finding_kind == null || s.finding_kind === kind),
    );
  }
  function clientStatusSuppression(c) {
    if (!c) return { reason: "no client record", scope: "client-status" };
    const st = String(c.status ?? "").toLowerCase();
    if (!LIVE_CLIENT_STATUS.has(st)) return { reason: `status=${c.status}`, scope: "client-status" };
    if (c.postponed_until && DateTime.fromISO(c.postponed_until, { zone: TZ }) > now)
      return {
        reason: `paused until ${dOnly(c.postponed_until)}`,
        until: c.postponed_until,
        scope: "client-status",
      };
    return null;
  }
  // → { reason, until?, scope } | null
  function findSuppression({ clientId, seriesId, kind }) {
    const st = clientStatusSuppression(clientById.get(clientId));
    if (st) return st;
    const c = matchSupp("client", clientId, kind);
    if (c) return { reason: c.reason, until: c.expires_at, scope: "client" };
    if (seriesId) {
      const s = matchSupp("recurring_series", seriesId, kind);
      if (s) return { reason: s.reason, until: s.expires_at, scope: "series" };
    }
    return null;
  }
  function ackTargets({ clientId, seriesId, kind }) {
    const t = [{ entityType: "client", entityId: clientId, findingKind: kind, label: "this warning" }];
    if (seriesId)
      t.unshift({ entityType: "recurring_series", entityId: seriesId, findingKind: kind, label: "this series" });
    t.push({ entityType: "client", entityId: clientId, findingKind: null, label: "all alerts for this client" });
    return t;
  }

  const findings = {
    noCoverage: [],
    onDemand: [],
    endingSoon: [],
    midGaps: [],
    overlaps: [],
    suppressed: [],
    config: cfg,
    generatedAt: now.toISO(),
  };
  const clientBase = (cid) => {
    const c = clientById.get(cid);
    return {
      clientId: cid,
      name: clientName(c),
      email: c?.email ?? null,
      phone: c?.phone ?? null,
      status: c?.status ?? null,
    };
  };
  const place = (bucket, rec, { clientId, seriesId, kind, extraSeriesIds = [] }) => {
    const supp =
      findSuppression({ clientId, seriesId, kind }) ||
      extraSeriesIds.map((sid) => findSuppression({ clientId, seriesId: sid, kind })).find(Boolean);
    if (supp)
      findings.suppressed.push({
        ...rec,
        suppressedBy: supp.reason,
        suppressedUntil: supp.until || null,
        suppressedScope: supp.scope,
      });
    else bucket.push(rec);
  };

  // ── índice de instancias vivas / todas por serie ─────────────────────────
  const bySeries = new Map(); // seriesId → Map(date → status)
  for (const r of instances ?? []) {
    if (!r.series_id) continue;
    if (!bySeries.has(r.series_id)) bySeries.set(r.series_id, new Map());
    bySeries.get(r.series_id).set(dOnly(r.scheduled_date), r.status);
  }

  // ── 🔴 sin cobertura / ⚪ on-demand ───────────────────────────────────────
  const done = new Map(); // clientId → { n, last, hasSeries }
  for (const r of pastServices ?? []) {
    if (!r.client_id) continue;
    const d = done.get(r.client_id) ?? { n: 0, last: null, hasSeries: false };
    d.n++;
    const day = dOnly(r.scheduled_date);
    if (!d.last || day > d.last) d.last = day;
    if (r.series_id || r.is_series_master) d.hasSeries = true;
    done.set(r.client_id, d);
  }
  for (const m of masters ?? []) if (m.client_id && done.has(m.client_id)) done.get(m.client_id).hasSeries = true;

  for (const [cid, d] of done) {
    if (d.n < cfg.minServices) continue; // un solo servicio: casi seguro one-time
    if (futureClientIds?.has(cid)) continue;
    const kind = d.hasSeries ? "no_coverage" : "on_demand";
    const rec = {
      kind,
      ...clientBase(cid),
      completed150d: d.n,
      hasSeries: d.hasSeries,
      lastService: d.last,
      ackTargets: ackTargets({ clientId: cid, kind }),
    };
    place(kind === "no_coverage" ? findings.noCoverage : findings.onDemand, rec, { clientId: cid, kind });
  }

  // ── por serie: ending_soon, gap, y material para overlap ─────────────────
  const liveByClient = new Map(); // clientId → [{ m, rec, days, cad, loc }]
  for (const m of masters ?? []) {
    if (isNonServiceEventRow(m)) continue;
    const rec = deserializeRecurrence(m.recurrence_rule);
    if (!rec) continue;
    const dtstartIso = m.starts_at || `${m.scheduled_date}T00:00:00`;
    let allDates;
    try {
      allDates = expandRecurrenceDates(rec, dtstartIso).map((d) => DateTime.fromJSDate(d).setZone(TZ));
    } catch {
      continue;
    }
    const future = allDates.filter((d) => d.startOf("day") >= today);
    const cid = m.client_id;
    if (!cid) continue;
    const seriesBase = {
      ...clientBase(cid),
      seriesId: m.id,
      seriesTitle: m.gcal_summary || null,
      rrule: cadenceLabel(rec),
    };

    // 🟠 ending_soon — solo series con fin explícito
    if ((rec.count != null || rec.until != null) && !rec.endless && future.length > 0) {
      const last = future[future.length - 1];
      if (future.length <= cfg.endingSoonTurns || last <= today.plus({ days: cfg.endingSoonDays })) {
        const cad = cadenceDays(rec);
        place(
          findings.endingSoon,
          {
            kind: "ending_soon",
            ...seriesBase,
            cadenceDays: cad,
            remaining: future.length,
            lastInstance: iso(last),
            reason: `${future.length} left, last on ${iso(last)}`,
            ackTargets: ackTargets({ clientId: cid, seriesId: m.id, kind: "ending_soon" }),
          },
          { clientId: cid, seriesId: m.id, kind: "ending_soon" },
        );
      }
    }

    // 🟡 gap — fechas esperadas dentro del horizonte sin fila (o canceladas)
    const rows = bySeries.get(m.id) ?? new Map();
    const expected = future.filter((d) => d <= horizonEnd);
    let run = [];
    const flush = () => {
      if (!run.length) return;
      const holes = run.filter((x) => x.st === undefined);
      const dates = run.map((x) => x.key);
      if (holes.length) {
        place(
          findings.midGaps,
          {
            kind: "gap",
            ...seriesBase,
            type: "GAP_HOLE",
            dates,
            gapFrom: dates[0],
            gapTo: dates.at(-1),
            missing: holes.map((x) => x.key),
            actionable: DateTime.fromISO(dates[0], { zone: TZ }) <= actionableEnd,
            ackTargets: ackTargets({ clientId: cid, seriesId: m.id, kind: "gap" }),
          },
          { clientId: cid, seriesId: m.id, kind: "gap" },
        );
      } else if (run.length >= 2) {
        place(
          findings.midGaps,
          {
            kind: "gap",
            ...seriesBase,
            type: "GAP_SKIP",
            dates,
            gapFrom: dates[0],
            gapTo: dates.at(-1),
            missing: [],
            actionable: false,
            ackTargets: ackTargets({ clientId: cid, seriesId: m.id, kind: "gap" }),
          },
          { clientId: cid, seriesId: m.id, kind: "gap" },
        );
      }
      run = [];
    };
    for (const d of expected) {
      const key = iso(d);
      const st = rows.get(key);
      if (st === undefined || st === "cancelled") run.push({ key, st });
      else flush();
    }
    flush();

    // material para overlap: días de instancias vivas dentro del horizonte
    const cad = cadenceDays(rec);
    if (cad) {
      const days = [...rows.entries()]
        .filter(([, st]) => st !== "cancelled")
        .map(([d]) => DateTime.fromISO(d, { zone: TZ }))
        .filter((t) => t.isValid && t.startOf("day") >= today)
        .map(dayNum)
        .sort((a, b) => a - b);
      if (days.length >= 2) {
        if (!liveByClient.has(cid)) liveByClient.set(cid, []);
        liveByClient.get(cid).push({ m, rec, days, cad, loc: locKey(m.property_address) });
      }
    }
  }

  // ── 🟣 overlap ───────────────────────────────────────────────────────────
  // Se mira solo el tramo donde ambas series están vivas: una que termina y otra
  // que arranca después (split "este y los siguientes") no cuenta.
  for (const [cid, list] of liveByClient) {
    if (list.length < 2) continue;
    const parent = list.map((_, i) => i);
    const find = (i) => (parent[i] === i ? i : (parent[i] = find(parent[i])));
    const pairs = [];
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        const A = list[i];
        const B = list[j];
        if (A.loc && B.loc && A.loc !== B.loc) continue; // otra propiedad
        const minCad = Math.min(A.cad, B.cad);
        if (Math.max(A.cad, B.cad) > minCad * 2) continue; // otro servicio (semanal + profundo mensual)
        const lo = Math.max(A.days[0], B.days[0]) - minCad / 2;
        const hi = Math.min(A.days.at(-1), B.days.at(-1)) + minCad / 2;
        const inA = A.days.filter((d) => d >= lo && d <= hi);
        const inB = B.days.filter((d) => d >= lo && d <= hi);
        if (inA.length < 2 || inB.length < 2) continue;
        const near = (d, other) => Math.min(...other.map((o) => Math.abs(o - d)));
        const med = median([...inA.map((d) => near(d, B.days)), ...inB.map((d) => near(d, A.days))]);
        if (med > minCad * 0.5 + 0.5) continue;
        parent[find(i)] = find(j);
        pairs.push({ i, med });
      }
    }
    const comps = new Map();
    for (const { i, med } of pairs) {
      const r = find(i);
      if (!comps.has(r)) comps.set(r, { meds: [] });
      comps.get(r).meds.push(med);
    }
    for (const [root, comp] of comps) {
      const members = list.filter((_, i) => find(i) === root).sort((a, b) => a.days[0] - b.days[0]);
      const med = Math.min(...comp.meds);
      const merged = members.flatMap((x) => x.days).sort((a, b) => a - b);
      const gaps = merged.slice(1).map((d, k) => d - merged[k]).filter((g) => g > 0);
      const rec = {
        kind: "overlap",
        ...clientBase(cid),
        type: med <= 3 ? "DUPLICATE" : "INTERLEAVED",
        medianDistanceDays: med,
        expectedEveryDays: Math.min(...members.map((x) => x.cad)),
        // solo tiene sentido si se intercalan (14d + 14d desfasadas = ~7d)
        effectiveEveryDays: med > 3 && gaps.length ? Math.round(median(gaps) * 10) / 10 : null,
        series: members.map((x) => ({
          seriesId: x.m.id,
          title: x.m.gcal_summary || null,
          rrule: cadenceLabel(x.rec),
          cadenceDays: x.cad,
          created: x.m.created_at ? dOnly(x.m.created_at) : null,
          nextDates: x.days.slice(0, 3).map(isoOfDay),
        })),
      };
      rec.ackTargets = [
        { entityType: "client", entityId: cid, findingKind: "overlap", label: "this warning" },
        ...members.map((x) => ({
          entityType: "recurring_series",
          entityId: x.m.id,
          findingKind: "overlap",
          label: `series created ${x.m.created_at ? dOnly(x.m.created_at) : "?"}`,
        })),
        { entityType: "client", entityId: cid, findingKind: null, label: "all alerts for this client" },
      ];
      place(findings.overlaps, rec, {
        clientId: cid,
        kind: "overlap",
        extraSeriesIds: members.map((x) => x.m.id),
      });
    }
  }

  const byLast = (a, b) => (b.completed150d - a.completed150d) || String(a.lastService).localeCompare(String(b.lastService));
  findings.noCoverage.sort(byLast);
  findings.onDemand.sort(byLast);
  findings.endingSoon.sort((a, b) => String(a.lastInstance).localeCompare(String(b.lastInstance)));
  findings.midGaps.sort(
    (a, b) => Number(b.actionable) - Number(a.actionable) || String(a.gapFrom).localeCompare(String(b.gapFrom)),
  );
  findings.overlaps.sort((a, b) =>
    a.type === b.type ? a.name.localeCompare(b.name) : a.type === "DUPLICATE" ? -1 : 1,
  );
  return findings;
}

// ── IO ──────────────────────────────────────────────────────────────────────
async function fetchAll(table, cols, apply) {
  const all = [];
  for (let off = 0; ; off += PAGE) {
    let q = supabase.from(table).select(cols).range(off, off + PAGE - 1);
    if (apply) q = apply(q);
    const { data, error } = await q;
    if (error) throw new Error(`${table}: ${error.message}`);
    all.push(...(data ?? []));
    if (!data || data.length < PAGE) break;
  }
  return all;
}

let _lastScan = null;
/** Última corrida de scanCoverage(), para que el panel no re-escanee en cada carga. */
export function getLastScan() {
  return _lastScan; // { at: epoch ms, findings } | null
}

/** Una supresión nueva o levantada cambia lo que muestra el panel: la próxima carga rescanea. */
export function invalidateLastScan() {
  _lastScan = null;
}

export async function scanCoverage({ cfg = DEFAULT_CONFIG } = {}) {
  const now = DateTime.now().setZone(TZ);
  const today = iso(now);
  const horizonIso = iso(now.plus({ days: cfg.horizonDays }));
  const lookbackIso = iso(now.minus({ days: cfg.lookbackDays }));

  const [masters, instances, past, future, supps] = await Promise.all([
    fetchAll(
      "appointments",
      "id, client_id, gcal_summary, color_id, recurrence_rule, starts_at, scheduled_date, property_address, created_at",
      (q) => q.eq("is_series_master", true).not("recurrence_rule", "is", null).neq("status", "cancelled"),
    ),
    fetchAll(
      "appointments",
      "id, series_id, is_series_master, scheduled_date, status",
      (q) =>
        q
          .or("series_id.not.is.null,is_series_master.eq.true")
          .gte("scheduled_date", today)
          .lte("scheduled_date", horizonIso),
    ),
    fetchAll(
      "appointments",
      "client_id, scheduled_date, series_id, is_series_master, color_id",
      (q) =>
        q
          .not("client_id", "is", null)
          .neq("status", "cancelled")
          .gte("scheduled_date", lookbackIso)
          .lt("scheduled_date", today),
    ),
    fetchAll(
      "appointments",
      "client_id, color_id",
      (q) =>
        q
          .not("client_id", "is", null)
          .neq("status", "cancelled")
          .gte("scheduled_date", today)
          .lte("scheduled_date", horizonIso),
    ),
    fetchAll("alert_suppressions", "entity_type, entity_id, finding_kind, reason, expires_at", (q) =>
      q.eq("alert_type", ALERT_TYPE),
    ),
  ]);

  // El maestro de la serie también cuenta como fila de su propia serie.
  const instanceRows = instances.map((r) => ({
    ...r,
    series_id: r.series_id || (r.is_series_master ? r.id : null),
  }));
  const pastServices = past.filter((r) => !isNonServiceEventRow(r));
  const futureClientIds = new Set(future.filter((r) => !isNonServiceEventRow(r)).map((r) => r.client_id));

  const clientIds = [
    ...new Set([...pastServices.map((r) => r.client_id), ...masters.map((m) => m.client_id)].filter(Boolean)),
  ];
  const clients = [];
  for (let i = 0; i < clientIds.length; i += 200) {
    const { data, error } = await supabase
      .from("clients")
      .select("id, first_name, last_name, email, phone, status, postponed_until")
      .in("id", clientIds.slice(i, i + 200));
    if (error) throw new Error(`clients: ${error.message}`);
    clients.push(...(data ?? []));
  }

  const findings = analyzeCoverage({
    now,
    cfg,
    masters,
    instances: instanceRows,
    pastServices,
    futureClientIds,
    clients,
    suppressions: supps,
  });
  _lastScan = { at: Date.now(), findings };
  return findings;
}
