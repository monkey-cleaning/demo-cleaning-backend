import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";

import { computeQuoteResponse } from "../src/services/quoteMapping.js";
import { verifyElevenLabsSignature } from "../src/utils/elevenLabsSignature.js";

// Valores esperados calculados contra cleaningQuoteCalculator.js de ESTE fork
// (HOURLY_RATE 45, HOURLY_RATE_MOVE_IN_OUT 50, MIN_HOURS 3, TEAM_SIZE 2,
// extras fridge 0.5 / freezer 0.25 / oven 0.25). Difieren de los del test
// original de Monkey Cleaning porque allá el calculador usa otra tarifa base.

test("bi-weekly 2 bed / 2 bath → recurring, 6h @ $45/h = $270", () => {
  const { httpStatus, payload } = computeQuoteResponse({
    cleaning_frequency: "Bi-weekly",
    bedrooms: "Two Bedrooms",
    full_bathrooms: "2 Bathrooms",
  });
  assert.equal(httpStatus, 200);
  assert.equal(payload.calc_type, "recurring");
  assert.equal(payload.hourly_rate_cad, 45);
  assert.equal(payload.estimated_labor_hours, 6);
  assert.equal(payload.hours_per_cleaner, 3);
  assert.equal(payload.estimated_total_cad, 270);
  assert.equal(payload.currency, "CAD");
});

test("move in/out studio / 1 bath → move in/out rate $50, 5h → $250", () => {
  const { httpStatus, payload } = computeQuoteResponse({
    cleaning_frequency: "Move In/Out",
    bedrooms: "Studio",
    full_bathrooms: "1 Bathroom",
  });
  assert.equal(httpStatus, 200);
  assert.equal(payload.calc_type, "move in/out");
  assert.equal(payload.hourly_rate_cad, 50);
  assert.equal(payload.estimated_labor_hours, 5);
  assert.equal(payload.estimated_total_cad, 250);
});

test("weekly 2 bed / 2 bath + fridge + oven → +0.75h rounded to 7h → $315", () => {
  const { payload } = computeQuoteResponse({
    cleaning_frequency: "Weekly",
    bedrooms: "Two Bedrooms",
    full_bathrooms: "2 Bathrooms",
    inside_fridge: "yes",
    inside_oven: "yes",
  });
  assert.equal(payload.estimated_labor_hours, 7);
  assert.equal(payload.estimated_total_cad, 315);
});

test("minimum 3 hours floor for a tiny job", () => {
  const { payload } = computeQuoteResponse({
    cleaning_frequency: "Monthly",
    bedrooms: "Studio",
    full_bathrooms: "1 Bathroom",
  });
  // 2 + 0 + 1 = 3 → floor kicks in at exactly 3
  assert.equal(payload.estimated_labor_hours, 3);
  assert.equal(payload.estimated_total_cad, 135);
});

test("natural-language aliases are accepted", () => {
  const { httpStatus, payload } = computeQuoteResponse({
    cleaning_frequency: "every other week",
    bedrooms: "bachelor",
    full_bathrooms: "four or more bathrooms",
  });
  assert.equal(httpStatus, 200);
  assert.equal(payload.calc_type, "recurring");
});

test("missing full_bathrooms → 400 VALIDATION_ERROR", () => {
  const { httpStatus, payload } = computeQuoteResponse({
    cleaning_frequency: "Weekly",
    bedrooms: "Two Bedrooms",
  });
  assert.equal(httpStatus, 400);
  assert.equal(payload.code, "VALIDATION_ERROR");
  assert.match(payload.error, /full_bathrooms/);
});

test("unknown frequency → 400 VALIDATION_ERROR", () => {
  const { httpStatus, payload } = computeQuoteResponse({
    cleaning_frequency: "whenever",
    bedrooms: "Two Bedrooms",
    full_bathrooms: "2 Bathrooms",
  });
  assert.equal(httpStatus, 400);
  assert.equal(payload.code, "VALIDATION_ERROR");
  assert.match(payload.error, /cleaning_frequency/);
});

test("invalid optional field is ignored, not fatal", () => {
  const { httpStatus, payload } = computeQuoteResponse({
    cleaning_frequency: "Weekly",
    bedrooms: "Two Bedrooms",
    full_bathrooms: "2 Bathrooms",
    property_size: "gigantic",
    inside_fridge: "maybe",
  });
  assert.equal(httpStatus, 200);
  assert.equal(payload.estimated_labor_hours, 6); // no area bonus, no fridge
});

// ── verifyElevenLabsSignature ──────────────────────────────────────────────

function sign(body, secret, timestamp) {
  const mac = crypto
    .createHmac("sha256", secret)
    .update(`${timestamp}.${body}`)
    .digest("hex");
  return `t=${timestamp},v0=${mac}`;
}

test("valid signature passes", () => {
  const secret = "wsec_test_abc";
  const raw = JSON.stringify({ type: "post_call_transcription", data: {} });
  const ts = Math.floor(Date.now() / 1000);
  const res = verifyElevenLabsSignature({
    rawBody: Buffer.from(raw),
    signatureHeader: sign(raw, secret, ts),
    secret,
  });
  assert.equal(res.ok, true);
});

test("tampered body fails", () => {
  const secret = "wsec_test_abc";
  const ts = Math.floor(Date.now() / 1000);
  const header = sign(JSON.stringify({ a: 1 }), secret, ts);
  const res = verifyElevenLabsSignature({
    rawBody: JSON.stringify({ a: 2 }),
    signatureHeader: header,
    secret,
  });
  assert.equal(res.ok, false);
  assert.equal(res.reason, "signature mismatch");
});

test("stale timestamp fails", () => {
  const secret = "wsec_test_abc";
  const raw = "{}";
  const ts = Math.floor(Date.now() / 1000) - 60 * 60; // 1h old
  const res = verifyElevenLabsSignature({
    rawBody: raw,
    signatureHeader: sign(raw, secret, ts),
    secret,
  });
  assert.equal(res.ok, false);
  assert.equal(res.reason, "timestamp outside tolerance");
});

test("missing secret fails closed", () => {
  const res = verifyElevenLabsSignature({
    rawBody: "{}",
    signatureHeader: "t=1,v0=abc",
    secret: undefined,
  });
  assert.equal(res.ok, false);
});
