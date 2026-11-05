import { test } from "node:test";
import assert from "node:assert/strict";

import { periodFrom } from "../src/services/payrollClosingsService.js";
import { captureJson } from "../src/controllers/payrollCloseController.js";

test("periodFrom: acepta números o strings (query/body) y rechaza lo inválido", () => {
  assert.deepEqual(periodFrom({ year: "2026", month: "9", half: "1" }), { year: 2026, month: 9, half: 1 });
  assert.deepEqual(periodFrom({ year: 2026, month: 12, half: 2 }), { year: 2026, month: 12, half: 2 });
  assert.equal(periodFrom({ year: 2026, month: 13, half: 1 }), null);
  assert.equal(periodFrom({ year: 2026, month: 9, half: 3 }), null);
  assert.equal(periodFrom({ year: 1999, month: 9, half: 1 }), null);
  assert.equal(periodFrom({}), null);
  assert.equal(periodFrom(undefined), null);
});

test("captureJson: devuelve el JSON que respondería el handler", async () => {
  const handler = async (req, res) => res.json({ ok: true, echoed: req.query.year });
  assert.deepEqual(await captureJson(handler, { year: "2026" }), { ok: true, echoed: "2026" });
});

test("captureJson: un handler que responde error hace fallar el cierre (no se guarda un snapshot roto)", async () => {
  const handler = async (_req, res) => res.status(500).json({ ok: false, error: "boom" });
  await assert.rejects(() => captureJson(handler, {}), /boom/);
});
