import { test } from "node:test";
import assert from "node:assert/strict";

import {
  quincenaRange,
  aggregateEmployeePayroll,
  stripMoney,
} from "../src/services/payrollSummaryService.js";

// ── quincenaRange ────────────────────────────────────────────────────────────
// Portado tal cual de Monkey Cleaning — es pura fecha/TZ, sin nada del
// modelo de datos.

test("quincenaRange: Q1 es día 1-15", () => {
  const r = quincenaRange({ year: 2026, month: 5, half: 1 });
  assert.equal(r.from.toISODate(), "2026-05-01");
  assert.equal(r.toInclusive.toISODate(), "2026-05-15");
  assert.equal(r.label, "Q1 May 2026");
});

test("quincenaRange: Q2 llega hasta el último día del mes (incluido)", () => {
  const r = quincenaRange({ year: 2026, month: 4, half: 2 }); // abril = 30 días
  assert.equal(r.from.toISODate(), "2026-04-16");
  assert.equal(r.toInclusive.toISODate(), "2026-04-30");
  assert.equal(r.label, "Q2 Apr 2026");
});

test("quincenaRange: Q2 de febrero respeta el año bisiesto", () => {
  const leap = quincenaRange({ year: 2028, month: 2, half: 2 });
  assert.equal(leap.toInclusive.toISODate(), "2028-02-29");
  const notLeap = quincenaRange({ year: 2026, month: 2, half: 2 });
  assert.equal(notLeap.toInclusive.toISODate(), "2026-02-28");
});

// ── aggregateEmployeePayroll ─────────────────────────────────────────────────
// Reescritos contra el shape de fila de `appointments` de este fork
// (starts_at/ends_at/scheduled_date/gcal_summary/color_id/series_id), no el
// de eventos de Google Calendar del original.

function row(id, startIso, endIso, opts = {}) {
  return {
    id,
    gcal_summary: opts.summary ?? `Job ${id}`,
    color_id: opts.colorId ?? null, // "4" = non-service (default de eventClassification.js)
    scheduled_date: startIso.slice(0, 10),
    starts_at: startIso,
    ends_at: endIso,
    property_address: opts.location ?? "123 Main St",
    series_id: opts.seriesId ?? null,
  };
}

test("traslado: un hueco limpio entre 2 eventos del mismo día", () => {
  const r = aggregateEmployeePayroll([
    row("a", "2026-05-01T09:00:00-07:00", "2026-05-01T11:00:00-07:00"),
    row("b", "2026-05-01T12:00:00-07:00", "2026-05-01T14:00:00-07:00"),
  ]);
  assert.equal(r.travelHours, 1);
  assert.equal(r.workHours, 4);
  assert.equal(r.eventCount, 2);
});

test("traslado: un Lunch en el medio se descuenta (no se saltea)", () => {
  const r = aggregateEmployeePayroll([
    row("a", "2026-05-01T09:00:00-07:00", "2026-05-01T11:00:00-07:00"),
    row("lunch", "2026-05-01T11:30:00-07:00", "2026-05-01T12:00:00-07:00", {
      summary: "Lunch",
    }),
    row("b", "2026-05-01T12:30:00-07:00", "2026-05-01T14:00:00-07:00"),
  ]);
  // Hueco real: 11:00→11:30 (30min) + 12:00→12:30 (30min) = 1h de traslado,
  // NO 1.5h (que sería si el Lunch se salteara del todo).
  assert.equal(r.travelHours, 1);
  // El Lunch no cuenta como trabajo ni aparece en la lista de eventos.
  assert.equal(r.workHours, 3.5);
  assert.equal(r.eventCount, 2);
  assert.ok(!r.events.some((e) => e.id === "lunch"));
});

test("traslado: sin tiempo antes del primero ni después del último del día", () => {
  const r = aggregateEmployeePayroll([
    row("a", "2026-05-01T09:00:00-07:00", "2026-05-01T10:00:00-07:00"),
  ]);
  assert.equal(r.travelHours, 0);
});

test("traslado: eventos solapados no restan (clamp a 0)", () => {
  const r = aggregateEmployeePayroll([
    row("a", "2026-05-01T09:00:00-07:00", "2026-05-01T11:00:00-07:00"),
    row("b", "2026-05-01T10:30:00-07:00", "2026-05-01T12:00:00-07:00"),
  ]);
  assert.equal(r.travelHours, 0);
});

test("traslado: el hueco entre el último evento de un día y el primero del día siguiente no cuenta", () => {
  const r = aggregateEmployeePayroll([
    row("a", "2026-05-01T09:00:00-07:00", "2026-05-01T17:00:00-07:00"),
    row("b", "2026-05-02T08:00:00-07:00", "2026-05-02T10:00:00-07:00"),
  ]);
  assert.equal(r.travelHours, 0);
});

test("isNonServiceEventRow se excluye del trabajo pero corta el hueco de traslado", () => {
  const r = aggregateEmployeePayroll([
    row("a", "2026-05-01T09:00:00-07:00", "2026-05-01T10:00:00-07:00"),
    row("block", "2026-05-01T10:15:00-07:00", "2026-05-01T10:30:00-07:00", {
      colorId: "4",
    }),
    row("b", "2026-05-01T11:00:00-07:00", "2026-05-01T12:00:00-07:00"),
  ]);
  assert.equal(r.eventCount, 2);
  assert.equal(r.workHours, 2);
  // 10:00→10:15 (15min) + 10:30→11:00 (30min) = 45min
  assert.equal(r.travelHours, 0.75);
});

// ── stripMoney ───────────────────────────────────────────────────────────────

test("stripMoney borra los 3 campos de plata, en empleados y en totales", () => {
  const summary = {
    ok: true,
    period: { year: 2026, month: 5, half: 1, label: "Q1 May 2026" },
    employees: [
      {
        employeeId: "1",
        name: "Ana",
        eventCount: 1,
        workHours: 2,
        travelHours: 0.5,
        workMoney: 100,
        travelMoney: 12.5,
        totalMoney: 112.5,
        events: [],
      },
    ],
    totals: {
      employeeCount: 1,
      eventCount: 1,
      workHours: 2,
      travelHours: 0.5,
      workMoney: 100,
      travelMoney: 12.5,
      totalMoney: 112.5,
    },
    tz: "America/Vancouver",
  };

  const r = stripMoney(summary);
  assert.equal("workMoney" in r.employees[0], false);
  assert.equal("travelMoney" in r.employees[0], false);
  assert.equal("totalMoney" in r.employees[0], false);
  assert.equal("workMoney" in r.totals, false);
  assert.equal("travelMoney" in r.totals, false);
  assert.equal("totalMoney" in r.totals, false);
  // El resto de los campos sigue intacto.
  assert.equal(r.employees[0].workHours, 2);
  assert.equal(r.totals.eventCount, 1);
});
