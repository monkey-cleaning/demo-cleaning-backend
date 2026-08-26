import { Router } from "express";
import { syncQuickbooksData } from "../jobs/syncQuickbooks.js";
import {
  getInvoicesSince,
  getPaymentsSince,
} from "../services/quickbooksService.js";
import { supabase } from "../services/supabaseService.js";
import { runEtransferSyncJob } from "../jobs/eTransferSyncJob.js";

const router = Router();

/**
 * GET /api/quickbooks/dashboard?from=2026-01-01
 * Devuelve facturas + pagos con resumen para el admin panel
 */
router.get("/dashboard", async (req, res) => {
  try {
    const from =
      req.query.from ||
      new Date(new Date().getFullYear(), 0, 1).toISOString().split("T")[0]; // default: inicio del año actual

    const [invoices, payments] = await Promise.all([
      getInvoicesSince(from),
      getPaymentsSince(from),
    ]);

    // ── Normalizar facturas
    const invoiceList = invoices.map((inv) => ({
      id: inv.Id,
      docNumber: inv.DocNumber,
      date: inv.TxnDate,
      dueDate: inv.DueDate,
      customer: inv.CustomerRef?.name || "Unknown",
      total: inv.TotalAmt,
      balance: inv.Balance, // lo que falta pagar
      paid: inv.TotalAmt - inv.Balance,
      currency: inv.CurrencyRef?.value || "CAD",
      status: resolveInvoiceStatus(inv),
    }));

    // ── Normalizar pagos
    const paymentList = payments.map((pay) => ({
      id: pay.Id,
      date: pay.TxnDate,
      customer: pay.CustomerRef?.name || "Unknown",
      amount: pay.TotalAmt,
      currency: pay.CurrencyRef?.value || "CAD",
      linkedInvoices: (pay.Line || [])
        .flatMap((l) => l.LinkedTxn || [])
        .filter((t) => t.TxnType === "Invoice")
        .map((t) => t.TxnId),
    }));

    // ── Resumen
    const summary = {
      totalInvoiced: invoiceList.reduce((acc, i) => acc + i.total, 0),
      totalPaid: invoiceList.reduce((acc, i) => acc + i.paid, 0),
      totalOverdue: invoiceList
        .filter((i) => i.status === "overdue")
        .reduce((acc, i) => acc + i.balance, 0),
      totalPending: invoiceList
        .filter((i) => i.status === "pending")
        .reduce((acc, i) => acc + i.balance, 0),
      countOverdue: invoiceList.filter((i) => i.status === "overdue").length,
      countPaid: invoiceList.filter((i) => i.status === "paid").length,
      countPending: invoiceList.filter((i) => i.status === "pending").length,
    };

    return res.json({
      from,
      summary,
      invoices: invoiceList,
      payments: paymentList,
    });
  } catch (err) {
    console.error("❌ Error fetching QB dashboard:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── Helper: determina el status de una factura
function resolveInvoiceStatus(inv) {
  if (inv.Balance === 0) return "paid";
  const today = new Date();
  const due = new Date(inv.DueDate);
  if (due < today) return "overdue";
  return "pending";
}

// GET /api/quickbooks/sync
router.get("/sync", async (req, res) => {
  try {
    await syncQuickbooksData();
    res.json({ success: true, message: "Sync completado" });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── GET /api/quickbooks/etransfers ─────────────────────────────────────────
// Reads e-transfers from the `etransfers` Supabase table (populated by the
// nightly sync job). Much faster than hitting Gmail directly.
//
// Query params:
//   from       → YYYY-MM-DD  (default: start of current year)
//   to         → YYYY-MM-DD  (default: today)
//   status     → pending | received | discrepancy  (optional)
//   unmatched  → 'true' → only rows where lead_id IS NULL (no client matched)
//   page       → number (default: 1)
//   limit      → number (default: 20, max: 200)
router.get("/etransfers", async (req, res) => {
  try {
    const from =
      req.query.from ||
      new Date(new Date().getFullYear(), 0, 1).toISOString().split("T")[0];
    const to = req.query.to || new Date().toISOString().split("T")[0];
    const status = req.query.status || null;
    const unmatchedOnly = req.query.unmatched === "true";
    const page = Math.max(1, Number(req.query.page || 1));
    const limit = Math.min(200, Math.max(1, Number(req.query.limit || 20)));
    const search = req.query.search?.trim().toLowerCase() || null;
    const offset = (page - 1) * limit;

    // ── Step 1: count ──────────────────────────────────────────────────────
    let countQ = supabase
      .from("etransfers")
      .select("id", { count: "exact", head: true })
      .gte("received_at", from)
      .lte("received_at", to + "T23:59:59Z");
    if (status) countQ = countQ.eq("status", status);
    if (unmatchedOnly)
      countQ = countQ.is("lead_id", null).is("client_id", null);
    if (search) countQ = countQ.ilike("sender_name", `%${search}%`);
    const { count, error: countErr } = await countQ;
    if (countErr) throw new Error(`etransfers count: ${countErr.message}`);

    const total = count ?? 0;

    if (total === 0 || offset >= total) {
      return res.json({
        ok: true,
        from,
        to,
        summary: {
          total: 0,
          received: 0,
          pending: 0,
          discrepancy: 0,
          totalAmount: 0,
        },
        etransfers: [],
        pagination: {
          total,
          page,
          limit,
          pages: Math.ceil(total / limit) || 0,
        },
      });
    }

    // ── Step 2: data with joins ────────────────────────────────────────────
    let dataQ = supabase
      .from("etransfers")
      .select(
        `
        id,
        message_id,
        received_at,
        sender_name,
        amount,
        status,
        match_confidence,
        doc_number,
        invoice_id,
        payment_id,
        synced_at,
        lead_id,
        client_id,
        leads ( id, full_name, email ),
        client:clients ( id, first_name, last_name ),
        invoice:invoices ( id, doc_number, total_amount, balance, due_date, status )
      `,
      )
      .gte("received_at", from)
      .lte("received_at", to + "T23:59:59Z")
      .order("received_at", { ascending: false })
      .range(offset, offset + limit - 1);
    if (status) dataQ = dataQ.eq("status", status);
    if (unmatchedOnly) dataQ = dataQ.is("lead_id", null).is("client_id", null);
    if (search) dataQ = dataQ.ilike("sender_name", `%${search}%`);

    const { data: rows, error: dataErr } = await dataQ;
    if (dataErr) throw new Error(`etransfers data: ${dataErr.message}`);

    // ── Step 3: summary (full range, not just this page) ──────────────────
    let sumQ = supabase
      .from("etransfers")
      .select("amount, status")
      .gte("received_at", from)
      .lte("received_at", to + "T23:59:59Z");
    if (status) sumQ = sumQ.eq("status", status);
    if (unmatchedOnly) sumQ = sumQ.is("lead_id", null).is("client_id", null);
    if (search) sumQ = sumQ.ilike("sender_name", `%${search}%`);

    const { data: allRows, error: sumErr } = await sumQ;
    if (sumErr) throw new Error(`etransfers summary: ${sumErr.message}`);

    const summary = {
      total: allRows.length,
      received: allRows.filter((r) => r.status === "received").length,
      pending: allRows.filter((r) => r.status === "pending").length,
      discrepancy: allRows.filter((r) => r.status === "discrepancy").length,
      totalAmount: allRows.reduce((s, r) => s + Number(r.amount), 0),
    };

    // ── Step 4: shape rows to match the existing frontend contract ─────────
    const etransfers = rows.map((r) => ({
      id: r.id,
      date: r.received_at,
      senderName: r.sender_name,
      received: Number(r.amount),
      status: r.status,
      matchConfidence: r.match_confidence,
      paymentId: r.payment_id ?? null,
      client: r.leads
        ? { id: r.leads.id, name: r.leads.full_name }
        : r.client
          ? {
              id: r.client.id,
              name: `${r.client.first_name ?? ""} ${r.client.last_name ?? ""}`.trim(),
            }
          : null,
      linkedInvoice: r.invoice
        ? {
            id: r.invoice.id,
            docNumber: r.invoice.doc_number ?? r.doc_number,
            total: r.invoice.total_amount,
            balance: r.invoice.balance,
            dueDate: r.invoice.due_date,
          }
        : r.doc_number
          ? { docNumber: r.doc_number }
          : null,
    }));

    return res.json({
      ok: true,
      from,
      to,
      summary,
      etransfers,
      pagination: { total, page, limit, pages: Math.ceil(total / limit) },
    });
  } catch (err) {
    console.error("❌ /etransfers:", err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ─── POST /api/quickbooks/etransfers/sync ────────────────────────────────────
// Triggers an on-demand e-transfer sync from Gmail.
// Accepts optional body: { from: "YYYY-MM-DD", dryRun: true }
router.post("/etransfers/sync", async (req, res) => {
  try {
    const { from, dryRun = false } = req.body ?? {};
    const stats = await runEtransferSyncJob({ fromDate: from, dryRun });
    return res.json({ ok: true, ...stats });
  } catch (err) {
    console.error("❌ /etransfers/sync:", err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

export default router;
