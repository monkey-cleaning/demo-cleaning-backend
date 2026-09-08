// controllers/staffRequestsController.js
// Portado de Monkey Cleaning (LAB425) — solicitudes de licencia/vacaciones y
// reclamos enviados por un cleaner desde el portal. Ambas tablas
// (time_off_requests, staff_complaints — ver
// db/migrations/20260907_lab425_staff_requests.sql) son solo el registro del
// pedido + disparan un mail a ops. NO tocan employee_time_off ni ningún dato
// que el motor de disponibilidad use para bloquear agenda.

import { supabase } from "../supabaseClient.js";
import {
  sendStaffTimeOffRequestAlert,
  sendStaffComplaintAlert,
} from "../services/opsNotificationService.js";

// El email del login (req.cleaner.email) YA es el canónico — viene de
// CLEANER_USERS y debe coincidir con employees.email.
async function resolveEmployee(req, res) {
  const email = (req.cleaner?.email || "").toLowerCase();
  if (!email) {
    res
      .status(403)
      .json({ ok: false, error: "This account has no email configured" });
    return null;
  }

  const { data, error } = await supabase
    .from("employees")
    .select("id, name")
    .eq("email", email)
    .maybeSingle();

  if (error) {
    console.error("❌ resolveEmployee:", error.message);
    res.status(500).json({ ok: false, error: error.message });
    return null;
  }
  if (!data) {
    res
      .status(404)
      .json({ ok: false, error: "No employee record matches this account" });
    return null;
  }
  return data;
}

// POST /api/staff/requests/time-off  Body: { start_date, end_date, reason?, notes? }
export async function createTimeOffRequest(req, res) {
  try {
    const employee = await resolveEmployee(req, res);
    if (!employee) return;

    const { start_date, end_date, reason, notes } = req.body;
    if (!start_date || !end_date) {
      return res
        .status(400)
        .json({ ok: false, error: "start_date and end_date are required" });
    }
    if (end_date < start_date) {
      return res
        .status(400)
        .json({ ok: false, error: "end_date must be >= start_date" });
    }

    const { data, error } = await supabase
      .from("time_off_requests")
      .insert({
        employee_id: employee.id,
        start_date,
        end_date,
        reason: reason ?? null,
        notes: notes ?? null,
      })
      .select("id, start_date, end_date, reason, notes, status, created_at")
      .single();

    if (error) throw error;

    await sendStaffTimeOffRequestAlert({
      employeeName: employee.name,
      startDate: start_date,
      endDate: end_date,
      reason,
      notes,
    });

    return res.status(201).json({ ok: true, request: data });
  } catch (e) {
    console.error("❌ createTimeOffRequest:", e.message);
    return res.status(500).json({ ok: false, error: e.message });
  }
}

// GET /api/staff/requests/time-off — historial propio
export async function listTimeOffRequests(req, res) {
  try {
    const employee = await resolveEmployee(req, res);
    if (!employee) return;

    const { data, error } = await supabase
      .from("time_off_requests")
      .select("id, start_date, end_date, reason, notes, status, created_at")
      .eq("employee_id", employee.id)
      .order("created_at", { ascending: false });

    if (error) throw error;
    return res.json({ ok: true, requests: data ?? [] });
  } catch (e) {
    console.error("❌ listTimeOffRequests:", e.message);
    return res.status(500).json({ ok: false, error: e.message });
  }
}

// POST /api/staff/requests/complaint  Body: { message }
export async function createComplaint(req, res) {
  try {
    const employee = await resolveEmployee(req, res);
    if (!employee) return;

    const message = (req.body?.message || "").trim();
    if (!message) {
      return res.status(400).json({ ok: false, error: "message is required" });
    }

    const { data, error } = await supabase
      .from("staff_complaints")
      .insert({ employee_id: employee.id, message })
      .select("id, message, status, created_at")
      .single();

    if (error) throw error;

    await sendStaffComplaintAlert({ employeeName: employee.name, message });

    return res.status(201).json({ ok: true, complaint: data });
  } catch (e) {
    console.error("❌ createComplaint:", e.message);
    return res.status(500).json({ ok: false, error: e.message });
  }
}

// GET /api/staff/requests/complaint — historial propio
export async function listComplaints(req, res) {
  try {
    const employee = await resolveEmployee(req, res);
    if (!employee) return;

    const { data, error } = await supabase
      .from("staff_complaints")
      .select("id, message, status, created_at")
      .eq("employee_id", employee.id)
      .order("created_at", { ascending: false });

    if (error) throw error;
    return res.json({ ok: true, complaints: data ?? [] });
  } catch (e) {
    console.error("❌ listComplaints:", e.message);
    return res.status(500).json({ ok: false, error: e.message });
  }
}
