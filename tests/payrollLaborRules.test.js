import { test } from "node:test";
import assert from "node:assert/strict";

import {
  BC_RULES,
  weekStartSunday,
  holidaysInRange,
  computeOvertimeHours,
  computeHolidayPay,
  computeLaborPay,
} from "../src/services/payrollLaborRulesService.js";

// ── semana y feriados ────────────────────────────────────────────────────────

test("semana laboral de BC: de domingo a sábado", () => {
  assert.equal(weekStartSunday("2026-10-11"), "2026-10-11"); // domingo
  assert.equal(weekStartSunday("2026-10-12"), "2026-10-11"); // lunes
  assert.equal(weekStartSunday("2026-10-17"), "2026-10-11"); // sábado
  assert.equal(weekStartSunday("2026-10-01"), "2026-09-27"); // jueves, semana que cruza el mes
});

test("feriados dentro de una quincena", () => {
  assert.deepEqual(holidaysInRange("2026-10-01", "2026-10-15"), [
    { date: "2026-10-12", name: "Thanksgiving" },
  ]);
  assert.deepEqual(
    holidaysInRange("2026-09-16", "2026-09-30").map((h) => h.date),
    ["2026-09-30"],
  );
  assert.deepEqual(holidaysInRange("2026-10-16", "2026-10-31"), []);
});

// ── horas extra por día ──────────────────────────────────────────────────────

test("extra por día: 11 horas = 3 horas a 1,5× (caso Javi 5/10)", () => {
  const out = computeOvertimeHours({
    days: [{ date: "2026-10-05", hours: 11 }],
    fromDate: "2026-10-01",
    toDate: "2026-10-15",
  });
  assert.deepEqual(out, [{ date: "2026-10-05", hours: 11, hours15: 3, hours2: 0, weeklyHours: 0 }]);
});

test("extra por día: pasadas las 12 horas se paga a 2×", () => {
  const [day] = computeOvertimeHours({
    days: [{ date: "2026-10-06", hours: 14 }],
    fromDate: "2026-10-01",
    toDate: "2026-10-15",
  });
  assert.equal(day.hours15, 4); // horas 9 a 12
  assert.equal(day.hours2, 2); // horas 13 y 14
});

test("hasta 8 horas no hay extra", () => {
  assert.deepEqual(
    computeOvertimeHours({
      days: [{ date: "2026-10-06", hours: 8 }],
      fromDate: "2026-10-01",
      toDate: "2026-10-15",
    }),
    [],
  );
});

// ── horas extra por semana ───────────────────────────────────────────────────

test("extra por semana: 40 horas en 5 días y 5 más el sábado = 5 horas a 1,5×", () => {
  const days = ["05", "06", "07", "08", "09"].map((d) => ({ date: `2026-10-${d}`, hours: 8 }));
  days.push({ date: "2026-10-10", hours: 5 });
  const out = computeOvertimeHours({ days, fromDate: "2026-10-01", toDate: "2026-10-15" });
  assert.deepEqual(out, [{ date: "2026-10-10", hours: 5, hours15: 5, hours2: 0, weeklyHours: 5 }]);
});

test("una hora no es extra por día y por semana a la vez: 5 días de 10 horas = 10 horas extra, no 20", () => {
  const days = ["05", "06", "07", "08", "09"].map((d) => ({ date: `2026-10-${d}`, hours: 10 }));
  const out = computeOvertimeHours({ days, fromDate: "2026-10-01", toDate: "2026-10-15" });
  const total = out.reduce((s, d) => s + d.hours15, 0);
  assert.equal(total, 10); // 2 por día; para la semana solo cuentan las primeras 8 de cada día = 40
  assert.ok(out.every((d) => d.weeklyHours === 0));
});

test("semana que cruza el cierre: los días de la quincena anterior solo cuentan para llegar a 40 y no se vuelven a pagar", () => {
  // Semana 27/9–3/10: lun-mié (28, 29, 30) caen en Sep Q2 y jue-sáb (1, 2, 3) en Oct Q1.
  const days = [
    { date: "2026-09-28", hours: 8 },
    { date: "2026-09-29", hours: 8 },
    { date: "2026-09-30", hours: 8 },
    { date: "2026-10-01", hours: 8 },
    { date: "2026-10-02", hours: 8 },
    { date: "2026-10-03", hours: 8 },
  ];
  const out = computeOvertimeHours({ days, fromDate: "2026-10-01", toDate: "2026-10-15" });
  // 24 horas en septiembre + 8 + 8 = 40 el viernes; el sábado ya son extra.
  assert.deepEqual(out, [{ date: "2026-10-03", hours: 8, hours15: 8, hours2: 0, weeklyHours: 8 }]);
});

test("la cuenta de 40 horas se reinicia cada domingo", () => {
  const days = [
    { date: "2026-10-09", hours: 8 }, // viernes
    { date: "2026-10-10", hours: 8 }, // sábado
    { date: "2026-10-11", hours: 8 }, // domingo: semana nueva
    { date: "2026-10-12", hours: 8 },
  ];
  assert.deepEqual(computeOvertimeHours({ days, fromDate: "2026-10-01", toDate: "2026-10-15" }), []);
});

test("un feriado trabajado ya pagado a 1,5× no suma extra por día", () => {
  const out = computeOvertimeHours({
    days: [{ date: "2026-10-12", hours: 10, holidayPaid: true }],
    fromDate: "2026-10-01",
    toDate: "2026-10-15",
  });
  assert.deepEqual(out, []);
});

// ── feriados ────────────────────────────────────────────────────────────────

// 20 días trabajados en los 30 previos al 12/10, con $150 por día.
function ledgerWithDays(n, money = 150, hoursPerDay = 6) {
  const m = new Map();
  for (let i = 1; i <= n; i++) {
    const d = new Date(Date.UTC(2026, 9, 12 - i)).toISOString().slice(0, 10);
    m.set(d, { workHours: hoursPerDay, hours: hoursPerDay, money });
  }
  return m;
}

test("feriado trabajado y con derecho: día promedio + 0,5× por cada hora (las horas ya están a tarifa simple)", () => {
  const ledgerByDate = ledgerWithDays(20);
  ledgerByDate.set("2026-10-12", { workHours: 6.5, hours: 6.5, money: 162.5 });
  const r = computeHolidayPay({ date: "2026-10-12", name: "Thanksgiving", ledgerByDate, workRate: 25 });
  assert.equal(r.eligible, true);
  assert.equal(r.daysWorkedInWindow, 20);
  assert.equal(r.avgDayPay, 150);
  assert.equal(r.premium, 81.25); // 0,5 × 25 × 6,5
  assert.equal(r.amount, 231.25);
});

test("feriado no trabajado y con derecho: cobra el día promedio", () => {
  const r = computeHolidayPay({
    date: "2026-10-12",
    name: "Thanksgiving",
    ledgerByDate: ledgerWithDays(20),
    workRate: 25,
  });
  assert.equal(r.worked, false);
  assert.equal(r.amount, 150);
});

test("sin 15 días trabajados en los 30 previos no hay pago de feriado", () => {
  const r = computeHolidayPay({
    date: "2026-10-12",
    name: "Thanksgiving",
    ledgerByDate: ledgerWithDays(14),
    workRate: 25,
  });
  assert.equal(r.eligible, false);
  assert.equal(r.amount, 0);
});

test("el día promedio usa solo los 30 días anteriores y divide por los días trabajados", () => {
  const ledgerByDate = ledgerWithDays(15, 100); // $100 × 15 días
  ledgerByDate.set("2026-08-01", { workHours: 8, hours: 8, money: 9999 }); // fuera de la ventana
  const r = computeHolidayPay({ date: "2026-10-12", name: "Thanksgiving", ledgerByDate, workRate: 25 });
  assert.equal(r.daysWorkedInWindow, 15);
  assert.equal(r.avgDayPay, 100);
});

test("feriado con más de 12 horas: las que pasan de 12 se pagan a 2×", () => {
  const ledgerByDate = ledgerWithDays(20);
  ledgerByDate.set("2026-10-12", { workHours: 14, hours: 14, money: 350 });
  const r = computeHolidayPay({ date: "2026-10-12", name: "Thanksgiving", ledgerByDate, workRate: 20 });
  // 0,5 × 20 × 12 + 1,0 × 20 × 2 = 120 + 40
  assert.equal(r.premium, 160);
});

// ── todo junto ───────────────────────────────────────────────────────────────

test("computeLaborPay: Javi 11 horas el 5/10 a $25 = $37,50 de plus (312,50 en vez de 275)", () => {
  const out = computeLaborPay({
    ledger: [{ date: "2026-10-05", workHours: 10.5, travelHours: 0.5, money: 275 }],
    fromDate: "2026-10-01",
    toDate: "2026-10-15",
    workRate: 25,
  });
  assert.equal(out.overtime.hours15, 3);
  assert.equal(out.overtime.money, 37.5);
  assert.deepEqual(out.holidays.map((h) => h.eligible), [false]); // 12/10 sin historial: no califica
});

test("computeLaborPay: un empleado exento no cobra horas extra pero sí feriado", () => {
  const ledger = [{ date: "2026-10-05", workHours: 11, travelHours: 0, money: 275 }];
  for (let i = 1; i <= 20; i++) {
    const d = new Date(Date.UTC(2026, 9, 11 - i)).toISOString().slice(0, 10);
    ledger.push({ date: d, workHours: 6, travelHours: 0, money: 150 });
  }
  const out = computeLaborPay({
    ledger,
    fromDate: "2026-10-01",
    toDate: "2026-10-15",
    workRate: 25,
    overtimeExempt: true,
  });
  assert.equal(out.overtime.money, 0);
  assert.ok(out.holidayMoney > 0);
});

test("computeLaborPay: el 12/10 trabajado con derecho paga el feriado y no cuenta extra por día ese día", () => {
  const ledger = [];
  for (let i = 1; i <= 20; i++) {
    const d = new Date(Date.UTC(2026, 9, 11 - i)).toISOString().slice(0, 10);
    ledger.push({ date: d, workHours: 6, travelHours: 0, money: 150 });
  }
  ledger.push({ date: "2026-10-12", workHours: 10, travelHours: 0, money: 250 });
  const out = computeLaborPay({
    ledger,
    fromDate: "2026-10-01",
    toDate: "2026-10-15",
    workRate: 25,
  });
  assert.equal(out.holidays[0].worked, true);
  assert.equal(out.holidays[0].premium, 125); // 0,5 × 25 × 10
  assert.ok(!out.overtime.days.some((d) => d.date === "2026-10-12"));
});

test("las reglas de BC están en un solo lugar", () => {
  assert.equal(BC_RULES.dailyRegularHours, 8);
  assert.equal(BC_RULES.dailyDoubleAfterHours, 12);
  assert.equal(BC_RULES.weeklyRegularHours, 40);
});
