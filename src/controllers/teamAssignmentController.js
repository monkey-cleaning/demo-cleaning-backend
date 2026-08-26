import { supabase } from "../supabaseClient.js";
import {
  generateWeeklySuggestions,
  applyWeeklyAssignments,
} from "../services/teamAutoAssignService.js";
import { validateColorOverrides } from "../services/colorAssignmentService.js";

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/admin/staff/team-assignments?date=YYYY-MM-DD
//
// Returns all assignments for that date, joined with employee name.
// Response: { ok, date, assignments: [{ id, team_id, employee_id, name, is_team_leader }] }
// ─────────────────────────────────────────────────────────────────────────────
export async function getAssignments(req, res) {
  try {
    const { date } = req.query;

    if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      return res
        .status(400)
        .json({ ok: false, error: "date query param required (YYYY-MM-DD)" });
    }

    const { data, error } = await supabase
      .from("daily_team_assignments")
      .select(
        `
        id,
        team_id,
        employee_id,
        employees ( name, is_team_leader, gender )
      `,
      )
      .eq("date", date)
      .order("team_id")
      .order("created_at");

    if (error) throw error;

    const assignments = (data ?? []).map((row) => ({
      id: row.id,
      team_id: row.team_id,
      employee_id: row.employee_id,
      name: row.employees?.name ?? "—",
      is_team_leader: row.employees?.is_team_leader ?? false,
      gender: row.employees?.gender ?? null,
    }));

    return res.json({ ok: true, date, assignments });
  } catch (e) {
    console.error("❌ getAssignments:", e.message);
    return res.status(500).json({ ok: false, error: e.message });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/admin/staff/team-assignments
//
// Body: { date: "YYYY-MM-DD", team_id: "team_1"|"team_2", employee_id: uuid }
// Adds one employee to one team for that day (upsert-safe via unique constraint).
// Response: { ok, assignment: { id, team_id, employee_id, name, is_team_leader } }
// ─────────────────────────────────────────────────────────────────────────────
export async function createAssignment(req, res) {
  try {
    const { date, team_id, employee_id } = req.body ?? {};

    if (!date || !team_id || !employee_id) {
      return res.status(400).json({
        ok: false,
        error: "date, team_id and employee_id are required",
      });
    }

    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      return res
        .status(400)
        .json({ ok: false, error: "date must be YYYY-MM-DD" });
    }

    // Validar que el team_id existe en la tabla teams y está activo
    const { data: teams, error: teamsErr } = await supabase
      .from("teams")
      .select("id")
      .eq("is_active", true);

    if (teamsErr || !teams?.length) {
      return res
        .status(500)
        .json({ ok: false, error: "Unable to validate teams" });
    }

    const validTeamIds = teams.map((t) => t.id);
    if (!validTeamIds.includes(team_id)) {
      return res.status(400).json({
        ok: false,
        error: `team_id must be one of: ${validTeamIds.join(", ")}`,
      });
    }

    // Guard: employee must not already be assigned to the OTHER team on this date.
    const { data: conflict, error: conflictErr } = await supabase
      .from("daily_team_assignments")
      .select("id, team_id")
      .eq("date", date)
      .eq("employee_id", employee_id)
      .neq("team_id", team_id)
      .maybeSingle();

    if (conflictErr) throw conflictErr;

    if (conflict) {
      return res.status(409).json({
        ok: false,
        error: `Employee is already assigned to ${conflict.team_id} on ${date}`,
      });
    }

    // Insert — if the exact (date, team_id, employee_id) triple already exists,
    // Postgres will throw a unique-constraint error; we surface it as 409.
    const { data: inserted, error: insertErr } = await supabase
      .from("daily_team_assignments")
      .insert({ date, team_id, employee_id })
      .select(
        `
        id,
        team_id,
        employee_id,
        employees ( name, is_team_leader, gender )
      `,
      )
      .single();

    if (insertErr) {
      if (insertErr.code === "23505") {
        return res.status(409).json({
          ok: false,
          error: "Employee already assigned to this team on this date",
        });
      }
      throw insertErr;
    }

    const assignment = {
      id: inserted.id,
      team_id: inserted.team_id,
      employee_id: inserted.employee_id,
      name: inserted.employees?.name ?? "—",
      is_team_leader: inserted.employees?.is_team_leader ?? false,
      gender: inserted.employees?.gender ?? null,
    };

    console.log(
      `✅ Team assignment created: ${assignment.name} → ${team_id} on ${date}`,
    );
    return res.status(201).json({ ok: true, assignment });
  } catch (e) {
    console.error("❌ createAssignment:", e.message);
    return res.status(500).json({ ok: false, error: e.message });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// DELETE /api/admin/staff/team-assignments/:id
//
// Removes a single assignment row by its UUID.
// Response: { ok, id }
// ─────────────────────────────────────────────────────────────────────────────
export async function deleteAssignment(req, res) {
  try {
    const { id } = req.params;

    const { data, error } = await supabase
      .from("daily_team_assignments")
      .delete()
      .eq("id", id)
      .select("id")
      .single();

    if (error) {
      if (error.code === "PGRST116") {
        return res
          .status(404)
          .json({ ok: false, error: "Assignment not found" });
      }
      throw error;
    }

    console.log(`🗑️  Deleted team assignment: ${id}`);
    return res.json({ ok: true, id: data.id });
  } catch (e) {
    console.error("❌ deleteAssignment:", e.message);
    return res.status(500).json({ ok: false, error: e.message });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/admin/teams?includeInactive=true
//
// Returns teams with their display config. By default only active teams
// (existing behavior, unchanged for every caller that doesn't pass the
// query param). AdminSettingsPage.tsx uses includeInactive=true to also
// list teams that exist but aren't colored/activated yet.
// Response: { ok, teams: [{ id, label, color, color_ids, emojis, is_active }] }
// `color_ids` = colorId(s) de GCal (ej. "10") — usado por el frontend
// (AdminCalendarPage.tsx: loadAssignTeamCfg()) para armar el dropdown de
// color y resolver el colorId al patchear un evento. No confundir con
// `color`, que es el hex de UI para badges/dots.
// ─────────────────────────────────────────────────────────────────────────────
export async function getTeams(req, res) {
  try {
    const includeInactive = req.query.includeInactive === "true";
    let query = supabase
      .from("teams")
      .select("id, label, color, color_ids, emojis, is_active")
      .order("id");

    if (!includeInactive) query = query.eq("is_active", true);

    const { data, error } = await query;

    if (error) throw error;
    return res.json({ ok: true, teams: data ?? [] });
  } catch (e) {
    console.error("❌ getTeams:", e.message);
    return res.status(500).json({ ok: false, error: e.message });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/admin/teams
// Body: { label, color, color_id, emoji }
//
// Crea un equipo nuevo y lo activa de inmediato. `id` se autogenera como
// team_N (N = mayor sufijo numérico existente + 1, contando también
// equipos inactivos para no reciclar un id ya usado). Este endpoint es el
// que dispara AdminSettingsPage.tsx cuando el admin sube
// "max_simultaneous_teams" por encima de la cantidad de equipos activos —
// por eso crea el equipo ya activo, no como borrador: el flujo entero
// asume que si estás creando un equipo es porque ya vas a operar con él.
// Response: { ok, team: { id, label, color, color_ids, emojis } }
// ─────────────────────────────────────────────────────────────────────────────
export async function createTeam(req, res) {
  try {
    const { label, color, color_id, emoji } = req.body ?? {};

    if (!label || !String(label).trim()) {
      return res.status(400).json({ ok: false, error: "label is required" });
    }
    if (!color || !/^#[0-9a-fA-F]{6}$/.test(color)) {
      return res.status(400).json({
        ok: false,
        error: "color must be a hex string, e.g. #ff887c",
      });
    }
    if (!color_id) {
      return res.status(400).json({ ok: false, error: "color_id is required" });
    }

    const colorCheck = await validateColorOverrides({
      teams: { __new__: color_id },
    });
    if (!colorCheck.ok) {
      return res.status(409).json({ ok: false, error: colorCheck.error });
    }

    const { data: allTeams, error: allErr } = await supabase
      .from("teams")
      .select("id");
    if (allErr) throw allErr;

    const usedNumbers = (allTeams ?? [])
      .map((t) => /^team_(\d+)$/.exec(t.id)?.[1])
      .filter(Boolean)
      .map(Number);
    const nextNumber = usedNumbers.length ? Math.max(...usedNumbers) + 1 : 1;
    const id = `team_${nextNumber}`;

    const { data: inserted, error: insertErr } = await supabase
      .from("teams")
      .insert({
        id,
        label: String(label).trim(),
        color,
        color_ids: [String(color_id)],
        emojis: emoji ? [emoji] : [],
        is_active: true,
      })
      .select("id, label, color, color_ids, emojis, is_active")
      .single();

    if (insertErr) throw insertErr;

    console.log(
      `✅ Team created: ${id} (${inserted.label}), colorId=${color_id}`,
    );
    return res.status(201).json({ ok: true, team: inserted });
  } catch (e) {
    console.error("❌ createTeam:", e.message);
    return res.status(500).json({ ok: false, error: e.message });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// PATCH /api/admin/teams/:id
// Body: cualquier subconjunto de { label, color, color_id, emoji, is_active }
//
// Response: { ok, team: { id, label, color, color_ids, emojis, is_active } }
// ─────────────────────────────────────────────────────────────────────────────
export async function updateTeam(req, res) {
  try {
    const { id } = req.params;
    const { label, color, color_id, emoji, is_active } = req.body ?? {};

    const patch = {};
    if (label !== undefined) patch.label = String(label).trim();
    if (color !== undefined) {
      if (!/^#[0-9a-fA-F]{6}$/.test(color)) {
        return res.status(400).json({
          ok: false,
          error: "color must be a hex string, e.g. #ff887c",
        });
      }
      patch.color = color;
    }
    if (emoji !== undefined) patch.emojis = emoji ? [emoji] : [];
    if (is_active !== undefined) patch.is_active = Boolean(is_active);

    if (color_id !== undefined) {
      const colorCheck = await validateColorOverrides({
        teams: { [id]: color_id },
      });
      if (!colorCheck.ok) {
        return res.status(409).json({ ok: false, error: colorCheck.error });
      }
      patch.color_ids = [String(color_id)];
    }

    if (Object.keys(patch).length === 0) {
      return res
        .status(400)
        .json({ ok: false, error: "No valid fields to update" });
    }

    const { data: updated, error } = await supabase
      .from("teams")
      .update(patch)
      .eq("id", id)
      .select("id, label, color, color_ids, emojis, is_active")
      .single();

    if (error) {
      if (error.code === "PGRST116") {
        return res.status(404).json({ ok: false, error: "Team not found" });
      }
      throw error;
    }

    console.log(`✅ Team updated: ${id} →`, patch);
    return res.json({ ok: true, team: updated });
  } catch (e) {
    console.error("❌ updateTeam:", e.message);
    return res.status(500).json({ ok: false, error: e.message });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/admin/staff/team-assignments/auto-suggestions?weekStart=YYYY-MM-DD
// Read-only — arma formaciones sugeridas para toda la semana.
// ─────────────────────────────────────────────────────────────────────────────
export async function getAutoAssignSuggestions(req, res) {
  try {
    const { weekStart } = req.query;
    if (!weekStart || !/^\d{4}-\d{2}-\d{2}$/.test(weekStart)) {
      return res.status(400).json({
        ok: false,
        error: "weekStart query param required (YYYY-MM-DD)",
      });
    }
    const result = await generateWeeklySuggestions({ weekStart });
    return res.json(result);
  } catch (e) {
    console.error("❌ getAutoAssignSuggestions:", e.message);
    return res.status(500).json({ ok: false, error: e.message });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/admin/staff/team-assignments/auto-apply
// Body: { assignments: [{ date, team_id, employee_ids: string[] }, ...] }
// ─────────────────────────────────────────────────────────────────────────────
export async function applyAutoAssign(req, res) {
  try {
    const { assignments } = req.body ?? {};
    if (!Array.isArray(assignments) || assignments.length === 0) {
      return res
        .status(400)
        .json({ ok: false, error: "assignments array required" });
    }
    const result = await applyWeeklyAssignments(assignments);
    const failedGcal = (result.gcalResults ?? []).filter((r) => !r.ok);
    if (failedGcal.length) {
      console.warn(
        `⚠️ applyAutoAssign: ${failedGcal.length} evento(s) no se pudieron sincronizar en GCal:`,
        failedGcal,
      );
    }
    return res.json(result);
  } catch (e) {
    console.error("❌ applyAutoAssign:", e.message);
    return res.status(500).json({ ok: false, error: e.message });
  }
}
