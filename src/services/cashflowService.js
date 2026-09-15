// Portado de Monkey Cleaning (LAB367) — Reporte de cashflow semanal
// (facturado vs. pagado). Directamente portable: usa payments/
// payment_allocations con allocation_type/superseded_by, que este fork ya
// tiene idéntico (ver paymentReconciliationService.js).
//
// Para una semana (lunes–domingo, ISO):
//   - facturado:  invoices con issued_date en la semana, status != 'draft'
//   - pagado:     payment_allocations 'invoice_payment' (no superseded) contra
//                 esas invoices, con el payment 'completed' — la conciliación
//                 real (ver services/paymentReconciliationService.js)
//   - pendiente:  facturado - pagado
//   - sin atribuir: payment_allocations 'pending_review' (no superseded) cuyo
//                 payment cayó en la semana — línea de aviso, NO se resta
//
// Es agnóstico de la fuente: lee payments / payment_allocations, que no
// distinguen QuickBooks vs. e-Transfer.

import { DateTime } from "luxon";
import { supabase } from "./supabaseService.js";

const TZ = process.env.BOOKING_TIMEZONE ?? "America/Vancouver";

/**
 * Rango de la semana ISO (lunes 00:00 → domingo) que contiene `ref`.
 * @param {DateTime} ref
 * @returns {{ from: string, to: string }} fechas YYYY-MM-DD
 */
export function isoWeekRange(ref = DateTime.now().setZone(TZ)) {
  const start = ref.setZone(TZ).startOf("week"); // luxon: lunes
  return {
    from: start.toISODate(),
    to: start.endOf("week").toISODate(), // domingo
  };
}

const round2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;

/**
 * Agregación pura — sin DB, para poder testearla.
 *
 * @param {object} p
 * @param {{ total_amount: number|string }[]} p.invoices          facturas de la semana (status != draft)
 * @param {{ amount: number|string }[]} p.invoicePaidAllocs       allocations invoice_payment (no superseded, payment completed) contra esas facturas
 * @param {{ amount: number|string, payment_id: string }[]} p.pendingReviewAllocs  allocations pending_review (no superseded) con payment de la semana
 * @param {{ from: string, to: string }} p.week
 */
export function aggregateCashflow({
  invoices = [],
  invoicePaidAllocs = [],
  pendingReviewAllocs = [],
  week,
}) {
  const invoicedAmount = round2(
    invoices.reduce((s, i) => s + Number(i.total_amount || 0), 0),
  );
  const paidAmount = round2(
    invoicePaidAllocs.reduce((s, a) => s + Number(a.amount || 0), 0),
  );
  const outstandingAmount = round2(invoicedAmount - paidAmount);

  const unreconciledAmount = round2(
    pendingReviewAllocs.reduce((s, a) => s + Number(a.amount || 0), 0),
  );
  const unreconciledCount = new Set(
    pendingReviewAllocs.map((a) => a.payment_id),
  ).size;

  return {
    week,
    invoiced: { amount: invoicedAmount, count: invoices.length },
    paid: {
      amount: paidAmount,
      pct: invoicedAmount > 0 ? round2(paidAmount / invoicedAmount) : 0,
    },
    outstanding: { amount: outstandingAmount },
    unreconciled: { amount: unreconciledAmount, count: unreconciledCount },
  };
}

/**
 * @param {{ from?: string, to?: string }} [opts]  YYYY-MM-DD (lunes / domingo).
 *   Si falta alguno, se usa la semana ISO actual en TZ del negocio.
 */
export async function getWeeklyCashflow({ from, to } = {}) {
  const week =
    from && to ? { from, to } : isoWeekRange();

  // 1. Facturado en la semana
  const { data: invoices, error: invErr } = await supabase
    .from("invoices")
    .select("id, total_amount")
    .gte("issued_date", week.from)
    .lte("issued_date", week.to)
    .neq("status", "draft");
  if (invErr) throw new Error(`cashflow invoices: ${invErr.message}`);

  const invoiceIds = (invoices ?? []).map((i) => i.id);

  // 2. Pagado / conciliado contra esas facturas
  let invoicePaidAllocs = [];
  if (invoiceIds.length) {
    const { data, error } = await supabase
      .from("payment_allocations")
      .select("amount, invoice_id, payments!inner(status)")
      .in("invoice_id", invoiceIds)
      .eq("allocation_type", "invoice_payment")
      .is("superseded_by", null)
      .eq("payments.status", "completed");
    if (error) throw new Error(`cashflow paid allocs: ${error.message}`);
    invoicePaidAllocs = data ?? [];
  }

  // 3. Plata de la semana sin atribuir
  const { data: pendingReviewAllocs, error: prErr } = await supabase
    .from("payment_allocations")
    .select("amount, payment_id, payments!inner(status, payment_date)")
    .eq("allocation_type", "pending_review")
    .is("superseded_by", null)
    .eq("payments.status", "completed")
    .gte("payments.payment_date", week.from)
    .lte("payments.payment_date", week.to);
  if (prErr) throw new Error(`cashflow pending_review: ${prErr.message}`);

  return aggregateCashflow({
    invoices: invoices ?? [],
    invoicePaidAllocs,
    pendingReviewAllocs: pendingReviewAllocs ?? [],
    week,
  });
}
