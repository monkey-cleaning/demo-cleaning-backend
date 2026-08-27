import { supabase } from "../supabaseClient.js";
import { DateTime } from "luxon";
import {
  getEventsForRange,
  TEAMS_CONFIG,
  TEAM_MEMBERS_MAP,
} from "./calendarController.js";

// ── Config ────────────────────────────────────────────────────────────────────

const TZ = process.env.BOOKING_TIMEZONE ?? "America/Vancouver";
const RISK_DAYS = 21;
const INACTIVE_DAYS = 30;

// Tarifa promedio por tipo de servicio (derivada de cleaningQuoteCalculator.js)
// ratePerHour × clockHoursForTwoPeople promedio por tipo
const RATE_BY_TYPE = {
  Residential: 180, // Recurrente ~40/h × 4.5h
  Commercial: 250, // Commercial ~50/h × 5h
  "Post-construction": 300, // Post Construction ~50/h × 6h (×1.5 multiplier)
  Special: 220, // Deep Cleaning ~45/h × ~5h (×1.25)
};
const RATE_DEFAULT = 180;

// ── Helpers ───────────────────────────────────────────────────────────────────

function inferServiceType(summary = "") {
  const t = summary.toLowerCase();
  if (
    t.includes("comercial") ||
    t.includes("office") ||
    t.includes("corporate")
  )
    return "Commercial";
  if (t.includes("post") || t.includes("construc")) return "Post-construction";
  if (t.includes("especial") || t.includes("tapicería") || t.includes("carpet"))
    return "Special";
  return "Residential";
}

function isoRange(unit /* 'day' | 'week' */) {
  const start = DateTime.now().setZone(TZ).startOf(unit);
  return {
    timeMin: start.toISO(),
    timeMax: start.endOf(unit).toISO(),
  };
}

// Builds the inverse map: teamId → [emails]  (derived from TEAM_MEMBERS_MAP)
// TEAM_MEMBERS_MAP is email (lowercase) → teamId, so we just invert it.
function buildTeamMembersRaw() {
  const raw = {};
  for (const [email, teamId] of Object.entries(TEAM_MEMBERS_MAP)) {
    if (!raw[teamId]) raw[teamId] = [];
    raw[teamId].push(email);
  }
  return raw;
}

// Resolve a team's display color: prefer explicit cfg.color, fall back to grey.
function resolveTeamColor(teamId, cfg) {
  return cfg?.color ?? "#6b7280";
}

// Return the most-frequent non-null value in an array, or null if all null.
function dominant(arr) {
  const counts = {};
  let best = null;
  let bestCount = 0;
  for (const v of arr) {
    if (v == null) continue;
    counts[v] = (counts[v] ?? 0) + 1;
    if (counts[v] > bestCount) {
      best = v;
      bestCount = counts[v];
    }
  }
  return best;
}

// ── eventos del calendario (hoy y semana) ─────────────────────────
const IGNORED_SUMMARIES = ["lunch", "hg"]; // agregar los que necesites

async function fetchEvents({ timeMin, timeMax }) {
  const events = await getEventsForRange(timeMin, timeMax);
  return events.filter((e) => {
    const summary = (e.summary ?? "").trim().toLowerCase();
    return !IGNORED_SUMMARIES.includes(summary);
  });
}

// ── clientes inactivos desde Supabase ───────────────────────────────────

async function fetchInactiveCount() {
  const { count, error } = await supabase
    .from("clients")
    .select("id", { count: "exact", head: true })
    .eq("status", "inactive");

  if (error) throw error;
  return count ?? 0;
}

// ── equipos activos desde TEAMS_CONFIG ──────────────────────────────────

function getTeamsInfo(todayEvents) {
  const totalTeams = Object.keys(TEAMS_CONFIG).length;

  // Equipos que tienen al menos 1 evento hoy
  const activeTeamIds = new Set(
    todayEvents.map((e) => e.teamId).filter(Boolean),
  );

  return {
    active: activeTeamIds.size,
    total: totalTeams,
  };
}

// ── Controlador principal ─────────────────────────────────────────────────────

export async function getOperationalKPIs(req, res) {
  try {
    const todayRange = isoRange("day");
    const weekRange = isoRange("week");

    // Paralelo: eventos de hoy, eventos de la semana, clientes inactivos
    const [todayEvents, weekEvents, inactiveCount] = await Promise.all([
      fetchEvents(todayRange).catch(() => []),
      fetchEvents(weekRange).catch(() => []),
      fetchInactiveCount().catch(() => 0),
    ]);

    // Servicios hoy
    const servicesToday = todayEvents.length;

    // Equipos activos
    const activeTeams = getTeamsInfo(todayEvents);

    // Clientes inactivos (total: inactivos + en riesgo)
    const clientsInactive = inactiveCount;

    // Ingresos estimados semana
    const estimatedWeeklyRev = weekEvents.reduce((sum, e) => {
      const type = inferServiceType(e.summary ?? "");
      return sum + (RATE_BY_TYPE[type] ?? RATE_DEFAULT);
    }, 0);

    return res.json({
      servicesToday,
      activeTeams, // { active: 2, total: 2 }
      clientsInactive,
      estimatedWeeklyRev, // número en CAD
    });
  } catch (err) {
    console.error("[dashboardController] getOperationalKPIs error:", err);
    return res
      .status(500)
      .json({ error: err.message ?? "Internal server error" });
  }
}

export async function getTeamsToday(req, res) {
  try {
    // Derive teamId → [emails] from the imported TEAM_MEMBERS_MAP
    const TEAM_MEMBERS_RAW = buildTeamMembersRaw();

    // ── 1. Today's date window ─────────────────────────────────────────────
    const today = DateTime.now().setZone(TZ);
    const dateStr = today.toISODate();
    const dayStart = today.startOf("day");
    const dayEnd = today.endOf("day");

    // ── 2. Pull today's events from the cache-backed month fetcher ─────────
    const todayEvents = await getEventsForRange(
      dayStart.toISO(),
      dayStart.plus({ days: 1 }).toISO(),
    );

    // ── 3. Pull service_type for today's appointments from Supabase ────────
    //    Keyed by gcal event id so we can enrich the event objects.
    const apptIds = todayEvents.map((e) => e.id).filter(Boolean);
    let serviceTypeByApptId = {};

    if (apptIds.length > 0) {
      const { data: appts } = await supabase
        .from("appointments")
        .select("id, service_type")
        .in("id", apptIds);

      for (const a of appts ?? []) {
        if (a.id && a.service_type) {
          serviceTypeByApptId[a.id] = a.service_type;
        }
      }
    }

    // ── 4. Pull active employees with their names, roles and emails ────────
    const { data: employees, error: empErr } = await supabase
      .from("employees")
      .select("id, name, email, is_team_leader, is_active")
      .eq("is_active", true)
      .order("name");
    if (empErr) throw empErr;

    // Build email → employee lookup
    const employeeByEmail = {};
    for (const emp of employees ?? []) {
      if (emp.email) employeeByEmail[emp.email.toLowerCase()] = emp;
    }

    // ── 5. Build a card per known team ────────────────────────────────────
    const teamCards = Object.entries(TEAMS_CONFIG).map(([teamId, cfg]) => {
      const teamEmails = (TEAM_MEMBERS_RAW[teamId] || []).map((e) =>
        e.toLowerCase(),
      );
      const teamEvents = todayEvents.filter((e) => e.teamId === teamId);
      const serviceTypes = teamEvents.map(
        (e) => serviceTypeByApptId[e.id] ?? null,
      );

      const members = teamEmails.map((email) => {
        const emp = employeeByEmail[email];
        return {
          name: emp?.name ?? email,
          email,
          is_team_leader: emp?.is_team_leader ?? false,
          is_active: emp?.is_active ?? false,
        };
      });

      return {
        teamId,
        label: cfg.label ?? teamId,
        color: resolveTeamColor(teamId, cfg),
        emojis: cfg.emojis ?? [],
        members,
        serviceCount: teamEvents.length,
        dominantType: dominant(serviceTypes),
        events: teamEvents,
      };
    });

    // ── 6. Available Staff card — active employees not in any team ──────────
    const assignedEmails = new Set(
      Object.values(TEAM_MEMBERS_RAW)
        .flat()
        .map((e) => e.toLowerCase()),
    );
    const unassigned = (employees ?? []).filter(
      (emp) => emp.email && !assignedEmails.has(emp.email.toLowerCase()),
    );

    // Always append the unassigned card (CA3) — frontend hides it if empty
    const availablesCard = {
      teamId: null,
      label: "Available Staff",
      color: null, // frontend renders dashed border
      emojis: [],
      members: unassigned.map((e) => ({
        name: e.name,
        email: e.email,
        is_team_leader: e.is_team_leader ?? false,
        is_active: true,
      })),
      serviceCount: 0,
      dominantType: null,
      events: [],
    };

    return res.json({
      ok: true,
      date: dateStr,
      teams: [...teamCards, availablesCard],
    });
  } catch (e) {
    console.error("❌ getTeamsToday:", e.message);
    return res.status(500).json({ ok: false, error: e.message });
  }
}
