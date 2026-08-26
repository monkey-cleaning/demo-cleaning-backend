import { Router } from "express";
import {
  getPayments,
  getPaymentById,
  getPaymentsSummary,
} from "../services/paymentService.js";
import { requireAdmin } from "../middleware/requireAdmin.js";
import { getPendingReview, resolveAllocation } from "../services/paymentReconciliationService.js";

const router = Router();

router.use(requireAdmin);

/**
 * GET /api/payments/summary
 * Totales y agrupados por mes para el dashboard.
 *
 * Query params:
 *   from  → YYYY-MM-DD
 *   to    → YYYY-MM-DD
 */
router.get("/summary", async (req, res) => {
  try {
    const { from, to } = req.query;
    const summary = await getPaymentsSummary({ from, to });
    return res.json(summary);
  } catch (err) {
    console.error("❌ GET /api/payments/summary:", err.message);
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/payments/pending-review
 * Cola global de allocations pendientes (para AdminPaymentsPage).
 */
router.get("/pending-review", async (req, res) => {
  try {
    const items = await getPendingReview();
    return res.json({ ok: true, count: items.length, items });
  } catch (err) {
    console.error("❌ GET /api/payments/pending-review:", err.message);
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/payments/allocations/:id/resolve
 * Body: { allocation_type: 'invoice_payment'|'tip'|'credit_balance', invoice_id?, note? }
 */
router.post("/allocations/:id/resolve", async (req, res) => {
  try {
    const { allocation_type, invoice_id, note } = req.body;
    const resolved = await resolveAllocation(req.params.id, {
      allocation_type,
      invoice_id,
      note,
      created_by: "admin", // sin tabla de usuarios todavía
    });
    return res.json({ ok: true, allocation: resolved });
  } catch (err) {
    console.error(
      "❌ POST /api/payments/allocations/:id/resolve:",
      err.message,
    );
    res.status(400).json({ error: err.message });
  }
});

/**
 * GET /api/payments
 * Lista payments con filtros opcionales.
 *
 * Query params:
 *   lead_id  → UUID
 *   status   → completed | pending | failed | refunded
 *   method   → 'Credit Card' | 'e-Transfer' | any raw payment_method value
 *   from     → YYYY-MM-DD
 *   to       → YYYY-MM-DD
 *   page     → número de página (default: 1)
 *   limit    → registros por página (default: 20)
 */
router.get("/", async (req, res) => {
  try {
    const {
      lead_id,
      status,
      method,
      from,
      to,
      search,
      page = 1,
      limit = 20,
    } = req.query;

    const result = await getPayments({
      lead_id,
      status,
      method,
      from,
      to,
      search,
      page: Number(page),
      limit: Number(limit),
    });
    return res.json(result);
  } catch (err) {
    console.error("❌ GET /api/payments:", err.message);
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/payments/:id
 * Detalle de un payment con sus invoices linkeadas y lead asociado.
 */
router.get("/:id", async (req, res) => {
  try {
    const payment = await getPaymentById(req.params.id);
    if (!payment)
      return res.status(404).json({ error: "Payment no encontrado" });
    return res.json(payment);
  } catch (err) {
    console.error("❌ GET /api/payments/:id:", err.message);
    res.status(500).json({ error: err.message });
  }
});

export default router;
