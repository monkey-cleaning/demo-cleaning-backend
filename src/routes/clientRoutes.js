import express from "express";
import { requireAdmin } from "../middleware/requireAdmin.js";
import {
  listClients,
  getClient,
  createClient,
  updateClient,
  deleteClient,
  searchClients,
  refreshClientStatuses,
  getClientAppointments,
  getClientPreferences,
  getClientBilling,
  getClientPendingReview,
  getClientOpenInvoicesHandler,
  exportClientBilling,
} from "../controllers/clientController.js";

const router = express.Router();

// All routes require admin auth
router.use(requireAdmin);

// Typeahead search — must be before /:id to avoid route conflict
router.get("/search", searchClients);

// on-demand status refresh (also runs nightly via cron)
router.post("/refresh-status", refreshClientStatuses);

// CRUD
router.get("/",     listClients);
router.post("/",    createClient);
router.get("/:id/appointments", getClientAppointments);
router.get("/:id/pending-review", getClientPendingReview);
router.get("/:id/preferences",  getClientPreferences);
router.get("/:id/billing",      getClientBilling);
router.get("/:id/export", exportClientBilling);
router.get("/:id/open-invoices", getClientOpenInvoicesHandler);
router.get("/:id",  getClient);
router.patch("/:id", updateClient);
router.delete("/:id", deleteClient);

export default router;