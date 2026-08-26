import { Router } from "express";
import {
  createDraftInvoice,
  getDraftInvoices,
  getDraftInvoiceById,
  updateDraftInvoice,
  deleteDraftInvoice,
  publishInvoiceToQB,
  sendInvoiceEmail,
} from "../services/invoiceService.js";
import { requireAdmin } from "../middleware/requireAdmin.js";

const router = Router();

router.use(requireAdmin);

/**
 * POST /api/invoices
 * Crea una invoice como draft en Supabase.
 *
 * Body:
 * {
 *   client_id:    string (UUID, requerido),
 *   line_items: [{ description: string, amount: number }],
 *   due_date:     string (YYYY-MM-DD, opcional),
 *   notes:        string (opcional)
 * }
 */
router.post("/", async (req, res) => {
  try {
    const { client_id, line_items, due_date, notes } = req.body;

    if (!client_id) {
      return res.status(400).json({ error: "client_id es requerido" });
    }
    if (!Array.isArray(line_items) || line_items.length === 0) {
      return res.status(400).json({ error: "line_items no puede estar vacío" });
    }
    for (const item of line_items) {
      if (
        !item.description ||
        typeof item.amount !== "number" ||
        item.amount <= 0
      ) {
        return res.status(400).json({
          error:
            "Cada line_item debe tener description (string) y amount (number > 0)",
        });
      }
    }

    const invoice = await createDraftInvoice({
      client_id,
      line_items,
      due_date,
      notes,
    });
    return res.status(201).json(invoice);
  } catch (err) {
    console.error("❌ POST /api/invoices:", err.message);
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/invoices
 * Lista invoices con filtros opcionales.
 *
 * Query params:
 *   status    → draft | published | sent | paid | overdue
 *   client_id → UUID
 *   search    → string (matches customer name or doc number)
 *   from      → YYYY-MM-DD
 *   to        → YYYY-MM-DD
 *   page      → número de página (default: 1)
 *   limit     → registros por página (default: 20)
 */
router.get("/", async (req, res) => {
  try {
    const {
      status,
      client_id,
      search,
      from,
      to,
      page = 1,
      limit = 20,
    } = req.query;

    const result = await getDraftInvoices({
      status,
      client_id,
      search,
      from,
      to,
      page: Number(page),
      limit: Number(limit),
    });

    return res.json(result);
  } catch (err) {
    console.error("❌ GET /api/invoices:", err.message);
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/invoices/:id
 * Detalle de una invoice (incluye line_items).
 */
router.get("/:id", async (req, res) => {
  try {
    const invoice = await getDraftInvoiceById(req.params.id);
    if (!invoice)
      return res.status(404).json({ error: "Invoice no encontrada" });
    return res.json(invoice);
  } catch (err) {
    console.error("❌ GET /api/invoices/:id:", err.message);
    res.status(500).json({ error: err.message });
  }
});

/**
 * PATCH /api/invoices/:id
 * Actualiza una invoice en estado draft.
 * No se puede editar una invoice ya publicada en QB.
 *
 * Body (todos opcionales):
 * {
 *   line_items: [{ description, amount }],
 *   due_date:   string,
 *   notes:      string
 * }
 */
router.patch("/:id", async (req, res) => {
  try {
    const { line_items, due_date, notes } = req.body;

    if (line_items !== undefined) {
      if (!Array.isArray(line_items) || line_items.length === 0) {
        return res
          .status(400)
          .json({ error: "line_items no puede estar vacío" });
      }
      for (const item of line_items) {
        if (
          !item.description ||
          typeof item.amount !== "number" ||
          item.amount <= 0
        ) {
          return res.status(400).json({
            error: "Cada line_item debe tener description y amount > 0",
          });
        }
      }
    }

    const updated = await updateDraftInvoice(req.params.id, {
      line_items,
      due_date,
      notes,
    });
    return res.json(updated);
  } catch (err) {
    console.error("❌ PATCH /api/invoices/:id:", err.message);
    if (err.message.includes("solo se pueden editar")) {
      return res.status(409).json({ error: err.message });
    }
    res.status(500).json({ error: err.message });
  }
});

/**
 * DELETE /api/invoices/:id
 * Elimina una invoice. Solo permite borrar drafts.
 */
router.delete("/:id", async (req, res) => {
  try {
    await deleteDraftInvoice(req.params.id);
    return res.json({ success: true });
  } catch (err) {
    console.error("❌ DELETE /api/invoices/:id:", err.message);
    if (err.message.includes("solo se pueden eliminar")) {
      return res.status(409).json({ error: err.message });
    }
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/invoices/:id/publish
 * Envía la invoice a QuickBooks y la marca como "published".
 *
 * Pasos internos:
 *  1. Trae el cliente vinculado para obtener el customer de QB (o lo crea).
 *  2. Crea la invoice en QB via createInvoice().
 *  3. Guarda el quickbooks_invoice_id en Supabase y cambia status → "published".
 */
router.post("/:id/publish", async (req, res) => {
  try {
    const published = await publishInvoiceToQB(req.params.id);
    return res.json(published);
  } catch (err) {
    console.error("❌ POST /api/invoices/:id/publish:", err.message);
    if (err.message.includes("ya fue publicada")) {
      return res.status(409).json({ error: err.message });
    }
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/invoices/:id/send
 * Envía la invoice por email al cliente vía QuickBooks.
 * La invoice debe estar en status "published" primero.
 */
router.post("/:id/send", async (req, res) => {
  try {
    const result = await sendInvoiceEmail(req.params.id);
    return res.json(result);
  } catch (err) {
    console.error("❌ POST /api/invoices/:id/send:", err.message);
    if (err.message.includes("debe estar publicada")) {
      return res.status(409).json({ error: err.message });
    }
    res.status(500).json({ error: err.message });
  }
});

export default router;
