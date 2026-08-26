import { Router } from "express";
import {
  getAuthorizationUrl,
  handleCallback,
  getInvoicesSince
} from "../services/quickbooksService.js";

const router = Router();

// GET /auth/quickbooks  → redirige a Intuit para autorizar
router.get("/quickbooks", (req, res) => {
  const url = getAuthorizationUrl();
  res.redirect(url);
  console.log(url);
});

// GET /auth/quickbooks/callback  → Intuit redirige acá con el code
router.get("/quickbooks/callback", async (req, res) => {
  if (req.query.error) {
    return res.status(400).json({
      error: req.query.error,
      message: "Authorization denied by Intuit",
    });
  }

  try {
    const fullUrl = `${req.protocol}://${req.get("host")}${req.originalUrl}`;
    const token = await handleCallback(fullUrl);
    res.json({ success: true, realmId: token.realmId });
  } catch (err) {
    console.error("❌ QuickBooks callback error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

router.get('/quickbooks/invoices', async (req, res) => {
  try {
    const from = req.query.from || '2026-01-01';
    const invoices = await getInvoicesSince(from);
    res.json({ total: invoices.length, invoices });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
