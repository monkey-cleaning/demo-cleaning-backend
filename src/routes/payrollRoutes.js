import { Router } from "express";
import { requireAdmin } from "../middleware/requireAdmin.js";
import { lock, serveFrozen, fromBody, fromQuery, fromRow } from "../middleware/payrollPeriodLock.js";
import { periodOfRow } from "../services/payrollClosingsService.js";
import { postClosePeriod } from "../controllers/payrollCloseController.js";
import {
  getAdminPayrollSummary,
  getAnnualSummary,
  updateTravelSlot,
  updateClientBilling,
  getExpenses,
  postExpense,
  patchExpense,
  deleteExpenseHandler,
  getPinnedConcepts,
  putPinnedConcepts,
  getDividends,
  postDividend,
  deleteDividendHandler,
  getDeductions,
  postDeduction,
  deleteDeductionHandler,
  updateClientRate,
  getBonuses,
  postBonus,
  patchBonus,
  deleteBonusHandler,
  getTips,
  postTip,
  patchTip,
  deleteTipHandler,
  putNetPay,
  deleteNetPay,
  getCreditCard,
  putCreditCard,
  deleteCreditCard,
  getNewServices,
  getDetectedNewClients,
  postNewService,
  patchNewService,
  deleteNewServiceHandler,
  getChecklist,
  postChecklistItem,
  patchChecklistItem,
  deleteChecklistItemHandler,
  putChecklistStatus,
  getPaymentPlans,
  putPaymentPlan,
  deletePaymentPlanHandler,
  postCopyPreviousPlans,
  getPartners,
  postPartner,
  patchPartner,
  deletePartnerHandler,
  getPartnerExtras,
  postPartnerExtra,
  patchPartnerExtra,
  patchDividend,
  patchDeduction,
  deletePartnerExtraHandler,
} from "../controllers/payrollController.js";

// LAB428 — resumen quincenal (eventos/horas/traslado/dinero) de TODOS los
// empleados, protegido por requireAdmin. Todo lo demás (travel-slot,
// client-billing, gastos, dividendos, deducciones, bonos, propinas, NET PAY,
// servicios nuevos, checklist y planes de pago) son las escrituras de la
// pestaña Payroll — ninguna tiene equivalente de staff.
const r = Router();
// Una quincena CERRADA se sirve congelada (serveFrozen) y rechaza escrituras (lock).
// travel-slot / client-billing / client-rate son ediciones por evento, sin período
// en el request: la UI las deshabilita en una quincena cerrada y el snapshot no cambia.
r.get("/summary", requireAdmin, serveFrozen("summary"), getAdminPayrollSummary);
// Resumen Anual: cruza varias quincenas (algunas cerradas, otras no) — no
// tiene un solo período para el lock/frozen-gate, así que no lleva ninguno.
r.get("/annual-summary", requireAdmin, getAnnualSummary);
r.post("/close", requireAdmin, postClosePeriod);
r.patch("/travel-slot", requireAdmin, updateTravelSlot);
r.patch("/client-billing", requireAdmin, updateClientBilling);
r.get("/expenses", requireAdmin, serveFrozen("sections->expenses"), getExpenses);
r.post("/expenses", requireAdmin, lock(fromBody), postExpense);
r.patch("/expenses/:id", requireAdmin, lock(fromBody), patchExpense);
r.delete(
  "/expenses/:id",
  requireAdmin,
  // Fijo: el período viene en el query; puntual: es el de la fila.
  lock((req) => (req.query.fixed === "true" ? fromQuery(req) : periodOfRow("payroll_expenses", req.params.id))),
  deleteExpenseHandler,
);
r.get("/pinned-concepts", requireAdmin, getPinnedConcepts);
r.put("/pinned-concepts", requireAdmin, putPinnedConcepts);
r.get("/dividends", requireAdmin, serveFrozen("sections->dividends"), getDividends);
r.post("/dividends", requireAdmin, lock(fromBody), postDividend);
r.patch("/dividends/:id", requireAdmin, lock(fromRow("payroll_dividends")), patchDividend);
r.delete("/dividends/:id", requireAdmin, lock(fromRow("payroll_dividends")), deleteDividendHandler);
r.get("/deductions", requireAdmin, serveFrozen("sections->deductions"), getDeductions);
r.post("/deductions", requireAdmin, lock(fromBody), postDeduction);
r.patch("/deductions/:id", requireAdmin, lock(fromRow("payroll_deductions")), patchDeduction);
r.delete("/deductions/:id", requireAdmin, lock(fromRow("payroll_deductions")), deleteDeductionHandler);
r.patch("/client-rate", requireAdmin, updateClientRate);

// Cierre de quincena (2026-09-23)
r.get("/bonuses", requireAdmin, serveFrozen("sections->bonuses"), getBonuses);
r.post("/bonuses", requireAdmin, lock(fromBody), postBonus);
r.patch("/bonuses/:id", requireAdmin, lock(fromRow("payroll_bonuses")), patchBonus);
r.delete("/bonuses/:id", requireAdmin, lock(fromRow("payroll_bonuses")), deleteBonusHandler);
r.get("/tips", requireAdmin, serveFrozen("sections->tips"), getTips);
r.post("/tips", requireAdmin, lock(fromBody), postTip);
r.patch("/tips/:id", requireAdmin, lock(fromRow("payroll_tips")), patchTip);
r.delete("/tips/:id", requireAdmin, lock(fromRow("payroll_tips")), deleteTipHandler);
r.put("/net-pay", requireAdmin, lock(fromBody), putNetPay);
r.delete("/net-pay", requireAdmin, lock(fromQuery), deleteNetPay);
r.get("/credit-card", requireAdmin, serveFrozen("sections->creditCard"), getCreditCard);
r.put("/credit-card", requireAdmin, lock(fromBody), putCreditCard);
r.delete("/credit-card", requireAdmin, lock(fromQuery), deleteCreditCard);
r.get("/new-services", requireAdmin, serveFrozen("sections->newServices"), getNewServices);
r.get("/new-services/detected", requireAdmin, serveFrozen("sections->newServices", { emptyBody: { ok: true, detected: [] } }), getDetectedNewClients);
r.post("/new-services", requireAdmin, lock(fromBody), postNewService);
r.patch("/new-services/:id", requireAdmin, lock(fromRow("payroll_new_services")), patchNewService);
r.delete("/new-services/:id", requireAdmin, lock(fromRow("payroll_new_services")), deleteNewServiceHandler);
r.get("/checklist", requireAdmin, serveFrozen("sections->checklist"), getChecklist);
r.post("/checklist/items", requireAdmin, lock(fromBody), postChecklistItem);
r.patch("/checklist/items/:id", requireAdmin, patchChecklistItem);
r.delete("/checklist/items/:id", requireAdmin, lock(fromQuery), deleteChecklistItemHandler);
r.put("/checklist/status", requireAdmin, lock(fromBody), putChecklistStatus);
r.get("/payment-plans", requireAdmin, serveFrozen("sections->paymentPlans"), getPaymentPlans);
r.put("/payment-plans", requireAdmin, lock(fromBody), putPaymentPlan);
r.delete("/payment-plans", requireAdmin, lock(fromQuery), deletePaymentPlanHandler);
r.post("/payment-plans/copy-previous", requireAdmin, lock(fromBody), postCopyPreviousPlans);
r.get("/partners", requireAdmin, getPartners);
r.post("/partners", requireAdmin, postPartner);
r.patch("/partners/:id", requireAdmin, patchPartner);
r.delete("/partners/:id", requireAdmin, deletePartnerHandler);
r.get("/partner-extras", requireAdmin, serveFrozen("sections->partnerExtras"), getPartnerExtras);
r.post("/partner-extras", requireAdmin, lock(fromBody), postPartnerExtra);
// Fijo: el período viene en el body (desde acá en adelante); puntual: es el de la fila.
r.patch(
  "/partner-extras/:id",
  requireAdmin,
  lock((req) => (req.body?.isFixed ? fromBody(req) : periodOfRow("payroll_partner_extras", req.params.id))),
  patchPartnerExtra,
);
r.delete(
  "/partner-extras/:id",
  requireAdmin,
  lock((req) => (req.query.fixed === "true" ? fromQuery(req) : periodOfRow("payroll_partner_extras", req.params.id))),
  deletePartnerExtraHandler,
);
export default r;
