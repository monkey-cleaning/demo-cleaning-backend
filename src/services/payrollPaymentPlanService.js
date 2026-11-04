// services/payrollPaymentPlanService.js
// Payroll — la tabla "Pagos Experimental" de la planilla manual (SEP_Q1.xlsx,
// L30:U39): CÓMO se le paga a cada persona en la quincena.
//
// Lógica reconstruida de las fórmulas de la planilla (2026-09-23), ajustada
// con lo que aclaró el usuario el 2026-09-24:
//   * Javier y Jhony son los ACCIONISTAS (ver payrollPartnersService.js). Javi
//     además es un cleaner; Jhony no — de Jhony solo son los dividendos.
//   * Parte de lo que gana un cleaner se paga por la nómina OFICIAL
//     (QuickBooks): columna "Real" = neto de esa nómina. Hay un tope BRUTO de
//     lo que se declara por nómina (1400 para Gael, 1256 para Nohely en Sep
//     Q1: `-1400`, `-1256` en las fórmulas).
//   * Lo que gana POR ENCIMA de ese tope (ganado + traslado + bonos −
//     deducciones − tope) es el "excedente": se le paga en efectivo a través
//     de los accionistas, que se lo reparten en partes iguales (`/2`), y a una
//     tarifa ajustada (`/22*19` para Nohely, `/25*22` para Gael = factor
//     19/22 y 22/25). Cada uno lo ve en su fila, columna "A Nohely" / "A Gael".
//   * Cada accionista además cobra lo propio ("A Javi" / "A Jhony"): sus
//     dividendos + extras (ej. el parking fijo de 45 de Javi) y, si es cleaner,
//     lo que ganó (ganado + traslado − deducciones).
//   * Columna "Bono" = lo que se paga fuera de la nómina oficial: traslado +
//     bonos (para Gael y Nohely la planilla lo pisa con 200 fijo).
//   * "Total sin Bono" = Real + lo que se cobra a través de otros + lo propio.
//
// PENDIENTE de confirmar con Jhony (el usuario lo va a consultar): de dónde
// salen los topes y los factores 19/22 y 22/25 (son decisiones de la planilla,
// el usuario no tiene el porqué), y cómo Jhony le paga a Yu (admin), al equipo
// de programación y a Edilsa según el NET PAY — hoy nada de eso está modelado.
//
// Todos esos números cambian de una quincena a otra, así que son PARÁMETROS
// editables por cleaner y quincena (`payroll_payment_plans`), no constantes.
import { supabase } from "../supabaseClient.js";
import { periodIndex } from "./payrollExpensesService.js";
import { splitAmountEqually, TIPS_IN_NET_PAY } from "./payrollAdjustmentsService.js";

const round2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;

const isMissingTable = (error) => error?.code === "PGRST205";
const isMissingColumn = (error) =>
  error?.code === "42703" || /column .* does not exist/i.test(error?.message ?? "");

// ── Puras ────────────────────────────────────────────────────────────────

// Excedente en efectivo de un cleaner con plan: lo que gana por encima del
// tope bruto de la nómina oficial, ajustado por el factor de tarifa.
export function computeCashExcess({ earnedTotal, officialGross, cashRateFactor }) {
  const excess = round2(Math.max(0, earnedTotal - officialGross));
  return { excess, cash: round2(excess * cashRateFactor) };
}

// people:   [{ employeeId, name, workMoney, travelMoney, workHours, travelHours,
//              bonuses, tips, deductions, extraMoney? }]
//           `extraMoney` = horas extra + pago de feriados (payrollLaborRulesService):
//           plata ganada por encima del pago normal; entra al excedente de un plan,
//           a "A <él>" de un accionista-cleaner y al "Bono" del resto.
// plans:    Map employeeId → { officialNet, officialGross, bonusCol,
//                              cashRateFactor, viaPartnerIds, note }
// partners: [{ id, name, employeeId|null }]
// dividendsByPartner / extrasByPartner: Map partnerId → total
export function buildPaymentTable({
  people,
  plans,
  partners = [],
  dividendsByPartner = new Map(),
  extrasByPartner = new Map(),
}) {
  const byId = new Map(people.map((p) => [p.employeeId, p]));
  const partnerById = new Map(partners.map((p) => [p.id, p]));
  const partnerByEmployee = new Map(
    partners.filter((p) => p.employeeId).map((p) => [p.employeeId, p]),
  );
  const warnings = [];
  const tipsPart = (p) => (TIPS_IN_NET_PAY ? p.tips : 0);

  // 1) Reparto del excedente de cada cleaner con plan de efectivo.
  // viaAmounts: accionista → (cleaner beneficiario → monto)
  const viaAmounts = new Map();
  const routed = []; // detalle por beneficiario (lo que ve la UI para editar)
  for (const [employeeId, plan] of plans) {
    const person = byId.get(employeeId);
    if (!person) {
      warnings.push(`El plan de ${employeeId} no corresponde a un cleaner de esta quincena.`);
      continue;
    }
    // Las propinas suman acá también (mismo TIPS_IN_NET_PAY que el NET PAY):
    // si el cleaner tiene plan, lo que gana por arriba del tope se paga en
    // efectivo, y una propina es plata que también hay que pagarle.
    const earnedTotal = round2(
      person.workMoney +
        person.travelMoney +
        (person.extraMoney ?? 0) +
        person.bonuses +
        tipsPart(person) -
        person.deductions,
    );
    const via = (plan.viaPartnerIds ?? []).filter((partnerId) => {
      const partner = partnerById.get(partnerId);
      if (!partner) {
        warnings.push(`El accionista ${partnerId} de ${person.name} no existe o está dado de baja.`);
        return false;
      }
      if (partner.employeeId === employeeId) {
        warnings.push(`${person.name} no puede cobrar a través de sí mismo.`);
        return false;
      }
      return true;
    });
    if (plan.officialGross == null || !via.length) {
      routed.push({ employeeId, name: person.name, earnedTotal, excess: 0, cash: 0, viaPartnerIds: via });
      continue;
    }
    const { excess, cash } = computeCashExcess({
      earnedTotal,
      officialGross: plan.officialGross,
      cashRateFactor: plan.cashRateFactor ?? 1,
    });
    const shares = splitAmountEqually(cash, via.length);
    via.forEach((partnerId, i) => {
      if (!viaAmounts.has(partnerId)) viaAmounts.set(partnerId, new Map());
      viaAmounts.get(partnerId).set(employeeId, shares[i]);
    });
    routed.push({ employeeId, name: person.name, earnedTotal, excess, cash, viaPartnerIds: via });
  }

  // 2) Una fila por persona. Un accionista que también es cleaner (Javi) se
  // muestra en SU fila de cleaner; el que no lo es (Jhony) tiene una fila propia.
  const viaFor = (partner) => {
    const via = {};
    let total = 0;
    for (const [beneficiaryId, amount] of viaAmounts.get(partner?.id) ?? []) {
      via[beneficiaryId] = amount;
      total = round2(total + amount);
    }
    return { via, total };
  };
  const partnerOwn = (partner) =>
    round2((dividendsByPartner.get(partner.id) ?? 0) + (extrasByPartner.get(partner.id) ?? 0));

  const employeeRows = people.map((p) => {
    const plan = plans.get(p.employeeId) ?? null;
    const partner = partnerByEmployee.get(p.employeeId) ?? null;

    // Accionista-cleaner: todo lo suyo va en "A <él mismo>" (ganado + traslado −
    // deducciones + dividendos + extras), como Javi en la planilla. El resto
    // cobra por nómina (Real = ganado − deducciones) y su traslado va en "Bono".
    const real = partner ? 0 : plan?.officialNet ?? round2(p.workMoney - p.deductions);
    const own = partner
      ? round2(p.workMoney + p.travelMoney + (p.extraMoney ?? 0) - p.deductions + partnerOwn(partner))
      : 0;
    const bonus = partner
      ? round2(p.bonuses + tipsPart(p))
      : plan?.bonusCol ?? round2(p.travelMoney + (p.extraMoney ?? 0) + p.bonuses + tipsPart(p));
    const { via, total: viaTotal } = viaFor(partner);
    const totalWithoutBonus = round2(real + own + viaTotal);
    return {
      key: `e:${p.employeeId}`,
      employeeId: p.employeeId,
      partnerId: partner?.id ?? null,
      name: p.name,
      isPartner: Boolean(partner),
      real: round2(real),
      via,
      own,
      bonus,
      totalWithoutBonus,
      total: round2(totalWithoutBonus + bonus),
      workHours: p.workHours,
      travelHours: p.travelHours,
    };
  });

  const linkedPartnerIds = new Set(employeeRows.map((r) => r.partnerId).filter(Boolean));
  const partnerOnlyRows = partners
    .filter((partner) => !linkedPartnerIds.has(partner.id))
    .map((partner) => {
      const { via, total: viaTotal } = viaFor(partner);
      const own = partnerOwn(partner);
      const totalWithoutBonus = round2(own + viaTotal);
      return {
        key: `p:${partner.id}`,
        employeeId: null,
        partnerId: partner.id,
        name: partner.name,
        isPartner: true,
        real: 0,
        via,
        own,
        bonus: 0,
        totalWithoutBonus,
        total: totalWithoutBonus,
        workHours: 0,
        travelHours: 0,
      };
    });

  // Sin las que no cobran nada ni participan de un plan — la planilla solo
  // lista a quien cobra.
  const rows = [
    ...employeeRows.filter((r) => r.total !== 0 || r.isPartner || plans.has(r.employeeId)),
    ...partnerOnlyRows,
  ];

  // 3) Totales por columna.
  const beneficiaries = routed
    .filter((r) => r.cash > 0 || r.viaPartnerIds.length)
    .map((r) => ({ employeeId: r.employeeId, name: r.name }));
  const sum = (pick) => round2(rows.reduce((s, r) => s + pick(r), 0));
  const totals = {
    real: sum((r) => r.real),
    own: sum((r) => r.own),
    bonus: sum((r) => r.bonus),
    totalWithoutBonus: sum((r) => r.totalWithoutBonus),
    total: sum((r) => r.total),
    via: Object.fromEntries(
      beneficiaries.map((b) => [b.employeeId, sum((r) => r.via[b.employeeId] ?? 0)]),
    ),
  };

  return { beneficiaries, rows, totals, routed, warnings };
}

// ── Planes (DB) ──────────────────────────────────────────────────────────

const PLAN_COLS =
  "employee_id, official_net, official_gross, bonus_col, cash_rate_factor, via_partner_ids, note, updated_by, updated_at";

const numOrNull = (v) => (v == null ? null : Number(v));

function mapPlan(row) {
  return {
    employeeId: row.employee_id,
    officialNet: numOrNull(row.official_net),
    officialGross: numOrNull(row.official_gross),
    bonusCol: numOrNull(row.bonus_col),
    cashRateFactor: row.cash_rate_factor != null ? Number(row.cash_rate_factor) : 1,
    viaPartnerIds: row.via_partner_ids ?? [],
    note: row.note ?? null,
    updatedBy: row.updated_by ?? null,
    updatedAt: row.updated_at,
  };
}

// Map employeeId → plan. Degrada con gracia si la migración no corrió.
export async function listPaymentPlans({ year, month, half }) {
  const byEmployee = new Map();
  const { data, error } = await supabase
    .from("payroll_payment_plans")
    .select(PLAN_COLS)
    .eq("year", year)
    .eq("month", month)
    .eq("half", half);
  if (error) {
    if (isMissingTable(error) || isMissingColumn(error)) {
      console.warn(
        "⚠️ [payrollPaymentPlanService] payroll_payment_plans (o via_partner_ids) no existe " +
          "todavía (faltan las migraciones 20260923 y 20260924) — sigo sin planes.",
      );
      return byEmployee;
    }
    throw new Error(`payroll payment plans: ${error.message}`);
  }
  for (const row of data ?? []) byEmployee.set(row.employee_id, mapPlan(row));
  return byEmployee;
}

export async function upsertPaymentPlan({
  year,
  month,
  half,
  employeeId,
  officialNet,
  officialGross,
  bonusCol,
  cashRateFactor,
  viaPartnerIds,
  note,
  updatedBy,
}) {
  const { data, error } = await supabase
    .from("payroll_payment_plans")
    .upsert(
      {
        year,
        month,
        half,
        employee_id: employeeId,
        official_net: officialNet,
        official_gross: officialGross,
        bonus_col: bonusCol,
        cash_rate_factor: cashRateFactor,
        via_partner_ids: viaPartnerIds,
        note: note ?? null,
        updated_by: updatedBy ?? null,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "year,month,half,employee_id" },
    )
    .select(PLAN_COLS)
    .single();
  if (error) throw new Error(`payroll payment plan upsert: ${error.message}`);
  return mapPlan(data);
}

export async function deletePaymentPlan({ year, month, half, employeeId }) {
  const { error } = await supabase
    .from("payroll_payment_plans")
    .delete()
    .eq("year", year)
    .eq("month", month)
    .eq("half", half)
    .eq("employee_id", employeeId);
  if (error) throw new Error(`payroll payment plan delete: ${error.message}`);
}

// Los parámetros casi no cambian de una quincena a otra (Gael y Nohely
// cobran "Real" 1200 en varias seguidas) — este atajo copia los de la
// quincena anterior a la actual, solo si la actual todavía no tiene ninguno.
export async function copyPreviousPaymentPlans({ year, month, half, updatedBy }) {
  const current = await listPaymentPlans({ year, month, half });
  if (current.size) return { copied: 0, skipped: true };

  const prevIdx = periodIndex({ year, month, half }) - 1;
  const prev = {
    year: Math.floor(prevIdx / 24),
    month: Math.floor((prevIdx % 24) / 2) + 1,
    half: (prevIdx % 2) + 1,
  };
  const previous = await listPaymentPlans(prev);
  if (!previous.size) return { copied: 0, skipped: false };

  const rows = [...previous.values()].map((p) => ({
    year,
    month,
    half,
    employee_id: p.employeeId,
    official_net: p.officialNet,
    official_gross: p.officialGross,
    bonus_col: p.bonusCol,
    cash_rate_factor: p.cashRateFactor,
    via_partner_ids: p.viaPartnerIds,
    note: p.note,
    updated_by: updatedBy ?? null,
    updated_at: new Date().toISOString(),
  }));
  const { error } = await supabase.from("payroll_payment_plans").insert(rows);
  if (error) throw new Error(`payroll payment plans copy: ${error.message}`);
  return { copied: rows.length, skipped: false };
}
