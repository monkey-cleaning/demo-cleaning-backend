import { supabase } from "./supabaseService.js";

// ── PAYMENT METHOD NORMALIZATION ─────────────────────────────────────────────
// Maps raw QB/Supabase payment_method values to normalized labels.
// Used to filter by method in getPayments.
const METHOD_NORMALIZED = {
  "quickbooks payments-credit card": "Credit Card",
  "quickbooks payments - credit card": "Credit Card",
  "credit card": "Credit Card",
  "e-transfer": "e-Transfer",
  "e-transfer (interac)": "e-Transfer",
};

/**
 * Normalizes a raw payment method string to a canonical label.
 * Returns null if no mapping found (pass-through case handled by caller).
 */
function normalizeMethod(raw) {
  if (!raw) return null;
  return METHOD_NORMALIZED[raw.toLowerCase()] ?? raw;
}

// ── LIST ─────────────────────────────────────────────────────────────────────

/**
 * Lista payments con filtros opcionales.
 * Query params: lead_id, status, method, from, to, page, limit
 *
 * `method` acepta los valores normalizados: 'Credit Card' | 'e-Transfer'
 * El filtrado por método se aplica sobre los valores raw en BD mapeando a los
 * valores posibles de cada grupo.
 */
export async function getPayments({
  lead_id,
  status,
  method,
  from,
  to,
  search,
  page = 1,
  limit = 20,
}) {
  const offset = (page - 1) * limit;

  // Helper: apply all filters to any Supabase query builder.
  function applyFilters(q) {
    if (lead_id) q = q.eq("lead_id", lead_id);
    if (status) q = q.eq("status", status);
    if (from) q = q.gte("payment_date", from);
    if (to) q = q.lte("payment_date", to);
    if (search) q = q.or(`quickbooks_customer_name.ilike.%${search}%`);
    if (method === "Credit Card") {
      // NULLs don't match ilike so they're excluded naturally -- correct for CC.
      q = q.or(
        "payment_method.ilike.%credit card%," +
          "payment_method.ilike.QuickBooks Payments%",
      );
    } else if (method === "e-Transfer") {
      // QB stores e-transfers as 'E-transfer'. Match all known variants.
      q = q.or(
        "payment_method.ilike.%e-transfer%," +
          "payment_method.ilike.%e transfer%," +
          "payment_method.ilike.%interac%",
      );
    } else if (method === "exclude-etransfers") {
      q = q.or(
        "payment_method.is.null," +
          "and(payment_method.not.ilike.%e-transfer%,payment_method.not.ilike.%e transfer%,payment_method.not.ilike.%interac%)",
      );
    } else if (method) {
      q = q.eq("payment_method", method);
    }
    // No method param (and not exclude-etransfers) -> return ALL rows.
    return q;
  }

  // Step 1: count-only query with no .range() — never throws on out-of-bounds pages.
  const { count, error: countError } = await applyFilters(
    supabase.from("payments").select("*", { count: "exact", head: true }),
  );
  if (countError)
    throw new Error(
      `Error listando payments: ${countError.message ?? JSON.stringify(countError)}`,
    );

  const total = count ?? 0;
  const pages = Math.ceil(total / limit) || 0;

  // Step 2: page beyond total — return empty without a second DB hit.
  if (total === 0 || offset >= total) {
    return { data: [], pagination: { total, page, limit, pages } };
  }

  // Step 3: data query with a guaranteed safe .range().
  const { data, error } = await applyFilters(
    supabase
      .from("payments")
      .select(
        `
        *,
        leads(full_name, email),
        invoice_payments(
          amount_applied,
          invoice:invoices(id, quickbooks_invoice_id, doc_number, total_amount, status, issued_date, due_date)
        )
      `,
      )
      .order("payment_date", { ascending: false })
      .range(offset, offset + limit - 1),
  );
  if (error)
    throw new Error(
      `Error listando payments: ${error.message ?? JSON.stringify(error)}`,
    );

  return {
    data,
    pagination: { total, page, limit, pages },
  };
}

// ── GET BY ID ─────────────────────────────────────────────────────────────────

/**
 * Detalle de un payment con sus invoices linkeadas y el lead asociado.
 */
export async function getPaymentById(id) {
  const { data, error } = await supabase
    .from("payments")
    .select(
      `
      *,
      leads(full_name, email, phone),
      invoice_payments(
        amount_applied,
        invoice:invoices(
          id,
          quickbooks_invoice_id,
          doc_number,
          total_amount,
          balance,
          status,
          issued_date,
          due_date,
          quickbooks_customer_name
        )
      )
      `,
    )
    .eq("id", id)
    .maybeSingle();

  if (error) throw new Error(`Error obteniendo payment: ${error.message}`);
  return data;
}

// ── SUMMARY ───────────────────────────────────────────────────────────────────

/**
 * Totales para las cards del dashboard.
 * Opcional: filtrar por rango de fechas.
 */
export async function getPaymentsSummary({ from, to } = {}) {
  let query = supabase
    .from("payments")
    .select("amount, status, currency, payment_date");

  if (from) query = query.gte("payment_date", from);
  if (to) query = query.lte("payment_date", to);

  const { data, error } = await query;
  if (error)
    throw new Error(`Error calculando summary de payments: ${error.message}`);

  const summary = {
    totalCollected: 0,
    countPayments: data.length,
    byStatus: {
      completed: { count: 0, amount: 0 },
      pending: { count: 0, amount: 0 },
      failed: { count: 0, amount: 0 },
      refunded: { count: 0, amount: 0 },
    },
    byMonth: {},
  };

  for (const payment of data) {
    const amount = Number(payment.amount);
    const status = payment.status;

    if (status === "completed") summary.totalCollected += amount;

    if (summary.byStatus[status]) {
      summary.byStatus[status].count++;
      summary.byStatus[status].amount += amount;
    }

    const month = payment.payment_date?.slice(0, 7);
    if (month) {
      if (!summary.byMonth[month]) {
        summary.byMonth[month] = { count: 0, amount: 0 };
      }
      summary.byMonth[month].count++;
      summary.byMonth[month].amount += amount;
    }
  }

  summary.totalCollected = Number(summary.totalCollected.toFixed(2));
  for (const s of Object.values(summary.byStatus)) {
    s.amount = Number(s.amount.toFixed(2));
  }
  for (const m of Object.values(summary.byMonth)) {
    m.amount = Number(m.amount.toFixed(2));
  }

  summary.byMonth = Object.entries(summary.byMonth)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([month, values]) => ({ month, ...values }));

  return summary;
}
