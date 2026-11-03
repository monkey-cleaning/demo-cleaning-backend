import test from "node:test";
import assert from "node:assert/strict";
import { DateTime } from "luxon";
import { TZ, TZ_LABEL } from "../src/config/timezone.js";

test("business zone is UTC-7 in winter 2026-27 (BC permanent daylight time)", () => {
  const dec = DateTime.fromISO("2026-12-15T12:00:00", { zone: TZ });
  assert.equal(dec.offset, -420);
});

test("TZ_LABEL stays the configured IANA name", () => {
  assert.equal(TZ_LABEL, process.env.BOOKING_TIMEZONE || "America/Vancouver");
});
