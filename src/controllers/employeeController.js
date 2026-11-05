import { supabase } from "../supabaseClient.js";
import { recordEntityChange, recordHistory } from "../services/recordHistory.js";
import {
  getStaffUsernameByEmployeeId,
  isValidPassword,
  isValidUsername,
  upsertCredential,
  usernameTaken,
} from "../services/appCredentials.js";

const PAGE_LIMIT = 25;

// LAB418 — campos de employees que se auditan en record_history.
const AUDITED_EMPLOYEE_FIELDS = [
  "name",
  "email",
  "phone",
  "is_active",
  "is_team_leader",
  "has_license",
  "hourly_work_rate",
  "gender",
];

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

// LAB484 — agrega `username` (su cuenta de la app) a una lista de empleadas.
// Una sola consulta para todas: la lista del dashboard trae 25 por pagina.
async function withUsernames(rows) {
  if (!rows.length) return rows;
  const { data, error } = await supabase
    .from("app_credentials")
    .select("username, employee_id")
    .eq("role", "cleaner")
    .in("employee_id", rows.map((r) => r.id));

  if (error) {
    // El acceso es informativo en la lista: si falla, se muestra la lista igual.
    console.warn("⚠️ withUsernames:", error.message);
    return rows.map((r) => ({ ...r, username: null }));
  }
  const byEmployee = new Map((data ?? []).map((c) => [c.employee_id, c.username]));
  return rows.map((r) => ({ ...r, username: byEmployee.get(r.id) ?? null }));
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

    // LAB484 — el username de cada una, en UNA consulta para toda la pagina
    // (no una por fila). Es lo que deja marcar en la lista a quien le falta el
    // acceso a la app; null = todavia no tiene cuenta.
    const employees = await withUsernames(data ?? []);

    const total = count ?? 0;
    return res.json({
      ok: true,
      employees,
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
        // LAB484 — su usuario de la app, o null si todavia no tiene acceso.
        username: await getStaffUsernameByEmployeeId(id),
      },
    });
  } catch (e) {
    console.error("❌ getEmployee:", e.message);
    const status = e.code === "PGRST116" ? 404 : 500;
    return res.status(status).json({ ok: false, error: e.message });
  }
}

// LAB484 — validacion del acceso a la app (app_credentials) antes de tocar
// nada. Se valida ANTES de insertar la empleada para no dejarla a medias si el
// usuario ya estaba tomado. Devuelve un mensaje listo para mostrar, o null.
//
// El rol siempre es "cleaner": crear cuentas de admin desde el dashboard no
// esta implementado a proposito (pedido explicito). Si alguna vez se agrega,
// el rol tiene que venir de una lista blanca, nunca del body tal cual.
async function validateNewLogin({ username, password }) {
  if (!isValidUsername(username)) {
    return "Username must be 3-30 characters: letters, numbers, dot, dash or underscore.";
  }
  if (!isValidPassword(password)) {
    return "Password must be at least 6 characters.";
  }
  // Ojo: el alta pisa por username (upsert onConflict), asi que sin este
  // chequeo un usuario repetido le cambiaria la contrasena a otra persona.
  if (await usernameTaken(username)) {
    return `The username "${username}" is already taken.`;
  }
  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/admin/staff
// Body: name*, hourly_work_rate*, hourly_travel_rate*, email*, username*,
//       password*, phone, hire_date, has_license, is_team_leader,
//       e_transfer_email, notes
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

    // LAB484 — el alta incluye el acceso a la app. Es obligatorio: una cleaner
    // sin cuenta no puede ver sus visitas ni cargar el checklist, y hasta ahora
    // la cuenta habia que crearla despues a mano con un script.
    const username = String(req.body.username || "").trim();
    const password = String(req.body.password || "");
    if (!fields.email?.trim()) {
      return res.status(400).json({ ok: false, error: "email is required" });
    }
    const loginError = await validateNewLogin({ username, password });
    if (loginError) return res.status(400).json({ ok: false, error: loginError });

    // Default to active on creation
    if (fields.is_active === undefined) fields.is_active = true;

    const { data, error } = await supabase
      .from("employees")
      .insert(fields)
      .select()
      .single();

    if (error) throw error;

    try {
      await upsertCredential({
        username,
        role: "cleaner",
        plainPassword: password,
        email: fields.email.trim(),
        employeeId: data.id,
      });
    } catch (credErr) {
      // Sin transacciones entre las dos tablas: si la credencial falla, se
      // borra la empleada recién creada para no dejar un alta a medias (no
      // tiene historial ni referencias todavía).
      await supabase.from("employees").delete().eq("id", data.id);
      console.error("❌ createEmployee (credential):", credErr.message);
      return res.status(500).json({
        ok: false,
        error: "The cleaner could not be created: their login failed to save.",
      });
    }

    console.log(`✅ Created employee: ${data.id} — ${data.name} (login: ${username})`);
    return res.status(201).json({ ok: true, employee: { ...data, username } });
  } catch (e) {
    console.error("❌ createEmployee:", e.message);
    return res.status(500).json({ ok: false, error: e.message });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/admin/staff/:id/credential
// Body: username*, password*
//
// LAB484 — acceso a la app para una empleada que ya estaba cargada sin cuenta.
// NO sirve para cambiar la contraseña de una cuenta existente: si ya tiene, se
// rechaza (eso se hace desde "My account" en la app).
// ─────────────────────────────────────────────────────────────────────────────
export async function createEmployeeCredential(req, res) {
  try {
    const { id } = req.params;
    const username = String(req.body.username || "").trim();
    const password = String(req.body.password || "");

    const { data: employee, error } = await supabase
      .from("employees")
      .select("id, name, email")
      .eq("id", id)
      .maybeSingle();
    if (error) throw error;
    if (!employee) {
      return res.status(404).json({ ok: false, error: "Employee not found" });
    }
    if (!employee.email?.trim()) {
      return res.status(400).json({
        ok: false,
        error: "This cleaner has no email yet. Add one before creating their login.",
      });
    }

    const existing = await getStaffUsernameByEmployeeId(id);
    if (existing) {
      return res.status(409).json({
        ok: false,
        error: `${employee.name} already signs in as "${existing}".`,
      });
    }

    const loginError = await validateNewLogin({ username, password });
    if (loginError) return res.status(400).json({ ok: false, error: loginError });

    await upsertCredential({
      username,
      role: "cleaner",
      plainPassword: password,
      email: employee.email.trim(),
      employeeId: id,
    });

    console.log(`✅ Created login "${username}" for employee ${id} — ${employee.name}`);
    return res.status(201).json({ ok: true, username });
  } catch (e) {
    console.error("❌ createEmployeeCredential:", e.message);
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

    const { data: before } = await supabase
      .from("employees")
      .select(AUDITED_EMPLOYEE_FIELDS.join(","))
      .eq("id", id)
      .maybeSingle();

    const { data, error } = await supabase
      .from("employees")
      .update(fields)
      .eq("id", id)
      .select()
      .single();

    if (error) throw error;
    if (!data)
      return res.status(404).json({ ok: false, error: "Employee not found" });

    if (before) {
      await recordEntityChange(
        "employee",
        id,
        before,
        data,
        AUDITED_EMPLOYEE_FIELDS,
      );
    }

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

    await recordHistory("employee", id, [
      { field: "is_active", oldValue: "true", newValue: "false" },
    ]);

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