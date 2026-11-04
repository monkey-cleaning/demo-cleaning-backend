// Etapa 4 — monitor de cobertura: análisis puro (sin base).
import test from "node:test";
import assert from "node:assert/strict";
import { DateTime } from "luxon";
import { TZ } from "../src/config/timezone.js";
import { serializeRecurrence, expandRecurrenceDates } from "../src/services/recurrenceService.js";
import { analyzeCoverage } from "../src/services/coverageScan.js";

const NOW = DateTime.fromISO("2026-12-01T09:00", { zone: TZ });
const localDate = (d) => DateTime.fromJSDate(d).setZone(TZ).toISODate();

const client = (id, extra = {}) => ({
  id,
  first_name: id,
  last_name: "Test",
  email: null,
  phone: null,
  status: "active",
  postponed_until: null,
  ...extra,
});

// Serie con sus filas: `skip` = fechas sin fila, `cancelled` = fechas canceladas.
function series(id, clientId, startLocal, rule, { skip = [], cancelled = [], address = "1 Main St" } = {}) {
  const start = DateTime.fromISO(startLocal, { zone: TZ });
  const master = {
    id,
    client_id: clientId,
    gcal_summary: `Clean ${clientId}`,
    color_id: null,
    recurrence_rule: serializeRecurrence(rule),
    starts_at: start.toISO(),
    scheduled_date: start.toISODate(),
    property_address: address,
    created_at: "2026-11-01T00:00:00Z",
  };
  const rows = expandRecurrenceDates(JSON.parse(master.recurrence_rule), master.starts_at)
    .map(localDate)
    .filter((d) => !skip.includes(d))
    .map((d) => ({
      series_id: id,
      scheduled_date: d,
      status: cancelled.includes(d) ? "cancelled" : "scheduled",
    }));
  return { master, rows };
}

const run = (over) =>
  analyzeCoverage({
    now: NOW,
    masters: [],
    instances: [],
    pastServices: [],
    futureClientIds: new Set(),
    clients: [],
    suppressions: [],
    ...over,
  });

const past = (clientId, dates, extra = {}) =>
  dates.map((d) => ({ client_id: clientId, scheduled_date: d, series_id: null, is_series_master: false, ...extra }));

test("no future service: serie → no_coverage, eventos sueltos → on_demand, un solo servicio → nada", () => {
  const f = run({
    clients: [client("ana"), client("bea"), client("cris")],
    pastServices: [
      ...past("ana", ["2026-10-10", "2026-10-24"], { series_id: "s1" }),
      ...past("bea", ["2026-10-10", "2026-10-24"]),
      ...past("cris", ["2026-10-10"]),
    ],
  });
  assert.deepEqual(f.noCoverage.map((x) => x.clientId), ["ana"]);
  assert.deepEqual(f.onDemand.map((x) => x.clientId), ["bea"]);
});

test("a client with something booked ahead is covered", () => {
  const f = run({
    clients: [client("ana")],
    pastServices: past("ana", ["2026-10-10", "2026-10-24"], { series_id: "s1" }),
    futureClientIds: new Set(["ana"]),
  });
  assert.equal(f.noCoverage.length, 0);
});

test("lost / paused clients are silenced by state, and shown as suppressed", () => {
  const f = run({
    clients: [
      client("ana", { status: "lost" }),
      client("bea", { postponed_until: "2027-01-15" }),
      client("cris"),
    ],
    pastServices: ["ana", "bea", "cris"].flatMap((c) => past(c, ["2026-10-10", "2026-10-24"], { series_id: "s" })),
  });
  assert.deepEqual(f.noCoverage.map((x) => x.clientId), ["cris"]);
  assert.deepEqual(f.suppressed.map((x) => x.clientId).sort(), ["ana", "bea"]);
});

test("a suppression silences one kind, not the rest; an expired one does not count", () => {
  const base = {
    clients: [client("ana")],
    pastServices: past("ana", ["2026-10-10", "2026-10-24"], { series_id: "s1" }),
  };
  const kind = run({
    ...base,
    suppressions: [{ entity_type: "client", entity_id: "ana", finding_kind: "no_coverage", reason: "called her", expires_at: "2027-02-01T00:00:00Z" }],
  });
  assert.equal(kind.noCoverage.length, 0);
  assert.equal(kind.suppressed[0].suppressedBy, "called her");

  const otherKind = run({
    ...base,
    suppressions: [{ entity_type: "client", entity_id: "ana", finding_kind: "gap", reason: null, expires_at: null }],
  });
  assert.equal(otherKind.noCoverage.length, 1);

  const expired = run({
    ...base,
    suppressions: [{ entity_type: "client", entity_id: "ana", finding_kind: null, reason: null, expires_at: "2026-11-20T00:00:00Z" }],
  });
  assert.equal(expired.noCoverage.length, 1);

  const all = run({
    ...base,
    suppressions: [{ entity_type: "client", entity_id: "ana", finding_kind: null, reason: null, expires_at: null }],
  });
  assert.equal(all.noCoverage.length, 0);
});

test("ending_soon: only series with an explicit end; Never series are left alone", () => {
  const ending = series("m1", "ana", "2026-12-01T10:00", { freq: "WEEKLY", count: 3 });
  const never = series("m2", "bea", "2026-12-01T10:00", { freq: "WEEKLY", endless: true });
  const far = series("m3", "cris", "2026-12-01T10:00", { freq: "WEEKLY", count: 20 });
  const f = run({
    clients: [client("ana"), client("bea"), client("cris")],
    masters: [ending.master, never.master, far.master],
    instances: [...ending.rows, ...never.rows, ...far.rows],
  });
  assert.deepEqual(f.endingSoon.map((x) => x.clientId), ["ana"]);
  assert.equal(f.endingSoon[0].remaining, 3);
});

test("gap: a missing date is a hole (actionable when soon); 2 cancelled in a row is a skip; 1 is fine", () => {
  const hole = series("m1", "ana", "2026-12-01T10:00", { freq: "WEEKLY", endless: true }, { skip: ["2026-12-15"] });
  const skip2 = series("m2", "bea", "2026-12-01T10:00", { freq: "WEEKLY", endless: true }, { cancelled: ["2026-12-15", "2026-12-22"] });
  const skip1 = series("m3", "cris", "2026-12-01T10:00", { freq: "WEEKLY", endless: true }, { cancelled: ["2026-12-15"] });
  const f = run({
    clients: [client("ana"), client("bea"), client("cris")],
    masters: [hole.master, skip2.master, skip1.master],
    instances: [...hole.rows, ...skip2.rows, ...skip1.rows],
  });
  const byClient = Object.fromEntries(f.midGaps.map((g) => [g.clientId, g]));
  assert.equal(byClient.ana.type, "GAP_HOLE");
  assert.deepEqual(byClient.ana.missing, ["2026-12-15"]);
  assert.equal(byClient.ana.actionable, true);
  assert.equal(byClient.bea.type, "GAP_SKIP");
  assert.equal(byClient.bea.actionable, false);
  assert.equal(byClient.cris, undefined);
});

test("a gap far in the future is informational, not actionable", () => {
  const far = series("m1", "ana", "2026-12-01T10:00", { freq: "WEEKLY", endless: true }, { skip: ["2027-02-16"] });
  const f = run({ clients: [client("ana")], masters: [far.master], instances: far.rows });
  assert.equal(f.midGaps.length, 1);
  assert.equal(f.midGaps[0].actionable, false);
});

test("overlap: two biweekly series offset by a week behave like a weekly one", () => {
  const a = series("m1", "ana", "2026-12-01T10:00", { freq: "BIWEEKLY", endless: true });
  const b = series("m2", "ana", "2026-12-08T10:00", { freq: "BIWEEKLY", endless: true });
  const f = run({ clients: [client("ana")], masters: [a.master, b.master], instances: [...a.rows, ...b.rows] });
  assert.equal(f.overlaps.length, 1);
  assert.equal(f.overlaps[0].type, "INTERLEAVED");
  assert.equal(f.overlaps[0].effectiveEveryDays, 7);
  assert.equal(f.overlaps[0].series.length, 2);
});

test("overlap: duplicates detected; other address or different service is not an overlap", () => {
  const a = series("m1", "ana", "2026-12-01T10:00", { freq: "WEEKLY", endless: true });
  const dup = series("m2", "ana", "2026-12-01T14:00", { freq: "WEEKLY", endless: true });
  const f = run({ clients: [client("ana")], masters: [a.master, dup.master], instances: [...a.rows, ...dup.rows] });
  assert.equal(f.overlaps[0].type, "DUPLICATE");

  const other = series("m3", "ana", "2026-12-01T10:00", { freq: "WEEKLY", endless: true }, { address: "99 Other Rd" });
  const g = run({ clients: [client("ana")], masters: [a.master, other.master], instances: [...a.rows, ...other.rows] });
  assert.equal(g.overlaps.length, 0);

  const monthly = series("m4", "ana", "2026-12-01T10:00", { freq: "MONTHLY", endless: true });
  const h = run({ clients: [client("ana")], masters: [a.master, monthly.master], instances: [...a.rows, ...monthly.rows] });
  assert.equal(h.overlaps.length, 0);
});

test("overlap can be silenced from the client or from either series, and the ackTargets offer all three", () => {
  const a = series("m1", "ana", "2026-12-01T10:00", { freq: "BIWEEKLY", endless: true });
  const b = series("m2", "ana", "2026-12-08T10:00", { freq: "BIWEEKLY", endless: true });
  const input = { clients: [client("ana")], masters: [a.master, b.master], instances: [...a.rows, ...b.rows] };
  const open = run(input);
  assert.deepEqual(
    open.overlaps[0].ackTargets.map((t) => `${t.entityType}:${t.entityId}:${t.findingKind}`),
    ["client:ana:overlap", "recurring_series:m1:overlap", "recurring_series:m2:overlap", "client:ana:null"],
  );
  for (const s of [
    { entity_type: "client", entity_id: "ana", finding_kind: "overlap" },
    { entity_type: "recurring_series", entity_id: "m2", finding_kind: "overlap" },
  ]) {
    const f = run({ ...input, suppressions: [{ ...s, reason: "intentional", expires_at: null }] });
    assert.equal(f.overlaps.length, 0);
    assert.equal(f.suppressed.length, 1);
  }
});
