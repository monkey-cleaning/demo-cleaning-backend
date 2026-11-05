// services/payrollCreditCardService.js
// Payroll (2026-09-30) — saldo de la tarjeta de crédito de la empresa, de
// carga manual por ahora (punto 13 del pedido grande). Un solo registro por
// quincena (upsert por período), mismo patrón que
// payrollAdjustmentsService.setNetPayOverride — sin tabla de historial
// propia (payroll no usa record_history, ver memoria del proyecto).
import { supabase } from "../supabaseClient.js";

const isMissingTable = (error) => error?.code === "PGRST205";

function warnMissing() {
  console.warn(
    "⚠️ [payrollCreditCardService] payroll_credit_card_balance no existe todavía " +
      "(falta correr la migración 20260930_payroll_credit_card.sql) — sigo sin datos.",
  );
}

function mapRow(row) {
  return {
    balance: Number(row.balance),
    paymentAmount: Number(row.payment_amount),
    note: row.note ?? null,
    updatedBy: row.updated_by ?? null,
    updatedAt: row.updated_at,
  };
}

// null = todavía no se cargó nada para esta quincena.
export async function getCreditCardBalance({ year, month, half }) {
  const { data, error } = await supabase
    .from("payroll_credit_card_balance")
    .select("balance, payment_amount, note, updated_by, updated_at")
    .eq("year", year)
    .eq("month", month)
    .eq("half", half)
    .maybeSingle();
  if (error) {
    if (isMissingTable(error)) {
      warnMissing();
      return null;
    }
    throw new Error(`payroll credit card balance: ${error.message}`);
  }
  return data ? mapRow(data) : null;
}

export async function setCreditCardBalance({
  year,
  month,
  half,
  balance,
  paymentAmount,
  note,
  updatedBy,
}) {
  const { data, error } = await supabase
    .from("payroll_credit_card_balance")
    .upsert(
      {
        year,
        month,
        half,
        balance,
        payment_amount: paymentAmount ?? 0,
        note: note ?? null,
        updated_by: updatedBy ?? null,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "year,month,half" },
    )
    .select("balance, payment_amount, note, updated_by, updated_at")
    .single();
  if (error) throw new Error(`payroll credit card balance upsert: ${error.message}`);
  return mapRow(data);
}

export async function deleteCreditCardBalance({ year, month, half }) {
  const { error } = await supabase
    .from("payroll_credit_card_balance")
    .delete()
    .eq("year", year)
    .eq("month", month)
    .eq("half", half);
  if (error) throw new Error(`payroll credit card balance delete: ${error.message}`);
}
