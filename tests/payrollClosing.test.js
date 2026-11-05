import { test } from "node:test";
import assert from "node:assert/strict";

import {
  splitAmountEqually,
  sumBonusesByEmployee,
  sumTipsByEmployee,
  computeNetPay,
  buildNetPayRows,
  TIPS_IN_NET_PAY,
} from "../src/services/payrollAdjustmentsService.js";
import { buildTeamsByDay } from "../src/services/payrollSummaryService.js";
import { mergeChecklist, pickNewClients, normalizeFrequency } from "../src/services/payrollClosingService.js";
import { sumByPartner, buildStakeholderPayments } from "../src/services/payrollPartnersService.js";
import {
  computeCashExcess,
  buildPaymentTable,
} from "../src/services/payrollPaymentPlanService.js";

// ── splitAmountEqually ───────────────────────────────────────────────────────

test("splitAmountEqually: 100 entre 3 no pierde centavos (el resto va a las primeras partes)", () => {
  const shares = splitAmountEqually(100, 3);
  assert.deepEqual(shares, [33.34, 33.33, 33.33]);
  assert.equal(Math.round(shares.reduce((s, v) => s + v, 0) * 100) / 100, 100);
});

test("splitAmountEqually: partes exactas y sin destinatarios", () => {
  assert.deepEqual(splitAmountEqually(50, 2), [25, 25]);
  assert.deepEqual(splitAmountEqually(50, 0), []);
});

// ── bonos ────────────────────────────────────────────────────────────────────

test("bonos: el monto es POR cleaner — para todos o solo para los destinatarios", () => {
  const bonuses = [
    { amount: 5, appliesToAll: true, recipients: [] },
    { amount: 20, appliesToAll: false, recipients: [{ employeeId: "b" }, { employeeId: "c" }] },
  ];
  const byEmployee = sumBonusesByEmployee(bonuses, ["a", "b", "c"]);
  assert.equal(byEmployee.get("a"), 5);
  assert.equal(byEmployee.get("b"), 25);
  assert.equal(byEmployee.get("c"), 25);
});

// ── propinas ─────────────────────────────────────────────────────────────────

test("propinas: se reparten en partes iguales entre los destinatarios; las sin asignar se informan aparte", () => {
  const tips = [
    { amount: 30, recipients: [{ employeeId: "a" }, { employeeId: "b" }] },
    { amount: 10, recipients: [{ employeeId: "a" }] },
    { amount: 7.5, recipients: [] },
  ];
  const { byEmployee, unassignedTotal } = sumTipsByEmployee(tips);
  assert.equal(byEmployee.get("a"), 25);
  assert.equal(byEmployee.get("b"), 15);
  assert.equal(unassignedTotal, 7.5);
});

// ── NET PAY ──────────────────────────────────────────────────────────────────

test("NET PAY: ganado + bonos + propinas - deducciones (confirmado con Jhony: pasan por la cuenta de la empresa); un override manual lo pisa", () => {
  assert.equal(TIPS_IN_NET_PAY, true);
  const base = { earned: 1000, bonuses: 25, tips: 15, deductions: 120 };
  assert.deepEqual(computeNetPay({ ...base, override: null }), {
    calculated: 920,
    applied: 920,
    overridden: false,
  });
  assert.deepEqual(computeNetPay({ ...base, override: { amount: 900 } }), {
    calculated: 920,
    applied: 900,
    overridden: true,
  });
});

test("NET PAY: un empleado fuera de la quincena (inactivo) con ajustes también aparece; las propinas suman al calculado", () => {
  const rows = buildNetPayRows({
    rows: [{ employeeId: "a", name: "Alex", totalMoney: 500, workHours: 59.25, travelHours: 7 }],
    extraPayees: [{ employeeId: "z", name: "Clara" }],
    deductionsByEmployee: new Map(),
    bonusesByEmployee: new Map([["z", 40]]),
    tipsByEmployee: new Map([["a", 12]]),
    overrides: new Map([["a", { amount: 480, note: "redondeo" }]]),
  });
  const alex = rows.find((r) => r.employeeId === "a");
  const clara = rows.find((r) => r.employeeId === "z");
  assert.equal(alex.calculated, 512);
  assert.equal(alex.tips, 12);
  assert.equal(alex.applied, 480);
  assert.equal(alex.overridden, true);
  assert.equal(alex.note, "redondeo");
  assert.equal(clara.active, false);
  assert.equal(clara.applied, 40);
  // Las horas viajan con la fila para mostrarlas en la tabla NET PAY.
  assert.equal(alex.workHours, 59.25);
  assert.equal(alex.travelHours, 7);
  assert.equal(clara.workHours, 0);
  assert.equal(clara.travelHours, 0);
});

test("NET PAY: el pago extra (horas extra + feriados) viaja aparte en la fila, sin cambiar el monto", () => {
  const rows = buildNetPayRows({
    rows: [
      {
        employeeId: "a",
        name: "Alex",
        totalMoney: 700,
        overtimeMoney: 60,
        overtimeHours15: 4,
        overtimeHours2: 0,
        holidayMoney: 90,
        holidayDays: [
          { name: "Labour Day", worked: true, amount: 90 },
          { name: "Otro", worked: false, amount: 0 },
        ],
      },
      { employeeId: "b", name: "Beto", totalMoney: 300 },
    ],
    extraPayees: [{ employeeId: "z", name: "Clara" }],
    deductionsByEmployee: new Map(),
    bonusesByEmployee: new Map(),
    tipsByEmployee: new Map(),
    overrides: new Map(),
  });
  const alex = rows.find((r) => r.employeeId === "a");
  assert.equal(alex.applied, 700);
  assert.equal(alex.extraIncluded, true);
  assert.equal(alex.overtimeMoney, 60);
  assert.equal(alex.overtimeHours15, 4);
  assert.equal(alex.holidayMoney, 90);
  // Solo los feriados que suman algo.
  assert.deepEqual(alex.holidays, [{ name: "Labour Day", worked: true, amount: 90 }]);
  for (const id of ["b", "z"]) {
    const r = rows.find((x) => x.employeeId === id);
    assert.equal(r.overtimeMoney, 0);
    assert.equal(r.holidayMoney, 0);
    assert.deepEqual(r.holidays, []);
  }

  // Con plan de pago el monto es solo la parte directa: el extra no está en él.
  const withPlan = buildNetPayRows({
    rows: [{ employeeId: "a", name: "Alex", totalMoney: 700, overtimeMoney: 60 }],
    deductionsByEmployee: new Map(),
    bonusesByEmployee: new Map(),
    tipsByEmployee: new Map(),
    overrides: new Map(),
    directAmountByEmployee: new Map([["a", 400]]),
  })[0];
  assert.equal(withPlan.applied, 400);
  assert.equal(withPlan.overtimeMoney, 60);
  assert.equal(withPlan.extraIncluded, false);
});

// ── checklist ────────────────────────────────────────────────────────────────

test("checklist: sin fila de estado = pendiente; el comentario y quién lo marcó viajan con el item", () => {
  const merged = mergeChecklist(
    [
      { id: "1", label: "Revisar fechas", position: 0 },
      { id: "2", label: "Telus", position: 1 },
    ],
    [{ item_id: "2", done: true, comment: "pagado el 12", done_by: "admin", done_at: "2026-09-15T10:00:00Z" }],
  );
  assert.equal(merged.total, 2);
  assert.equal(merged.doneCount, 1);
  assert.equal(merged.items[0].done, false);
  assert.equal(merged.items[1].done, true);
  assert.equal(merged.items[1].comment, "pagado el 12");
  assert.equal(merged.items[1].doneBy, "admin");
});

// ── accionistas ──────────────────────────────────────────────────────────────

test("accionistas: dividendos/extras se suman por accionista y lo que no tiene dueño se ignora", () => {
  const byPartner = sumByPartner([
    { partnerId: "javi", amount: 1000 },
    { partnerId: "javi", amount: 520 },
    { partnerId: null, amount: 300 },
  ]);
  assert.equal(byPartner.get("javi"), 1520);
  assert.equal(byPartner.size, 1);
});

// ── Pagos a accionistas en NET PAY ───────────────────────────────────────────

test("accionistas en NET PAY: dividendos + extras por accionista; el efectivo que pasan a cleaners se informa aparte y no suma", () => {
  const partners = [
    { id: "javi", name: "Javi", employeeId: "e-javi" },
    { id: "jhony", name: "Jhony", employeeId: null },
    { id: "otro", name: "Sin pagos", employeeId: null },
  ];
  const out = buildStakeholderPayments({
    partners,
    dividendsByPartner: new Map([
      ["javi", 1640],
      ["jhony", 1640],
    ]),
    extrasByPartner: new Map([["javi", 45]]),
    paymentRows: [
      { partnerId: "javi", via: { gael: 100.43, nohely: 40.11 } },
      { partnerId: "jhony", via: { gael: 100.43, nohely: 40.1 } },
      { partnerId: null, via: {} },
    ],
    dividendsTotal: 3280,
  });
  assert.deepEqual(out.stakeholders.map((s) => s.name), ["Javi", "Jhony"]);
  const javi = out.stakeholders[0];
  assert.equal(javi.dividends, 1640);
  assert.equal(javi.extras, 45);
  assert.equal(javi.total, 1685);
  assert.equal(javi.viaCash, 140.54);
  assert.equal(out.stakeholders[1].total, 1640);
  assert.equal(out.otherDividends, 0);
  assert.equal(out.total, 3325);
});

test("accionistas en NET PAY: un dividendo sin accionista cuenta en `otherDividends` y en el total", () => {
  const out = buildStakeholderPayments({
    partners: [{ id: "javi", name: "Javi", employeeId: null }],
    dividendsByPartner: new Map([["javi", 500]]),
    extrasByPartner: new Map(),
    paymentRows: [],
    dividendsTotal: 800,
  });
  assert.equal(out.otherDividends, 300);
  assert.equal(out.total, 800);
});

// ── horas extra / feriados en la tabla de pagos ──────────────────────────────

test("tabla de pagos: las horas extra y el feriado (extraMoney) suman al Bono, a 'A <él>' de un accionista y al excedente de un plan", () => {
  const base = { workHours: 40, travelHours: 5, bonuses: 0, tips: 0, deductions: 0 };
  const people = [
    { ...base, employeeId: "m", name: "Marcela", workMoney: 1000, travelMoney: 90, extraMoney: 50 },
    { ...base, employeeId: "j", name: "Javi", workMoney: 1000, travelMoney: 90, extraMoney: 100 },
    { ...base, employeeId: "g", name: "Gael", workMoney: 1500, travelMoney: 100, extraMoney: 100 },
  ];
  const table = buildPaymentTable({
    people,
    plans: new Map([
      ["g", { officialNet: 1200, officialGross: 1400, bonusCol: 200, cashRateFactor: 1, viaPartnerIds: ["pj"] }],
    ]),
    partners: [{ id: "pj", name: "Javi", employeeId: "j" }],
  });
  const marcela = table.rows.find((r) => r.employeeId === "m");
  assert.equal(marcela.bonus, 140); // traslado 90 + extra 50
  const javi = table.rows.find((r) => r.employeeId === "j");
  assert.equal(javi.own, 1190); // trabajo 1000 + traslado 90 + extra 100
  const gael = table.routed.find((r) => r.employeeId === "g");
  assert.equal(gael.earnedTotal, 1700); // 1500 + 100 + extra 100
  assert.equal(gael.excess, 300); // 1700 - tope bruto 1400
});

// ── Pagos Experimental — regresión contra las fórmulas de SEP_Q1.xlsx ────────

test("Pagos Experimental: excedente de Gael = (ganado - tope 1400) x 22/25 (fórmula O32 de la planilla)", () => {
  // M13 salario 2260.42 + M14 traslado 182.55 (sin bonos ni deducciones).
  const { excess, cash } = computeCashExcess({
    earnedTotal: 2260.42 + 182.55,
    officialGross: 1400,
    cashRateFactor: 22 / 25,
  });
  assert.equal(excess, 1042.97);
  // La planilla da 458.9068 por cada uno de los dos → 917.8136 en total.
  assert.equal(cash, 917.81);
});

test("Pagos Experimental: sin excedente si lo ganado no supera el tope oficial", () => {
  assert.deepEqual(
    computeCashExcess({ earnedTotal: 1000, officialGross: 1256, cashRateFactor: 19 / 22 }),
    { excess: 0, cash: 0 },
  );
});

const person = (employeeId, name, workMoney, travelMoney, extra = {}) => ({
  employeeId,
  name,
  workMoney,
  travelMoney,
  workHours: 0,
  travelHours: 0,
  bonuses: 0,
  tips: 0,
  deductions: 0,
  ...extra,
});

function septemberPeople() {
  return [
    person("javier", "Javier Martinez", 1781.25, 141.49, { deductions: 120 }),
    person("edilsa", "Edilsa Higuera", 456.25, 36.51),
    person("marcela", "Marcela", 887.5, 63.9),
    person("gael", "Gael", 2260.42, 182.55),
    person("nohely", "Nohely", 1191.74, 127.79, { bonuses: 5 }),
  ];
}

// Javi es accionista Y cleaner (Javier Martinez); Jhony es accionista y NO cleaner.
const septemberPartners = [
  { id: "p-javi", name: "Javi", employeeId: "javier" },
  { id: "p-jhony", name: "Jhony", employeeId: null },
];

function septemberPlans() {
  return new Map([
    ["gael", { officialNet: 1200, officialGross: 1400, bonusCol: 200, cashRateFactor: 22 / 25, viaPartnerIds: ["p-javi", "p-jhony"] }],
    ["nohely", { officialNet: 1200, officialGross: 1256, bonusCol: 200, cashRateFactor: 19 / 22, viaPartnerIds: ["p-javi", "p-jhony"] }],
  ]);
}

function septemberTable(overrides = {}) {
  return buildPaymentTable({
    people: septemberPeople(),
    plans: septemberPlans(),
    partners: septemberPartners,
    dividendsByPartner: new Map([["p-javi", 1520], ["p-jhony", 1520]]),
    extrasByPartner: new Map([["p-javi", 45]]), // parking fijo (N50 de la planilla)
    ...overrides,
  });
}

test("Pagos Experimental: los accionistas se reparten en partes iguales lo que se le paga en efectivo a Gael y Nohely", () => {
  const table = septemberTable();
  const javi = table.rows.find((r) => r.partnerId === "p-javi");
  const jhony = table.rows.find((r) => r.partnerId === "p-jhony");

  // Gael: 917.81 en efectivo → 458.91 + 458.90 (la planilla: 458.9068 c/u).
  assert.equal(javi.via.gael, 458.91);
  assert.equal(jhony.via.gael, 458.9);
  // Nohely: (1191.74 + 127.79 + 5 - 1256) x 19/22 = 59.19 → 29.60 + 29.59.
  assert.equal(javi.via.nohely, 29.6);
  assert.equal(jhony.via.nohely, 29.59);
  assert.deepEqual(table.beneficiaries.map((b) => b.employeeId).sort(), ["gael", "nohely"]);
});

test("Pagos Experimental: Javi (accionista y cleaner) cobra ganado + traslado - deducciones + dividendos + parking = 3367.74 (P32 de la planilla)", () => {
  const javi = septemberTable().rows.find((r) => r.partnerId === "p-javi");
  assert.equal(javi.employeeId, "javier"); // vive en SU fila de cleaner
  assert.equal(javi.isPartner, true);
  assert.equal(javi.real, 0);
  assert.equal(javi.own, 3367.74);
  assert.equal(javi.totalWithoutBonus, Math.round((3367.74 + 458.91 + 29.6) * 100) / 100);
});

test("Pagos Experimental: Jhony NO es cleaner — fila propia con solo sus dividendos (Q33 de la planilla), y Edilsa es una fila de cleaner aparte", () => {
  const table = septemberTable();
  const jhony = table.rows.find((r) => r.partnerId === "p-jhony");
  assert.equal(jhony.employeeId, null);
  assert.equal(jhony.own, 1520);
  assert.equal(jhony.workHours, 0);
  // Las horas/traslado de la fila "Jhony" de la planilla son de Edilsa, que cobra como cualquier cleaner.
  const edilsa = table.rows.find((r) => r.employeeId === "edilsa");
  assert.equal(edilsa.isPartner, false);
  assert.equal(edilsa.real, 456.25);
  assert.equal(edilsa.bonus, 36.51);
});

test("Pagos Experimental: sin plan, 'Real' = salario - deducciones y el traslado va en 'Bono' (Marcela)", () => {
  const marcela = septemberTable().rows.find((r) => r.employeeId === "marcela");
  assert.equal(marcela.real, 887.5);
  assert.equal(marcela.bonus, 63.9);
  assert.equal(marcela.totalWithoutBonus, 887.5);
  assert.equal(marcela.total, 951.4);
});

test("Pagos Experimental: con plan, Real y Bono los fija el plan (Gael 1200 + 200)", () => {
  const gael = septemberTable().rows.find((r) => r.employeeId === "gael");
  assert.equal(gael.real, 1200);
  assert.equal(gael.bonus, 200);
  assert.equal(gael.total, 1400);
});

test("Pagos Experimental: las propinas suman al 'Bono' de quien no tiene plan (pasan por la cuenta de la empresa)", () => {
  const people = [person("marcela", "Marcela", 887.5, 63.9, { tips: 20 })];
  const table = buildPaymentTable({ people, plans: new Map(), partners: [] });
  assert.equal(table.rows[0].bonus, 83.9);
});

test("Pagos Experimental: las propinas también suman al excedente en efectivo de quien tiene plan", () => {
  const table = septemberTable({
    people: [...septemberPeople().filter((p) => p.employeeId !== "gael"), person("gael", "Gael", 2260.42, 182.55, { tips: 50 })],
  });
  const javi = table.rows.find((r) => r.partnerId === "p-javi");
  const jhony = table.rows.find((r) => r.partnerId === "p-jhony");
  // Excedente sin propina: 1042.97 (ver test de arriba). Con +50 de propina: 1092.97 x 22/25 = 961.81 → 480.91/480.90.
  assert.equal(javi.via.gael, 480.91);
  assert.equal(jhony.via.gael, 480.9);
});

test("Pagos Experimental: un plan sin tope bruto no genera efectivo", () => {
  const table = septemberTable({
    plans: new Map([["gael", { officialNet: 1200, officialGross: null, bonusCol: null, cashRateFactor: 1, viaPartnerIds: ["p-javi"] }]]),
  });
  assert.deepEqual(table.rows.find((r) => r.partnerId === "p-javi").via, {});
});

test("Pagos Experimental: un accionista inexistente o que se paga a sí mismo se avisa, no rompe", () => {
  const unknown = septemberTable({
    plans: new Map([["gael", { officialNet: 1200, officialGross: 1400, bonusCol: null, cashRateFactor: 1, viaPartnerIds: ["fantasma"] }]]),
  });
  assert.ok(unknown.warnings.some((w) => w.includes("fantasma")));

  const self = septemberTable({
    plans: new Map([["javier", { officialNet: null, officialGross: 0, bonusCol: null, cashRateFactor: 1, viaPartnerIds: ["p-javi"] }]]),
  });
  assert.ok(self.warnings.some((w) => w.includes("sí mismo")));
});

test("Pagos Experimental: no lista a quien no cobra nada ni participa de un plan", () => {
  const people = [...septemberPeople(), person("test", "Joaquín (test)", 0, 0)];
  const table = septemberTable({ people });
  assert.equal(table.rows.some((r) => r.employeeId === "test"), false);
});

test("equipos por día: agrupa por fecha y empleado; ignora filas incompletas", () => {
  const map = buildTeamsByDay([
    { date: "2026-09-14", team_id: "team_1", employee_id: "nohely" },
    { date: "2026-09-14", team_id: "team_1", employee_id: "gael" },
    { date: "2026-09-14", team_id: "team_2", employee_id: "javi" },
    { date: "2026-09-15", team_id: "team_2", employee_id: "nohely" },
    { date: "2026-09-15", team_id: null, employee_id: "gael" },
  ]);
  assert.deepEqual(map, {
    "2026-09-14": { nohely: "team_1", gael: "team_1", javi: "team_2" },
    "2026-09-15": { nohely: "team_2" },
  });
  assert.deepEqual(buildTeamsByDay(null), {});
});

test("clientes nuevos: solo los que no tienen servicios anteriores; toma la fecha más temprana; omite placeholder y ya cargados", () => {
  const inPeriod = [
    { client_id: "nuevo", scheduled_date: "2026-09-14" },
    { client_id: "nuevo", scheduled_date: "2026-09-10" },
    { client_id: "viejo", scheduled_date: "2026-09-05" },
    { client_id: "cargado", scheduled_date: "2026-09-03" },
    { client_id: "00000000-0000-0000-0000-000000000001", scheduled_date: "2026-09-02" },
    { client_id: null, scheduled_date: "2026-09-02" },
  ];
  const picked = pickNewClients({
    inPeriod,
    priorClientIds: new Set(["viejo"]),
    excluded: new Set(["cargado"]),
  });
  assert.deepEqual(picked, [{ clientId: "nuevo", firstServiceDate: "2026-09-10" }]);
});

test("clientes nuevos: la frecuencia del cliente se normaliza a las opciones de la tarjeta", () => {
  assert.equal(normalizeFrequency("one-time"), "One-time");
  assert.equal(normalizeFrequency(" Bi-weekly "), "Bi-weekly");
  assert.equal(normalizeFrequency("cada tanto"), null);
  assert.equal(normalizeFrequency(null), null);
});
