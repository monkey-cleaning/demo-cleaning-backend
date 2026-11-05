// services/payrollClosingsService.js
// Payroll — cierre manual de quincena (archivo inmutable). Ver la migración
// 20260925_payroll_closings.sql. Una quincena cerrada guarda un snapshot del
// resumen admin y de las tarjetas; después se sirve desde ahí y las
// escrituras del período se rechazan (middleware payrollPeriodLock).
import { supabase } from "../supabaseClient.js";

const isMissingTable = (error) => error?.code === "PGRST205";

let warned = false;
function warnMissing() {
  if (warned) return;
  warned = true;
  console.warn(
    "⚠️ [payrollClosingsService] payroll_closings no existe todavía " +
      "(falta correr la migración 20260925_payroll_closings.sql) — no hay quincenas cerradas.",
  );
}

// Función pura: { year, month, half } válidos o null.
export function periodFrom(source) {
  const year = parseInt(source?.year, 10);
  const month = parseInt(source?.month, 10);
  const half = parseInt(source?.half, 10);
  if (!Number.isInteger(year) || year < 2000 || year > 2100) return null;
  if (!Number.isInteger(month) || month < 1 || month > 12) return null;
  if (half !== 1 && half !== 2) return null;
  return { year, month, half };
}

// Solo metadatos (barato): { closedAt, closedBy } o null si está abierta. Si la
// tabla no existe (migración sin correr) nada está cerrado.
export async function getClosing({ year, month, half }) {
  const { data, error } = await supabase
    .from("payroll_closings")
    .select("closed_at, closed_by")
    .eq("year", year)
    .eq("month", month)
    .eq("half", half)
    .maybeSingle();
  if (error) {
    if (isMissingTable(error)) {
      warnMissing();
      return null;
    }
    throw new Error(`payroll closings: ${error.message}`);
  }
  return data ? { closedAt: data.closed_at, closedBy: data.closed_by } : null;
}

// Trae SOLO una parte del snapshot (p. ej. "summary" o "sections->dividends")
// para no bajar el JSON entero por cada tarjeta. `path` sale de una lista fija
// del código, nunca del request.
export async function getClosingPart({ year, month, half }, path) {
  const { data, error } = await supabase
    .from("payroll_closings")
    .select(`closed_at, closed_by, part:snapshot->${path}`)
    .eq("year", year)
    .eq("month", month)
    .eq("half", half)
    .maybeSingle();
  if (error) {
    if (isMissingTable(error)) {
      warnMissing();
      return null;
    }
    throw new Error(`payroll closings part: ${error.message}`);
  }
  return data
    ? { closedAt: data.closed_at, closedBy: data.closed_by, part: data.part ?? null }
    : null;
}

export async function createClosing({ year, month, half, closedBy, snapshot }) {
  const { data, error } = await supabase
    .from("payroll_closings")
    .insert({ year, month, half, closed_by: closedBy ?? null, snapshot })
    .select("closed_at, closed_by")
    .single();
  if (error) {
    if (isMissingTable(error)) {
      throw new Error("payroll_closings table is missing — run migration 20260925_payroll_closings.sql");
    }
    const e = new Error(
      error.code === "23505" ? "This fortnight is already closed" : `payroll closings create: ${error.message}`,
    );
    e.code = error.code;
    throw e;
  }
  return { closedAt: data.closed_at, closedBy: data.closed_by };
}

// Período (year, month, half) de una fila de una tabla de payroll, para
// bloquear ediciones por id. null si no existe la fila o la tabla.
const PERIOD_TABLES = new Set([
  "payroll_expenses",
  "payroll_dividends",
  "payroll_deductions",
  "payroll_bonuses",
  "payroll_tips",
  "payroll_new_services",
  "payroll_partner_extras",
]);

export async function periodOfRow(table, id) {
  if (!PERIOD_TABLES.has(table) || !id) return null;
  const { data, error } = await supabase
    .from(table)
    .select("year, month, half")
    .eq("id", id)
    .maybeSingle();
  if (error || !data) return null;
  return periodFrom(data);
}
