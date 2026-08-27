import { supabase } from "../supabaseClient.js";

const PAGE_LIMIT = 25;

function parseIntSafe(v, fallback) {
  const n = parseInt(v, 10);
  return isNaN(n) ? fallback : n;
}

// Fields safe to write from the request body (whitelist)
const WRITABLE_FIELDS = [
  "name",
  "email",
  "phone",
  "hire_date",
  "is_active",
  "hourly_work_rate",
  "hourly_travel_rate",
  "notes",
  "has_license",
  "is_team_leader",
  "e_transfer_email",
  "gender",
];

const VALID_GENDERS = new Set(["male", "female", "other"]);

function pickWritable(body) {
  const fields = Object.fromEntries(
    Object.entries(body).filter(
      ([k, v]) => WRITABLE_FIELDS.includes(k) && v !== undefined,
    ),
  );
  // "" desde un <select> sin elegir opción → tratarlo como "no cargado"
  // en vez de intentar insertar un string vacío que rompe el CHECK.
  if (fields.gender === "") fields.gender = null;
  return fields;
}

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/admin/staff
// Query: search, active (true|false|all), page, limit
// ─────────────────────────────────────────────────────────────────────────────
export async function listEmployees(req, res) {
  try {
    const page = parseIntSafe(req.query.page, 1);
    const limit = parseIntSafe(req.query.limit, PAGE_LIMIT);
    const offset = (page - 1) * limit;
    const search = req.query.search?.trim() ?? "";
    const active = req.query.active ?? "true"; // default: only active staff

    let query = supabase
      .from("employees")
      .select("*", { count: "exact" })
      .order("name", { ascending: true })
      .range(offset, offset + limit - 1);

    // Filter by active status unless caller explicitly requests all
    if (active !== "all") {
      query = query.eq("is_active", active !== "false");
    }

    if (search) {
      query = query.or(
        `name.ilike.%${search}%,email.ilike.%${search}%,phone.ilike.%${search}%`,
      );
    }

    const { data, error, count } = await query;
    if (error) throw error;

    const total = count ?? 0;
    return res.json({
      ok: true,
      employees: data ?? [],
      pagination: {
        page,
        limit,
        total,
        pages: Math.ceil(total / limit),
      },
    });
  } catch (e) {
    console.error("❌ listEmployees:", e.message);
    return res.status(500).json({ ok: false, error: e.message });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/admin/staff/:id
// Returns employee + their weekly availability + upcoming time off
// ─────────────────────────────────────────────────────────────────────────────
export async function getEmployee(req, res) {
  try {
    const { id } = req.params;

    // Fetch employee
    const { data: employee, error: empErr } = await supabase
      .from("employees")
      .select("*")
      .eq("id", id)
      .single();

    if (empErr) throw empErr;
    if (!employee)
      return res.status(404).json({ ok: false, error: "Employee not found" });

    // Fetch weekly availability
    const { data: availability, error: availErr } = await supabase
      .from("employee_availability")
      .select("day_of_week, start_time, end_time")
      .eq("employee_id", id)
      .order("day_of_week");

    const normalizedAvailability = (availability ?? []).map((a) => ({
      day_of_week: a.day_of_week,
      start_time: a.start_time.slice(0, 5), // "08:00:00" → "08:00"
      end_time: a.end_time.slice(0, 5),
    }));

    if (availErr) throw availErr;

    // Fetch upcoming time off (from today onwards)
    const { data: timeOff, error: timeOffErr } = await supabase
      .from("employee_time_off")
      .select("id, start_date, end_date, reason, notes")
      .eq("employee_id", id)
      .gte("end_date", new Date().toISOString().split("T")[0])
      .order("start_date");

    if (timeOffErr) throw timeOffErr;

    return res.json({
      ok: true,
      employee: {
        ...employee,
        availability: normalizedAvailability,
        time_off: timeOff ?? [],
      },
    });
  } catch (e) {
    console.error("❌ getEmployee:", e.message);
    const status = e.code === "PGRST116" ? 404 : 500;
    return res.status(status).json({ ok: false, error: e.message });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/admin/staff
// Body: name*, hourly_work_rate*, hourly_travel_rate*, email, phone,
//       hire_date, has_license, is_team_leader, e_transfer_email, notes
// ─────────────────────────────────────────────────────────────────────────────
export async function createEmployee(req, res) {
  try {
    const fields = pickWritable(req.body);

    if (!fields.name?.trim()) {
      return res.status(400).json({ ok: false, error: "name is required" });
    }
    if (fields.hourly_work_rate == null || fields.hourly_travel_rate == null) {
      return res
        .status(400)
        .json({
          ok: false,
          error: "hourly_work_rate and hourly_travel_rate are required",
        });
    }
    if (fields.gender != null && !VALID_GENDERS.has(fields.gender)) {
      return res
        .status(400)
        .json({ ok: false, error: "gender must be male, female, or other" });
    }

    // Default to active on creation
    if (fields.is_active === undefined) fields.is_active = true;

    const { data, error } = await supabase
      .from("employees")
      .insert(fields)
      .select()
      .single();

    if (error) throw error;

    console.log(`✅ Created employee: ${data.id} — ${data.name}`);
    return res.status(201).json({ ok: true, employee: data });
  } catch (e) {
    console.error("❌ createEmployee:", e.message);
    return res.status(500).json({ ok: false, error: e.message });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// PATCH /api/admin/staff/:id
// Body: any subset of writable fields
// ─────────────────────────────────────────────────────────────────────────────
export async function updateEmployee(req, res) {
  try {
    const { id } = req.params;
    const fields = pickWritable(req.body);

    if (Object.keys(fields).length === 0) {
      return res
        .status(400)
        .json({ ok: false, error: "No valid fields to update" });
    }
    if (fields.gender != null && !VALID_GENDERS.has(fields.gender)) {
      return res
        .status(400)
        .json({ ok: false, error: "gender must be male, female, or other" });
    }

    fields.updated_at = new Date().toISOString();

    const { data, error } = await supabase
      .from("employees")
      .update(fields)
      .eq("id", id)
      .select()
      .single();

    if (error) throw error;
    if (!data)
      return res.status(404).json({ ok: false, error: "Employee not found" });

    console.log(`✅ Updated employee: ${id}`);
    return res.json({ ok: true, employee: data });
  } catch (e) {
    console.error("❌ updateEmployee:", e.message);
    const status = e.code === "PGRST116" ? 404 : 500;
    return res.status(status).json({ ok: false, error: e.message });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// DELETE /api/admin/staff/:id
// Soft delete — sets is_active = false. Does NOT remove the record.
// Future appointments already assigned are preserved.
// ─────────────────────────────────────────────────────────────────────────────
export async function deactivateEmployee(req, res) {
  try {
    const { id } = req.params;

    const { data, error } = await supabase
      .from("employees")
      .update({ is_active: false, updated_at: new Date().toISOString() })
      .eq("id", id)
      .select()
      .single();

    if (error) throw error;
    if (!data)
      return res.status(404).json({ ok: false, error: "Employee not found" });

    console.log(`🗑️  Deactivated employee: ${id} — ${data.name}`);
    return res.json({ ok: true, employee: data });
  } catch (e) {
    console.error("❌ deactivateEmployee:", e.message);
    const status = e.code === "PGRST116" ? 404 : 500;
    return res.status(status).json({ ok: false, error: e.message });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/admin/staff/search
// Lightweight typeahead — returns active employees only
// Query: q (min 2 chars), limit (default 8)
// ─────────────────────────────────────────────────────────────────────────────
export async function searchEmployees(req, res) {
  try {
    const q = req.query.q?.trim() ?? "";
    const limit = parseIntSafe(req.query.limit, 8);

    if (q.length < 2) {
      return res.json({ ok: true, employees: [] });
    }

    const { data, error } = await supabase
      .from("employees")
      .select("id, name, email, phone, is_team_leader, has_license")
      .eq("is_active", true)
      .or(`name.ilike.%${q}%,email.ilike.%${q}%`)
      .order("name")
      .limit(limit);

    if (error) throw error;

    return res.json({ ok: true, employees: data ?? [] });
  } catch (e) {
    console.error("❌ searchEmployees:", e.message);
    return res.status(500).json({ ok: false, error: e.message });
  }
}

/**
 * GET /api/admin/staff/available
 *
 * Devuelve empleados disponibles para un conjunto de turnos en una fecha
 * específica. Reusan la lógica de disponibilidad del auto-assign backend.
 *
 * Query params:
 *   - date: "YYYY-MM-DD" (obligatorio)
 *   - eventIds: comma-separated (obligatorio, puede ser vacío "")
 *     ⚠️ Post-standalone: son appointments.id (uuid), NO event IDs de GCal.
 *     El nombre del query param se mantiene igual para no romper el
 *     contrato con el frontend (TeamAutoAssignModal) — si el frontend
 *     todavía arma esta lista a partir de IDs de Google, hay que
 *     actualizarlo para que mande appointments.id.
 *
 * Response:
 *   { ok: true, availableEmployees: [ { id, name, email, is_team_leader }, ... ] }
 *
 * LAB-248, ago 2026 — filtrado de disponibilidad para TeamAutoAssignModal
 */
export async function getAvailableStaffForEvents(req, res) {
  try {
    const { date, eventIds } = req.query;
    
    if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      return res.status(400).json({ ok: false, error: 'Invalid or missing date parameter (YYYY-MM-DD)' });
    }

    // Parsear appointment IDs (antes eran event IDs de GCal)
    const requestedAppointmentIds = eventIds && eventIds.trim()
      ? eventIds.split(',').map(s => s.trim()).filter(Boolean)
      : [];

    if (requestedAppointmentIds.length === 0) {
      // Sin turnos especificados, devolver todos activos (sin restricción de horario)
      const { data: employees, error } = await supabase
        .from('employees')
        .select('id, name, email, is_team_leader')
        .eq('is_active', true)
        .order('name');
      
      if (error) throw error;
      return res.json({ ok: true, availableEmployees: employees ?? [] });
    }

    // Fetchear los appointments directo de Supabase en un solo query — antes
    // era un loop secuencial de calendar.events.get(), uno por eventId.
    const { data: appts, error: apptsErr } = await supabase
      .from('appointments')
      .select('id, scheduled_start_time, scheduled_end_time, status')
      .in('id', requestedAppointmentIds)
      .neq('status', 'cancelled');

    if (apptsErr) throw apptsErr;

    if (!appts || appts.length === 0) {
      // Ninguno de los turnos es válido → devolver todos activos
      const { data: employees, error } = await supabase
        .from('employees')
        .select('id, name, email, is_team_leader')
        .eq('is_active', true)
        .order('name');
      
      if (error) throw error;
      return res.json({ ok: true, availableEmployees: employees ?? [] });
    }

    // Horarios directo de las columnas ya guardadas — sin parseo de
    // timezone: scheduled_start_time/scheduled_end_time ya vienen en
    // HH:mm:ss, no hace falta pasarlas por DateTime.
    const eventTimes = appts
      .filter(a => a.scheduled_start_time && a.scheduled_end_time)
      .map(a => ({
        startTime: a.scheduled_start_time.slice(0, 8),
        endTime: a.scheduled_end_time.slice(0, 8),
      }));

    // Cargar empleados activos
    const { data: employees, error: empError } = await supabase
      .from('employees')
     .select('id, name, email, is_team_leader')
      .eq('is_active', true)
      .order('name');
    
    if (empError) throw empError;

    const empIds = (employees ?? []).map(e => e.id);

    // Cargar disponibilidad: weekly, extra, time off, exceptions
    const [
      { data: weeklyAvail, error: weekErr },
      { data: extraAvail, error: extraErr },
      { data: timeOffs, error: timeErr },
      { data: exceptions, error: excErr },
    ] = await Promise.all([
      supabase.from('employee_availability').select('employee_id, day_of_week, start_time, end_time').in('employee_id', empIds),
      supabase.from('employee_extra_availability').select('employee_id, date, start_time, end_time').eq('date', date).in('employee_id', empIds),
      supabase.from('employee_time_off').select('employee_id, start_date, end_date').in('employee_id', empIds),
      supabase.from('employee_exceptions').select('employee_id, exception_date, all_day, start_time, end_time').eq('exception_date', date).in('employee_id', empIds),
    ]);

    if (weekErr || extraErr || timeErr || excErr) {
      throw weekErr || extraErr || timeErr || excErr;
    }

    // Index disponibilidad por empleado+día para búsqueda rápida
    const weeklyByEmpDay = new Map();
    for (const a of weeklyAvail ?? []) {
      const k = `${a.employee_id}|${a.day_of_week}`;
      if (!weeklyByEmpDay.has(k)) weeklyByEmpDay.set(k, []);
      weeklyByEmpDay.get(k).push(a);
    }

    const extraByEmpDate = new Map();
    for (const a of extraAvail ?? []) {
      const k = `${a.employee_id}|${a.date}`;
      if (!extraByEmpDate.has(k)) extraByEmpDate.set(k, []);
      extraByEmpDate.get(k).push(a);
    }

    const timeOffByEmp = new Map();
    for (const t of timeOffs ?? []) {
      if (!timeOffByEmp.has(t.employee_id)) timeOffByEmp.set(t.employee_id, []);
      timeOffByEmp.get(t.employee_id).push(t);
    }

    const exceptionsByEmpDate = new Map();
    for (const ex of exceptions ?? []) {
      const k = `${ex.employee_id}|${ex.exception_date}`;
      if (!exceptionsByEmpDate.has(k)) exceptionsByEmpDate.set(k, []);
      exceptionsByEmpDate.get(k).push(ex);
    }

    // Helpers de disponibilidad
    function covers(availStart, availEnd, needStart, needEnd) {
      return availStart <= needStart && availEnd >= needEnd;
    }

    function isBlocked(empId, blockDate, checkStartTime, checkEndTime) {
      const offs = timeOffByEmp.get(empId) || [];
      if (offs.some(o => o.start_date <= blockDate && o.end_date >= blockDate)) return true;
      
      const excs = exceptionsByEmpDate.get(`${empId}|${blockDate}`) || [];
      return excs.some(ex => {
        if (ex.all_day) return true;
        if (!ex.start_time || !ex.end_time) return false;
        return ex.start_time < checkEndTime && ex.end_time > checkStartTime;
      });
    }

    function isAvailableForEvent(empId, eventStartTime, eventEndTime) {
      if (isBlocked(empId, date, eventStartTime, eventEndTime)) return false;
      
      const dow = new Date(`${date}T12:00:00`).getDay();
      const weekly = weeklyByEmpDay.get(`${empId}|${dow}`) || [];
      if (weekly.some(w => covers(w.start_time, w.end_time, eventStartTime, eventEndTime))) return true;
      
      const extra = extraByEmpDate.get(`${empId}|${date}`) || [];
      return extra.some(x => covers(x.start_time, x.end_time, eventStartTime, eventEndTime));
    }

    function isAvailableForAllEvents(empId) {
      return eventTimes.every(et => isAvailableForEvent(empId, et.startTime, et.endTime));
    }

    // Filtrar: devolver solo empleados disponibles
    const available = (employees ?? []).filter(emp => isAvailableForAllEvents(emp.id));

    res.json({ ok: true, availableEmployees: available });
  } catch (error) {
    console.error('[getAvailableStaffForEvents] error:', error);
    res.status(500).json({ ok: false, error: error.message });
  }
}