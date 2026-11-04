// controllers/payrollController.js
// LAB428 — pestaña "Payroll": resumen quincenal de eventos/horas/traslado/
// dinero. Dos handlers sobre el mismo service — el gating de plata y de
// "solo mis propios datos" es estructural (qué handler corre según el
// middleware de auth), no un flag de query ni algo que decida el frontend.
import { supabase } from "../supabaseClient.js";
import {
  computePayrollSummary,
  setTravelSlotOverride,
  setClientBillingOverride,
  setClientRateForEvent,
  setEventOnlyRate,
  stripMoney,
  buildAnnualSummary,
} from "../services/payrollSummaryService.js";
import { DateTime } from "luxon";
import {
  EXPENSE_CATEGORIES,
  listExpenses,
  createExpense,
  updateExpense,
  deleteExpense,
  listPinnedConcepts,
  setPinnedConcepts,
} from "../services/payrollExpensesService.js";
import {
  getCreditCardBalance,
  setCreditCardBalance,
  deleteCreditCardBalance,
} from "../services/payrollCreditCardService.js";
import {
  listDividends,
  createDividend,
  updateDividend,
  clientExists,
  deleteDividend,
  listDeductions,
  createDeduction,
  updateDeduction,
  deleteDeduction,
  listBonuses,
  createBonus,
  updateBonus,
  deleteBonus,
  listTips,
  createTip,
  updateTip,
  deleteTip,
  setNetPayOverride,
  clearNetPayOverride,
} from "../services/payrollAdjustmentsService.js";
import {
  listChecklist,
  createChecklistItem,
  renameChecklistItem,
  deleteChecklistItem,
  setChecklistStatus,
  NEW_SERVICE_FREQUENCIES,
  listNewServices,
  detectNewClients,
  createNewService,
  updateNewService,
  deleteNewService,
} from "../services/payrollClosingService.js";
import {
  listPaymentPlans,
  upsertPaymentPlan,
  deletePaymentPlan,
  copyPreviousPaymentPlans,
} from "../services/payrollPaymentPlanService.js";
import {
  listPartners,
  createPartner,
  updatePartner,
  deactivatePartner,
  listPartnerExtras,
  createPartnerExtra,
  updatePartnerExtra,
  deletePartnerExtra,
} from "../services/payrollPartnersService.js";
import { TZ } from "../config/timezone.js";


function parsePeriodQuery(query) {
  const year = parseInt(query.year, 10);
  const month = parseInt(query.month, 10);
  const half = parseInt(query.half, 10);

  if (!Number.isInteger(year) || year < 2000 || year > 2100) {
    return { error: "year must be a valid 4-digit year" };
  }
  if (!Number.isInteger(month) || month < 1 || month > 12) {
    return { error: "month must be between 1 and 12" };
  }
  if (half !== 1 && half !== 2) {
    return { error: "half must be 1 or 2" };
  }
  return { year, month, half };
}

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/admin/payroll/summary?year=&month=&half=
// Requiere requireAdmin. Devuelve TODOS los empleados activos, con plata y
// con el detalle de travelSlots por tramo (editable — ver updateTravelSlot).
// ─────────────────────────────────────────────────────────────────────────────
export async function getAdminPayrollSummary(req, res) {
  try {
    const parsed = parsePeriodQuery(req.query);
    if (parsed.error) {
      return res.status(400).json({ ok: false, error: parsed.error });
    }

    const summary = await computePayrollSummary({
      ...parsed,
      includeTravelSlots: true,
    });
    return res.json(summary);
  } catch (e) {
    console.error("❌ getAdminPayrollSummary:", e.message);
    return res.status(500).json({ ok: false, error: e.message });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/admin/payroll/annual-summary?year=
// Requiere requireAdmin. Réplica de la hoja "Resumen_Anual" del Excel: los
// 12 meses del año, cada uno la suma de sus dos quincenas (cerrada → del
// snapshot; abierta → calculada en vivo). Un mes sin quincenas arrancadas
// todavía vuelve con `hasData: false` (igual que el Excel lo deja en blanco).
// ─────────────────────────────────────────────────────────────────────────────
export async function getAnnualSummary(req, res) {
  try {
    const year = parseInt(req.query.year, 10) || DateTime.now().setZone(TZ).year;
    if (!Number.isInteger(year) || year < 2000 || year > 2100) {
      return res.status(400).json({ ok: false, error: "year must be a valid 4-digit year" });
    }
    const { rows, total } = await buildAnnualSummary(year);
    return res.json({ ok: true, year, months: rows, total });
  } catch (e) {
    console.error("❌ getAnnualSummary:", e.message);
    return res.status(500).json({ ok: false, error: e.message });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// PATCH /api/admin/payroll/travel-slot
// Body: { employeeId, prevEventId, nextEventId, appliedHours, calculatedHours? }
// Requiere requireAdmin. Carga a mano cuántas horas de traslado corresponden
// para un tramo puntual que quedó "para revisión manual" (hueco calculado
// >= 1h). No hay endpoint de staff equivalente — un cleaner nunca ve ni edita
// esto (pedido explícito 2026-09-16).
// ─────────────────────────────────────────────────────────────────────────────
export async function updateTravelSlot(req, res) {
  try {
    const { employeeId, prevEventId, nextEventId, appliedHours, calculatedHours } =
      req.body || {};

    if (!employeeId || !prevEventId || !nextEventId) {
      return res.status(400).json({
        ok: false,
        error: "employeeId, prevEventId and nextEventId are required",
      });
    }

    const hours = Number(appliedHours);
    if (!Number.isFinite(hours) || hours < 0) {
      return res
        .status(400)
        .json({ ok: false, error: "appliedHours must be a non-negative number" });
    }

    await setTravelSlotOverride({
      employeeId,
      prevEventId,
      nextEventId,
      appliedHours: hours,
      calculatedHours:
        calculatedHours != null ? Number(calculatedHours) : null,
      reviewedBy: req.admin?.user ?? "admin",
    });

    return res.json({ ok: true });
  } catch (e) {
    console.error("❌ updateTravelSlot:", e.message);
    return res.status(500).json({ ok: false, error: e.message });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// PATCH /api/admin/payroll/client-billing
// Body: { eventId, appliedAmount, calculatedAmount? }
// Requiere requireAdmin. Corrige a mano el monto facturado al cliente por un
// evento puntual — el monto calculado es solo una referencia (no hay forma
// de reconstruir el monto cotizado real, ver comentario en
// payrollSummaryService.js). No hay endpoint de staff equivalente.
// ─────────────────────────────────────────────────────────────────────────────
export async function updateClientBilling(req, res) {
  try {
    const { eventId, appliedAmount, calculatedAmount } = req.body || {};

    if (!eventId) {
      return res.status(400).json({ ok: false, error: "eventId is required" });
    }

    const amount = Number(appliedAmount);
    if (!Number.isFinite(amount) || amount < 0) {
      return res
        .status(400)
        .json({ ok: false, error: "appliedAmount must be a non-negative number" });
    }

    await setClientBillingOverride({
      eventId,
      appliedAmount: amount,
      calculatedAmount: calculatedAmount != null ? Number(calculatedAmount) : null,
      reviewedBy: req.admin?.user ?? "admin",
    });

    return res.json({ ok: true });
  } catch (e) {
    console.error("❌ updateClientBilling:", e.message);
    return res.status(500).json({ ok: false, error: e.message });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/admin/payroll/expenses?year=&month=&half=
// POST /api/admin/payroll/expenses  body: { year, month, half, concept, category, amount }
// DELETE /api/admin/payroll/expenses/:id
// Requiere requireAdmin — no hay equivalente de staff, los gastos operativos
// del negocio no son un dato de cleaners. Categorías fijas: ver
// EXPENSE_CATEGORIES (financial/operational/administrative).
// ─────────────────────────────────────────────────────────────────────────────
export async function getExpenses(req, res) {
  try {
    const parsed = parsePeriodQuery(req.query);
    if (parsed.error) {
      return res.status(400).json({ ok: false, error: parsed.error });
    }
    const result = await listExpenses(parsed);
    return res.json({ ok: true, ...result });
  } catch (e) {
    console.error("❌ getExpenses:", e.message);
    return res.status(500).json({ ok: false, error: e.message });
  }
}

export async function postExpense(req, res) {
  try {
    const { year, month, half, concept, category, amount, isFixed } = req.body || {};
    const parsed = parsePeriodQuery({ year, month, half });
    if (parsed.error) {
      return res.status(400).json({ ok: false, error: parsed.error });
    }

    if (typeof concept !== "string" || !concept.trim()) {
      return res.status(400).json({ ok: false, error: "concept is required" });
    }
    if (!EXPENSE_CATEGORIES.includes(category)) {
      return res.status(400).json({
        ok: false,
        error: `category must be one of: ${EXPENSE_CATEGORIES.join(", ")}`,
      });
    }
    const amt = Number(amount);
    if (!Number.isFinite(amt) || amt < 0) {
      return res
        .status(400)
        .json({ ok: false, error: "amount must be a non-negative number" });
    }

    const expense = await createExpense({
      ...parsed,
      concept: concept.trim(),
      category,
      amount: amt,
      createdBy: req.admin?.user ?? "admin",
      isFixed: Boolean(isFixed),
    });
    return res.status(201).json({ ok: true, expense });
  } catch (e) {
    console.error("❌ postExpense:", e.message);
    return res.status(500).json({ ok: false, error: e.message });
  }
}

// PATCH /api/admin/payroll/expenses/:id
// Body: { isFixed, makeFixed?, year, month, half, concept, category, amount }
// Un gasto FIJO se edita "desde esta quincena en adelante" (ver
// updateExpense en payrollExpensesService.js). `isFixed` es el tipo ACTUAL de
// la fila; `makeFixed` (opcional) es el tipo al que se la quiere pasar.
export async function patchExpense(req, res) {
  try {
    const { id } = req.params;
    const { isFixed, makeFixed, year, month, half, concept, category, amount } = req.body || {};
    const parsed = parsePeriodQuery({ year, month, half });
    if (parsed.error) {
      return res.status(400).json({ ok: false, error: parsed.error });
    }
    if (typeof concept !== "string" || !concept.trim()) {
      return res.status(400).json({ ok: false, error: "concept is required" });
    }
    if (!EXPENSE_CATEGORIES.includes(category)) {
      return res.status(400).json({
        ok: false,
        error: `category must be one of: ${EXPENSE_CATEGORIES.join(", ")}`,
      });
    }
    const amt = Number(amount);
    if (!Number.isFinite(amt) || amt < 0) {
      return res
        .status(400)
        .json({ ok: false, error: "amount must be a non-negative number" });
    }
    const expense = await updateExpense({
      id,
      isFixed: Boolean(isFixed),
      makeFixed: typeof makeFixed === "boolean" ? makeFixed : undefined,
      ...parsed,
      concept: concept.trim(),
      category,
      amount: amt,
      updatedBy: req.admin?.user ?? "admin",
    });
    return res.json({ ok: true, expense });
  } catch (e) {
    console.error("❌ patchExpense:", e.message);
    return res.status(500).json({ ok: false, error: e.message });
  }
}

// DELETE /api/admin/payroll/expenses/:id?fixed=true&year=&month=&half=
// Puntual: borra la fila. Fijo (fixed=true): lo da de baja desde esta
// quincena en adelante — las anteriores lo conservan.
export async function deleteExpenseHandler(req, res) {
  try {
    const { id } = req.params;
    if (!id) return res.status(400).json({ ok: false, error: "id is required" });
    const isFixed = req.query.fixed === "true";
    let period = {};
    if (isFixed) {
      period = parsePeriodQuery(req.query);
      if (period.error) {
        return res.status(400).json({ ok: false, error: period.error });
      }
    }
    await deleteExpense({ id, isFixed, ...period });
    return res.json({ ok: true });
  } catch (e) {
    console.error("❌ deleteExpenseHandler:", e.message);
    return res.status(500).json({ ok: false, error: e.message });
  }
}

// GET/PUT /api/admin/payroll/pinned-concepts
// Lista fija de conceptos que la tabla de "gastos relevantes" muestra
// SIEMPRE (aunque el monto de la quincena sea 0). PUT reemplaza la lista.
export async function getPinnedConcepts(_req, res) {
  try {
    return res.json({ ok: true, pinned: await listPinnedConcepts() });
  } catch (e) {
    console.error("❌ getPinnedConcepts:", e.message);
    return res.status(500).json({ ok: false, error: e.message });
  }
}

export async function putPinnedConcepts(req, res) {
  try {
    const { concepts } = req.body || {};
    if (!Array.isArray(concepts)) {
      return res.status(400).json({ ok: false, error: "concepts must be an array of strings" });
    }
    const pinned = await setPinnedConcepts(concepts);
    return res.json({ ok: true, pinned });
  } catch (e) {
    console.error("❌ putPinnedConcepts:", e.message);
    return res.status(500).json({ ok: false, error: e.message });
  }
}

// Dividendos / deducciones — mismo formato que expenses, sin categorías.
// Deducción: además `employeeId` (a quién se le descuenta).
function parseMoneyBody(body) {
  const parsed = parsePeriodQuery(body || {});
  if (parsed.error) return { error: parsed.error };
  const concept = typeof body?.concept === "string" ? body.concept.trim() : "";
  if (!concept) return { error: "concept is required" };
  const amount = Number(body?.amount);
  if (!Number.isFinite(amount) || amount < 0) {
    return { error: "amount must be a non-negative number" };
  }
  return { ...parsed, concept, amount };
}

export async function getDividends(req, res) {
  try {
    const parsed = parsePeriodQuery(req.query);
    if (parsed.error) return res.status(400).json({ ok: false, error: parsed.error });
    return res.json({ ok: true, ...(await listDividends(parsed)) });
  } catch (e) {
    console.error("❌ getDividends:", e.message);
    return res.status(500).json({ ok: false, error: e.message });
  }
}

export async function postDividend(req, res) {
  try {
    const parsed = parseMoneyBody(req.body);
    if (parsed.error) return res.status(400).json({ ok: false, error: parsed.error });
    const partnerId = req.body?.partnerId || null;
    if (partnerId && !isUuid(partnerId)) {
      return res.status(400).json({ ok: false, error: "partnerId must be a valid id" });
    }
    const dividend = await createDividend({
      ...parsed,
      partnerId,
      createdBy: req.admin?.user ?? "admin",
    });
    return res.status(201).json({ ok: true, dividend });
  } catch (e) {
    console.error("❌ postDividend:", e.message);
    return res.status(500).json({ ok: false, error: e.message });
  }
}

// Edición de un dividendo / deducción / extra: mismos campos y validaciones que
// el alta, sin el período (la fila no cambia de quincena).
function parseMoneyPatch(body) {
  const concept = typeof body?.concept === "string" ? body.concept.trim() : "";
  if (!concept) return { error: "concept is required" };
  const amount = Number(body?.amount);
  if (!Number.isFinite(amount) || amount < 0) {
    return { error: "amount must be a non-negative number" };
  }
  return { concept, amount };
}

export async function patchDividend(req, res) {
  try {
    const parsed = parseMoneyPatch(req.body);
    if (parsed.error) return res.status(400).json({ ok: false, error: parsed.error });
    const partnerId = req.body?.partnerId || null;
    if (partnerId && !isUuid(partnerId)) {
      return res.status(400).json({ ok: false, error: "partnerId must be a valid id" });
    }
    const dividend = await updateDividend({ id: req.params.id, ...parsed, partnerId });
    return res.json({ ok: true, dividend });
  } catch (e) {
    console.error("❌ patchDividend:", e.message);
    return res.status(500).json({ ok: false, error: e.message });
  }
}

export async function patchDeduction(req, res) {
  try {
    const parsed = parseMoneyPatch(req.body);
    if (parsed.error) return res.status(400).json({ ok: false, error: parsed.error });
    if (!isUuid(req.body?.employeeId)) {
      return res.status(400).json({ ok: false, error: "employeeId is required" });
    }
    const deduction = await updateDeduction({
      id: req.params.id,
      employeeId: req.body.employeeId,
      ...parsed,
    });
    return res.json({ ok: true, deduction });
  } catch (e) {
    console.error("❌ patchDeduction:", e.message);
    return res.status(500).json({ ok: false, error: e.message });
  }
}

export async function deleteDividendHandler(req, res) {
  try {
    await deleteDividend(req.params.id);
    return res.json({ ok: true });
  } catch (e) {
    console.error("❌ deleteDividendHandler:", e.message);
    return res.status(500).json({ ok: false, error: e.message });
  }
}

export async function getDeductions(req, res) {
  try {
    const parsed = parsePeriodQuery(req.query);
    if (parsed.error) return res.status(400).json({ ok: false, error: parsed.error });
    return res.json({ ok: true, ...(await listDeductions(parsed)) });
  } catch (e) {
    console.error("❌ getDeductions:", e.message);
    return res.status(500).json({ ok: false, error: e.message });
  }
}

export async function postDeduction(req, res) {
  try {
    const parsed = parseMoneyBody(req.body);
    if (parsed.error) return res.status(400).json({ ok: false, error: parsed.error });
    const employeeId = req.body?.employeeId;
    if (!employeeId) {
      return res.status(400).json({ ok: false, error: "employeeId is required" });
    }
    const deduction = await createDeduction({
      ...parsed,
      employeeId,
      createdBy: req.admin?.user ?? "admin",
    });
    return res.status(201).json({ ok: true, deduction });
  } catch (e) {
    console.error("❌ postDeduction:", e.message);
    return res.status(500).json({ ok: false, error: e.message });
  }
}

export async function deleteDeductionHandler(req, res) {
  try {
    await deleteDeduction(req.params.id);
    return res.json({ ok: true });
  } catch (e) {
    console.error("❌ deleteDeductionHandler:", e.message);
    return res.status(500).json({ ok: false, error: e.message });
  }
}

// PATCH /api/admin/payroll/client-rate
// Body: { eventId, hourlyRate, durationH, attendeeCount, eventStartIso, scope? }
// `scope` (2026-09-30): "client" (default, compatibilidad) actualiza
// clients.rate en el CRM (trabajos futuros) y fija el monto de ESTE trabajo
// con la tarifa nueva — ver setClientRateForEvent. "job" fija SOLO este
// trabajo (p. ej. una limpieza de alfombras a otra tarifa) sin tocar la
// tarifa habitual del cliente — ver setEventOnlyRate.
export async function updateClientRate(req, res) {
  try {
    const { eventId, hourlyRate, durationH, attendeeCount, eventStartIso, scope } = req.body || {};
    if (!eventId || !eventStartIso) {
      return res.status(400).json({ ok: false, error: "eventId and eventStartIso are required" });
    }
    const rate = Number(hourlyRate);
    if (!Number.isFinite(rate) || rate < 0) {
      return res.status(400).json({ ok: false, error: "hourlyRate must be a non-negative number" });
    }
    const hours = Number(durationH);
    if (!Number.isFinite(hours) || hours < 0) {
      return res.status(400).json({ ok: false, error: "durationH must be a non-negative number" });
    }
    if (scope !== undefined && scope !== "client" && scope !== "job") {
      return res.status(400).json({ ok: false, error: 'scope must be "client" or "job"' });
    }
    const setRate = scope === "job" ? setEventOnlyRate : setClientRateForEvent;
    const result = await setRate({
      eventId,
      hourlyRate: rate,
      durationH: hours,
      attendeeCount: Number(attendeeCount) || 1,
      eventStartIso,
      reviewedBy: req.admin?.user ?? "admin",
    });
    return res.json({ ok: true, ...result });
  } catch (e) {
    console.error("❌ updateClientRate:", e.message);
    return res.status(e.status ?? 500).json({ ok: false, error: e.message });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Cierre de quincena (2026-09-23): bonos, propinas, NET PAY editable, servicios
// nuevos, checklist y planes de pago ("Pagos Experimental"). Todo admin-only;
// mismo formato que dividendos/deducciones (período en query o body).
// ─────────────────────────────────────────────────────────────────────────────
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isUuid = (v) => typeof v === "string" && UUID_RE.test(v);

// try/catch + log + 500 uniforme; los handlers devuelven 4xx ellos mismos.
const wrap = (name, fn) => async (req, res) => {
  try {
    await fn(req, res);
  } catch (e) {
    console.error(`❌ ${name}:`, e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
};

const fail = (res, error) => res.status(400).json({ ok: false, error });
const adminUser = (req) => req.admin?.user ?? "admin";

// undefined = "no vino" (PATCH parcial); si vino tiene que ser un array de ids.
function parseEmployeeIds(value) {
  if (value === undefined) return { value: undefined };
  if (!Array.isArray(value) || !value.every(isUuid)) {
    return { error: "employeeIds must be an array of valid employee ids" };
  }
  return { value: [...new Set(value)] };
}

function parseAmount(value, { required = true } = {}) {
  if (value === undefined && !required) return { value: undefined };
  const amount = Number(value);
  if (value === "" || value == null || !Number.isFinite(amount) || amount < 0) {
    return { error: "amount must be a non-negative number" };
  }
  return { value: amount };
}

const optionalText = (v) => (typeof v === "string" && v.trim() ? v.trim() : null);

// ── Bonos ──
export const getBonuses = wrap("getBonuses", async (req, res) => {
  const parsed = parsePeriodQuery(req.query);
  if (parsed.error) return fail(res, parsed.error);
  res.json({ ok: true, ...(await listBonuses(parsed)) });
});

export const postBonus = wrap("postBonus", async (req, res) => {
  const parsed = parseMoneyBody(req.body);
  if (parsed.error) return fail(res, parsed.error);
  const appliesToAll = req.body?.appliesToAll === true;
  const ids = parseEmployeeIds(req.body?.employeeIds ?? []);
  if (ids.error) return fail(res, ids.error);
  if (!appliesToAll && !ids.value.length) {
    return fail(res, "pick at least one cleaner, or apply the bonus to all");
  }
  const bonus = await createBonus({
    ...parsed,
    appliesToAll,
    employeeIds: ids.value,
    createdBy: adminUser(req),
  });
  res.status(201).json({ ok: true, bonus });
});

export const patchBonus = wrap("patchBonus", async (req, res) => {
  const { concept, amount, appliesToAll } = req.body || {};
  const patch = { id: req.params.id };
  if (concept !== undefined) {
    if (!optionalText(concept)) return fail(res, "concept is required");
    patch.concept = concept.trim();
  }
  const amt = parseAmount(amount, { required: false });
  if (amt.error) return fail(res, amt.error);
  patch.amount = amt.value;
  if (appliesToAll !== undefined) patch.appliesToAll = appliesToAll === true;
  const ids = parseEmployeeIds(req.body?.employeeIds);
  if (ids.error) return fail(res, ids.error);
  patch.employeeIds = ids.value;
  // Pasar de "todos" a "algunos" sin decir cuáles dejaría un bono que no
  // le llega a nadie.
  if (appliesToAll === false && !ids.value?.length) {
    return fail(res, "pick at least one cleaner, or apply the bonus to all");
  }
  res.json({ ok: true, bonus: await updateBonus(patch) });
});

export const deleteBonusHandler = wrap("deleteBonusHandler", async (req, res) => {
  await deleteBonus(req.params.id);
  res.json({ ok: true });
});

// ── Propinas ──
export const getTips = wrap("getTips", async (req, res) => {
  const parsed = parsePeriodQuery(req.query);
  if (parsed.error) return fail(res, parsed.error);
  res.json({ ok: true, ...(await listTips(parsed)) });
});

export const postTip = wrap("postTip", async (req, res) => {
  const period = parsePeriodQuery(req.body || {});
  if (period.error) return fail(res, period.error);
  const clientName = optionalText(req.body?.clientName);
  if (!clientName) return fail(res, "clientName is required");
  const amt = parseAmount(req.body?.amount);
  if (amt.error) return fail(res, amt.error);
  const ids = parseEmployeeIds(req.body?.employeeIds ?? []);
  if (ids.error) return fail(res, ids.error);
  // La propina se asocia a un cliente real del CRM (elegido o recién creado).
  const clientId = req.body?.clientId || null;
  if (!isUuid(clientId)) return fail(res, "pick an existing client (or create a new one)");
  if (!(await clientExists(clientId))) return fail(res, "client not found");
  const tip = await createTip({
    ...period,
    clientName,
    clientId,
    amount: amt.value,
    note: optionalText(req.body?.note),
    employeeIds: ids.value,
    createdBy: adminUser(req),
  });
  res.status(201).json({ ok: true, tip });
});

export const patchTip = wrap("patchTip", async (req, res) => {
  const { clientName, clientId, amount, note } = req.body || {};
  const patch = { id: req.params.id };
  if (clientName !== undefined) {
    if (!optionalText(clientName)) return fail(res, "clientName is required");
    patch.clientName = clientName.trim();
  }
  if (clientId !== undefined) {
    if (!isUuid(clientId)) return fail(res, "pick an existing client (or create a new one)");
    if (!(await clientExists(clientId))) return fail(res, "client not found");
    patch.clientId = clientId;
  }
  const amt = parseAmount(amount, { required: false });
  if (amt.error) return fail(res, amt.error);
  patch.amount = amt.value;
  if (note !== undefined) patch.note = optionalText(note);
  const ids = parseEmployeeIds(req.body?.employeeIds);
  if (ids.error) return fail(res, ids.error);
  patch.employeeIds = ids.value;
  res.json({ ok: true, tip: await updateTip(patch) });
});

export const deleteTipHandler = wrap("deleteTipHandler", async (req, res) => {
  await deleteTip(req.params.id);
  res.json({ ok: true });
});

// ── NET PAY editable ──
// PUT body: { year, month, half, employeeId, amount, calculated?, note? }
export const putNetPay = wrap("putNetPay", async (req, res) => {
  const period = parsePeriodQuery(req.body || {});
  if (period.error) return fail(res, period.error);
  if (!isUuid(req.body?.employeeId)) return fail(res, "employeeId is required");
  const amt = parseAmount(req.body?.amount);
  if (amt.error) return fail(res, amt.error);
  const calculated = req.body?.calculated != null ? Number(req.body.calculated) : null;
  await setNetPayOverride({
    ...period,
    employeeId: req.body.employeeId,
    amount: amt.value,
    calculated: Number.isFinite(calculated) ? calculated : null,
    note: optionalText(req.body?.note),
    updatedBy: adminUser(req),
  });
  res.json({ ok: true });
});

// Volver al valor calculado: DELETE /net-pay?year=&month=&half=&employeeId=
export const deleteNetPay = wrap("deleteNetPay", async (req, res) => {
  const period = parsePeriodQuery(req.query);
  if (period.error) return fail(res, period.error);
  if (!isUuid(req.query.employeeId)) return fail(res, "employeeId is required");
  await clearNetPayOverride({ ...period, employeeId: req.query.employeeId });
  res.json({ ok: true });
});

// ── Servicios nuevos ──
export const getNewServices = wrap("getNewServices", async (req, res) => {
  const parsed = parsePeriodQuery(req.query);
  if (parsed.error) return fail(res, parsed.error);
  res.json({ ok: true, frequencies: NEW_SERVICE_FREQUENCIES, ...(await listNewServices(parsed)) });
});

export const getDetectedNewClients = wrap("getDetectedNewClients", async (req, res) => {
  const parsed = parsePeriodQuery(req.query);
  if (parsed.error) return fail(res, parsed.error);
  res.json({ ok: true, ...(await detectNewClients(parsed)) });
});

export const postNewService = wrap("postNewService", async (req, res) => {
  const period = parsePeriodQuery(req.body || {});
  if (period.error) return fail(res, period.error);
  const serviceName = optionalText(req.body?.serviceName);
  if (!serviceName) return fail(res, "serviceName is required");
  if (!NEW_SERVICE_FREQUENCIES.includes(req.body?.frequency)) {
    return fail(res, `frequency must be one of: ${NEW_SERVICE_FREQUENCIES.join(", ")}`);
  }
  const clientId = req.body?.clientId || null;
  if (clientId && !isUuid(clientId)) return fail(res, "clientId must be a valid id");
  const newService = await createNewService({
    ...period,
    serviceName,
    clientId,
    frequency: req.body.frequency,
    note: optionalText(req.body?.note),
    createdBy: adminUser(req),
  });
  res.status(201).json({ ok: true, newService });
});

export const patchNewService = wrap("patchNewService", async (req, res) => {
  const { serviceName, clientId, frequency, note } = req.body || {};
  const patch = { id: req.params.id };
  if (serviceName !== undefined) {
    if (!optionalText(serviceName)) return fail(res, "serviceName is required");
    patch.serviceName = serviceName.trim();
  }
  if (frequency !== undefined) {
    if (!NEW_SERVICE_FREQUENCIES.includes(frequency)) {
      return fail(res, `frequency must be one of: ${NEW_SERVICE_FREQUENCIES.join(", ")}`);
    }
    patch.frequency = frequency;
  }
  if (clientId !== undefined) {
    if (clientId && !isUuid(clientId)) return fail(res, "clientId must be a valid id");
    patch.clientId = clientId || null;
  }
  if (note !== undefined) patch.note = optionalText(note);
  res.json({ ok: true, newService: await updateNewService(patch) });
});

export const deleteNewServiceHandler = wrap("deleteNewServiceHandler", async (req, res) => {
  await deleteNewService(req.params.id);
  res.json({ ok: true });
});

// ── Checklist "Chequeo Nomina" ──
export const getChecklist = wrap("getChecklist", async (req, res) => {
  const parsed = parsePeriodQuery(req.query);
  if (parsed.error) return fail(res, parsed.error);
  res.json({ ok: true, ...(await listChecklist(parsed)) });
});

export const postChecklistItem = wrap("postChecklistItem", async (req, res) => {
  const period = parsePeriodQuery(req.body || {});
  if (period.error) return fail(res, period.error);
  const label = optionalText(req.body?.label);
  if (!label) return fail(res, "label is required");
  const item = await createChecklistItem({ ...period, label, createdBy: adminUser(req) });
  res.status(201).json({ ok: true, item });
});

export const patchChecklistItem = wrap("patchChecklistItem", async (req, res) => {
  const label = optionalText(req.body?.label);
  if (!label) return fail(res, "label is required");
  await renameChecklistItem({ id: req.params.id, label });
  res.json({ ok: true });
});

// DELETE /checklist/items/:id?year=&month=&half= — baja desde esa quincena.
export const deleteChecklistItemHandler = wrap("deleteChecklistItemHandler", async (req, res) => {
  const period = parsePeriodQuery(req.query);
  if (period.error) return fail(res, period.error);
  await deleteChecklistItem({ id: req.params.id, ...period });
  res.json({ ok: true });
});

// PUT body: { year, month, half, itemId, done, comment? }
export const putChecklistStatus = wrap("putChecklistStatus", async (req, res) => {
  const period = parsePeriodQuery(req.body || {});
  if (period.error) return fail(res, period.error);
  if (!isUuid(req.body?.itemId)) return fail(res, "itemId is required");
  if (typeof req.body?.done !== "boolean") return fail(res, "done must be true or false");
  await setChecklistStatus({
    ...period,
    itemId: req.body.itemId,
    done: req.body.done,
    comment: optionalText(req.body?.comment),
    updatedBy: adminUser(req),
  });
  res.json({ ok: true });
});

// ── Accionistas y sus extras ──
export const getPartners = wrap("getPartners", async (req, res) => {
  res.json({ ok: true, partners: await listPartners({ includeInactive: req.query.all === "1" }) });
});

export const postPartner = wrap("postPartner", async (req, res) => {
  const name = optionalText(req.body?.name);
  if (!name) return fail(res, "name is required");
  const employeeId = req.body?.employeeId || null;
  if (employeeId && !isUuid(employeeId)) return fail(res, "employeeId must be a valid id");
  res.status(201).json({ ok: true, partner: await createPartner({ name, employeeId }) });
});

export const patchPartner = wrap("patchPartner", async (req, res) => {
  const { name, employeeId, isActive } = req.body || {};
  const patch = { id: req.params.id };
  if (name !== undefined) {
    if (!optionalText(name)) return fail(res, "name is required");
    patch.name = name.trim();
  }
  if (employeeId !== undefined) {
    if (employeeId && !isUuid(employeeId)) return fail(res, "employeeId must be a valid id");
    patch.employeeId = employeeId || null;
  }
  if (isActive !== undefined) patch.isActive = isActive === true;
  res.json({ ok: true, partner: await updatePartner(patch) });
});

// Baja lógica — los dividendos y planes ya cargados siguen apuntando a él.
export const deletePartnerHandler = wrap("deletePartnerHandler", async (req, res) => {
  await deactivatePartner(req.params.id);
  res.json({ ok: true });
});

export const getPartnerExtras = wrap("getPartnerExtras", async (req, res) => {
  const parsed = parsePeriodQuery(req.query);
  if (parsed.error) return fail(res, parsed.error);
  res.json({ ok: true, ...(await listPartnerExtras(parsed)) });
});

export const postPartnerExtra = wrap("postPartnerExtra", async (req, res) => {
  const parsed = parseMoneyBody(req.body);
  if (parsed.error) return fail(res, parsed.error);
  if (!isUuid(req.body?.partnerId)) return fail(res, "partnerId is required");
  const extra = await createPartnerExtra({
    ...parsed,
    partnerId: req.body.partnerId,
    createdBy: adminUser(req),
    isFixed: Boolean(req.body?.isFixed),
  });
  res.status(201).json({ ok: true, extra });
});

// PATCH — puntual: solo concept/amount/partnerId, sin período (la fila no
// cambia de quincena). Fijo: además necesita year/month/half (desde acá en
// adelante), mismo criterio que patchExpense.
export const patchPartnerExtra = wrap("patchPartnerExtra", async (req, res) => {
  const parsed = parseMoneyPatch(req.body);
  if (parsed.error) return fail(res, parsed.error);
  if (!isUuid(req.body?.partnerId)) return fail(res, "partnerId is required");
  const isFixed = Boolean(req.body?.isFixed);
  let period = {};
  if (isFixed) {
    period = parsePeriodQuery(req.body || {});
    if (period.error) return fail(res, period.error);
  }
  const extra = await updatePartnerExtra({
    id: req.params.id,
    isFixed,
    ...period,
    partnerId: req.body.partnerId,
    ...parsed,
    updatedBy: adminUser(req),
  });
  res.json({ ok: true, extra });
});

// DELETE /partner-extras/:id?fixed=true&year=&month=&half= — baja desde esa quincena.
export const deletePartnerExtraHandler = wrap("deletePartnerExtraHandler", async (req, res) => {
  const isFixed = req.query.fixed === "true";
  let period = {};
  if (isFixed) {
    period = parsePeriodQuery(req.query);
    if (period.error) return fail(res, period.error);
  }
  await deletePartnerExtra({ id: req.params.id, isFixed, ...period });
  res.json({ ok: true });
});

// ── Tarjeta de crédito de la empresa (carga manual, 2026-09-30) ──
export const getCreditCard = wrap("getCreditCard", async (req, res) => {
  const parsed = parsePeriodQuery(req.query);
  if (parsed.error) return fail(res, parsed.error);
  res.json({ ok: true, creditCard: await getCreditCardBalance(parsed) });
});

export const putCreditCard = wrap("putCreditCard", async (req, res) => {
  const period = parsePeriodQuery(req.body || {});
  if (period.error) return fail(res, period.error);
  const balance = parseAmount(req.body?.balance);
  if (balance.error) return fail(res, balance.error);
  const paymentAmount = parseAmount(req.body?.paymentAmount ?? 0);
  if (paymentAmount.error) return fail(res, paymentAmount.error);
  const creditCard = await setCreditCardBalance({
    ...period,
    balance: balance.value,
    paymentAmount: paymentAmount.value ?? 0,
    note: optionalText(req.body?.note),
    updatedBy: adminUser(req),
  });
  res.json({ ok: true, creditCard });
});

export const deleteCreditCard = wrap("deleteCreditCard", async (req, res) => {
  const parsed = parsePeriodQuery(req.query);
  if (parsed.error) return fail(res, parsed.error);
  await deleteCreditCardBalance(parsed);
  res.json({ ok: true });
});

// ── Planes de pago ("Pagos Experimental") ──
export const getPaymentPlans = wrap("getPaymentPlans", async (req, res) => {
  const parsed = parsePeriodQuery(req.query);
  if (parsed.error) return fail(res, parsed.error);
  res.json({ ok: true, plans: [...(await listPaymentPlans(parsed)).values()] });
});

const optionalMoney = (v) =>
  v === undefined || v === null || v === "" ? { value: null } : parseAmount(v);

// PUT body: { year, month, half, employeeId, officialNet?, officialGross?,
//             bonusCol?, cashRateFactor?, viaPartnerIds?, note? }
export const putPaymentPlan = wrap("putPaymentPlan", async (req, res) => {
  const period = parsePeriodQuery(req.body || {});
  if (period.error) return fail(res, period.error);
  if (!isUuid(req.body?.employeeId)) return fail(res, "employeeId is required");

  const officialNet = optionalMoney(req.body?.officialNet);
  const officialGross = optionalMoney(req.body?.officialGross);
  const bonusCol = optionalMoney(req.body?.bonusCol);
  for (const m of [officialNet, officialGross, bonusCol]) {
    if (m.error) {
      return fail(res, "officialNet, officialGross and bonusCol must be non-negative numbers");
    }
  }
  const rawFactor = req.body?.cashRateFactor;
  const factor = rawFactor === undefined || rawFactor === null || rawFactor === "" ? 1 : Number(rawFactor);
  if (!Number.isFinite(factor) || factor < 0) {
    return fail(res, "cashRateFactor must be a non-negative number");
  }
  const via = parseEmployeeIds(req.body?.viaPartnerIds ?? []);
  if (via.error) return fail(res, "viaPartnerIds must be an array of valid partner ids");
  if (via.value.length) {
    const partners = await listPartners({ includeInactive: true });
    const byId = new Map(partners.map((p) => [p.id, p]));
    if (via.value.some((id) => !byId.has(id))) return fail(res, "unknown partner in viaPartnerIds");
    if (via.value.some((id) => byId.get(id).employeeId === req.body.employeeId)) {
      return fail(res, "a cleaner can't be paid through themselves");
    }
  }
  const plan = await upsertPaymentPlan({
    ...period,
    employeeId: req.body.employeeId,
    officialNet: officialNet.value,
    officialGross: officialGross.value,
    bonusCol: bonusCol.value,
    cashRateFactor: factor,
    viaPartnerIds: via.value,
    note: optionalText(req.body?.note),
    updatedBy: adminUser(req),
  });
  res.json({ ok: true, plan });
});

export const deletePaymentPlanHandler = wrap("deletePaymentPlanHandler", async (req, res) => {
  const period = parsePeriodQuery(req.query);
  if (period.error) return fail(res, period.error);
  if (!isUuid(req.query.employeeId)) return fail(res, "employeeId is required");
  await deletePaymentPlan({ ...period, employeeId: req.query.employeeId });
  res.json({ ok: true });
});

export const postCopyPreviousPlans = wrap("postCopyPreviousPlans", async (req, res) => {
  const period = parsePeriodQuery(req.body || {});
  if (period.error) return fail(res, period.error);
  res.json({ ok: true, ...(await copyPreviousPaymentPlans({ ...period, updatedBy: adminUser(req) })) });
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/staff/payroll/summary?year=&month=&half=
// Requiere requireCleaner. Resuelve el employee propio por
// req.cleaner.email (mismo email que ya filtra el calendario del cleaner)
// y computa el resumen SOLO para ese empleado — el resto ni se consulta.
// Nunca devuelve campos de plata.
// ─────────────────────────────────────────────────────────────────────────────
export async function getStaffPayrollSummary(req, res) {
  try {
    const parsed = parsePeriodQuery(req.query);
    if (parsed.error) {
      return res.status(400).json({ ok: false, error: parsed.error });
    }

    const selfEmail = (req.cleaner?.email || "").toLowerCase();
    if (!selfEmail) {
      return res
        .status(403)
        .json({ ok: false, error: "This account has no email configured" });
    }

    const { data: employee, error } = await supabase
      .from("employees")
      .select("id")
      .ilike("email", selfEmail)
      .eq("is_active", true)
      .maybeSingle();
    if (error) throw error;
    if (!employee) {
      return res
        .status(403)
        .json({ ok: false, error: "This account has no email configured" });
    }

    const summary = await computePayrollSummary({
      ...parsed,
      employeeIds: [employee.id],
    });
    return res.json(stripMoney(summary));
  } catch (e) {
    console.error("❌ getStaffPayrollSummary:", e.message);
    return res.status(500).json({ ok: false, error: e.message });
  }
}
