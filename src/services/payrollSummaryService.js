// services/payrollSummaryService.js
// LAB428 — resumen por quincena (eventos, horas, traslado, dinero) para la
// pestaña "Payroll".
//
// Reusa getEventsForRange (calendarController.js) para no duplicar el
// fetch/cache/merge de meses de GCal. El gating de plata NO vive acá adentro
// como un flag — computePayrollSummary siempre calcula todo; es el CALLER
// (el controller, según el rol) el que decide si pasa `employeeIds` acotado
// (staff, un solo empleado), si pasa `includeTravelSlots` (solo admin — el
// staff nunca ve el detalle de tramos, pedido explícito 2026-09-16) y si
// aplica stripMoney() antes de responder.
//
// Fórmula de traslado — arrancó calcada del Google Apps Script que arma la
// planilla manual de nómina (pegado por el usuario 2026-09-15), con un ajuste
// pedido el 2026-09-16: para cada empleado, por cada día calendario, se
// recorren los eventos consecutivos y el hueco entre uno y el siguiente:
//   1. (La regla "Westshore" de Monkey, propia de su negocio, no se porta.)
//   2. Si no, es un TRAMO DE TRASLADO visible (ver `travelSlots` abajo). El
//      hueco alrededor de un Lunch cuenta de los dos lados (revertido
//      2026-09-16 — el script original solo contaba el lado ANTES del
//      Lunch; ahora cuenta también el lado DESPUÉS).
//   3. Si el hueco calculado da >= 1h, queda "para revisión manual": no se
//      aplica solo (0h por default) hasta que un admin carga a mano cuántas
//      horas corresponden de verdad (`payroll_travel_overrides`, ver
//      `applyTravelOverrides`). Si da < 1h, se aplica el cálculo tal cual.
import { DateTime } from "luxon";
import { getPayrollEvents as getEventsForRange } from "./payrollEvents.js";
import { supabase } from "../supabaseClient.js";
// Sin alias de emails en este fork: se compara el email normalizado.
const canonicalEmail = (email) => String(email ?? "").trim().toLowerCase();
import { isLunchEvent } from "./eventClassification.js";
import { computeEventClientMoney, GST_RATE } from "./clientBillingCalculator.js";
import {
  listExpenses,
  listPinnedConcepts,
  buildRelevantExpenses,
} from "./payrollExpensesService.js";
import {
  listDividends,
  listDeductions,
  listBonuses,
  listTips,
  listNetPayOverrides,
  loadEmployeeNames,
  sumDeductionsByEmployee,
  sumBonusesByEmployee,
  sumTipsByEmployee,
  buildNetPayRows,
} from "./payrollAdjustmentsService.js";
import { listPaymentPlans, buildPaymentTable } from "./payrollPaymentPlanService.js";
import { computeLaborPay, holidaysInRange, weekStartSunday, BC_RULES } from "./payrollLaborRulesService.js";
import {
  listPartners,
  listPartnerExtras,
  sumByPartner,
  buildStakeholderPayments,
} from "./payrollPartnersService.js";
import { recordHistory } from "./recordHistory.js";
import { syncAndPersistZohoId } from "./zohoService.js";
import { getClosingPart } from "./payrollClosingsService.js";
import { TZ } from "../config/timezone.js";


// Mismo placeholder que clientController.js/recurringCoverageMonitor.js/
// surveyRequestJob.js — un appointment sin match real de cliente. Nunca tiene
// una `created_at` de cliente confiable → cae en la tarifa de cliente nuevo
// (mismo fail-safe que isNewClientByEmail: ante la duda, no bajamos la tarifa).
const PLACEHOLDER_CLIENT_ID = "00000000-0000-0000-0000-000000000001";

// Un hueco de esta duración o más queda "para revisión manual" en vez de
// aplicarse solo.
const TRAVEL_REVIEW_THRESHOLD_HOURS = 1;


const round2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;

// Ganancia y ganancia neta del P&L. Los dividendos restan igual que en la
// planilla (donde van dentro del Nominee): Ganancia = ingresos − nómina −
// dividendos; Ganancia neta = Ganancia − gastos. Una sola fórmula para el
// resumen de la quincena y para el Resumen Anual.
export function computeProfits({ grossRevenue, cleanerPayroll, dividends = 0, expensesTotal = 0 }) {
  const grossProfit = round2(grossRevenue - cleanerPayroll - (dividends || 0));
  return { grossProfit, netProfit: round2(grossProfit - (expensesTotal || 0)) };
}

// ── quincenaRange ────────────────────────────────────────────────────────────
// Generaliza getQuincenalRange (staffHoursController.js) a CUALQUIER
// quincena, no solo current/previous — necesario para navegar el histórico.
// half:1 → día 1-15; half:2 → día 16-fin de mes (inclusive). Devuelve
// DateTime en TZ del negocio, al inicio del día (mismo criterio que el
// original: el corte de quincena no puede depender del huso del navegador).
export function quincenaRange({ year, month, half }) {
  const from =
    half === 1
      ? DateTime.fromObject({ year, month, day: 1 }, { zone: TZ })
      : DateTime.fromObject({ year, month, day: 16 }, { zone: TZ });
  const toInclusive =
    half === 1
      ? DateTime.fromObject({ year, month, day: 15 }, { zone: TZ })
      : from.endOf("month").startOf("day");

  const label = `Q${half} ${from.toFormat("LLL yyyy")}`;
  return { from, toInclusive, label };
}

// ── isEventCounted ───────────────────────────────────────────────────────
// Un evento se cuenta como "trabajado" si ya terminó, O si arranca el
// ÚLTIMO día de la quincena — el cierre de nómina se empieza esa misma
// mañana y ya toma en cuenta los trabajos de ese día, se hayan completado o
// no (pedido explícito del usuario 2026-09-30). Si alguno se cancela
// después de cerrada la quincena, se corrige a mano en la siguiente. Pura
// (sin DB) — recibe los DateTime ya resueltos por el caller.
export function isEventCounted({ startIso, endIso }, toInclusive, now, tz = TZ) {
  if (DateTime.fromISO(endIso, { zone: tz }) <= now) return true;
  return DateTime.fromISO(startIso, { zone: tz }).hasSame(toInclusive, "day");
}

// ── buildForecastEvents ───────────────────────────────────────────────────
// Función pura — eventos "de servicio" (no all-day, no lunch, no
// isNonService) de TODA la quincena, trabajados o no, con la cantidad de
// cleaners ACTIVOS que asisten (`attendeeCount`, para el cálculo de plata —
// mismo criterio de horas-persona que `computeEventClientMoney`). Base del
// Forecast (2026-09-30): a diferencia de `rawList` por empleado, acá no se
// filtra por `isEventCounted` — un evento futuro de la quincena también
// cuenta para "estimado total". Un evento sin ningún cleaner activo como
// asistente se descarta (nada que facturar ni que pagar).
export function buildForecastEvents(events, employees) {
  const activeCanonEmails = new Set(
    (employees ?? []).map((e) => canonicalEmail(e.email || "")).filter(Boolean),
  );
  return events
    .filter((e) => !e.isAllDay && !e.isNonService && !isLunchEvent(e.summary))
    .map((e) => ({
      ...e,
      attendeeCount: (e.attendees || []).filter((a) => activeCanonEmails.has(canonicalEmail(a)))
        .length,
    }))
    .filter((e) => e.attendeeCount > 0);
}

// ── aggregateEmployeePayroll ─────────────────────────────────────────────────
// Función pura (sin DB/GCal) — recibe YA filtrados los eventos donde el
// empleado es attendee (rawList: todo salvo all-day) y calcula:
//   - workList: rawList menos isNonService menos Lunch.
//   - workHours / eventCount sobre workList.
//   - travelSlots: un registro POR HUECO entre dos eventos consecutivos del
//     mismo día (ver reglas arriba) — cada uno con `calculatedHours` (el
//     hueco real) y `appliedHours` (lo que cuenta para el total: igual al
//     calculado si `needsReview` es false, 0 por default si es true — recién
//     `applyTravelOverrides` puede cambiar ese 0 por un valor cargado a mano).
//   - travelHours: suma de `appliedHours` de todos los slots — el total
//     ANTES de aplicar overrides (computePayrollSummary los aplica después,
//     necesita ir a la DB).
// No aplica rates acá — eso lo hace el caller (necesita el employee).
export function aggregateEmployeePayroll(rawList) {
  const workList = rawList.filter(
    (e) => !e.isNonService && !isLunchEvent(e.summary),
  );

  const workHours = round2(
    workList.reduce((s, e) => s + (e.durationH || 0), 0),
  );

  // Agrupar por día calendario, ordenar por hora de inicio, armar un slot
  // por hueco entre consecutivos. Sin evento antes del primero del día ni
  // después del último → cumple "sin tiempo al inicio ni al final" (el loop
  // solo mira huecos ENTRE eventos).
  const byDay = new Map();
  for (const e of rawList) {
    const day = e.startDate;
    if (!byDay.has(day)) byDay.set(day, []);
    byDay.get(day).push(e);
  }

  const travelSlots = [];
  for (const dayEvents of byDay.values()) {
    if (dayEvents.length < 2) continue;
    const sorted = [...dayEvents].sort((a, b) =>
      a.startIso.localeCompare(b.startIso),
    );
    for (let i = 1; i < sorted.length; i++) {
      const prev = sorted[i - 1];
      const curr = sorted[i];
      const prevEnd = DateTime.fromISO(prev.endIso, { zone: TZ });
      const nextStart = DateTime.fromISO(curr.startIso, { zone: TZ });
      const gapH = nextStart.diff(prevEnd, "hours").hours;
      if (gapH <= 0) continue; // solapados o pegados — no hay hueco

      const calculatedHours = round2(gapH);
      // Epsilon mínimo por precisión de punto flotante alrededor del tope
      // exacto de 1h — no arriesgarse a mandar a revisión un hueco que en
      // realidad es 1.0000000001 por redondeo de Luxon.
      const needsReview =
        calculatedHours >= TRAVEL_REVIEW_THRESHOLD_HOURS - 1e-9;

      travelSlots.push({
        day: prev.startDate,
        prevEventId: prev.id,
        nextEventId: curr.id,
        prevSummary: prev.summary,
        prevEndIso: prev.endIso,
        nextSummary: curr.summary,
        nextStartIso: curr.startIso,
        calculatedHours,
        needsReview,
        appliedHours: needsReview ? 0 : calculatedHours,
        reviewedBy: null,
        reviewedAt: null,
      });
    }
  }
  travelSlots.sort((a, b) => a.prevEndIso.localeCompare(b.prevEndIso));

  const travelHours = round2(
    travelSlots.reduce((s, slot) => s + slot.appliedHours, 0),
  );

  return {
    eventCount: workList.length,
    workHours,
    travelHours,
    travelSlots,
    events: workList
      .map((e) => ({
        id: e.id,
        summary: e.summary,
        startIso: e.startIso,
        endIso: e.endIso,
        durationH: e.durationH,
        location: e.location,
        isRecurring: Boolean(e.recurringEventId),
      }))
      .sort((a, b) => a.startIso.localeCompare(b.startIso)),
  };
}

// ── applyTravelOverrides ─────────────────────────────────────────────────
// Función pura — mezcla los overrides cargados a mano (de
// `payroll_travel_overrides`) sobre los `travelSlots` calculados. Un slot
// que no necesita revisión nunca se toca, tenga o no un override viejo
// dando vueltas. `overrides` es un Map `"${prevEventId}::${nextEventId}"` →
// `{ appliedHours, reviewedBy, reviewedAt }`.
export function applyTravelOverrides(travelSlots, overrides) {
  const slots = travelSlots.map((slot) => {
    if (!slot.needsReview) return slot;
    const override = overrides.get(travelSlotKey(slot));
    if (!override) return slot;
    return {
      ...slot,
      appliedHours: round2(override.appliedHours),
      reviewedBy: override.reviewedBy ?? null,
      reviewedAt: override.reviewedAt ?? null,
    };
  });
  const travelHours = round2(
    slots.reduce((s, slot) => s + slot.appliedHours, 0),
  );
  return { slots, travelHours };
}

export function travelSlotKey(slot) {
  return `${slot.prevEventId}::${slot.nextEventId}`;
}

// ── client billing (LAB428, 2026-09-17) ─────────────────────────────────
// Cuánto se le cobró al CLIENTE por un evento ya trabajado — no confundir
// con workMoney/travelMoney (lo que se le paga al CLEANER). La fórmula en sí
// (calculatedAmount, resolveClientHourlyRate, isNewClientAt) vive en
// clientBillingCalculator.js — compartida con invoiceService.js, que la usa
// para pre-llenar el monto de la draft invoice de un appointment completado.
// Acá el admin sigue pudiendo corregir `appliedAmount` a mano contra su
// propia facturación real (`payroll_client_billing_overrides`, mismo patrón
// que `payroll_travel_overrides`/`applyTravelOverrides`) sin que eso
// desincronice la invoice ya creada.

// ── loadClientBillingContext ─────────────────────────────────────────────
// Una sola query a `appointments` (el id del evento ES appointments.id; ya
// resuelto por appointmentSyncService.js) + una sola query a `clients` para
// TODOS los eventos/clientes en juego (evita N+1). El placeholder cuenta
// como "sin cliente" — mismo criterio que ClientPage (excluido del listado).
async function loadClientBillingContext(eventIds) {
  const byEvent = new Map();
  if (!eventIds?.length) return { byEvent, clientInfoById: new Map() };

  const { data, error } = await supabase
    .from("appointments")
    .select("id, client_id, service_type, invoice_id")
    .in("id", eventIds);
  if (error) throw new Error(`payroll client billing (appointments): ${error.message}`);

  const clientIds = new Set();
  const invoiceIds = new Set();
  for (const row of data ?? []) {
    const clientId =
      row.client_id && row.client_id !== PLACEHOLDER_CLIENT_ID ? row.client_id : null;
    byEvent.set(row.id, {
      clientId,
      serviceType: row.service_type,
      invoiceId: row.invoice_id ?? null,
    });
    if (clientId) clientIds.add(clientId);
    if (row.invoice_id) invoiceIds.add(row.invoice_id);
  }

  // Estado de la invoice y fecha de pago — solo lo que ya está linkeado vía
  // appointments.invoice_id (LAB452). Un evento sin invoice queda en null.
  const invoiceById = new Map();
  if (invoiceIds.size) {
    const { data: invRows, error: invErr } = await supabase
      .from("invoices")
      .select("id, status, paid_date")
      .in("id", [...invoiceIds]);
    if (invErr) throw new Error(`payroll client billing (invoices): ${invErr.message}`);
    for (const inv of invRows ?? []) invoiceById.set(inv.id, inv);
  }
  for (const ctx of byEvent.values()) {
    const inv = ctx.invoiceId ? invoiceById.get(ctx.invoiceId) : null;
    ctx.invoiceStatus = inv?.status ?? null;
    ctx.paidDate = inv?.paid_date ?? null;
  }

  let clientInfoById = new Map();
  if (clientIds.size) {
    const { data: clientRows, error: clientErr } = await supabase
      .from("clients")
      .select("id, created_at, rate")
      .in("id", [...clientIds]);
    if (clientErr) throw new Error(`payroll client billing (clients): ${clientErr.message}`);
    clientInfoById = new Map(
      (clientRows ?? []).map((c) => [c.id, { createdAt: c.created_at, rate: c.rate }]),
    );
  }

  return { byEvent, clientInfoById };
}

// ── loadClientBillingOverrides ───────────────────────────────────────────
// Una sola query para todos los eventos en juego. Clave por event_id (no
// por empleado) — mismo criterio que loadTravelOverrides pero más simple
// porque acá no hay dos empleados que puedan discrepar sobre el monto de
// un mismo servicio.
async function loadClientBillingOverrides(eventIds) {
  const byEvent = new Map();
  if (!eventIds?.length) return byEvent;

  // `select("*")` a propósito — `billed_rate` (2026-09-30) puede no existir
  // todavía si la migración 20260930_payroll_billing_override_rate.sql no
  // corrió; con `*` la fila se lee igual, solo sin esa columna.
  const { data, error } = await supabase
    .from("payroll_client_billing_overrides")
    .select("*")
    .in("event_id", eventIds);
  if (error) {
    if (error.code === "PGRST205") {
      console.warn(
        "⚠️ [payrollSummaryService] payroll_client_billing_overrides no existe todavía " +
          "(falta correr la migración 20260917_payroll_client_billing_overrides.sql) — " +
          "sigo con el monto calculado sin overrides.",
      );
      return byEvent;
    }
    throw new Error(`payroll client billing overrides: ${error.message}`);
  }

  for (const o of data ?? []) {
    byEvent.set(o.event_id, {
      appliedAmount: Number(o.applied_amount),
      billedRate: o.billed_rate != null ? Number(o.billed_rate) : null,
      reviewedBy: o.reviewed_by,
      reviewedAt: o.reviewed_at,
    });
  }
  return byEvent;
}

// ── loadReceivedPayments ─────────────────────────────────────────────────
// Forecast (2026-09-30) — "Ingresos": plata efectivamente cobrada durante la
// quincena (payment_date dentro del rango), sin importar a qué trabajo
// corresponda. Mismo criterio que cashflowService.js ("completed").
async function loadReceivedPayments(fromDate, toDate) {
  const { data, error } = await supabase
    .from("payments")
    .select("amount")
    .gte("payment_date", fromDate)
    .lte("payment_date", toDate)
    .eq("status", "completed");
  if (error) throw new Error(`payroll forecast payments: ${error.message}`);
  return round2((data ?? []).reduce((s, p) => s + Number(p.amount || 0), 0));
}

// ── setClientBillingOverride ─────────────────────────────────────────────
// Upsert de la corrección manual de un admin para el monto facturado de un
// evento puntual. Unique key: event_id — volver a llamar para el mismo
// evento actualiza el valor, no duplica la fila.
export async function setClientBillingOverride({
  eventId,
  appliedAmount,
  calculatedAmount,
  billedRate,
  reviewedBy,
}) {
  const { error } = await supabase.from("payroll_client_billing_overrides").upsert(
    {
      event_id: eventId,
      applied_amount: appliedAmount,
      calculated_amount: calculatedAmount ?? null,
      billed_rate: billedRate ?? null,
      reviewed_by: reviewedBy ?? null,
      reviewed_at: new Date().toISOString(),
    },
    { onConflict: "event_id" },
  );
  if (error) {
    // 42703/PGRST204: la migración 20260930_payroll_billing_override_rate.sql
    // todavía no corrió — se guarda igual sin billed_rate (degradación
    // elegante, mismo criterio que el resto del módulo).
    if (billedRate != null && (error.code === "42703" || error.code === "PGRST204")) {
      const { error: retryErr } = await supabase.from("payroll_client_billing_overrides").upsert(
        {
          event_id: eventId,
          applied_amount: appliedAmount,
          calculated_amount: calculatedAmount ?? null,
          reviewed_by: reviewedBy ?? null,
          reviewed_at: new Date().toISOString(),
        },
        { onConflict: "event_id" },
      );
      if (retryErr) throw new Error(`payroll client billing override upsert: ${retryErr.message}`);
      return;
    }
    throw new Error(`payroll client billing override upsert: ${error.message}`);
  }
}

// ── computeEventProfit ───────────────────────────────────────────────────
// Ganancia por TRABAJO (Payroll estilo Excel, 2026-09-18). Función pura, y
// única a propósito: es donde vive la fórmula de "ganancia del cleaner" /
// "ganancia del negocio", para poder calzarla con el Excel cambiando un solo
// lugar.
//   * Ganancia del cleaner = durationH × su tarifa de trabajo (cada cleaner
//     asignado cobra las horas del evento).
//   * Ganancia del negocio = monto aplicado al cliente − lo que se le paga a
//     TODOS los cleaners de ese trabajo. El traslado no entra: es un hueco
//     ENTRE trabajos, no de un trabajo puntual (por eso la suma de estas
//     ganancias no coincide exacto con `pnl.grossProfit`, que sí lo resta).
//   * Sigue la convención del P&L: `appliedAmount` ya incluye el 5% de GST,
//     igual que `grossRevenue`.
export function computeEventProfit({ appliedAmount, durationH, attendeeRates }) {
  const cleanerPayEach = attendeeRates.map((rate) => round2((durationH || 0) * Number(rate || 0)));
  const cleanerPayTotal = round2(cleanerPayEach.reduce((s, n) => s + n, 0));
  return {
    cleanerPayTotal,
    businessProfit: round2((appliedAmount || 0) - cleanerPayTotal),
  };
}

// ── setClientRateForEvent ────────────────────────────────────────────────
// Editar la tarifa aplicada al cliente en un trabajo (acordado con el
// usuario 2026-09-18): actualiza `clients.rate` en el CRM — vale para los
// trabajos FUTUROS del cliente — y FIJA el monto de ESTE trabajo
// (payroll_client_billing_overrides) con la tarifa nueva, así las quincenas
// pasadas no se recalculan solas al cambiar el CRM.
// `durationH`/`attendeeCount` vienen del registro que el admin está viendo
// (la fórmula sigue siendo la de clientBillingCalculator.js, server-side).
export async function setClientRateForEvent({
  eventId,
  hourlyRate,
  durationH,
  attendeeCount,
  eventStartIso,
  reviewedBy,
}) {
  const { data: appt, error: apptErr } = await supabase
    .from("appointments")
    .select("client_id")
    .eq("id", eventId)
    .maybeSingle();
  if (apptErr) throw new Error(`client rate (appointment): ${apptErr.message}`);
  const clientId =
    appt?.client_id && appt.client_id !== PLACEHOLDER_CLIENT_ID ? appt.client_id : null;
  if (!clientId) {
    const err = new Error(
      "This job has no client linked yet — assign a client to the appointment before setting a rate",
    );
    err.status = 400;
    throw err;
  }

  const { data: before, error: beforeErr } = await supabase
    .from("clients")
    .select("rate")
    .eq("id", clientId)
    .single();
  if (beforeErr) throw new Error(`client rate (lookup): ${beforeErr.message}`);

  const { data: client, error: updErr } = await supabase
    .from("clients")
    .update({ rate: hourlyRate, updated_at: new Date().toISOString() })
    .eq("id", clientId)
    .select()
    .single();
  if (updErr) throw new Error(`client rate (update): ${updErr.message}`);

  if (Number(before?.rate ?? NaN) !== hourlyRate) {
    await recordHistory("client", clientId, [
      { field: "rate", oldValue: before?.rate ?? null, newValue: hourlyRate },
    ]);
  }
  syncAndPersistZohoId(supabase, client).catch(() => {});

  const { calculatedAmount } = computeEventClientMoney({
    durationH,
    attendeeCount,
    serviceType: null,
    clientCreatedAt: null,
    clientRate: hourlyRate,
    eventStartIso,
  });
  await setClientBillingOverride({
    eventId,
    appliedAmount: calculatedAmount,
    calculatedAmount,
    billedRate: hourlyRate,
    reviewedBy,
  });

  return { clientId, appliedAmount: calculatedAmount };
}

// ── setEventOnlyRate ─────────────────────────────────────────────────────
// Igual que setClientRateForEvent, pero SOLO para este trabajo puntual — no
// toca `clients.rate` (pedido explícito 2026-09-30: un servicio a otra
// tarifa, como una limpieza de alfombras, sin cambiar la tarifa habitual del
// cliente). El monto queda fijo en `payroll_client_billing_overrides` con su
// propio `billed_rate`, así la columna Rate de este trabajo muestra la
// tarifa puntual y no la del cliente.
export async function setEventOnlyRate({
  eventId,
  hourlyRate,
  durationH,
  attendeeCount,
  eventStartIso,
  reviewedBy,
}) {
  const { data: appt, error: apptErr } = await supabase
    .from("appointments")
    .select("client_id")
    .eq("id", eventId)
    .maybeSingle();
  if (apptErr) throw new Error(`event-only rate (appointment): ${apptErr.message}`);
  const clientId =
    appt?.client_id && appt.client_id !== PLACEHOLDER_CLIENT_ID ? appt.client_id : null;
  if (!clientId) {
    const err = new Error(
      "This job has no client linked yet — assign a client to the appointment before setting a rate",
    );
    err.status = 400;
    throw err;
  }

  const { calculatedAmount } = computeEventClientMoney({
    durationH,
    attendeeCount,
    serviceType: null,
    clientCreatedAt: null,
    clientRate: hourlyRate,
    eventStartIso,
  });
  await setClientBillingOverride({
    eventId,
    appliedAmount: calculatedAmount,
    calculatedAmount,
    billedRate: hourlyRate,
    reviewedBy,
  });

  return { clientId, appliedAmount: calculatedAmount };
}

// ── horas extra y feriados (ver payrollLaborRulesService.js) ──────────────────
// Libro diario de un empleado: un registro por día con trabajo — horas de
// trabajo, horas de traslado (ya con los overrides) y el pago normal del día.
// `rawList` son sus eventos YA filtrados (attendee, no all-day, contados),
// incluidos los de días anteriores a la quincena que hacen falta para la
// semana que la abre y para el día promedio de un feriado.
export function buildEmployeeLedger({ rawList, overrides, workRate, travelRate }) {
  const byDay = new Map();
  for (const e of rawList) {
    if (!byDay.has(e.startDate)) byDay.set(e.startDate, []);
    byDay.get(e.startDate).push(e);
  }
  const ledger = [];
  for (const [date, list] of byDay) {
    const agg = aggregateEmployeePayroll(list);
    if (agg.workHours <= 0) continue; // un día solo con Lunch no es un día trabajado
    const { travelHours } = applyTravelOverrides(agg.travelSlots, overrides);
    ledger.push({
      date,
      workHours: agg.workHours,
      travelHours,
      money: round2(agg.workHours * workRate + travelHours * travelRate),
    });
  }
  return ledger.sort((a, b) => a.date.localeCompare(b.date));
}

// Emails de quienes NO cobran horas extra (p. ej. un "manager" según la ley,
// que la excluye de las horas extra). Env `PAYROLL_OVERTIME_EXEMPT_EMAILS`,
// separados por coma. Por defecto nadie: la ley no exceptúa a las limpiadoras.
export function overtimeExemptEmails(raw = process.env.PAYROLL_OVERTIME_EXEMPT_EMAILS) {
  return new Set(
    String(raw ?? "")
      .split(",")
      .map((x) => canonicalEmail(x.trim()))
      .filter(Boolean),
  );
}

// ── computePayrollSummary ────────────────────────────────────────────────────
// `employeeIds` opcional: si se pasa, solo se cargan/calculan ESOS
// empleados — usado por el endpoint de staff para no traer (ni siquiera a
// memoria del proceso) los datos de otros compañeros. Si se omite, todos
// los activos (usado por admin).
// `includeTravelSlots`: si es true, cada fila de `employees[]` incluye el
// array `travelSlots` completo (detalle por tramo, editable). El total
// `travelHours` siempre refleja los overrides ya cargados, la tengas o no
// expuesta — un cleaner sin este flag ve el número correcto, solo no ve el
// desglose ni puede editar nada. Mismo flag gatea LAB428 "cuánto se le cobró
// al cliente": `events[].calculatedAmount`/`appliedAmount`/`billedRate`/
// `attendeeNames`, el bloque `pnl` (ingresos/pagos a cleaners/gastos/
// ganancia) y `clientBilling` (un registro por servicio, deduplicado) — un
// cleaner no debe ver ninguno de los tres.
export async function computePayrollSummary({
  year,
  month,
  half,
  employeeIds,
  includeTravelSlots = false,
}) {
  const { from, toInclusive, label } = quincenaRange({ year, month, half });
  const timeMin = from.toISO();
  // timeMax exclusivo — el día siguiente al último de la quincena a las
  // 00:00 cubre el último día completo (mismo patrón que staffHoursController).
  const timeMax = toInclusive.plus({ days: 1 }).toISO();

  const events = await getEventsForRange(timeMin, timeMax);
  const now = DateTime.now().setZone(TZ);

  // Horas extra y feriados necesitan días ANTERIORES a la quincena: desde el
  // domingo de la semana que la abre (para las 40 horas semanales) y, si hay un
  // feriado, los 30 días previos a él (para el día promedio). Esos días solo se
  // leen para calcular; lo que se paga es lo trabajado dentro de la quincena.
  const fromDate = from.toISODate();
  const toDate = toInclusive.toISODate();
  const periodHolidays = holidaysInRange(fromDate, toDate);
  let lookbackFromDate = weekStartSunday(fromDate);
  if (periodHolidays.length) {
    const firstWindow = DateTime.fromISO(periodHolidays[0].date, { zone: "utc" })
      .minus({ days: BC_RULES.holidayLookbackDays })
      .toISODate();
    if (firstWindow < lookbackFromDate) lookbackFromDate = firstWindow;
  }
  const lookbackEvents =
    lookbackFromDate < fromDate
      ? await getEventsForRange(
          DateTime.fromISO(lookbackFromDate, { zone: TZ }).toISO(),
          timeMin,
        )
      : [];
  const exemptEmails = overtimeExemptEmails();

  let query = supabase
    .from("employees")
    .select("id, name, email, hourly_work_rate, hourly_travel_rate")
    .eq("is_active", true)
    .order("name");
  if (employeeIds?.length) query = query.in("id", employeeIds);

  const { data: employees, error } = await query;
  if (error) throw new Error(`payroll employees: ${error.message}`);

  const employeeIdsInScope = (employees ?? []).map((e) => e.id);
  const overridesByEmployee = await loadTravelOverrides(employeeIdsInScope);

  const rows = (employees ?? []).map((emp) => {
    const canonEmail = canonicalEmail(emp.email || "");

    const rawList = events.filter((e) => {
      if (e.isAllDay) return false;
      if (!(e.attendees || []).some((a) => canonicalEmail(a) === canonEmail))
        return false;
      // Completado, o del último día de la quincena (ver isEventCounted) —
      // mismo criterio que staffHoursController salvo por esa excepción. Un
      // evento futuro de un día anterior al último no es "trabajado" todavía.
      // No-op para quincenas pasadas (todo termina siendo `endIso <= now`).
      return isEventCounted(e, toInclusive, now);
    });

    const agg = aggregateEmployeePayroll(rawList);
    const overrides = overridesByEmployee.get(emp.id) ?? new Map();
    const { slots, travelHours } = applyTravelOverrides(
      agg.travelSlots,
      overrides,
    );

    const workRate = Number(emp.hourly_work_rate || 0);
    const travelRate = Number(emp.hourly_travel_rate || 0);
    const workMoney = round2(agg.workHours * workRate);
    const travelMoney = round2(travelHours * travelRate);

    // Horas extra y pago de feriados (BC): se SUMAN al pago normal de arriba.
    const rawAll = [...lookbackEvents, ...events].filter(
      (e) =>
        !e.isAllDay &&
        (e.attendees || []).some((a) => canonicalEmail(a) === canonEmail) &&
        isEventCounted(e, toInclusive, now),
    );
    const labor = computeLaborPay({
      ledger: buildEmployeeLedger({ rawList: rawAll, overrides, workRate, travelRate }),
      fromDate,
      toDate,
      workRate,
      overtimeExempt: exemptEmails.has(canonEmail),
    });
    const overtimeMoney = labor.overtime.money;
    const holidayMoney = labor.holidayMoney;

    const result = {
      employeeId: emp.id,
      name: emp.name,
      eventCount: agg.eventCount,
      workHours: agg.workHours,
      travelHours,
      workMoney,
      travelMoney,
      overtimeHours15: labor.overtime.hours15,
      overtimeHours2: labor.overtime.hours2,
      overtimeMoney,
      holidayMoney,
      totalMoney: round2(workMoney + travelMoney + overtimeMoney + holidayMoney),
      events: agg.events,
      overtimeDays: labor.overtime.days,
      holidayDays: labor.holidays,
    };
    if (includeTravelSlots) result.travelSlots = slots;
    return result;
  });

  const totals = rows.reduce(
    (acc, r) => ({
      employeeCount: acc.employeeCount + 1,
      eventCount: acc.eventCount + r.eventCount,
      workHours: round2(acc.workHours + r.workHours),
      travelHours: round2(acc.travelHours + r.travelHours),
      workMoney: round2(acc.workMoney + r.workMoney),
      travelMoney: round2(acc.travelMoney + r.travelMoney),
      overtimeHours: round2(acc.overtimeHours + r.overtimeHours15 + r.overtimeHours2),
      overtimeMoney: round2(acc.overtimeMoney + r.overtimeMoney),
      holidayMoney: round2(acc.holidayMoney + r.holidayMoney),
      totalMoney: round2(acc.totalMoney + r.totalMoney),
    }),
    {
      employeeCount: 0,
      eventCount: 0,
      workHours: 0,
      travelHours: 0,
      workMoney: 0,
      travelMoney: 0,
      overtimeHours: 0,
      overtimeMoney: 0,
      holidayMoney: 0,
      totalMoney: 0,
    },
  );

  // ── Client billing + P&L (admin-only, mismo gate que travelSlots) ───────
  // El monto facturado es propio del EVENTO, no del empleado — un evento
  // con 2 cleaners de attendees aparece en agg.events de ambos con el mismo
  // número (correcto para mostrarlo en cada itinerario), pero sumarlo por
  // fila lo contaría 2 veces. Por eso se dedupea por event.id acá para el
  // total del período (clientRevenue) y para `clientBilling` (un registro
  // por servicio, no por cleaner que lo trabajó).
  let pnl;
  let clientBilling;
  let netPaySummary;
  let paymentTable;
  let teamsByDay;
  if (includeTravelSlots) {
    teamsByDay = await loadTeamsByDay(from.toISODate(), toInclusive.toISODate());
    const eventById = new Map();
    const attendeeNamesByEventId = new Map();
    for (const row of rows) {
      for (const ev of row.events) {
        if (!eventById.has(ev.id)) eventById.set(ev.id, ev);
        if (!attendeeNamesByEventId.has(ev.id)) attendeeNamesByEventId.set(ev.id, []);
        attendeeNamesByEventId.get(ev.id).push(row.name);
      }
    }

    // Forecast (2026-09-30) — "estimado total" necesita TODA la quincena,
    // no solo lo ya trabajado: forecastEvents es un superset de eventById
    // (mismos filtros, sin el corte de isEventCounted). Se pide el contexto
    // de facturación (cliente/override) para ese set completo de una — así
    // `clientBilling`/`grossRevenue` de acá abajo no piden nada de más.
    const forecastEvents = buildForecastEvents(events, employees ?? []);
    const eventIds = [...new Set([...eventById.keys(), ...forecastEvents.map((e) => e.id)])];
    const [{ byEvent, clientInfoById }, billingOverrides] = await Promise.all([
      loadClientBillingContext(eventIds),
      loadClientBillingOverrides(eventIds),
    ]);

    // Tarifa de trabajo de cada cleaner asignado a cada evento — para la
    // ganancia por trabajo (computeEventProfit). `rows` sigue el orden de
    // `employees` (map 1-a-1).
    const attendeeRatesByEventId = new Map();
    rows.forEach((row, i) => {
      const rate = Number(employees[i].hourly_work_rate || 0);
      for (const ev of row.events) {
        if (!attendeeRatesByEventId.has(ev.id)) attendeeRatesByEventId.set(ev.id, []);
        attendeeRatesByEventId.get(ev.id).push(rate);
      }
    });

    const billingByEventId = new Map();
    // "Gross revenue" del P&L, sin el 5% de GST (no es ingreso de la
    // empresa) — pedido explícito 2026-09-30. Si el evento tiene un override
    // manual de monto, se le saca el GST de la misma forma que se le puso
    // (dividir, no repetir el cálculo) para no inventar un pretax distinto
    // del que el admin efectivamente cargó.
    let grossRevenuePreTax = 0;
    for (const [id, ev] of eventById) {
      const ctx = byEvent.get(id);
      const clientInfo = ctx?.clientId ? clientInfoById.get(ctx.clientId) : null;
      const attendeeNames = attendeeNamesByEventId.get(id) ?? [];
      const { calculatedAmount, preTaxAmount, billedRate } = computeEventClientMoney({
        durationH: ev.durationH,
        attendeeCount: attendeeNames.length,
        serviceType: ctx?.serviceType ?? null,
        clientCreatedAt: clientInfo?.createdAt ?? null,
        clientRate: clientInfo?.rate ?? null,
        eventStartIso: ev.startIso,
      });
      const override = billingOverrides.get(id);
      const appliedAmount = override ? round2(override.appliedAmount) : calculatedAmount;
      grossRevenuePreTax = round2(
        grossRevenuePreTax + (override ? round2(appliedAmount / (1 + GST_RATE)) : preTaxAmount),
      );
      const { cleanerPayTotal, businessProfit } = computeEventProfit({
        appliedAmount,
        durationH: ev.durationH,
        attendeeRates: attendeeRatesByEventId.get(id) ?? [],
      });
      billingByEventId.set(id, {
        clientId: ctx?.clientId ?? null,
        serviceType: ctx?.serviceType ?? null,
        attendeeNames,
        calculatedAmount,
        // Si el override trae su propia tarifa ("solo este trabajo", ver
        // setEventOnlyRate), esa es la que se ve en la columna Rate — no la
        // del cliente, que para este trabajo puntual puede ser otra.
        billedRate: override?.billedRate ?? billedRate,
        appliedAmount,
        cleanerPayTotal,
        businessProfit,
        invoiceId: ctx?.invoiceId ?? null,
        invoiceStatus: ctx?.invoiceStatus ?? null,
        paidDate: ctx?.paidDate ?? null,
        billingReviewedBy: override?.reviewedBy ?? null,
        billingReviewedAt: override?.reviewedAt ?? null,
      });
    }

    rows.forEach((row, i) => {
      const rate = Number(employees[i].hourly_work_rate || 0);
      row.events = row.events.map((ev) => ({
        ...ev,
        ...billingByEventId.get(ev.id),
        // Ganancia de ESTE cleaner en este trabajo (no la del evento entero).
        cleanerPay: round2((ev.durationH || 0) * rate),
      }));
    });

    // Ojo: SOLO lo ya trabajado (eventById, no el `eventIds` extendido del
    // Forecast) — un evento futuro no tiene nada que mostrar en esta tabla
    // todavía.
    clientBilling = [...eventById.keys()]
      .map((id) => {
        const ev = eventById.get(id);
        return {
          eventId: id,
          summary: ev.summary,
          startIso: ev.startIso,
          endIso: ev.endIso,
          durationH: ev.durationH,
          location: ev.location,
          ...billingByEventId.get(id),
        };
      })
      .sort((a, b) => a.startIso.localeCompare(b.startIso));

    // Sin GST (ver grossRevenuePreTax más arriba) — lo facturado al cliente
    // (con GST) sigue intacto en `clientBilling[].appliedAmount`/`Billed`.
    const grossRevenue = grossRevenuePreTax;

    // ── Forecast (2026-09-30) ────────────────────────────────────────────
    // "Estimado hoy" reutiliza lo YA trabajado (con GST — a diferencia de
    // `grossRevenue`, acá sí interesa el monto que el cliente efectivamente
    // paga). "Estimado total" le suma lo que falta: los eventos de la
    // quincena que todavía no están en `eventById` (días futuros), con su
    // propio cálculo — sin override todavía, salvo que alguien haya cargado
    // uno por adelantado.
    const estimatedToday = round2(
      [...billingByEventId.values()].reduce((s, b) => s + b.appliedAmount, 0),
    );
    let estimatedTotal = estimatedToday;
    for (const ev of forecastEvents) {
      if (eventById.has(ev.id)) continue; // ya sumado en estimatedToday
      const ctx = byEvent.get(ev.id);
      const clientInfo = ctx?.clientId ? clientInfoById.get(ctx.clientId) : null;
      const { calculatedAmount } = computeEventClientMoney({
        durationH: ev.durationH,
        attendeeCount: ev.attendeeCount,
        serviceType: ctx?.serviceType ?? null,
        clientCreatedAt: clientInfo?.createdAt ?? null,
        clientRate: clientInfo?.rate ?? null,
        eventStartIso: ev.startIso,
      });
      const override = billingOverrides.get(ev.id);
      estimatedTotal = round2(estimatedTotal + (override ? round2(override.appliedAmount) : calculatedAmount));
    }
    const received = await loadReceivedPayments(from.toISODate(), toInclusive.toISODate());
    const forecast = { received, estimatedToday, estimatedTotal };

    const [
      { totals: expenseTotals, expenses: expenseList },
      { total: dividendsTotal, dividends },
      { deductions, total: deductionsTotal },
      pinnedConcepts,
      { bonuses },
      { tips },
      netPayOverrides,
      paymentPlans,
      partners,
      { extras: partnerExtras },
    ] = await Promise.all([
      listExpenses({ year, month, half }),
      listDividends({ year, month, half }),
      listDeductions({ year, month, half }),
      listPinnedConcepts(),
      listBonuses({ year, month, half }),
      listTips({ year, month, half }),
      listNetPayOverrides({ year, month, half }),
      listPaymentPlans({ year, month, half }),
      listPartners(),
      listPartnerExtras({ year, month, half }),
    ]);

    // Ajustes al pago de cada cleaner (2026-09-23):
    //   * Deducciones (adelantos): se descuentan de lo que cobra — NO tocan el
    //     P&L, el costo ya está en `cleanerPayroll`.
    //   * Bonos: monto POR cleaner (para todos o para algunos). Sí son un
    //     costo: entran en `cleanerPayroll`.
    //   * Propinas: plata de paso, repartida en partes iguales entre los
    //     destinatarios. Ni ingreso ni costo del P&L; solo suman al pago.
    //   * NET PAY ("A Pagar") = ganado + bonos + propinas − deducciones, con un
    //     override manual por cleaner (`payroll_net_pay_overrides`).
    const deductionsByEmployee = sumDeductionsByEmployee(deductions);
    const bonusesByEmployee = sumBonusesByEmployee(
      bonuses,
      rows.map((r) => r.employeeId),
    );
    const { byEmployee: tipsByEmployee, unassignedTotal: tipsUnassigned } = sumTipsByEmployee(tips);

    // Empleados que NO están en `rows` (típicamente inactivos, como Clara) pero
    // tienen un ajuste en la quincena: sin esto su bono/deducción/propina/
    // override quedaría afuera de la tabla NET PAY y de los totales.
    const rowIds = new Set(rows.map((r) => r.employeeId));
    const extraIds = new Set();
    for (const id of [
      ...deductionsByEmployee.keys(),
      ...bonusesByEmployee.keys(),
      ...tipsByEmployee.keys(),
      ...netPayOverrides.keys(),
    ]) {
      if (!rowIds.has(id)) extraIds.add(id);
    }
    const extraNames = await loadEmployeeNames([...extraIds]);
    const extraPayees = [...extraIds].map((id) => ({
      employeeId: id,
      name: extraNames.get(id) ?? id,
    }));

    // Un cleaner con plan de pago (tope bruto + accionistas) ya cobra el
    // excedente por Pagos Experimental — NET PAY no debe mostrarle el ganado
    // COMPLETO como "a pagar" (ver buildNetPayRows). Mismo gate que
    // buildPaymentTable (plan.officialGross + al menos un accionista vía), y
    // se excluye a los accionistas-cleaner (Javi): su "own" no es un tope.
    const partnerEmployeeIds = new Set(partners.filter((p) => p.employeeId).map((p) => p.employeeId));
    const directAmountByEmployee = new Map();
    for (const [employeeId, plan] of paymentPlans) {
      if (partnerEmployeeIds.has(employeeId)) continue;
      if (plan.officialGross == null || !(plan.viaPartnerIds ?? []).length) continue;
      const person = rows.find((r) => r.employeeId === employeeId);
      if (!person) continue;
      const real = plan.officialNet ?? round2(person.workMoney - (deductionsByEmployee.get(employeeId) ?? 0));
      const bonus = plan.bonusCol ?? round2(person.travelMoney);
      directAmountByEmployee.set(employeeId, round2(real + bonus));
    }

    const netPayRows = buildNetPayRows({
      rows,
      extraPayees,
      deductionsByEmployee,
      bonusesByEmployee,
      tipsByEmployee,
      overrides: netPayOverrides,
      directAmountByEmployee,
    });
    const netPayById = new Map(netPayRows.map((n) => [n.employeeId, n]));
    for (const row of rows) {
      const n = netPayById.get(row.employeeId);
      row.deductions = n.deductions;
      row.bonuses = n.bonuses;
      row.tips = n.tips;
      row.netPayCalculated = n.calculated;
      row.netPay = n.applied;
      row.netPayOverridden = n.overridden;
    }
    const sumMap = (m) => round2([...m.values()].reduce((s, v) => s + v, 0));
    totals.deductions = deductionsTotal;
    totals.bonuses = sumMap(bonusesByEmployee);
    totals.tips = sumMap(tipsByEmployee);
    totals.netPay = round2(netPayRows.reduce((s, n) => s + n.applied, 0));

    // Los bonos son costo del negocio → entran en la nómina del P&L.
    const cleanerPayroll = round2(totals.totalMoney + totals.bonuses);
    // Mismo modelo que la planilla manual: "Ganancia" es el margen bruto
    // ANTES de gastos (ingresos - nómina - dividendos); "Ganancia Neta" recién
    // descuenta los 3 gastos operativos/administrativos/financieros. Los
    // dividendos restan igual que en el Excel, donde van dentro del Nominee
    // (pedido 2026-10-14).
    const { grossProfit, netProfit } = computeProfits({
      grossRevenue,
      cleanerPayroll,
      dividends: dividendsTotal,
      expensesTotal: expenseTotals.total,
    });
    pnl = {
      grossRevenue,
      cleanerPayroll,
      grossProfit,
      // Forecast (2026-09-30): pagos recibidos vs. lo que ya debería haber
      // ingresado vs. lo que ingresaría si se completa toda la quincena
      // como está agendada. Con GST (a diferencia de grossRevenue) — es
      // dinero real entrando/por entrar, no la base imponible del P&L.
      forecast,
      expensesFinancial: expenseTotals.financial,
      expensesOperational: expenseTotals.operational,
      expensesAdministrative: expenseTotals.administrative,
      expensesTotal: expenseTotals.total,
      netProfit,
      // Tabla de "gastos relevantes": Transporte (autocompletado con lo pagado
      // a cleaners por traslados, ya incluido en cleanerPayroll) + los
      // conceptos fijados por el admin (siempre presentes, aunque en 0).
      // Los dividendos se muestran aparte de la nómina, pero SÍ restan de
      // grossProfit (ver computeProfits).
      relevantExpenses: buildRelevantExpenses({
        travelMoney: totals.travelMoney,
        expenses: expenseList,
        pinned: pinnedConcepts,
      }),
      dividends: dividendsTotal,
      // Bonos incluidos en `cleanerPayroll` (para mostrarlos aparte).
      bonuses: totals.bonuses,
      // Ahorro: todavía sin definir de dónde sale el dato (pendiente).
      savings: null,
    };

    // NET PAY (resumen de arriba, editable) y tabla de pagos (quién cobra qué
    // y a través de quién) — ver payrollPaymentPlanService.js.
    netPaySummary = {
      rows: netPayRows,
      total: totals.netPay,
      tipsUnassigned,
    };
    paymentTable = {
      ...buildPaymentTable({
        people: rows.map((r) => ({
          employeeId: r.employeeId,
          name: r.name,
          workMoney: r.workMoney,
          travelMoney: r.travelMoney,
          workHours: r.workHours,
          travelHours: r.travelHours,
          bonuses: r.bonuses,
          tips: r.tips,
          deductions: r.deductions,
          // Horas extra y feriado: también son plata ganada (entran al tope
          // del plan y al "Bono"/"A <él>" de la tabla de pagos).
          extraMoney: round2(r.overtimeMoney + r.holidayMoney),
        })),
        plans: paymentPlans,
        partners,
        dividendsByPartner: sumByPartner(dividends),
        extrasByPartner: sumByPartner(partnerExtras),
      }),
      plans: [...paymentPlans.values()],
      partners,
    };
    // Pagos a los accionistas (dividendos + extras) en el mismo cuadro NET PAY.
    const stakeholderPayments = buildStakeholderPayments({
      partners,
      dividendsByPartner: sumByPartner(dividends),
      extrasByPartner: sumByPartner(partnerExtras),
      paymentRows: paymentTable.rows,
      dividendsTotal,
    });
    netPaySummary.stakeholders = stakeholderPayments.stakeholders;
    netPaySummary.otherDividends = stakeholderPayments.otherDividends;
    netPaySummary.stakeholdersTotal = stakeholderPayments.total;
  }

  return {
    ok: true,
    period: {
      year,
      month,
      half,
      label,
      from: from.toISODate(),
      to: toInclusive.toISODate(),
    },
    employees: rows,
    totals,
    ...(pnl && { pnl }),
    ...(clientBilling && { clientBilling }),
    ...(netPaySummary && { netPaySummary }),
    ...(paymentTable && { paymentTable }),
    ...(teamsByDay && { teamsByDay }),
    tz: TZ,
  };
}

// ── Resumen Anual (LAB428, 2026-09-30) ──────────────────────────────────
// Réplica de la hoja "Resumen_Anual" del Accounting.xlsx: un año, un mes por
// fila, cada mes es la suma de sus dos quincenas. Las columnas son
// exactamente los campos de `pnl` (Ing.Bruto=grossRevenue, Nominee=
// cleanerPayroll + dividends, Profit=grossProfit, G.Financ/Operat/Admin=
// expenses*, GA/CIA NETA=netProfit) — el Excel las suma con una fórmula por
// celda (`Ene_Q1!B4+Ene_Q2!B4`), acá es la misma suma en código.
const MONTH_LABELS = [
  "Enero", "Febrero", "Marzo", "Abril", "Mayo", "Junio",
  "Julio", "Agosto", "Septiembre", "Octubre", "Noviembre", "Diciembre",
];

const PNL_FIELDS = [
  "grossRevenue", "cleanerPayroll", "dividends", "grossProfit",
  "expensesFinancial", "expensesOperational", "expensesAdministrative", "expensesTotal",
  "netProfit",
];

function emptyPnl() {
  return PNL_FIELDS.reduce((acc, k) => ({ ...acc, [k]: 0 }), {});
}

function addPnl(a, b) {
  if (!b) return a;
  const out = { ...a };
  for (const k of PNL_FIELDS) out[k] = round2((out[k] || 0) + (b[k] || 0));
  return out;
}

// Una quincena cerrada se lee del snapshot (barato); si no, se calcula en
// vivo (mismo camino que /summary). Una quincena que todavía no arrancó no
// se calcula — vuelve null, igual que el Excel la deja en blanco.
async function getFortnightPnl(period) {
  const { from } = quincenaRange(period);
  if (from > DateTime.now().setZone(TZ)) return null;

  const closing = await getClosingPart(period, "summary");
  if (closing) {
    const pnl = closing.part?.pnl;
    // El snapshot es inmutable y se cerró con la fórmula vieja (dividendos
    // fuera de la ganancia): se recalculan las dos ganancias desde sus
    // componentes para que el año sea consistente.
    return pnl ? { ...pnl, dividends: pnl.dividends ?? 0, ...computeProfits(pnl) } : null;
  }

  const result = await computePayrollSummary({ ...period, includeTravelSlots: true });
  return result.pnl ?? null;
}

export async function buildAnnualSummary(year) {
  const periods = [];
  for (let month = 1; month <= 12; month++) {
    periods.push({ year, month, half: 1 });
    periods.push({ year, month, half: 2 });
  }
  const pnls = await Promise.all(periods.map(getFortnightPnl));

  const rows = [];
  let total = emptyPnl();
  for (let month = 1; month <= 12; month++) {
    const p1 = pnls[(month - 1) * 2];
    const p2 = pnls[(month - 1) * 2 + 1];
    const hasData = Boolean(p1 || p2);
    const monthPnl = addPnl(addPnl(emptyPnl(), p1), p2);
    if (hasData) total = addPnl(total, monthPnl);
    rows.push({ month, label: MONTH_LABELS[month - 1], hasData, ...monthPnl });
  }
  return { rows, total };
}

// ── Equipos por día ──────────────────────────────────────────────────────
// `daily_team_assignments` guarda, por fecha, a qué equipo (team_1, team_2…)
// pertenece cada cleaner. La vista "All records" agrupa por equipo dentro de
// cada día, así que el summary admin expone { 'YYYY-MM-DD': { employeeId:
// 'team_1' } }. Pura (testeable): recibe las filas crudas de la tabla.
export function buildTeamsByDay(assignments) {
  const out = {};
  for (const a of assignments ?? []) {
    if (!a?.date || !a.employee_id || !a.team_id) continue;
    (out[a.date] ??= {})[a.employee_id] = a.team_id;
  }
  return out;
}

// Degrada a {} si la query falla: el agrupamiento por equipo es cosmético,
// no debe tumbar todo el summary.
async function loadTeamsByDay(fromDate, toDate) {
  const { data, error } = await supabase
    .from("daily_team_assignments")
    .select("date, team_id, employee_id")
    .gte("date", fromDate)
    .lte("date", toDate);
  if (error) {
    console.warn("payroll teamsByDay:", error.message);
    return {};
  }
  return buildTeamsByDay(data);
}

// ── loadTravelOverrides ──────────────────────────────────────────────────
// Una sola query para todos los empleados en juego (evita N+1). Devuelve
// Map employeeId → Map(`"${prevEventId}::${nextEventId}"` → override).
// `recordHistory()` no aplica acá (no es un campo de una fila con historial
// genérico, es su propia tabla chica) — no se llama.
async function loadTravelOverrides(employeeIds) {
  const byEmployee = new Map();
  if (!employeeIds?.length) return byEmployee;

  const { data, error } = await supabase
    .from("payroll_travel_overrides")
    .select("employee_id, prev_event_id, next_event_id, applied_hours, reviewed_by, reviewed_at")
    .in("employee_id", employeeIds);
  if (error) {
    // Degrada con gracia si la migración todavía no corrió (PGRST205 =
    // "tabla no encontrada en el schema cache de PostgREST") — mismo
    // criterio que distanceService con distance_geocode_cache: el resto de
    // Payroll sigue andando (todo slot >=1h queda simplemente sin revisar,
    // 0h, que es el default de todas formas) en vez de tirar la pestaña
    // entera abajo por una tabla que todavía no existe.
    if (error.code === "PGRST205") {
      console.warn(
        "⚠️ [payrollSummaryService] payroll_travel_overrides no existe todavía " +
          "(falta correr la migración 20260916_payroll_travel_overrides.sql) — " +
          "sigo sin overrides.",
      );
      return byEmployee;
    }
    throw new Error(`payroll travel overrides: ${error.message}`);
  }

  for (const o of data ?? []) {
    if (!byEmployee.has(o.employee_id)) byEmployee.set(o.employee_id, new Map());
    byEmployee.get(o.employee_id).set(`${o.prev_event_id}::${o.next_event_id}`, {
      appliedHours: Number(o.applied_hours),
      reviewedBy: o.reviewed_by,
      reviewedAt: o.reviewed_at,
    });
  }
  return byEmployee;
}

// ── setTravelSlotOverride ────────────────────────────────────────────────
// Upsert de la decisión manual de un admin para un tramo puntual. La unique
// key de la tabla es (employee_id, prev_event_id, next_event_id) — volver a
// llamar para el mismo tramo actualiza el valor, no duplica la fila.
export async function setTravelSlotOverride({
  employeeId,
  prevEventId,
  nextEventId,
  appliedHours,
  calculatedHours,
  reviewedBy,
}) {
  const { error } = await supabase.from("payroll_travel_overrides").upsert(
    {
      employee_id: employeeId,
      prev_event_id: prevEventId,
      next_event_id: nextEventId,
      applied_hours: appliedHours,
      calculated_hours: calculatedHours ?? null,
      reviewed_by: reviewedBy ?? null,
      reviewed_at: new Date().toISOString(),
    },
    { onConflict: "employee_id,prev_event_id,next_event_id" },
  );
  if (error) throw new Error(`payroll travel override upsert: ${error.message}`);
}

// ── stripMoney ────────────────────────────────────────────────────────────
// Borra todo campo de plata de la respuesta antes de mandarla a un cleaner.
// Los campos se OMITEN (delete), no se mandan como null — así un frontend
// que itere Object.keys() no encuentra ni rastro de la key. Es lo único que
// decide qué ve un cleaner: nunca un prop de frontend (criterio 7).
export function stripMoney(summary) {
  const strip = (obj) => {
    const {
      workMoney,
      travelMoney,
      overtimeMoney,
      holidayMoney,
      holidayDays,
      totalMoney,
      deductions,
      netPay,
      netPayCalculated,
      netPayOverridden,
      bonuses,
      tips,
      ...rest
    } = obj;
    return rest;
  };
  const stripEvent = (e) => {
    const {
      calculatedAmount,
      appliedAmount,
      billedRate,
      attendeeNames,
      serviceType,
      billingReviewedBy,
      billingReviewedAt,
      clientId,
      cleanerPay,
      cleanerPayTotal,
      businessProfit,
      invoiceId,
      invoiceStatus,
      paidDate,
      ...rest
    } = e;
    return rest;
  };
  const { pnl, clientBilling, netPaySummary, paymentTable, teamsByDay, ...restSummary } = summary;
  return {
    ...restSummary,
    employees: summary.employees.map((emp) => ({
      ...strip(emp),
      events: (emp.events ?? []).map(stripEvent),
    })),
    totals: strip(summary.totals),
  };
}
