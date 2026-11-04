import { test } from "node:test";
import assert from "node:assert/strict";

import { DateTime } from "luxon";
import {
  quincenaRange,
  aggregateEmployeePayroll,
  applyTravelOverrides,
  travelSlotKey,
  stripMoney,
  isEventCounted,
  buildForecastEvents,
  computeProfits,
} from "../src/services/payrollSummaryService.js";
import {
  resolveClientHourlyRate,
  computeEventClientMoney,
} from "../src/services/clientBillingCalculator.js";

const TZ = "America/Vancouver";

// ── quincenaRange ────────────────────────────────────────────────────────────

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

function ev(id, startIso, endIso, opts = {}) {
  return {
    id,
    summary: opts.summary ?? `Job ${id}`,
    startIso,
    endIso,
    startDate: startIso.slice(0, 10),
    durationH:
      (new Date(endIso).getTime() - new Date(startIso).getTime()) /
      3_600_000,
    isNonService: opts.isNonService ?? false,
    location: opts.location ?? "123 Main St",
    recurringEventId: opts.recurringEventId ?? null,
  };
}

test("traslado: un hueco limpio (< 1h) entre 2 eventos del mismo día", () => {
  const r = aggregateEmployeePayroll([
    ev("a", "2026-05-01T09:00:00-07:00", "2026-05-01T11:00:00-07:00"),
    ev("b", "2026-05-01T11:45:00-07:00", "2026-05-01T14:00:00-07:00"),
  ]);
  assert.equal(r.travelHours, 0.75);
  assert.equal(r.workHours, 4.25);
  assert.equal(r.eventCount, 2);
});

test("traslado: un Lunch en el medio cuenta de los DOS lados (revertido 2026-09-16, ya no es asimétrico)", () => {
  const r = aggregateEmployeePayroll([
    ev("a", "2026-05-01T09:00:00-07:00", "2026-05-01T11:00:00-07:00"),
    ev("lunch", "2026-05-01T11:30:00-07:00", "2026-05-01T12:00:00-07:00", {
      summary: "Lunch",
    }),
    ev("b", "2026-05-01T12:30:00-07:00", "2026-05-01T14:00:00-07:00"),
  ]);
  // Hueco antes del Lunch (11:00→11:30) + después (12:00→12:30) = 1h total.
  assert.equal(r.travelHours, 1);
  assert.equal(r.travelSlots.length, 2);
  assert.ok(r.travelSlots.every((s) => !s.needsReview));
  // El Lunch no cuenta como trabajo ni aparece en la lista de eventos.
  assert.equal(r.workHours, 3.5);
  assert.equal(r.eventCount, 2);
  assert.ok(!r.events.some((e) => e.id === "lunch"));
});

test("traslado: un hueco >= 1h queda 'para revisión manual' — aplica 0h por default, pero SIGUE siendo un slot visible", () => {
  const r = aggregateEmployeePayroll([
    ev("a", "2026-05-01T09:00:00-07:00", "2026-05-01T11:00:00-07:00"),
    // hueco de 1h15
    ev("b", "2026-05-01T12:15:00-07:00", "2026-05-01T14:00:00-07:00"),
  ]);
  assert.equal(r.travelHours, 0);
  assert.equal(r.travelSlots.length, 1);
  const slot = r.travelSlots[0];
  assert.equal(slot.needsReview, true);
  assert.equal(slot.calculatedHours, 1.25);
  assert.equal(slot.appliedHours, 0);
  assert.equal(slot.prevEventId, "a");
  assert.equal(slot.nextEventId, "b");
});

test("traslado: un hueco de exactamente 1h YA necesita revisión (el corte pasó a ser >=, no <=)", () => {
  const r = aggregateEmployeePayroll([
    ev("a", "2026-05-01T09:00:00-07:00", "2026-05-01T11:00:00-07:00"),
    ev("b", "2026-05-01T12:00:00-07:00", "2026-05-01T14:00:00-07:00"),
  ]);
  assert.equal(r.travelSlots[0].needsReview, true);
  assert.equal(r.travelSlots[0].appliedHours, 0);
  assert.equal(r.travelHours, 0);
});

test("traslado: un hueco de menos de 1h se aplica solo, sin revisión", () => {
  const r = aggregateEmployeePayroll([
    ev("a", "2026-05-01T09:00:00-07:00", "2026-05-01T11:00:00-07:00"),
    ev("b", "2026-05-01T11:45:00-07:00", "2026-05-01T13:00:00-07:00"),
  ]);
  assert.equal(r.travelSlots[0].needsReview, false);
  assert.equal(r.travelSlots[0].appliedHours, 0.75);
  assert.equal(r.travelHours, 0.75);
});

test("traslado: sin tiempo antes del primero ni después del último del día", () => {
  const r = aggregateEmployeePayroll([
    ev("a", "2026-05-01T09:00:00-07:00", "2026-05-01T10:00:00-07:00"),
  ]);
  assert.equal(r.travelHours, 0);
});

test("traslado: eventos solapados no restan (clamp a 0)", () => {
  const r = aggregateEmployeePayroll([
    ev("a", "2026-05-01T09:00:00-07:00", "2026-05-01T11:00:00-07:00"),
    ev("b", "2026-05-01T10:30:00-07:00", "2026-05-01T12:00:00-07:00"),
  ]);
  assert.equal(r.travelHours, 0);
});

test("traslado: el hueco entre el último evento de un día y el primero del día siguiente no cuenta", () => {
  const r = aggregateEmployeePayroll([
    ev("a", "2026-05-01T09:00:00-07:00", "2026-05-01T17:00:00-07:00"),
    ev("b", "2026-05-02T08:00:00-07:00", "2026-05-02T10:00:00-07:00"),
  ]);
  assert.equal(r.travelHours, 0);
});

test("isNonService se excluye del trabajo pero corta el hueco de traslado", () => {
  const r = aggregateEmployeePayroll([
    ev("a", "2026-05-01T09:00:00-07:00", "2026-05-01T10:00:00-07:00"),
    ev("block", "2026-05-01T10:15:00-07:00", "2026-05-01T10:30:00-07:00", {
      isNonService: true,
    }),
    ev("b", "2026-05-01T11:00:00-07:00", "2026-05-01T12:00:00-07:00"),
  ]);
  assert.equal(r.eventCount, 2);
  assert.equal(r.workHours, 2);
  // 10:00→10:15 (15min) + 10:30→11:00 (30min) = 45min
  assert.equal(r.travelHours, 0.75);
});

// ── applyTravelOverrides ─────────────────────────────────────────────────────

test("applyTravelOverrides: un override cambia appliedHours de un slot que necesita revisión", () => {
  const r = aggregateEmployeePayroll([
    ev("a", "2026-05-01T09:00:00-07:00", "2026-05-01T11:00:00-07:00"),
    ev("b", "2026-05-01T12:15:00-07:00", "2026-05-01T14:00:00-07:00"), // hueco 1h15
  ]);
  const slot = r.travelSlots[0];
  const overrides = new Map([
    [travelSlotKey(slot), { appliedHours: 0.5, reviewedBy: "tech", reviewedAt: "2026-09-16T00:00:00Z" }],
  ]);

  const { slots, travelHours } = applyTravelOverrides(r.travelSlots, overrides);
  assert.equal(slots[0].appliedHours, 0.5);
  assert.equal(slots[0].reviewedBy, "tech");
  assert.equal(travelHours, 0.5);
});

test("applyTravelOverrides: un override para un slot que NO necesita revisión se ignora", () => {
  const r = aggregateEmployeePayroll([
    ev("a", "2026-05-01T09:00:00-07:00", "2026-05-01T11:00:00-07:00"),
    ev("b", "2026-05-01T11:30:00-07:00", "2026-05-01T13:00:00-07:00"), // hueco 0.5h, auto
  ]);
  const slot = r.travelSlots[0];
  const overrides = new Map([
    [travelSlotKey(slot), { appliedHours: 5, reviewedBy: "tech" }],
  ]);

  const { slots, travelHours } = applyTravelOverrides(r.travelSlots, overrides);
  assert.equal(slots[0].appliedHours, 0.5); // ignora el override, no es su lugar
  assert.equal(travelHours, 0.5);
});

test("applyTravelOverrides: sin override, un slot con revisión pendiente sigue en 0", () => {
  const r = aggregateEmployeePayroll([
    ev("a", "2026-05-01T09:00:00-07:00", "2026-05-01T11:00:00-07:00"),
    ev("b", "2026-05-01T12:15:00-07:00", "2026-05-01T14:00:00-07:00"),
  ]);
  const { slots, travelHours } = applyTravelOverrides(r.travelSlots, new Map());
  assert.equal(slots[0].appliedHours, 0);
  assert.equal(slots[0].reviewedBy, null);
  assert.equal(travelHours, 0);
});

// ── clientMoney (LAB428) ─────────────────────────────────────────────────────

test("computeEventClientMoney: 4h de trabajo, 1 cleaner, cliente recurrente → $189 a $45/h + 5% GST", () => {
  const r = computeEventClientMoney({
    durationH: 4,
    attendeeCount: 1,
    serviceType: "Residential Cleaning",
    clientCreatedAt: "2026-01-01T00:00:00-07:00",
    eventStartIso: "2026-09-10T09:00:00-07:00",
  });
  assert.equal(r.billedRate, 45);
  assert.equal(r.calculatedAmount, 189);
});

test("computeEventClientMoney: 2 cleaners asignados al mismo evento duplican el monto (horas-persona, no horas de reloj)", () => {
  const r = computeEventClientMoney({
    durationH: 2,
    attendeeCount: 2,
    serviceType: "Residential Cleaning",
    clientCreatedAt: "2026-01-01T00:00:00-07:00",
    eventStartIso: "2026-09-10T09:00:00-07:00",
  });
  assert.equal(r.calculatedAmount, 189); // 2h x 2 cleaners x $45 x 1.05 GST
});

test("computeEventClientMoney: attendeeCount ausente o 0 se trata como 1 (nunca cobra menos que 1 cleaner)", () => {
  const withZero = computeEventClientMoney({
    durationH: 2,
    attendeeCount: 0,
    serviceType: "Residential Cleaning",
    clientCreatedAt: "2026-01-01T00:00:00-07:00",
    eventStartIso: "2026-09-10T09:00:00-07:00",
  });
  const withUndefined = computeEventClientMoney({
    durationH: 2,
    serviceType: "Residential Cleaning",
    clientCreatedAt: "2026-01-01T00:00:00-07:00",
    eventStartIso: "2026-09-10T09:00:00-07:00",
  });
  assert.equal(withZero.calculatedAmount, 94.5);
  assert.equal(withUndefined.calculatedAmount, 94.5);
});

// Casos reales dados por el usuario 2026-09-17 (monto facturado / recibido
// por e-transfer) — regresión contra la fórmula completa: clients.rate ??
// diferencial nuevo/recurrente, × cleaners asignados, + 5% GST.
test("computeEventClientMoney: caso real Tara Hearn — 2h, 2 cleaners, clients.rate=$40 → $168", () => {
  const r = computeEventClientMoney({
    durationH: 2,
    attendeeCount: 2,
    serviceType: "Residential Cleaning",
    clientCreatedAt: "2025-10-23T20:43:58",
    clientRate: 40,
    eventStartIso: "2026-09-15T18:30:00Z",
  });
  assert.equal(r.calculatedAmount, 168);
});

test("computeEventClientMoney: caso real Cody McMullin — 4h, 2 cleaners, clients.rate=$40 → $336", () => {
  const r = computeEventClientMoney({
    durationH: 4,
    attendeeCount: 2,
    serviceType: "Residential Cleaning",
    clientCreatedAt: "2025-10-23T20:43:58",
    clientRate: 40,
    eventStartIso: "2026-09-15T15:30:00Z",
  });
  assert.equal(r.calculatedAmount, 336);
});

test("computeEventClientMoney: caso real Katie Hamilton — 3h, 2 cleaners, sin clients.rate (recurrente $45) → $283.50", () => {
  const r = computeEventClientMoney({
    durationH: 3,
    attendeeCount: 2,
    serviceType: "Residential Cleaning",
    clientCreatedAt: "2026-08-05T17:56:32.272",
    clientRate: null,
    eventStartIso: "2026-09-15T21:15:00Z",
  });
  assert.equal(r.calculatedAmount, 283.5);
});

// ── stripMoney: horas extra y feriados ───────────────────────────────────────

test("stripMoney: un cleaner ve sus horas extra pero no el dinero de horas extra ni de feriados", () => {
  const out = stripMoney({
    ok: true,
    employees: [
      {
        employeeId: "1",
        name: "Yudith",
        workHours: 11,
        travelHours: 0,
        overtimeHours15: 3,
        overtimeHours2: 0,
        overtimeMoney: 37.5,
        holidayMoney: 150,
        holidayDays: [{ date: "2026-10-12", name: "Thanksgiving", amount: 150 }],
        overtimeDays: [{ date: "2026-10-05", hours: 11, hours15: 3, hours2: 0, weeklyHours: 0 }],
        totalMoney: 462.5,
        events: [],
      },
    ],
    totals: { workHours: 11, travelHours: 0, overtimeHours: 3, overtimeMoney: 37.5, holidayMoney: 150, totalMoney: 462.5 },
  });
  const emp = out.employees[0];
  assert.equal(emp.overtimeHours15, 3);
  assert.equal(emp.overtimeDays.length, 1);
  for (const key of ["overtimeMoney", "holidayMoney", "holidayDays", "totalMoney"]) {
    assert.equal(key in emp, false, key);
  }
  assert.equal(out.totals.overtimeHours, 3);
  for (const key of ["overtimeMoney", "holidayMoney", "totalMoney"]) {
    assert.equal(key in out.totals, false, key);
  }
});

// ── stripMoney ───────────────────────────────────────────────────────────────

test("stripMoney borra los 3 campos de plata, en empleados y en totales", () => {
  const summary = {
    ok: true,
    period: { year: 2026, month: 5, half: 1, label: "Q1 May 2026" },
    employees: [
      {
        employeeId: "1",
        name: "Yudith",
        eventCount: 1,
        workHours: 2,
        travelHours: 0.5,
        workMoney: 100,
        travelMoney: 12.5,
        totalMoney: 112.5,
        events: [
          {
            id: "a",
            summary: "Job a",
            durationH: 2,
            calculatedAmount: 90,
            appliedAmount: 90,
            billedRate: 45,
            attendeeNames: ["Yudith"],
            serviceType: "Residential Cleaning",
            billingReviewedBy: null,
            billingReviewedAt: null,
          },
        ],
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
    pnl: {
      grossRevenue: 90,
      cleanerPayroll: 112.5,
      grossProfit: -22.5,
      expensesFinancial: 0,
      expensesOperational: 0,
      expensesAdministrative: 0,
      expensesTotal: 0,
      netProfit: -22.5,
    },
    clientBilling: [{ eventId: "a", summary: "Job a", appliedAmount: 90 }],
    tz: "America/Vancouver",
  };

  const r = stripMoney(summary);
  assert.equal("workMoney" in r.employees[0], false);
  assert.equal("travelMoney" in r.employees[0], false);
  assert.equal("totalMoney" in r.employees[0], false);
  assert.equal("workMoney" in r.totals, false);
  assert.equal("travelMoney" in r.totals, false);
  assert.equal("totalMoney" in r.totals, false);
  assert.equal("pnl" in r, false);
  assert.equal("clientBilling" in r, false);
  for (const field of [
    "calculatedAmount",
    "appliedAmount",
    "billedRate",
    "attendeeNames",
    "serviceType",
    "billingReviewedBy",
    "billingReviewedAt",
  ]) {
    assert.equal(field in r.employees[0].events[0], false, `${field} should be stripped`);
  }
  // El resto de los campos sigue intacto.
  assert.equal(r.employees[0].workHours, 2);
  assert.equal(r.employees[0].events[0].summary, "Job a");
  assert.equal(r.totals.eventCount, 1);
});

// ── Ganancia por trabajo ─────────────────────────────────────────────────────
import { computeEventProfit } from "../src/services/payrollSummaryService.js";
import { sumDeductionsByEmployee } from "../src/services/payrollAdjustmentsService.js";

test("computeEventProfit: 2 cleaners a $20/h en 3h → pagan $120, el negocio se queda con el resto", () => {
  const r = computeEventProfit({ appliedAmount: 283.5, durationH: 3, attendeeRates: [20, 20] });
  assert.equal(r.cleanerPayTotal, 120);
  assert.equal(r.businessProfit, 163.5);
});

test("computeEventProfit: cada cleaner cobra con SU tarifa", () => {
  const r = computeEventProfit({ appliedAmount: 200, durationH: 2, attendeeRates: [18, 22.5] });
  assert.equal(r.cleanerPayTotal, 81);
  assert.equal(r.businessProfit, 119);
});

test("computeEventProfit: si se paga más de lo facturado la ganancia es negativa (no se oculta)", () => {
  const r = computeEventProfit({ appliedAmount: 40, durationH: 2, attendeeRates: [25, 25] });
  assert.equal(r.businessProfit, -60);
});

test("sumDeductionsByEmployee: suma los adelantos por empleado", () => {
  const byEmp = sumDeductionsByEmployee([
    { employeeId: "a", amount: 100 },
    { employeeId: "b", amount: 50.25 },
    { employeeId: "a", amount: 20.1 },
  ]);
  assert.equal(byEmp.get("a"), 120.1);
  assert.equal(byEmp.get("b"), 50.25);
  assert.equal(byEmp.get("c"), undefined);
});

test("stripMoney también borra deducciones, net pay y las ganancias por trabajo", () => {
  const r = stripMoney({
    period: {},
    employees: [
      {
        employeeId: "e1",
        workHours: 2,
        totalMoney: 50,
        deductions: 10,
        netPay: 40,
        events: [
          { id: "a", summary: "Job", cleanerPay: 40, businessProfit: 90, invoiceStatus: "paid", paidDate: "2026-09-10", clientId: "c1" },
        ],
      },
    ],
    totals: { eventCount: 1, totalMoney: 50, deductions: 10, netPay: 40 },
  });
  for (const f of ["deductions", "netPay"]) {
    assert.equal(f in r.employees[0], false, `${f} en empleado`);
    assert.equal(f in r.totals, false, `${f} en totales`);
  }
  for (const f of ["cleanerPay", "businessProfit", "invoiceStatus", "paidDate", "clientId"]) {
    assert.equal(f in r.employees[0].events[0], false, `${f} en evento`);
  }
  assert.equal(r.employees[0].events[0].summary, "Job");
});

// ── isEventCounted ───────────────────────────────────────────────────────────

test("isEventCounted: un evento ya terminado cuenta, sin importar el día", () => {
  const toInclusive = DateTime.fromISO("2026-09-15", { zone: TZ });
  const now = DateTime.fromISO("2026-09-10T18:00:00", { zone: TZ });
  const ev = { startIso: "2026-09-10T14:00:00", endIso: "2026-09-10T16:00:00" };
  assert.equal(isEventCounted(ev, toInclusive, now), true);
});

test("isEventCounted: un evento futuro de un día que NO es el último de la quincena no cuenta", () => {
  const toInclusive = DateTime.fromISO("2026-09-15", { zone: TZ });
  const now = DateTime.fromISO("2026-09-10T10:00:00", { zone: TZ });
  const ev = { startIso: "2026-09-10T14:00:00", endIso: "2026-09-10T16:00:00" };
  assert.equal(isEventCounted(ev, toInclusive, now), false);
});

test("isEventCounted: un evento del ÚLTIMO día que todavía no terminó cuenta igual (cierre arranca esa mañana)", () => {
  const toInclusive = DateTime.fromISO("2026-09-15", { zone: TZ });
  const now = DateTime.fromISO("2026-09-15T08:00:00", { zone: TZ });
  const ev = { startIso: "2026-09-15T14:00:00", endIso: "2026-09-15T16:00:00" };
  assert.equal(isEventCounted(ev, toInclusive, now), true);
});

test("isEventCounted: el último día de la quincena que ya terminó cuenta (caso normal, no depende de la excepción)", () => {
  const toInclusive = DateTime.fromISO("2026-09-15", { zone: TZ });
  const now = DateTime.fromISO("2026-09-16T00:30:00", { zone: TZ });
  const ev = { startIso: "2026-09-15T22:00:00", endIso: "2026-09-15T23:30:00" };
  assert.equal(isEventCounted(ev, toInclusive, now), true);
});

test("computeEventClientMoney: preTaxAmount es calculatedAmount sin el 5% de GST (para Gross revenue del P&L)", () => {
  const r = computeEventClientMoney({
    durationH: 4,
    attendeeCount: 1,
    serviceType: "Residential Cleaning",
    clientCreatedAt: "2020-01-01",
    clientRate: 45,
    eventStartIso: "2026-09-01T10:00:00",
  });
  assert.equal(r.preTaxAmount, 180); // 4h x $45, sin GST
  assert.equal(r.calculatedAmount, 189); // con 5% GST — lo que se factura, sin cambios
});

// ── buildForecastEvents (Forecast, 2026-09-30) ────────────────────────────────

test("buildForecastEvents: descarta all-day, non-service, Lunch y eventos sin ningún cleaner activo", () => {
  const employees = [{ email: "a@x.com" }, { email: "b@x.com" }];
  const base = { startIso: "2026-09-10T09:00:00-07:00", endIso: "2026-09-10T11:00:00-07:00", durationH: 2 };
  const events = [
    { ...base, id: "1", summary: "House Cleaning", isAllDay: false, isNonService: false, attendees: ["a@x.com"] },
    { ...base, id: "2", summary: "Holiday", isAllDay: true, isNonService: false, attendees: ["a@x.com"] },
    { ...base, id: "3", summary: "Team meeting", isAllDay: false, isNonService: true, attendees: ["a@x.com"] },
    { ...base, id: "4", summary: "Lunch", isAllDay: false, isNonService: false, attendees: ["a@x.com"] },
    { ...base, id: "5", summary: "House Cleaning", isAllDay: false, isNonService: false, attendees: ["nobody@x.com"] },
    { ...base, id: "6", summary: "House Cleaning", isAllDay: false, isNonService: false, attendees: ["a@x.com", "b@x.com"] },
  ];
  const r = buildForecastEvents(events, employees);
  assert.deepEqual(r.map((e) => e.id), ["1", "6"]);
  assert.equal(r.find((e) => e.id === "6").attendeeCount, 2);
  assert.equal(r.find((e) => e.id === "1").attendeeCount, 1);
});

test("computeProfits: los dividendos restan de la ganancia (como el Nominee del Excel) y la ganancia neta descuenta los gastos", () => {
  const r = computeProfits({ grossRevenue: 18604.17, cleanerPayroll: 10498.95, dividends: 3160, expensesTotal: 2510.66 });
  assert.equal(r.grossProfit, 4945.22);
  assert.equal(r.netProfit, 2434.56);
});

test("computeProfits: sin dividendos queda igual que antes (ingresos − nómina − gastos)", () => {
  const r = computeProfits({ grossRevenue: 100, cleanerPayroll: 60, expensesTotal: 10 });
  assert.equal(r.grossProfit, 40);
  assert.equal(r.netProfit, 30);
});
