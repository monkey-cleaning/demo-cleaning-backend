// controllers/payrollController.js
// LAB428 (portado de Monkey Cleaning) — pestaña "Payroll": resumen quincenal
// de eventos/horas/traslado/dinero. Dos handlers sobre el mismo service — el
// gating de plata y de "solo mis propios datos" es estructural (qué handler
// corre según el middleware de auth), no un flag de query ni algo que decida
// el frontend.
import { supabase } from "../supabaseClient.js";
import {
  computePayrollSummary,
  stripMoney,
} from "../services/payrollSummaryService.js";

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
// Requiere requireAdmin. Devuelve TODOS los empleados activos, con plata.
// ─────────────────────────────────────────────────────────────────────────────
export async function getAdminPayrollSummary(req, res) {
  try {
    const parsed = parsePeriodQuery(req.query);
    if (parsed.error) {
      return res.status(400).json({ ok: false, error: parsed.error });
    }

    const summary = await computePayrollSummary(parsed);
    return res.json(summary);
  } catch (e) {
    console.error("❌ getAdminPayrollSummary:", e.message);
    return res.status(500).json({ ok: false, error: e.message });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/staff/payroll/summary?year=&month=&half=
// Requiere requireCleaner. Resuelve el employee propio por req.cleaner.email
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
