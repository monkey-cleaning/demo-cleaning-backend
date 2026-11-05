// services/payrollPartnersService.js
// Payroll — accionistas (Javi y Jhony) y sus extras de la quincena.
//
// Javier y Jhony son los accionistas de la empresa (aclarado por el usuario
// 2026-09-24). Javi además es un cleaner (`employee_id` lo enlaza a su
// empleado); Jhony NO — en la planilla las horas/traslado de las filas
// "Jhony" son de Edilsa, y de Jhony solo son los dividendos. Los dividendos y
// los intermediarios de Pagos Experimental apuntan a un accionista.
// Admin-only en toda la cadena (controller/rutas).
//
// Extras FIJOS (2026-09-29, confirmado con Jhony: el parking de Javi se
// repite todas las quincenas): mismo patrón que los gastos fijos — una
// plantilla con vigencia [from_period, until_period) en
// `payroll_recurring_partner_extras`, no una fila copiada a cada quincena.
import { supabase } from "../supabaseClient.js";
import { periodIndex, activeRecurringForPeriod } from "./payrollExpensesService.js";

const round2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;

const isMissingTable = (error) => error?.code === "PGRST205";

function warnMissing(table) {
  console.warn(
    `⚠️ [payrollPartnersService] ${table} no existe todavía ` +
      "(falta correr la migración 20260924_payroll_partners.sql) — sigo sin datos.",
  );
}

// Puras ───────────────────────────────────────────────────────────────────

// Total por accionista de una lista de { partnerId, amount } (dividendos o
// extras). Lo que no tiene dueño se ignora.
export function sumByPartner(items) {
  const byPartner = new Map();
  for (const it of items) {
    if (!it.partnerId) continue;
    byPartner.set(it.partnerId, round2((byPartner.get(it.partnerId) ?? 0) + it.amount));
  }
  return byPartner;
}

// Pagos a los accionistas para la tabla NET PAY: dividendos + extras (el
// parking de Javi, etc.), por accionista. Lo que cada uno hace pasar en
// efectivo a los cleaners con plan (`viaCash`, de la tabla de pagos) se
// informa aparte y NO suma a lo suyo — es plata de los cleaners. Los
// dividendos sin accionista (o de uno dado de baja) van en `otherDividends`,
// para que el total cierre con el de los dividendos del P&L.
// partners: [{ id, name, employeeId }] · paymentRows: filas de buildPaymentTable
export function buildStakeholderPayments({
  partners,
  dividendsByPartner,
  extrasByPartner,
  paymentRows = [],
  dividendsTotal = 0,
}) {
  const viaCashByPartner = new Map();
  for (const row of paymentRows) {
    if (!row.partnerId) continue;
    const cash = Object.values(row.via ?? {}).reduce((sum, v) => sum + v, 0);
    viaCashByPartner.set(row.partnerId, round2((viaCashByPartner.get(row.partnerId) ?? 0) + cash));
  }
  const stakeholders = partners
    .map((partner) => {
      const dividends = dividendsByPartner.get(partner.id) ?? 0;
      const extras = extrasByPartner.get(partner.id) ?? 0;
      return {
        partnerId: partner.id,
        name: partner.name,
        employeeId: partner.employeeId ?? null,
        dividends,
        extras,
        total: round2(dividends + extras),
        viaCash: viaCashByPartner.get(partner.id) ?? 0,
      };
    })
    .filter((s) => s.total !== 0 || s.viaCash !== 0);
  const assignedDividends = partners.reduce((sum, p) => sum + (dividendsByPartner.get(p.id) ?? 0), 0);
  const otherDividends = round2(Math.max(0, dividendsTotal - assignedDividends));
  const total = round2(stakeholders.reduce((sum, s) => sum + s.total, 0) + otherDividends);
  return { stakeholders, otherDividends, total };
}

// Accionistas ─────────────────────────────────────────────────────────────

const PARTNER_COLS = "id, name, employee_id, is_active, employees(name)";

function mapPartner(row) {
  return {
    id: row.id,
    name: row.name,
    employeeId: row.employee_id ?? null,
    employeeName: row.employees?.name ?? null,
    isActive: row.is_active,
  };
}

export async function listPartners({ includeInactive = false } = {}) {
  let query = supabase.from("payroll_partners").select(PARTNER_COLS).order("name");
  if (!includeInactive) query = query.eq("is_active", true);
  const { data, error } = await query;
  if (error) {
    if (isMissingTable(error)) {
      warnMissing("payroll_partners");
      return [];
    }
    throw new Error(`payroll partners: ${error.message}`);
  }
  return (data ?? []).map(mapPartner);
}

export async function createPartner({ name, employeeId }) {
  const { data, error } = await supabase
    .from("payroll_partners")
    .insert({ name, employee_id: employeeId ?? null })
    .select(PARTNER_COLS)
    .single();
  if (error) throw new Error(`payroll partners create: ${error.message}`);
  return mapPartner(data);
}

export async function updatePartner({ id, name, employeeId, isActive }) {
  const patch = {};
  if (name !== undefined) patch.name = name;
  if (employeeId !== undefined) patch.employee_id = employeeId;
  if (isActive !== undefined) patch.is_active = isActive;
  const { data, error } = await supabase
    .from("payroll_partners")
    .update(patch)
    .eq("id", id)
    .select(PARTNER_COLS)
    .single();
  if (error) throw new Error(`payroll partners update: ${error.message}`);
  return mapPartner(data);
}

// Baja lógica: los dividendos y planes ya cargados siguen apuntando a él.
export async function deactivatePartner(id) {
  const { error } = await supabase.from("payroll_partners").update({ is_active: false }).eq("id", id);
  if (error) throw new Error(`payroll partners deactivate: ${error.message}`);
}

// Extras ──────────────────────────────────────────────────────────────────

const EXTRA_COLS = "id, partner_id, concept, amount, created_by, created_at, payroll_partners(name)";

function mapExtra(row) {
  return {
    id: row.id,
    partnerId: row.partner_id,
    partnerName: row.payroll_partners?.name ?? null,
    concept: row.concept,
    amount: Number(row.amount),
    createdBy: row.created_by,
    createdAt: row.created_at,
    isFixed: false,
    seriesId: null,
  };
}

const RECURRING_EXTRA_COLS =
  "id, series_id, partner_id, concept, amount, from_period, until_period, created_by, created_at, payroll_partners(name)";

function mapRecurringExtra(row) {
  return {
    id: row.id,
    partnerId: row.partner_id,
    partnerName: row.payroll_partners?.name ?? null,
    concept: row.concept,
    amount: Number(row.amount),
    createdBy: row.created_by,
    createdAt: row.created_at,
    isFixed: true,
    seriesId: row.series_id,
  };
}

async function loadRecurringExtraTemplates() {
  const { data, error } = await supabase
    .from("payroll_recurring_partner_extras")
    .select(RECURRING_EXTRA_COLS);
  if (error) {
    if (isMissingTable(error)) {
      console.warn(
        "⚠️ [payrollPartnersService] payroll_recurring_partner_extras no existe todavía " +
          "(falta correr la migración 20260929_payroll_partner_extras_fixed.sql) — sigo sin extras fijos.",
      );
      return [];
    }
    throw new Error(`payroll recurring partner extras: ${error.message}`);
  }
  return data ?? [];
}

export async function listPartnerExtras({ year, month, half }) {
  const idx = periodIndex({ year, month, half });

  const { data, error } = await supabase
    .from("payroll_partner_extras")
    .select(EXTRA_COLS)
    .eq("year", year)
    .eq("month", month)
    .eq("half", half)
    .order("created_at", { ascending: true });
  if (error) {
    if (isMissingTable(error)) {
      warnMissing("payroll_partner_extras");
      return { extras: [], total: 0 };
    }
    throw new Error(`payroll partner extras: ${error.message}`);
  }

  const fixed = activeRecurringForPeriod(await loadRecurringExtraTemplates(), idx)
    .map(mapRecurringExtra)
    .sort((a, b) => a.concept.localeCompare(b.concept));
  const oneOff = (data ?? []).map(mapExtra);
  const extras = [...fixed, ...oneOff];
  return { extras, total: round2(extras.reduce((s, e) => s + e.amount, 0)) };
}

export async function createPartnerExtra({
  year,
  month,
  half,
  partnerId,
  concept,
  amount,
  createdBy,
  isFixed = false,
}) {
  if (isFixed) {
    const { data, error } = await supabase
      .from("payroll_recurring_partner_extras")
      .insert({
        partner_id: partnerId,
        concept,
        amount,
        from_period: periodIndex({ year, month, half }),
        created_by: createdBy ?? null,
      })
      .select(RECURRING_EXTRA_COLS)
      .single();
    if (error) throw new Error(`payroll fixed partner extra create: ${error.message}`);
    return mapRecurringExtra(data);
  }

  const { data, error } = await supabase
    .from("payroll_partner_extras")
    .insert({ year, month, half, partner_id: partnerId, concept, amount, created_by: createdBy ?? null })
    .select(EXTRA_COLS)
    .single();
  if (error) throw new Error(`payroll partner extras create: ${error.message}`);
  return mapExtra(data);
}

// Puntual: se edita la fila. Fijo: si la versión vigente arranca justo en
// esta quincena se edita en el lugar; si arranca antes, se CIERRA en esta
// quincena y se abre una versión nueva desde acá — mismo criterio que
// updateExpense en payrollExpensesService.js.
export async function updatePartnerExtra({
  id,
  isFixed,
  year,
  month,
  half,
  partnerId,
  concept,
  amount,
  updatedBy,
}) {
  if (!isFixed) {
    const patch = {};
    if (partnerId !== undefined) patch.partner_id = partnerId;
    if (concept !== undefined) patch.concept = concept;
    if (amount !== undefined) patch.amount = amount;
    const { data, error } = await supabase
      .from("payroll_partner_extras")
      .update(patch)
      .eq("id", id)
      .select(EXTRA_COLS)
      .single();
    if (error) throw new Error(`payroll partner extras update: ${error.message}`);
    return mapExtra(data);
  }

  const idx = periodIndex({ year, month, half });
  const { data: current, error: curErr } = await supabase
    .from("payroll_recurring_partner_extras")
    .select(RECURRING_EXTRA_COLS)
    .eq("id", id)
    .single();
  if (curErr) throw new Error(`payroll fixed partner extra lookup: ${curErr.message}`);
  if (!activeRecurringForPeriod([current], idx).length) {
    throw new Error("This fixed extra is not active in the selected fortnight");
  }

  if (current.from_period === idx) {
    const { data, error } = await supabase
      .from("payroll_recurring_partner_extras")
      .update({ partner_id: partnerId, concept, amount })
      .eq("id", id)
      .select(RECURRING_EXTRA_COLS)
      .single();
    if (error) throw new Error(`payroll fixed partner extra update: ${error.message}`);
    return mapRecurringExtra(data);
  }

  const { error: closeErr } = await supabase
    .from("payroll_recurring_partner_extras")
    .update({ until_period: idx })
    .eq("id", id);
  if (closeErr) throw new Error(`payroll fixed partner extra close: ${closeErr.message}`);

  const { data, error } = await supabase
    .from("payroll_recurring_partner_extras")
    .insert({
      series_id: current.series_id,
      partner_id: partnerId,
      concept,
      amount,
      from_period: idx,
      until_period: current.until_period,
      created_by: updatedBy ?? current.created_by,
    })
    .select(RECURRING_EXTRA_COLS)
    .single();
  if (error) throw new Error(`payroll fixed partner extra new version: ${error.message}`);
  return mapRecurringExtra(data);
}

// Puntual: borra la fila. Fijo: lo da de baja desde esta quincena en
// adelante — cierra la versión vigente y borra las versiones futuras de la
// serie; las quincenas anteriores conservan el extra.
export async function deletePartnerExtra({ id, isFixed, year, month, half }) {
  if (!isFixed) {
    const { error } = await supabase.from("payroll_partner_extras").delete().eq("id", id);
    if (error) throw new Error(`payroll partner extras delete: ${error.message}`);
    return;
  }

  const idx = periodIndex({ year, month, half });
  const { data: current, error: curErr } = await supabase
    .from("payroll_recurring_partner_extras")
    .select("id, series_id, from_period, until_period")
    .eq("id", id)
    .single();
  if (curErr) throw new Error(`payroll fixed partner extra lookup: ${curErr.message}`);

  const { error: delErr } = await supabase
    .from("payroll_recurring_partner_extras")
    .delete()
    .eq("series_id", current.series_id)
    .gte("from_period", idx);
  if (delErr) throw new Error(`payroll fixed partner extra delete future: ${delErr.message}`);

  if (current.from_period < idx) {
    const { error: closeErr } = await supabase
      .from("payroll_recurring_partner_extras")
      .update({ until_period: idx })
      .eq("id", id);
    if (closeErr) throw new Error(`payroll fixed partner extra close: ${closeErr.message}`);
  }
}
