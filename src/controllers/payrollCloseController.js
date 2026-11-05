// controllers/payrollCloseController.js
// POST /api/admin/payroll/close  body: { year, month, half }
// Cierra la quincena: guarda un snapshot inmutable del resumen admin y de las
// tarjetas (misma forma que devuelven sus GET, capturada llamando a los mismos
// handlers) y desde ahí la quincena se sirve congelada. Ver migración
// 20260925_payroll_closings.sql y middleware/payrollPeriodLock.js.
import { DateTime } from "luxon";
import {
  getAdminPayrollSummary,
  getExpenses,
  getDividends,
  getDeductions,
  getBonuses,
  getTips,
  getNewServices,
  getChecklist,
  getPaymentPlans,
  getPartnerExtras,
  getCreditCard,
} from "./payrollController.js";
import { getClosing, createClosing, periodFrom } from "../services/payrollClosingsService.js";
import { TZ } from "../config/timezone.js";


// Corre un handler de Express sin request real y devuelve el JSON que respondería.
export async function captureJson(handler, query) {
  let body;
  let statusCode = 200;
  const res = {
    status(code) {
      statusCode = code;
      return res;
    },
    json(payload) {
      body = payload;
      return res;
    },
  };
  await handler({ query, body: {}, params: {}, admin: {} }, res);
  if (statusCode >= 400) {
    throw new Error(body?.error ?? `handler failed with status ${statusCode}`);
  }
  return body;
}

// Qué se congela, y con qué handler. `summary` va aparte (es el resumen admin).
const SECTIONS = {
  expenses: getExpenses,
  dividends: getDividends,
  deductions: getDeductions,
  bonuses: getBonuses,
  tips: getTips,
  newServices: getNewServices,
  checklist: getChecklist,
  paymentPlans: getPaymentPlans,
  partnerExtras: getPartnerExtras,
  creditCard: getCreditCard,
};

export async function buildSnapshot(period) {
  const query = { year: String(period.year), month: String(period.month), half: String(period.half) };
  const summary = await captureJson(getAdminPayrollSummary, query);
  const sections = {};
  for (const [key, handler] of Object.entries(SECTIONS)) {
    sections[key] = await captureJson(handler, query);
  }
  return { version: 1, capturedAt: new Date().toISOString(), summary, sections };
}

export async function postClosePeriod(req, res) {
  try {
    const period = periodFrom(req.body);
    if (!period) return res.status(400).json({ ok: false, error: "year, month and half are required" });

    // No se cierra una quincena que todavía no empezó.
    const start = DateTime.fromObject(
      { year: period.year, month: period.month, day: period.half === 1 ? 1 : 16 },
      { zone: TZ },
    );
    if (start > DateTime.now().setZone(TZ)) {
      return res.status(400).json({ ok: false, error: "This fortnight hasn't started yet" });
    }

    if (await getClosing(period)) {
      return res.status(409).json({ ok: false, closed: true, error: "This fortnight is already closed" });
    }

    const snapshot = await buildSnapshot(period);
    const closing = await createClosing({
      ...period,
      closedBy: req.admin?.user ?? "admin",
      snapshot,
    });
    return res.status(201).json({ ok: true, closing });
  } catch (e) {
    console.error("❌ postClosePeriod:", e.message);
    const status = e.code === "23505" ? 409 : 500;
    return res.status(status).json({ ok: false, error: e.message });
  }
}
