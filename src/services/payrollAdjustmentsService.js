// services/payrollAdjustmentsService.js
// Payroll estilo Excel — todo lo que ajusta lo que cobra cada cleaner en una
// quincena, además de los dividendos:
//   * Dividendos (2026-09-18): plata que sale hacia los accionistas DESPUÉS de
//     la ganancia neta. No la baja. Desde 2026-09-24 llevan el ACCIONISTA
//     (Javi / Jhony, ver payrollPartnersService.js) al que le corresponden.
//   * Deducciones (2026-09-18): adelantos de sueldo a un cleaner. El costo ya
//     está en su nómina; acá solo se descuentan de lo que se le paga.
//   * Bonos (2026-09-23): un monto POR cleaner, para todos o para algunos. Sí
//     son un costo — entran en `cleanerPayroll` del P&L.
//   * Propinas (2026-09-23): registro de lo que dejó un cliente y a qué
//     cleaners les corresponde (partes iguales). Confirmado con Jhony
//     (2026-09-29): pasan por la cuenta de la empresa — el cliente manda un
//     extra en la transferencia — así que SÍ hay que pagárselas al cleaner:
//     entran en el NET PAY (ver TIPS_IN_NET_PAY). Siguen sin ser ingreso ni
//     costo del P&L (no hay forma de saber cuánto de lo cobrado es propina sin
//     que el admin lo cargue a mano, y el P&L ya cuenta el monto facturado).
//   * NET PAY (2026-09-23): "A Pagar" de cada cleaner = ganado + bonos −
//     deducciones, con un override manual por cleaner y quincena.
// Admin-only en toda la cadena (controller/rutas), como los gastos.
import { supabase } from "../supabaseClient.js";

const round2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;

const isMissingTable = (error) => error?.code === "PGRST205";
// Migración sin correr: PostgREST devuelve 42703 si el select nombra una
// columna que no existe, o PGRST200 si el embed (`employees(name)`) depende de
// una FK que todavía no existe.
const isMissingColumn = (error) =>
  error?.code === "42703" ||
  error?.code === "PGRST200" ||
  /column .* does not exist/i.test(error?.message ?? "");

function warnMissing(table, migration = "20260923_payroll_closing.sql") {
  console.warn(
    `⚠️ [payrollAdjustmentsService] ${table} no existe todavía ` +
      `(falta correr la migración ${migration}) — sigo sin datos.`,
  );
}

// ── Puras ────────────────────────────────────────────────────────────────

// Total de deducciones por empleado.
export function sumDeductionsByEmployee(deductions) {
  const byEmployee = new Map();
  for (const d of deductions) {
    byEmployee.set(d.employeeId, round2((byEmployee.get(d.employeeId) ?? 0) + d.amount));
  }
  return byEmployee;
}

// Reparte `amount` en `n` partes iguales sin perder centavos: el resto de la
// división (en centavos) se lo lleva de a 1 centavo a las primeras partes,
// así la suma de las partes es SIEMPRE exactamente `amount`.
export function splitAmountEqually(amount, n) {
  if (!n || n < 1) return [];
  const totalCents = Math.round(amount * 100);
  const base = Math.floor(totalCents / n);
  const remainder = totalCents - base * n;
  return Array.from({ length: n }, (_, i) => (base + (i < remainder ? 1 : 0)) / 100);
}

// Bonos → total por empleado. El monto es POR cleaner; `applies_to_all`
// se resuelve contra `allEmployeeIds` (los cleaners de la quincena).
export function sumBonusesByEmployee(bonuses, allEmployeeIds) {
  const byEmployee = new Map();
  for (const b of bonuses) {
    const targets = b.appliesToAll ? allEmployeeIds : b.recipients.map((r) => r.employeeId);
    for (const employeeId of targets) {
      byEmployee.set(employeeId, round2((byEmployee.get(employeeId) ?? 0) + b.amount));
    }
  }
  return byEmployee;
}

// Propinas → total por empleado (partes iguales entre destinatarios). Las
// propinas sin destinatarios no le suman a nadie: `unassignedTotal` avisa
// cuánto quedó sin asignar.
export function sumTipsByEmployee(tips) {
  const byEmployee = new Map();
  let unassignedTotal = 0;
  for (const t of tips) {
    if (!t.recipients.length) {
      unassignedTotal = round2(unassignedTotal + t.amount);
      continue;
    }
    const shares = splitAmountEqually(t.amount, t.recipients.length);
    t.recipients.forEach((r, i) => {
      byEmployee.set(r.employeeId, round2((byEmployee.get(r.employeeId) ?? 0) + shares[i]));
    });
  }
  return { byEmployee, unassignedTotal };
}

// Las propinas suman al NET PAY: pasan por la cuenta de la empresa (el
// cliente manda un extra en la transferencia), así que hay que pagárselas al
// cleaner — confirmado con Jhony 2026-09-29.
export const TIPS_IN_NET_PAY = true;

// NET PAY de un cleaner: lo calculado es el valor por defecto; un override
// manual del admin lo pisa.
export function computeNetPay({ earned, bonuses, tips, deductions, override }) {
  const calculated = round2(earned + bonuses + (TIPS_IN_NET_PAY ? tips : 0) - deductions);
  const overridden = override != null;
  return {
    calculated,
    applied: overridden ? round2(override.amount) : calculated,
    overridden,
  };
}

// Pago extra de un cleaner (horas extra + feriados) para mostrarlo aparte en
// NET PAY. Es informativo: ya está dentro de `totalMoney`. Los feriados que no
// suman nada (no calificó) no se listan.
function extraPayOf(r) {
  return {
    overtimeMoney: r.overtimeMoney ?? 0,
    overtimeHours15: r.overtimeHours15 ?? 0,
    overtimeHours2: r.overtimeHours2 ?? 0,
    holidayMoney: r.holidayMoney ?? 0,
    holidays: (r.holidayDays ?? [])
      .filter((h) => h.amount > 0)
      .map((h) => ({ name: h.name, worked: h.worked, amount: h.amount })),
  };
}

// Arma las filas de la tabla NET PAY. `rows` = cleaners de la quincena (con su
// `totalMoney` ganado); `extraPayees` = empleados que NO están en `rows`
// (típicamente inactivos, como Clara) pero tienen algún ajuste ese período —
// si no, su bono/deducción/propina quedaría afuera del total.
//
// `directAmountByEmployee` (2026-10-01) — un cleaner con plan de pago en
// efectivo (payrollPaymentPlanService.buildPaymentTable) ya cobra parte de lo
// suyo A TRAVÉS de los accionistas (el "excedente" sobre el tope bruto, ver
// Pagos Experimental). Sin esto, NET PAY mostraba el ganado COMPLETO como "a
// pagar" — doble pago real si alguien usa NET PAY para pagarle directo Y el
// excedente ya se le dio en efectivo por Pagos Experimental. Cuando este mapa
// trae un valor para el empleado, reemplaza `totalMoney` como base de
// "earned" (solo la parte directa: Real + Bono del plan).
export function buildNetPayRows({
  rows,
  extraPayees = [],
  deductionsByEmployee,
  bonusesByEmployee,
  tipsByEmployee,
  overrides,
  directAmountByEmployee = new Map(),
}) {
  const people = [
    ...rows.map((r) => ({
      employeeId: r.employeeId,
      name: r.name,
      earned: directAmountByEmployee.get(r.employeeId) ?? (r.totalMoney ?? 0),
      workHours: r.workHours ?? 0,
      travelHours: r.travelHours ?? 0,
      // Con plan de pago, `earned` es solo la parte directa: el extra va por
      // los accionistas (Pagos Experimental) y no está en este monto.
      extra: { ...extraPayOf(r), extraIncluded: !directAmountByEmployee.has(r.employeeId) },
      active: true,
    })),
    ...extraPayees.map((p) => ({
      employeeId: p.employeeId,
      name: p.name,
      earned: 0,
      workHours: 0,
      travelHours: 0,
      extra: { ...extraPayOf({}), extraIncluded: true },
      active: false,
    })),
  ];
  return people.map((p) => {
    const bonuses = bonusesByEmployee.get(p.employeeId) ?? 0;
    const tips = tipsByEmployee.get(p.employeeId) ?? 0;
    const deductions = deductionsByEmployee.get(p.employeeId) ?? 0;
    const override = overrides.get(p.employeeId) ?? null;
    const { calculated, applied, overridden } = computeNetPay({
      earned: p.earned,
      bonuses,
      tips,
      deductions,
      override,
    });
    return {
      employeeId: p.employeeId,
      name: p.name,
      active: p.active,
      workHours: p.workHours,
      travelHours: p.travelHours,
      ...p.extra,
      earned: p.earned,
      bonuses,
      tips,
      deductions,
      calculated,
      applied,
      overridden,
      note: override?.note ?? null,
      updatedBy: override?.updatedBy ?? null,
      updatedAt: override?.updatedAt ?? null,
    };
  });
}

// ── Mapeo de filas ───────────────────────────────────────────────────────

function mapDividend(row) {
  return {
    id: row.id,
    concept: row.concept,
    amount: Number(row.amount),
    partnerId: row.partner_id ?? null,
    partnerName: row.payroll_partners?.name ?? null,
    createdBy: row.created_by,
    createdAt: row.created_at,
  };
}

function mapDeduction(row) {
  return {
    id: row.id,
    employeeId: row.employee_id,
    employeeName: row.employees?.name ?? null,
    concept: row.concept,
    amount: Number(row.amount),
    createdBy: row.created_by,
    createdAt: row.created_at,
  };
}

const mapRecipients = (rows) =>
  (rows ?? []).map((r) => ({ employeeId: r.employee_id, name: r.employees?.name ?? null }));

function mapBonus(row) {
  return {
    id: row.id,
    concept: row.concept,
    amount: Number(row.amount),
    appliesToAll: Boolean(row.applies_to_all),
    recipients: mapRecipients(row.payroll_bonus_recipients),
    createdBy: row.created_by,
    createdAt: row.created_at,
  };
}

function mapTip(row) {
  return {
    id: row.id,
    clientName: row.client_name,
    clientId: row.client_id ?? null,
    amount: Number(row.amount),
    note: row.note ?? null,
    recipients: mapRecipients(row.payroll_tip_recipients),
    createdBy: row.created_by,
    createdAt: row.created_at,
  };
}

// ── Dividendos ───────────────────────────────────────────────────────────
const DIVIDEND_COLS = "id, concept, amount, partner_id, created_by, created_at, payroll_partners(name)";
const DIVIDEND_COLS_LEGACY = "id, concept, amount, created_by, created_at";

export async function listDividends({ year, month, half }) {
  const run = (cols) =>
    supabase
      .from("payroll_dividends")
      .select(cols)
      .eq("year", year)
      .eq("month", month)
      .eq("half", half)
      .order("created_at", { ascending: true });

  let { data, error } = await run(DIVIDEND_COLS);
  // Migración 20260924 sin correr: partner_id / payroll_partners todavía no existen.
  if (error && isMissingColumn(error)) ({ data, error } = await run(DIVIDEND_COLS_LEGACY));
  if (error) {
    if (isMissingTable(error)) {
      warnMissing("payroll_dividends", "20260918_payroll_finance_v2.sql");
      return { dividends: [], total: 0 };
    }
    throw new Error(`payroll dividends: ${error.message}`);
  }
  const dividends = (data ?? []).map(mapDividend);
  return { dividends, total: round2(dividends.reduce((s, d) => s + d.amount, 0)) };
}

export async function createDividend({ year, month, half, concept, amount, partnerId, createdBy }) {
  const { data, error } = await supabase
    .from("payroll_dividends")
    .insert({
      year,
      month,
      half,
      concept,
      amount,
      partner_id: partnerId ?? null,
      created_by: createdBy ?? null,
    })
    .select(DIVIDEND_COLS)
    .single();
  if (error) throw new Error(`payroll dividends create: ${error.message}`);
  return mapDividend(data);
}

export async function updateDividend({ id, concept, amount, partnerId }) {
  const patch = {};
  if (concept !== undefined) patch.concept = concept;
  if (amount !== undefined) patch.amount = amount;
  if (partnerId !== undefined) patch.partner_id = partnerId;
  const { data, error } = await supabase
    .from("payroll_dividends")
    .update(patch)
    .eq("id", id)
    .select(DIVIDEND_COLS)
    .single();
  if (error) throw new Error(`payroll dividends update: ${error.message}`);
  return mapDividend(data);
}

export async function deleteDividend(id) {
  const { error } = await supabase.from("payroll_dividends").delete().eq("id", id);
  if (error) throw new Error(`payroll dividends delete: ${error.message}`);
}

// ── Deducciones ──────────────────────────────────────────────────────────
export async function listDeductions({ year, month, half }) {
  const { data, error } = await supabase
    .from("payroll_deductions")
    .select("id, employee_id, concept, amount, created_by, created_at, employees(name)")
    .eq("year", year)
    .eq("month", month)
    .eq("half", half)
    .order("created_at", { ascending: true });
  if (error) {
    if (isMissingTable(error)) {
      warnMissing("payroll_deductions", "20260918_payroll_finance_v2.sql");
      return { deductions: [], total: 0 };
    }
    throw new Error(`payroll deductions: ${error.message}`);
  }
  const deductions = (data ?? []).map(mapDeduction);
  return { deductions, total: round2(deductions.reduce((s, d) => s + d.amount, 0)) };
}

export async function createDeduction({
  year,
  month,
  half,
  employeeId,
  concept,
  amount,
  createdBy,
}) {
  const { data, error } = await supabase
    .from("payroll_deductions")
    .insert({
      year,
      month,
      half,
      employee_id: employeeId,
      concept,
      amount,
      created_by: createdBy ?? null,
    })
    .select("id, employee_id, concept, amount, created_by, created_at, employees(name)")
    .single();
  if (error) throw new Error(`payroll deductions create: ${error.message}`);
  return mapDeduction(data);
}

export async function updateDeduction({ id, employeeId, concept, amount }) {
  const patch = {};
  if (employeeId !== undefined) patch.employee_id = employeeId;
  if (concept !== undefined) patch.concept = concept;
  if (amount !== undefined) patch.amount = amount;
  const { data, error } = await supabase
    .from("payroll_deductions")
    .update(patch)
    .eq("id", id)
    .select("id, employee_id, concept, amount, created_by, created_at, employees(name)")
    .single();
  if (error) throw new Error(`payroll deductions update: ${error.message}`);
  return mapDeduction(data);
}

export async function deleteDeduction(id) {
  const { error } = await supabase.from("payroll_deductions").delete().eq("id", id);
  if (error) throw new Error(`payroll deductions delete: ${error.message}`);
}

// ── Bonos ────────────────────────────────────────────────────────────────
const BONUS_COLS =
  "id, concept, amount, applies_to_all, created_by, created_at, payroll_bonus_recipients(employee_id, employees(name))";

export async function listBonuses({ year, month, half }) {
  const { data, error } = await supabase
    .from("payroll_bonuses")
    .select(BONUS_COLS)
    .eq("year", year)
    .eq("month", month)
    .eq("half", half)
    .order("created_at", { ascending: true });
  if (error) {
    if (isMissingTable(error)) {
      warnMissing("payroll_bonuses");
      return { bonuses: [] };
    }
    throw new Error(`payroll bonuses: ${error.message}`);
  }
  return { bonuses: (data ?? []).map(mapBonus) };
}

async function replaceRecipients(table, idColumn, id, employeeIds) {
  const { error: delErr } = await supabase.from(table).delete().eq(idColumn, id);
  if (delErr) throw new Error(`${table} reset: ${delErr.message}`);
  if (!employeeIds.length) return;
  const { error } = await supabase
    .from(table)
    .insert(employeeIds.map((employeeId) => ({ [idColumn]: id, employee_id: employeeId })));
  if (error) throw new Error(`${table} insert: ${error.message}`);
}

async function fetchBonus(id) {
  const { data, error } = await supabase.from("payroll_bonuses").select(BONUS_COLS).eq("id", id).single();
  if (error) throw new Error(`payroll bonuses fetch: ${error.message}`);
  return mapBonus(data);
}

export async function createBonus({
  year,
  month,
  half,
  concept,
  amount,
  appliesToAll,
  employeeIds,
  createdBy,
}) {
  const { data, error } = await supabase
    .from("payroll_bonuses")
    .insert({
      year,
      month,
      half,
      concept,
      amount,
      applies_to_all: appliesToAll,
      created_by: createdBy ?? null,
    })
    .select("id")
    .single();
  if (error) throw new Error(`payroll bonuses create: ${error.message}`);
  try {
    if (!appliesToAll) await replaceRecipients("payroll_bonus_recipients", "bonus_id", data.id, employeeIds);
  } catch (e) {
    // Sin destinatarios el bono queda huérfano — mejor no dejarlo a medias.
    await supabase.from("payroll_bonuses").delete().eq("id", data.id);
    throw e;
  }
  return fetchBonus(data.id);
}

export async function updateBonus({ id, concept, amount, appliesToAll, employeeIds }) {
  const patch = {};
  if (concept !== undefined) patch.concept = concept;
  if (amount !== undefined) patch.amount = amount;
  if (appliesToAll !== undefined) patch.applies_to_all = appliesToAll;
  if (Object.keys(patch).length) {
    const { error } = await supabase.from("payroll_bonuses").update(patch).eq("id", id);
    if (error) throw new Error(`payroll bonuses update: ${error.message}`);
  }
  if (appliesToAll === true) {
    await replaceRecipients("payroll_bonus_recipients", "bonus_id", id, []);
  } else if (employeeIds !== undefined) {
    await replaceRecipients("payroll_bonus_recipients", "bonus_id", id, employeeIds);
  }
  return fetchBonus(id);
}

export async function deleteBonus(id) {
  const { error } = await supabase.from("payroll_bonuses").delete().eq("id", id);
  if (error) throw new Error(`payroll bonuses delete: ${error.message}`);
}

// ── Propinas ─────────────────────────────────────────────────────────────
const TIP_COLS =
  "id, client_name, client_id, amount, note, created_by, created_at, payroll_tip_recipients(employee_id, employees(name))";

export async function listTips({ year, month, half }) {
  const { data, error } = await supabase
    .from("payroll_tips")
    .select(TIP_COLS)
    .eq("year", year)
    .eq("month", month)
    .eq("half", half)
    .order("created_at", { ascending: true });
  if (error) {
    if (isMissingTable(error)) {
      warnMissing("payroll_tips");
      return { tips: [], total: 0 };
    }
    throw new Error(`payroll tips: ${error.message}`);
  }
  const tips = (data ?? []).map(mapTip);
  return { tips, total: round2(tips.reduce((s, t) => s + t.amount, 0)) };
}

async function fetchTip(id) {
  const { data, error } = await supabase.from("payroll_tips").select(TIP_COLS).eq("id", id).single();
  if (error) throw new Error(`payroll tips fetch: ${error.message}`);
  return mapTip(data);
}

export async function createTip({
  year,
  month,
  half,
  clientName,
  clientId,
  amount,
  note,
  employeeIds,
  createdBy,
}) {
  const { data, error } = await supabase
    .from("payroll_tips")
    .insert({
      year,
      month,
      half,
      client_name: clientName,
      client_id: clientId ?? null,
      amount,
      note: note ?? null,
      created_by: createdBy ?? null,
    })
    .select("id")
    .single();
  if (error) throw new Error(`payroll tips create: ${error.message}`);
  try {
    await replaceRecipients("payroll_tip_recipients", "tip_id", data.id, employeeIds);
  } catch (e) {
    await supabase.from("payroll_tips").delete().eq("id", data.id);
    throw e;
  }
  return fetchTip(data.id);
}

export async function updateTip({ id, clientName, clientId, amount, note, employeeIds }) {
  const patch = {};
  if (clientName !== undefined) patch.client_name = clientName;
  if (clientId !== undefined) patch.client_id = clientId;
  if (amount !== undefined) patch.amount = amount;
  if (note !== undefined) patch.note = note;
  if (Object.keys(patch).length) {
    const { error } = await supabase.from("payroll_tips").update(patch).eq("id", id);
    if (error) throw new Error(`payroll tips update: ${error.message}`);
  }
  if (employeeIds !== undefined) {
    await replaceRecipients("payroll_tip_recipients", "tip_id", id, employeeIds);
  }
  return fetchTip(id);
}

// Las propinas se asocian a un cliente REAL del CRM (no texto libre).
export async function clientExists(id) {
  const { data, error } = await supabase.from("clients").select("id").eq("id", id).maybeSingle();
  if (error) throw new Error(`payroll tips client lookup: ${error.message}`);
  return Boolean(data);
}

export async function deleteTip(id) {
  const { error } = await supabase.from("payroll_tips").delete().eq("id", id);
  if (error) throw new Error(`payroll tips delete: ${error.message}`);
}

// ── NET PAY (override manual de "A Pagar") ───────────────────────────────
// Map employeeId → { amount, calculated, note, updatedBy, updatedAt }.
export async function listNetPayOverrides({ year, month, half }) {
  const byEmployee = new Map();
  const { data, error } = await supabase
    .from("payroll_net_pay_overrides")
    .select("employee_id, amount, calculated, note, updated_by, updated_at")
    .eq("year", year)
    .eq("month", month)
    .eq("half", half);
  if (error) {
    if (isMissingTable(error)) {
      warnMissing("payroll_net_pay_overrides");
      return byEmployee;
    }
    throw new Error(`payroll net pay overrides: ${error.message}`);
  }
  for (const o of data ?? []) {
    byEmployee.set(o.employee_id, {
      amount: Number(o.amount),
      calculated: o.calculated != null ? Number(o.calculated) : null,
      note: o.note ?? null,
      updatedBy: o.updated_by ?? null,
      updatedAt: o.updated_at,
    });
  }
  return byEmployee;
}

export async function setNetPayOverride({
  year,
  month,
  half,
  employeeId,
  amount,
  calculated,
  note,
  updatedBy,
}) {
  const { error } = await supabase.from("payroll_net_pay_overrides").upsert(
    {
      year,
      month,
      half,
      employee_id: employeeId,
      amount,
      calculated: calculated ?? null,
      note: note ?? null,
      updated_by: updatedBy ?? null,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "year,month,half,employee_id" },
  );
  if (error) throw new Error(`payroll net pay override upsert: ${error.message}`);
}

// Volver al valor calculado = borrar el override.
export async function clearNetPayOverride({ year, month, half, employeeId }) {
  const { error } = await supabase
    .from("payroll_net_pay_overrides")
    .delete()
    .eq("year", year)
    .eq("month", month)
    .eq("half", half)
    .eq("employee_id", employeeId);
  if (error) throw new Error(`payroll net pay override delete: ${error.message}`);
}

// Empleados (activos o no) por id — para nombrar a los "extra payees".
export async function loadEmployeeNames(employeeIds) {
  const names = new Map();
  if (!employeeIds.length) return names;
  const { data, error } = await supabase.from("employees").select("id, name").in("id", employeeIds);
  if (error) throw new Error(`payroll employee names: ${error.message}`);
  for (const e of data ?? []) names.set(e.id, e.name);
  return names;
}
