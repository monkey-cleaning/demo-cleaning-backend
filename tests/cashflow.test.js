import { test } from "node:test";
import assert from "node:assert/strict";

import { aggregateCashflow, isoWeekRange } from "../src/services/cashflowService.js";
import { DateTime } from "luxon";

const week = { from: "2026-09-07", to: "2026-09-13" }; // lunes–domingo

test("isoWeekRange returns Monday–Sunday", () => {
  const r = isoWeekRange(DateTime.fromISO("2026-09-09")); // miércoles
  assert.equal(r.from, "2026-09-07");
  assert.equal(r.to, "2026-09-13");
});

test("fully paid week → paid 100%, outstanding 0", () => {
  const r = aggregateCashflow({
    week,
    invoices: [{ total_amount: 100 }, { total_amount: 50 }],
    invoicePaidAllocs: [{ amount: 100 }, { amount: 50 }],
    pendingReviewAllocs: [],
  });
  assert.equal(r.invoiced.amount, 150);
  assert.equal(r.invoiced.count, 2);
  assert.equal(r.paid.amount, 150);
  assert.equal(r.paid.pct, 1);
  assert.equal(r.outstanding.amount, 0);
});

test("partially paid week", () => {
  const r = aggregateCashflow({
    week,
    invoices: [{ total_amount: 200 }],
    invoicePaidAllocs: [{ amount: 75 }],
    pendingReviewAllocs: [],
  });
  assert.equal(r.paid.amount, 75);
  assert.equal(r.paid.pct, 0.38); // 75/200 = 0.375 → round2
  assert.equal(r.outstanding.amount, 125);
});

test("no invoices → all zeros, pct 0 (no divide-by-zero)", () => {
  const r = aggregateCashflow({
    week,
    invoices: [],
    invoicePaidAllocs: [],
    pendingReviewAllocs: [],
  });
  assert.equal(r.invoiced.amount, 0);
  assert.equal(r.paid.pct, 0);
  assert.equal(r.outstanding.amount, 0);
});

test("pending_review feeds the warning line, not 'paid'", () => {
  const r = aggregateCashflow({
    week,
    invoices: [{ total_amount: 300 }],
    invoicePaidAllocs: [{ amount: 300 }],
    // dos allocations pending_review, mismo payment → cuenta 1
    pendingReviewAllocs: [
      { amount: 40, payment_id: "p1" },
      { amount: 10, payment_id: "p1" },
      { amount: 25, payment_id: "p2" },
    ],
  });
  assert.equal(r.paid.amount, 300);
  assert.equal(r.outstanding.amount, 0);
  assert.equal(r.unreconciled.amount, 75);
  assert.equal(r.unreconciled.count, 2);
});

test("string amounts from Supabase numeric are coerced", () => {
  const r = aggregateCashflow({
    week,
    invoices: [{ total_amount: "120.50" }],
    invoicePaidAllocs: [{ amount: "120.50" }],
    pendingReviewAllocs: [],
  });
  assert.equal(r.invoiced.amount, 120.5);
  assert.equal(r.paid.amount, 120.5);
  assert.equal(r.outstanding.amount, 0);
});
