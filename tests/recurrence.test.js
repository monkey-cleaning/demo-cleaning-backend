// LAB617 — recurrencia: validación del input y expansión de fechas en hora
// local del negocio. Puro, sin base.
import test from "node:test";
import assert from "node:assert/strict";
import { DateTime } from "luxon";
import { TZ } from "../src/config/timezone.js";
import {
  serializeRecurrence,
  deserializeRecurrence,
  expandRecurrenceDates,
  describeRecurrence,
  assertRuleFitsStart,
  RecurrenceInputError,
} from "../src/services/recurrenceService.js";

const ser = (input) => deserializeRecurrence(serializeRecurrence(input));
const dates = (input, startLocal, opts) =>
  expandRecurrenceDates(ser(input), DateTime.fromISO(startLocal, { zone: TZ }).toISO(), opts).map((d) =>
    DateTime.fromJSDate(d).setZone(TZ).toFormat("yyyy-MM-dd HH:mm"),
  );

test("presets: weekly, every 2 weeks and the old BIWEEKLY alias", () => {
  assert.deepEqual(
    [ser({ freq: "WEEKLY" }).interval, ser({ freq: "BIWEEKLY" }).interval, ser({ freq: "WEEKLY", interval: 4 }).interval],
    [1, 2, 4],
  );
  assert.equal(ser({ freq: "BIWEEKLY" }).freq, "WEEKLY");
});

test("legacy rows without byDay/monthly/endless still deserialize and expand", () => {
  const legacy = { freq: "WEEKLY", interval: 1, count: 3, until: null };
  const out = expandRecurrenceDates(legacy, DateTime.fromISO("2026-12-01T10:00", { zone: TZ }).toISO());
  assert.equal(out.length, 3);
});

test("every 4 weeks keeps the weekday", () => {
  assert.deepEqual(dates({ freq: "WEEKLY", interval: 4, count: 3 }, "2026-12-01T10:00"), [
    "2026-12-01 10:00",
    "2026-12-29 10:00",
    "2027-01-26 10:00",
  ]);
});

test("custom weekly: several days, an evening visit keeps its LOCAL weekday", () => {
  // 18:30 locales caen en el día siguiente en UTC — el día de la semana no puede correrse.
  const out = dates({ freq: "WEEKLY", byDay: ["MO", "TH"], count: 4 }, "2026-12-07T18:30");
  assert.deepEqual(out, ["2026-12-07 18:30", "2026-12-10 18:30", "2026-12-14 18:30", "2026-12-17 18:30"]);
});

test("a series keeps its wall-clock time across the March daylight-saving change", () => {
  // En 2026 BC ya está en UTC-7 fijo, pero otra zona configurada sí cambia; igual la hora de pared no se mueve.
  const out = dates({ freq: "WEEKLY", count: 3 }, "2027-03-02T09:00");
  assert.deepEqual(out, ["2027-03-02 09:00", "2027-03-09 09:00", "2027-03-16 09:00"]);
});

test('monthly: "first Monday" and "last Friday"', () => {
  assert.deepEqual(
    dates({ freq: "MONTHLY", monthly: { type: "nthWeekday", nth: 1, weekday: "MO" }, count: 3 }, "2026-12-07T10:00"),
    ["2026-12-07 10:00", "2027-01-04 10:00", "2027-02-01 10:00"],
  );
  assert.deepEqual(
    dates({ freq: "MONTHLY", monthly: { type: "nthWeekday", nth: -1, weekday: "FR" }, count: 3 }, "2026-12-25T10:00"),
    ["2026-12-25 10:00", "2027-01-29 10:00", "2027-02-26 10:00"],
  );
});

test("monthly by day number skips months where the day does not exist", () => {
  assert.deepEqual(dates({ freq: "MONTHLY", count: 3 }, "2027-01-31T10:00"), [
    "2027-01-31 10:00",
    "2027-03-31 10:00",
    "2027-05-31 10:00",
  ]);
});

test("without count/until the series is capped at one year, including the anniversary day", () => {
  const out = dates({ freq: "WEEKLY" }, "2026-12-01T10:00");
  assert.equal(out[0], "2026-12-01 10:00");
  assert.equal(out.at(-1), "2027-11-30 10:00");
  assert.ok(out.includes("2027-12-01 10:00") === false);
});

test('"Never" is not cut at one year, only at the materialization cap', () => {
  const out = dates({ freq: "WEEKLY", endless: true }, "2026-12-01T10:00");
  assert.ok(out.length > 60);
  const capped = dates({ freq: "WEEKLY", endless: true }, "2026-12-01T10:00", { materializationCapMonths: 6 });
  assert.ok(capped.length < out.length);
});

test("an explicit until is inclusive of its whole day", () => {
  const out = dates({ freq: "WEEKLY", until: "2026-12-15" }, "2026-12-01T10:00");
  assert.deepEqual(out, ["2026-12-01 10:00", "2026-12-08 10:00", "2026-12-15 10:00"]);
});

test("invalid input is rejected with RecurrenceInputError (400, not 500)", () => {
  const bad = [
    { freq: "DAILY" },
    { freq: "WEEKLY", interval: 0 },
    { freq: "WEEKLY", interval: 53 },
    { freq: "WEEKLY", byDay: [] },
    { freq: "WEEKLY", byDay: ["XX"] },
    { freq: "WEEKLY", monthly: { type: "dayOfMonth" } },
    { freq: "MONTHLY", byDay: ["MO"] },
    { freq: "MONTHLY", monthly: { type: "nthWeekday", nth: 5, weekday: "MO" } },
    { freq: "WEEKLY", count: 0 },
    { freq: "WEEKLY", endless: true, count: 3 },
    { freq: "WEEKLY", until: "not-a-date" },
  ];
  for (const input of bad) {
    assert.throws(() => serializeRecurrence(input), RecurrenceInputError, JSON.stringify(input));
  }
});

test("the start date must fit the pattern", () => {
  // 2026-12-02 es miércoles
  assert.throws(() => assertRuleFitsStart({ freq: "WEEKLY", byDay: ["MO", "FR"] }, "2026-12-02"), RecurrenceInputError);
  assert.doesNotThrow(() => assertRuleFitsStart({ freq: "WEEKLY", byDay: ["WE"] }, "2026-12-02"));
  assert.throws(
    () => assertRuleFitsStart({ freq: "MONTHLY", monthly: { type: "nthWeekday", nth: 1, weekday: "WE" } }, "2026-12-09"),
    RecurrenceInputError,
  );
  assert.throws(() => assertRuleFitsStart({ freq: "WEEKLY", until: "2026-11-01" }, "2026-12-02"), RecurrenceInputError);
});

test("describeRecurrence gives the panel its preset", () => {
  assert.equal(describeRecurrence(ser({ freq: "WEEKLY" })).preset, "WEEKLY");
  assert.equal(describeRecurrence(ser({ freq: "BIWEEKLY" })).preset, "BIWEEKLY");
  assert.equal(describeRecurrence(ser({ freq: "WEEKLY", interval: 4 })).preset, "EVERY_4_WEEKS");
  assert.equal(describeRecurrence(ser({ freq: "WEEKLY", byDay: ["MO", "WE"] })).preset, "CUSTOM");
  assert.equal(describeRecurrence(ser({ freq: "MONTHLY" })).preset, "CUSTOM");
  assert.equal(describeRecurrence(ser({ freq: "WEEKLY", count: 4 })).endType, "count");
});

test("describeRecurrence hands the panel a plain end date", () => {
  const d = describeRecurrence(ser({ freq: "WEEKLY", until: "2027-02-10T23:59:00-07:00" }));
  assert.equal(d.endType, "until");
  assert.equal(d.until, "2027-02-10");
});
