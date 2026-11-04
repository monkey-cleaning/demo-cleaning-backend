// services/payrollExpensesService.js
// LAB428 (2026-09-17) — gastos de la quincena en la pestaña "Payroll".
// Calcado de la sección "GASTOS" de la planilla manual (Concepto | Tipo |
// Monto), categorías fijas financial/operational/administrative. Admin-only
// en toda la cadena (controller/rutas) — un cleaner nunca ve ni carga esto.
//
// (2026-09-18) Gastos FIJOS: plantillas con vigencia en
// `payroll_recurring_expenses`, no filas copiadas a cada quincena. Una fila
// es una VERSION [from_period, until_period) de un gasto (mismo series_id =
// mismo gasto con distintos precios). Cambiar el precio cierra la versión
// vigente y abre otra desde esa quincena — las anteriores no se tocan.
import { supabase } from "../supabaseClient.js";

export const EXPENSE_CATEGORIES = ["financial", "operational", "administrative"];

const round2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;

const isMissingTable = (error) => error?.code === "PGRST205";

// Índice monotónico de quincena: permite comparar/ordenar con <=.
export function periodIndex({ year, month, half }) {
  return year * 24 + (month - 1) * 2 + (half - 1);
}

export function conceptKey(concept) {
  return String(concept ?? "").trim().toLowerCase();
}

function mapRow(row) {
  return {
    id: row.id,
    concept: row.concept,
    category: row.category,
    amount: Number(row.amount),
    createdBy: row.created_by,
    createdAt: row.created_at,
    isFixed: false,
    seriesId: null,
  };
}

function mapRecurring(row) {
  return {
    id: row.id,
    concept: row.concept,
    category: row.category,
    amount: Number(row.amount),
    createdBy: row.created_by,
    createdAt: row.created_at,
    isFixed: true,
    seriesId: row.series_id,
  };
}

// Función pura (sin DB) — separada para poder testearla sin Supabase, mismo
// patrón que cashflowService.aggregateCashflow.
export function aggregateExpenseTotals(expenses) {
  const totals = { financial: 0, operational: 0, administrative: 0, total: 0 };
  for (const e of expenses) {
    totals[e.category] = round2((totals[e.category] || 0) + e.amount);
    totals.total = round2(totals.total + e.amount);
  }
  return totals;
}

// Función pura — qué versiones de gastos fijos aplican a la quincena `idx`.
export function activeRecurringForPeriod(templates, idx) {
  return templates.filter(
    (t) => t.from_period <= idx && (t.until_period == null || idx < t.until_period),
  );
}

// Función pura — total de la quincena por cada concepto fijado (siempre una
// fila por concepto fijado, aunque el total sea 0). Match por concepto sin
// distinguir mayúsculas ni espacios en los bordes.
export function summarizeRelevantExpenses(expenses, pinned) {
  const totalByKey = new Map();
  for (const e of expenses) {
    const key = conceptKey(e.concept);
    totalByKey.set(key, round2((totalByKey.get(key) ?? 0) + e.amount));
  }
  return pinned.map((p) => ({ label: p.label, amount: totalByKey.get(p.key) ?? 0 }));
}

// Concepto que NO se carga a mano: "Transporte" es lo que se les paga a los
// cleaners por traslados (travelMoney), se autocompleta.
export const AUTO_TRANSPORT_KEY = "transporte";

// Función pura — filas de la tabla "Key expenses": Transporte primero, con el
// total pagado a cleaners por traslados (autocompletado, `auto: true`), y
// después los conceptos fijados por el admin. Ese monto YA está dentro de
// `cleanerPayroll` (work + travel), así que es informativo: no se suma a los
// gastos ni baja el Net profit de nuevo. Un concepto fijado llamado
// "Transporte" se ignora para no duplicar la fila.
export function buildRelevantExpenses({ travelMoney, expenses, pinned }) {
  return [
    {
      label: "Transporte",
      amount: round2(travelMoney || 0),
      auto: true,
      hint: "Paid to cleaners for travel — already included in Cleaner payroll",
    },
    ...summarizeRelevantExpenses(
      expenses,
      pinned.filter((p) => p.key !== AUTO_TRANSPORT_KEY),
    ),
  ];
}

const EMPTY_TOTALS ={ financial: 0, operational: 0, administrative: 0, total: 0 };

async function loadRecurringTemplates() {
  const { data, error } = await supabase
    .from("payroll_recurring_expenses")
    .select("id, series_id, concept, category, amount, from_period, until_period, created_by, created_at");
  if (error) {
    if (isMissingTable(error)) {
      console.warn(
        "⚠️ [payrollExpensesService] payroll_recurring_expenses no existe todavía " +
          "(falta correr la migración 20260918_payroll_finance_v2.sql) — sigo sin gastos fijos.",
      );
      return [];
    }
    throw new Error(`payroll recurring expenses: ${error.message}`);
  }
  return data ?? [];
}

// ── listExpenses ─────────────────────────────────────────────────────────
// Devuelve los gastos de la quincena (fijos + puntuales) + totales por
// categoría y general. Degrada con gracia si la migración todavía no corrió
// (PGRST205, mismo criterio que loadTravelOverrides en
// payrollSummaryService.js) — el resto de Payroll sigue andando, la sección
// de gastos queda simplemente vacía.
export async function listExpenses({ year, month, half }) {
  const idx = periodIndex({ year, month, half });

  const { data, error } = await supabase
    .from("payroll_expenses")
    .select("id, concept, category, amount, created_by, created_at")
    .eq("year", year)
    .eq("month", month)
    .eq("half", half)
    .order("created_at", { ascending: true });

  if (error) {
    if (isMissingTable(error)) {
      console.warn(
        "⚠️ [payrollExpensesService] payroll_expenses no existe todavía " +
          "(falta correr la migración 20260917_payroll_expenses.sql) — sigo sin gastos.",
      );
      return { expenses: [], totals: { ...EMPTY_TOTALS } };
    }
    throw new Error(`payroll expenses: ${error.message}`);
  }

  const fixed = activeRecurringForPeriod(await loadRecurringTemplates(), idx)
    .map(mapRecurring)
    .sort((a, b) => a.concept.localeCompare(b.concept));
  const oneOff = (data ?? []).map(mapRow);
  const expenses = [...fixed, ...oneOff];
  return { expenses, totals: aggregateExpenseTotals(expenses) };
}

export async function createExpense({
  year,
  month,
  half,
  concept,
  category,
  amount,
  createdBy,
  isFixed = false,
}) {
  if (isFixed) {
    const { data, error } = await supabase
      .from("payroll_recurring_expenses")
      .insert({
        concept,
        category,
        amount,
        from_period: periodIndex({ year, month, half }),
        created_by: createdBy ?? null,
      })
      .select("id, series_id, concept, category, amount, from_period, until_period, created_by, created_at")
      .single();
    if (error) throw new Error(`payroll fixed expense create: ${error.message}`);
    return mapRecurring(data);
  }

  const { data, error } = await supabase
    .from("payroll_expenses")
    .insert({
      year,
      month,
      half,
      concept,
      category,
      amount,
      created_by: createdBy ?? null,
    })
    .select("id, concept, category, amount, created_by, created_at")
    .single();
  if (error) throw new Error(`payroll expenses create: ${error.message}`);
  return mapRow(data);
}

// ── updateExpense ────────────────────────────────────────────────────────
// Puntual: se edita la fila. Fijo: si la versión vigente arranca justo en
// esta quincena se edita en el lugar; si arranca antes, se CIERRA en esta
// quincena y se abre una versión nueva desde acá (hasta donde terminaba la
// anterior) — así el histórico conserva el precio viejo.
//
// `makeFixed` (opcional) cambia el TIPO del gasto al editarlo: puntual → fijo
// lo repite desde esta quincena; fijo → puntual lo deja solo en esta quincena y
// lo da de baja de ahí en adelante (las anteriores lo conservan). Si no viene
// o coincide con `isFixed`, el tipo no cambia.
export async function updateExpense({
  id,
  isFixed,
  makeFixed,
  year,
  month,
  half,
  concept,
  category,
  amount,
  updatedBy,
}) {
  if (typeof makeFixed === "boolean" && makeFixed !== Boolean(isFixed)) {
    // Primero se crea el nuevo y después se retira el viejo: si algo falla en
    // el medio queda un gasto de más (visible y borrable), nunca uno perdido.
    const created = await createExpense({
      year,
      month,
      half,
      concept,
      category,
      amount,
      createdBy: updatedBy,
      isFixed: makeFixed,
    });
    try {
      await deleteExpense({ id, isFixed: Boolean(isFixed), year, month, half });
    } catch (e) {
      await deleteExpense({ id: created.id, isFixed: makeFixed, year, month, half }).catch(() => {});
      throw e;
    }
    return created;
  }

  if (!isFixed) {
    const { data, error } = await supabase
      .from("payroll_expenses")
      .update({ concept, category, amount })
      .eq("id", id)
      .select("id, concept, category, amount, created_by, created_at")
      .single();
    if (error) throw new Error(`payroll expenses update: ${error.message}`);
    return mapRow(data);
  }

  const idx = periodIndex({ year, month, half });
  const { data: current, error: curErr } = await supabase
    .from("payroll_recurring_expenses")
    .select("id, series_id, concept, category, amount, from_period, until_period, created_by, created_at")
    .eq("id", id)
    .single();
  if (curErr) throw new Error(`payroll fixed expense lookup: ${curErr.message}`);
  if (!activeRecurringForPeriod([current], idx).length) {
    throw new Error("This fixed expense is not active in the selected fortnight");
  }

  if (current.from_period === idx) {
    const { data, error } = await supabase
      .from("payroll_recurring_expenses")
      .update({ concept, category, amount })
      .eq("id", id)
      .select("id, series_id, concept, category, amount, from_period, until_period, created_by, created_at")
      .single();
    if (error) throw new Error(`payroll fixed expense update: ${error.message}`);
    return mapRecurring(data);
  }

  const { error: closeErr } = await supabase
    .from("payroll_recurring_expenses")
    .update({ until_period: idx })
    .eq("id", id);
  if (closeErr) throw new Error(`payroll fixed expense close: ${closeErr.message}`);

  const { data, error } = await supabase
    .from("payroll_recurring_expenses")
    .insert({
      series_id: current.series_id,
      concept,
      category,
      amount,
      from_period: idx,
      until_period: current.until_period,
      created_by: updatedBy ?? current.created_by,
    })
    .select("id, series_id, concept, category, amount, from_period, until_period, created_by, created_at")
    .single();
  if (error) throw new Error(`payroll fixed expense new version: ${error.message}`);
  return mapRecurring(data);
}

// ── deleteExpense ────────────────────────────────────────────────────────
// Puntual: borra la fila. Fijo: lo DA DE BAJA desde esta quincena en
// adelante — cierra la versión vigente y borra las versiones futuras de la
// serie; las quincenas anteriores conservan el gasto.
export async function deleteExpense({ id, isFixed, year, month, half }) {
  if (!isFixed) {
    const { error } = await supabase.from("payroll_expenses").delete().eq("id", id);
    if (error) throw new Error(`payroll expenses delete: ${error.message}`);
    return;
  }

  const idx = periodIndex({ year, month, half });
  const { data: current, error: curErr } = await supabase
    .from("payroll_recurring_expenses")
    .select("id, series_id, from_period, until_period")
    .eq("id", id)
    .single();
  if (curErr) throw new Error(`payroll fixed expense lookup: ${curErr.message}`);

  const { error: delErr } = await supabase
    .from("payroll_recurring_expenses")
    .delete()
    .eq("series_id", current.series_id)
    .gte("from_period", idx);
  if (delErr) throw new Error(`payroll fixed expense delete: ${delErr.message}`);

  if (current.from_period < idx) {
    const { error } = await supabase
      .from("payroll_recurring_expenses")
      .update({ until_period: idx })
      .eq("id", id);
    if (error) throw new Error(`payroll fixed expense stop: ${error.message}`);
  }
}

// ── Conceptos fijados (tabla de "gastos relevantes") ─────────────────────
export async function listPinnedConcepts() {
  const { data, error } = await supabase
    .from("payroll_pinned_expense_concepts")
    .select("concept_key, label, position")
    .order("position", { ascending: true });
  if (error) {
    if (isMissingTable(error)) return [];
    throw new Error(`payroll pinned concepts: ${error.message}`);
  }
  return (data ?? []).map((r) => ({ key: r.concept_key, label: r.label }));
}

// Reemplaza la lista completa (el orden del array es el orden de display).
export async function setPinnedConcepts(labels) {
  const seen = new Set();
  const rows = [];
  for (const raw of labels) {
    const label = String(raw ?? "").trim();
    const key = conceptKey(label);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    rows.push({ concept_key: key, label, position: rows.length });
  }

  if (rows.length) {
    const { error } = await supabase
      .from("payroll_pinned_expense_concepts")
      .upsert(rows, { onConflict: "concept_key" });
    if (error) throw new Error(`payroll pinned concepts upsert: ${error.message}`);
  }

  let del = supabase.from("payroll_pinned_expense_concepts").delete();
  del = rows.length
    ? del.not("concept_key", "in", `(${rows.map((r) => `"${r.concept_key.replace(/"/g, '""')}"`).join(",")})`)
    : del.neq("concept_key", "");
  const { error: delErr } = await del;
  if (delErr) throw new Error(`payroll pinned concepts prune: ${delErr.message}`);

  return rows.map((r) => ({ key: r.concept_key, label: r.label }));
}
