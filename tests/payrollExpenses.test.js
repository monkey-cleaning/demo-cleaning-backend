import { test } from "node:test";
import assert from "node:assert/strict";

import { aggregateExpenseTotals } from "../src/services/payrollExpensesService.js";

test("aggregateExpenseTotals: suma por categoría y el total general", () => {
  const totals = aggregateExpenseTotals([
    { category: "financial", amount: 16.24 },
    { category: "financial", amount: 350 },
    { category: "operational", amount: 232.1 },
    { category: "administrative", amount: 1532 },
  ]);
  assert.equal(totals.financial, 366.24);
  assert.equal(totals.operational, 232.1);
  assert.equal(totals.administrative, 1532);
  assert.equal(totals.total, 2130.34);
});

test("aggregateExpenseTotals: sin gastos, todo en 0 (sin dividir por cero ni NaN)", () => {
  const totals = aggregateExpenseTotals([]);
  assert.deepEqual(totals, { financial: 0, operational: 0, administrative: 0, total: 0 });
});

// ── Gastos fijos (plantillas con vigencia) ───────────────────────────────────
import {
  periodIndex,
  activeRecurringForPeriod,
  summarizeRelevantExpenses,
  conceptKey,
} from "../src/services/payrollExpensesService.js";

test("periodIndex: monotónico entre quincenas consecutivas, cruzando mes y año", () => {
  const q = (year, month, half) => periodIndex({ year, month, half });
  assert.equal(q(2026, 9, 2) - q(2026, 9, 1), 1);
  assert.equal(q(2026, 10, 1) - q(2026, 9, 2), 1);
  assert.equal(q(2027, 1, 1) - q(2026, 12, 2), 1);
});

test("activeRecurringForPeriod: aplica de from_period en adelante, hasta until_period (exclusivo)", () => {
  const from = periodIndex({ year: 2026, month: 9, half: 1 });
  const until = periodIndex({ year: 2026, month: 10, half: 1 });
  const templates = [{ id: "a", from_period: from, until_period: until }];
  const active = (y, m, h) => activeRecurringForPeriod(templates, periodIndex({ year: y, month: m, half: h })).length;
  assert.equal(active(2026, 8, 2), 0, "antes de arrancar no aplica");
  assert.equal(active(2026, 9, 1), 1, "la quincena de inicio aplica");
  assert.equal(active(2026, 9, 2), 1);
  assert.equal(active(2026, 10, 1), 0, "until_period es exclusivo");
});

test("activeRecurringForPeriod: until_period null = sin fin", () => {
  const templates = [{ id: "a", from_period: periodIndex({ year: 2026, month: 1, half: 1 }), until_period: null }];
  assert.equal(activeRecurringForPeriod(templates, periodIndex({ year: 2030, month: 6, half: 2 })).length, 1);
});

test("activeRecurringForPeriod: un cambio de precio son dos versiones y solo una aplica por quincena", () => {
  const change = periodIndex({ year: 2026, month: 10, half: 1 });
  const templates = [
    { id: "v1", amount: 100, from_period: periodIndex({ year: 2026, month: 1, half: 1 }), until_period: change },
    { id: "v2", amount: 120, from_period: change, until_period: null },
  ];
  const idOf = (y, m, h) => activeRecurringForPeriod(templates, periodIndex({ year: y, month: m, half: h }))[0]?.id;
  assert.equal(idOf(2026, 9, 2), "v1", "el histórico conserva el precio viejo");
  assert.equal(idOf(2026, 10, 1), "v2");
  assert.equal(idOf(2027, 3, 1), "v2", "el precio nuevo se mantiene de ahí en adelante");
});

test("summarizeRelevantExpenses: una fila por concepto fijado (aunque sea 0), sin distinguir mayúsculas", () => {
  const pinned = [
    { key: "transporte", label: "Transporte" },
    { key: "gasolina", label: "Gasolina" },
  ];
  const rows = summarizeRelevantExpenses(
    [
      { concept: "  TRANSPORTE ", amount: 40.5 },
      { concept: "transporte", amount: 10 },
      { concept: "Oficina", amount: 999 },
    ],
    pinned,
  );
  assert.deepEqual(rows, [
    { label: "Transporte", amount: 50.5 },
    { label: "Gasolina", amount: 0 },
  ]);
});

test("conceptKey: recorta y pasa a minúsculas", () => {
  assert.equal(conceptKey("  Gasolina "), "gasolina");
});

// ── Transporte autocompletado ────────────────────────────────────────────────
import { buildRelevantExpenses } from "../src/services/payrollExpensesService.js";

test("buildRelevantExpenses: Transporte va primero y sale de lo pagado a cleaners por traslados", () => {
  const rows = buildRelevantExpenses({
    travelMoney: 880.574,
    expenses: [{ concept: "Gasolina", amount: 55.5 }],
    pinned: [{ key: "gasolina", label: "Gasolina" }],
  });
  assert.equal(rows[0].label, "Transporte");
  assert.equal(rows[0].amount, 880.57);
  assert.equal(rows[0].auto, true);
  assert.deepEqual(rows[1], { label: "Gasolina", amount: 55.5 });
});

test("buildRelevantExpenses: un concepto fijado 'Transporte' o gastos cargados a mano con ese nombre no duplican ni pisan la fila", () => {
  const rows = buildRelevantExpenses({
    travelMoney: 100,
    expenses: [{ concept: "transporte", amount: 999 }],
    pinned: [
      { key: "transporte", label: "Transporte" },
      { key: "gasolina", label: "Gasolina" },
    ],
  });
  assert.equal(rows.filter((r) => r.label.toLowerCase() === "transporte").length, 1);
  assert.equal(rows[0].amount, 100, "el monto es el de traslados, no el de gastos manuales");
  assert.deepEqual(rows.map((r) => r.label), ["Transporte", "Gasolina"]);
});

test("buildRelevantExpenses: sin traslados el monto es 0 (nunca NaN)", () => {
  assert.equal(buildRelevantExpenses({ travelMoney: undefined, expenses: [], pinned: [] })[0].amount, 0);
});
