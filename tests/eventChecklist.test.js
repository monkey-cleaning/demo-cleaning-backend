// LAB457/463 — reglas puras del checklist: ventana de escritura del staff,
// hora real de acciones offline y client_ref de idempotencia.
import test from "node:test";
import assert from "node:assert/strict";
import { DateTime } from "luxon";
import {
  evaluateChecklistWindow,
  parseActedAt,
  parseClientRef,
  CHECKLIST_GRACE_MINUTES,
} from "../src/controllers/eventChecklistController.js";

const start = DateTime.fromISO("2026-12-01T10:00:00");
const end = DateTime.fromISO("2026-12-01T12:00:00");

test("window: closed before the visit starts, open during, open until the grace ends, closed after", () => {
  assert.equal(evaluateChecklistWindow(start, end, start.minus({ minutes: 1 }))?.code, "EVENT_NOT_STARTED");
  assert.equal(evaluateChecklistWindow(start, end, start), null);
  assert.equal(evaluateChecklistWindow(start, end, end.plus({ minutes: CHECKLIST_GRACE_MINUTES })), null);
  assert.equal(
    evaluateChecklistWindow(start, end, end.plus({ minutes: CHECKLIST_GRACE_MINUTES + 1 }))?.code,
    "EVENT_CLOSED",
  );
});

test("actedAt: recent past is kept, future/stale/garbage fall back to server time", () => {
  const recent = DateTime.now().minus({ hours: 5 });
  assert.equal(parseActedAt(recent.toISO())?.toMillis(), recent.toMillis());
  assert.equal(parseActedAt(null), null);
  assert.equal(parseActedAt("nope"), null);
  assert.equal(parseActedAt(DateTime.now().plus({ hours: 2 }).toISO()), null);
  assert.equal(parseActedAt(DateTime.now().minus({ days: 4 }).toISO()), null);
});

test("actedAt: a clock a minute ahead is clamped to now", () => {
  const out = parseActedAt(DateTime.now().plus({ minutes: 1 }).toISO());
  assert.ok(out && out <= DateTime.now());
});

test("clientRef: uuid-ish accepted, junk rejected", () => {
  assert.equal(parseClientRef("3f2b8c1e-aaaa-bbbb-cccc-1234567890ab"), "3f2b8c1e-aaaa-bbbb-cccc-1234567890ab");
  assert.equal(parseClientRef("x"), null);
  assert.equal(parseClientRef("has space and ../"), null);
  assert.equal(parseClientRef(undefined), null);
});
