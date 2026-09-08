// controllers/staffHoursController.js
// Portado de Monkey Cleaning (LAB425) — horas acumuladas por quincena para el
// cleaner logueado. Reimplementado contra appointments + appointment_teams.

import { DateTime } from "luxon";
import { supabase } from "../supabaseClient.js";
import { isNonServiceEventRow } from "../services/eventClassification.js";

const TZ = process.env.BOOKING_TIMEZONE || "America/Vancouver";

// Mismo criterio que getQuincenalRange en el frontend (día 1–15 = Q1,
// 16–fin de mes = Q2), en TZ Vancouver — el corte de un cleaner no puede
// depender del huso horario de su celular.
function getQuincenalRange(period) {
  const today = DateTime.now().setZone(TZ);
  const { year, month, day } = today;

  let from, toInclusive;
  if (day <= 15) {
    from = DateTime.fromObject({ year, month, day: 1 }, { zone: TZ });
    toInclusive = DateTime.fromObject({ year, month, day: 15 }, { zone: TZ });
  } else {
    from = DateTime.fromObject({ year, month, day: 16 }, { zone: TZ });
    toInclusive = from.endOf("month").startOf("day");
  }

  if (period === "previous") {
    if (from.day === 1) {
      const prevMonth = from.minus({ months: 1 });
      from = DateTime.fromObject(
        { year: prevMonth.year, month: prevMonth.month, day: 16 },
        { zone: TZ },
      );
      toInclusive = from.endOf("month").startOf("day");
    } else {
      from = DateTime.fromObject({ year, month, day: 1 }, { zone: TZ });
      toInclusive = DateTime.fromObject({ year, month, day: 15 }, { zone: TZ });
    }
  }

  const qNum = from.day === 1 ? 1 : 2;
  const label = `Q${qNum} ${from.toFormat("LLL yyyy")}`;
  return { from, toInclusive, label };
}

async function resolveEmployeeId(email) {
  if (!email) return null;
  const { data } = await supabase
    .from("employees")
    .select("id")
    .eq("email", email)
    .maybeSingle();
  return data?.id ?? null;
}

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/staff/hours/summary?period=current|previous
// requireCleaner. Suma la duración de los servicios YA prestados (ends_at
// pasado) donde el cleaner está en appointment_teams, excluyendo no-servicio
// (Lunch/bloqueos) y cancelados.
// ─────────────────────────────────────────────────────────────────────────────
export async function getStaffHoursSummary(req, res) {
  try {
    const period = req.query.period === "previous" ? "previous" : "current";

    const selfEmail = (req.cleaner?.email || "").toLowerCase();
    const selfId = await resolveEmployeeId(selfEmail);
    if (!selfId) {
      return res.status(403).json({
        ok: false,
        error: "This account is not linked to an employee record",
      });
    }

    const { from, toInclusive, label } = getQuincenalRange(period);
    const timeMin = from.toISO();
    const timeMax = toInclusive.plus({ days: 1 }).toISO(); // exclusivo
    const nowIso = DateTime.now().setZone(TZ).toISO();

    const { data: rows, error } = await supabase
      .from("appointments")
      .select(
        "id, color_id, gcal_summary, starts_at, ends_at, status, appointment_teams(employee_id)",
      )
      .gte("starts_at", timeMin)
      .lt("starts_at", timeMax)
      .neq("status", "cancelled");
    if (error) throw error;

    let hours = 0;
    let eventCount = 0;
    for (const r of rows ?? []) {
      if (isNonServiceEventRow(r)) continue;
      if (!(r.appointment_teams ?? []).some((t) => t.employee_id === selfId))
        continue;
      if (!r.ends_at || r.ends_at > nowIso) continue; // solo prestados
      const start = DateTime.fromISO(r.starts_at, { zone: TZ });
      const end = DateTime.fromISO(r.ends_at, { zone: TZ });
      if (!start.isValid || !end.isValid) continue;
      hours += end.diff(start, "hours").hours;
      eventCount++;
    }

    return res.json({
      ok: true,
      from: from.toISODate(),
      to: toInclusive.toISODate(),
      label,
      hours: Math.round(hours * 100) / 100,
      eventCount,
    });
  } catch (e) {
    console.error("❌ getStaffHoursSummary:", e.message);
    return res.status(500).json({ ok: false, error: e.message });
  }
}
