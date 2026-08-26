import { supabase } from "../supabaseClient.js";

function parseIntSafe(v, fallback) {
  const n = parseInt(v, 10);
  return isNaN(n) ? fallback : n;
}

const PAGE_LIMIT = 25;

// Fields safe to write from the request body (whitelist)
const WRITABLE_FIELDS = [
  "client_id", "scheduled_date", "scheduled_start_time", "scheduled_end_time",
  "status", "property_address", "property_size_range", "estimated_hours",
  "has_carpet_cleaning", "special_instructions", "service_type", "value",
  "google_calendar_event_id", "starts_at", "ends_at", "timezone", "is_locked",
];

function pickWritable(body) {
  return Object.fromEntries(
    Object.entries(body).filter(([k, v]) => WRITABLE_FIELDS.includes(k) && v !== undefined)
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Shared select for appointment lists
// ─────────────────────────────────────────────────────────────────────────────
const APPOINTMENT_SELECT = `
  id,
  scheduled_date,
  scheduled_start_time,
  scheduled_end_time,
  actual_start_time,
  actual_end_time,
  status,
  property_address,
  property_size_range,
  estimated_hours,
  actual_hours,
  has_carpet_cleaning,
  special_instructions,
  service_type,
  value,
  is_locked,
  google_calendar_event_id,
  created_at,
  updated_at,
  starts_at,
  ends_at,
  client:client_id (
    id, 
    first_name, 
    last_name, 
    email, 
    phone
  ),
  teams:appointment_teams (
    role,
    employee:employee_id ( 
      id, 
      name, 
      phone, 
      is_team_leader 
    )
  )
`.trim();

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/admin/appointments/weekly-summary
// Query: start (YYYY-MM-DD), end (YYYY-MM-DD)
//
// Returns { [employee_id]: count } for all employees that have at least one
// non-cancelled appointment in the given date range, in a single query.
// The frontend uses this to populate "servicios esta semana" for all rows
// at once, replacing the previous N+1 per-employee fetch.
// ─────────────────────────────────────────────────────────────────────────────
export async function getWeeklySummary(req, res) {
  try {
    const { start, end } = req.query;

    if (!start || !end) {
      return res.status(400).json({ ok: false, error: "start and end query params are required (YYYY-MM-DD)" });
    }

    // 1. Find all appointments in range with a non-cancelled status
    const { data: appointments, error: aptErr } = await supabase
      .from("appointments")
      .select("id")
      .gte("scheduled_date", start)
      .lte("scheduled_date", end)
      .neq("status", "cancelled");

    if (aptErr) throw aptErr;

    if (!appointments || appointments.length === 0) {
      return res.json({ ok: true, summary: {} });
    }

    const appointmentIds = appointments.map(a => a.id);

    // 2. Join with appointment_teams to count per employee
    const { data: teamRows, error: teamErr } = await supabase
      .from("appointment_teams")
      .select("employee_id")
      .in("appointment_id", appointmentIds);

    if (teamErr) throw teamErr;

    // 3. Aggregate counts in JS — avoids needing a raw SQL GROUP BY
    const summary = {};
    for (const row of teamRows ?? []) {
      summary[row.employee_id] = (summary[row.employee_id] ?? 0) + 1;
    }

    return res.json({ ok: true, summary });
  } catch (e) {
    console.error("❌ getWeeklySummary:", e.message);
    return res.status(500).json({ ok: false, error: e.message });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/admin/appointments
// Query: employee_id, client_id, start (date), end (date),
//        status, page, limit
//
// Used by the weekly schedule modal in AdminStaffPage:
//   /api/admin/appointments?employee_id=X&start=YYYY-MM-DD&end=YYYY-MM-DD
// ─────────────────────────────────────────────────────────────────────────────
export async function listAppointments(req, res) {
  try {
    const page        = parseIntSafe(req.query.page, 1);
    const limit       = parseIntSafe(req.query.limit, PAGE_LIMIT);
    const offset      = (page - 1) * limit;
    const { employee_id, client_id, start, end, status } = req.query;

    // When filtering by employee we need to go through appointment_teams.
    // Supabase doesn't support filtering on a joined table in a top-level
    // .select() + .eq(), so we resolve the appointment IDs first.
    let appointmentIds = null;

    if (employee_id) {
      const { data: teamRows, error: teamErr } = await supabase
        .from("appointment_teams")
        .select("appointment_id")
        .eq("employee_id", employee_id);

      if (teamErr) throw teamErr;

      appointmentIds = (teamRows ?? []).map(r => r.appointment_id);

      // Employee has no appointments in range — return early
      if (appointmentIds.length === 0) {
        return res.json({
          ok: true,
          appointments: [],
          pagination: { page, limit, total: 0, pages: 0 },
        });
      }
    }

    let query = supabase
      .from("appointments")
      .select(APPOINTMENT_SELECT, { count: "exact" })
      .order("scheduled_date", { ascending: true })
      .order("scheduled_start_time", { ascending: true })
      .range(offset, offset + limit - 1);

    if (appointmentIds) query = query.in("id", appointmentIds);
    if (client_id)      query = query.eq("client_id", client_id);
    if (status)         query = query.eq("status", status);
    if (start)          query = query.gte("scheduled_date", start);
    if (end)            query = query.lte("scheduled_date", end);

    const { data, error, count } = await query;
    if (error) throw error;

    const total = count ?? 0;
    return res.json({
      ok: true,
      appointments: (data ?? []).map(normalizeAppointment),
      pagination: { page, limit, total, pages: Math.ceil(total / limit) },
    });
  } catch (e) {
    console.error("❌ listAppointments:", e.message);
    return res.status(500).json({ ok: false, error: e.message });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/admin/appointments/:id
// ─────────────────────────────────────────────────────────────────────────────
export async function getAppointment(req, res) {
  try {
    const { id } = req.params;

    const { data, error } = await supabase
      .from("appointments")
      .select(`
        ${APPOINTMENT_SELECT},
        history:appointment_history (
          id, changed_field, old_value, new_value, changed_by, changed_at, reason
        )
      `)
      .eq("id", id)
      .single();

    if (error) throw error;
    if (!data) return res.status(404).json({ ok: false, error: "Appointment not found" });

    return res.json({ ok: true, appointment: normalizeAppointment(data) });
  } catch (e) {
    console.error("❌ getAppointment:", e.message);
    const status = e.code === "PGRST116" ? 404 : 500;
    return res.status(status).json({ ok: false, error: e.message });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/admin/appointments
// Body: client_id*, scheduled_date*, scheduled_start_time*, scheduled_end_time*,
//       property_address*, property_size_range*, ...optional fields
//       employee_ids?: string[]   — assigned team members
// ─────────────────────────────────────────────────────────────────────────────
export async function createAppointment(req, res) {
  try {
    const fields = pickWritable(req.body);
    const { employee_ids = [] } = req.body;

    // Required field validation
    const required = ["client_id", "scheduled_date", "scheduled_start_time",
                      "scheduled_end_time", "property_address", "property_size_range"];
    for (const f of required) {
      if (!fields[f]) {
        return res.status(400).json({ ok: false, error: `${f} is required` });
      }
    }

    const { data: appointment, error: aptErr } = await supabase
      .from("appointments")
      .insert(fields)
      .select()
      .single();

    if (aptErr) throw aptErr;

    if (employee_ids.length > 0) {
      const teamRows = employee_ids.map((eid, idx) => ({
        appointment_id: appointment.id,
        employee_id:    eid,
        role:           idx === 0 ? "leader" : "member",
      }));

      const { error: teamErr } = await supabase
        .from("appointment_teams")
        .insert(teamRows);

      if (teamErr) throw teamErr;
    }

    console.log(`✅ Created appointment: ${appointment.id}`);
    return res.status(201).json({ ok: true, appointment });
  } catch (e) {
    console.error("❌ createAppointment:", e.message);
    return res.status(500).json({ ok: false, error: e.message });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// PATCH /api/admin/appointments/:id
// Body: any subset of writable fields
//       employee_ids?: string[]   — replaces the entire team if provided
// ─────────────────────────────────────────────────────────────────────────────
export async function updateAppointment(req, res) {
  try {
    const { id }   = req.params;
    const fields   = pickWritable(req.body);
    const { employee_ids } = req.body;

    if (Object.keys(fields).length === 0 && employee_ids === undefined) {
      return res.status(400).json({ ok: false, error: "No valid fields to update" });
    }

    if (Object.keys(fields).length > 0) {
      fields.updated_at = new Date().toISOString();

      const { error } = await supabase
        .from("appointments")
        .update(fields)
        .eq("id", id);

      if (error) throw error;
    }

    if (Array.isArray(employee_ids)) {
      const { error: delErr } = await supabase
        .from("appointment_teams")
        .delete()
        .eq("appointment_id", id);

      if (delErr) throw delErr;

      if (employee_ids.length > 0) {
        const teamRows = employee_ids.map((eid, idx) => ({
          appointment_id: id,
          employee_id:    eid,
          role:           idx === 0 ? "leader" : "member",
        }));

        const { error: teamErr } = await supabase
          .from("appointment_teams")
          .insert(teamRows);

        if (teamErr) throw teamErr;
      }
    }

    const { data, error: fetchErr } = await supabase
      .from("appointments")
      .select(APPOINTMENT_SELECT)
      .eq("id", id)
      .single();

    if (fetchErr) throw fetchErr;
    if (!data) return res.status(404).json({ ok: false, error: "Appointment not found" });

    console.log(`✅ Updated appointment: ${id}`);
    return res.json({ ok: true, appointment: normalizeAppointment(data) });
  } catch (e) {
    console.error("❌ updateAppointment:", e.message);
    const status = e.code === "PGRST116" ? 404 : 500;
    return res.status(status).json({ ok: false, error: e.message });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// DELETE /api/admin/appointments/:id
// Hard delete — cascade removes appointment_teams and appointment_history
// ─────────────────────────────────────────────────────────────────────────────
export async function deleteAppointment(req, res) {
  try {
    const { id } = req.params;

    const { error } = await supabase
      .from("appointments")
      .delete()
      .eq("id", id);

    if (error) throw error;

    console.log(`🗑️  Deleted appointment: ${id}`);
    return res.json({ ok: true });
  } catch (e) {
    console.error("❌ deleteAppointment:", e.message);
    return res.status(500).json({ ok: false, error: e.message });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function normalizeAppointment(row) {
  return {
    ...row,
    date:         row.scheduled_date,
    start_time:   row.scheduled_start_time?.slice(0, 5) ?? null,
    end_time:     row.scheduled_end_time?.slice(0, 5)   ?? null,
    
    // Nombre completo del cliente
    client_name: row.client 
      ? `${row.client.first_name || ''} ${row.client.last_name || ''}`.trim()
      : null,
    
    address: row.property_address,
  };
}

// Event search by title

const EVENT_SEARCH_UPCOMING_LIMIT = 2;
const EVENT_SEARCH_PAST_LIMIT = 2;
 
export async function searchAppointmentsByTitle(req, res) {
  try {
    const q = String(req.query.q || "").trim();
    if (q.length < 2) {
      return res.json({ ok: true, events: [] });
    }
 
    const nowIso = new Date().toISOString();
 
    const baseQuery = () =>
      supabase
        .from("appointments")
        .select("google_calendar_event_id, gcal_summary, scheduled_date, starts_at, client_id")
        .not("google_calendar_event_id", "is", null)
        .neq("status", "cancelled")
        .ilike("gcal_summary", `%${q}%`);
 
    const [{ data: upcoming, error: upErr }, { data: past, error: pastErr }] = await Promise.all([
      baseQuery()
        .gte("starts_at", nowIso)
        .order("starts_at", { ascending: true }) // el más cercano primero
        .limit(EVENT_SEARCH_UPCOMING_LIMIT),
      baseQuery()
        .lt("starts_at", nowIso)
        .order("starts_at", { ascending: false }) // el más reciente primero
        .limit(EVENT_SEARCH_PAST_LIMIT),
    ]);
 
    if (upErr) throw upErr;
    if (pastErr) throw pastErr;
 
    const mapRow = (row, isPast) => ({
      id: row.google_calendar_event_id,
      summary: row.gcal_summary || "(No title)",
      startIso: row.starts_at,
      startDate: row.scheduled_date,
      isAllDay: false,
      isPast,
      clientId: row.client_id ?? null,
      htmlLink: null,
    });
 
    // Orden de lectura: próximos (más cercano → más lejano), después
    // pasados (más reciente → más viejo) — igual que el buscador de GCal.
    const events = [
      ...(upcoming ?? []).map((r) => mapRow(r, false)),
      ...(past ?? []).map((r) => mapRow(r, true)),
    ];
 
    return res.json({ ok: true, events });
  } catch (e) {
    console.error("❌ searchAppointmentsByTitle:", e.message);
    return res.status(500).json({ ok: false, error: e.message });
  }
}