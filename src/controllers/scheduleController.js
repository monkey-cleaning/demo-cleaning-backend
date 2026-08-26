import { supabase } from "../supabaseClient.js";

// ─────────────────────────────────────────────────────────────────────────────
// AVAILABILITY  (employee_availability table — recurring weekly schedule)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * PUT /api/admin/staff/:id/availability
 * Replaces the full weekly availability for an employee.
 * Body: { availability: [{ day_of_week: 0-6, start_time: "HH:MM", end_time: "HH:MM" }] }
 *
 * Strategy: delete all existing rows for this employee, then insert the new ones.
 * This is simpler and safer than diffing individual days.
 */
export async function upsertAvailability(req, res) {
  try {
    const { id } = req.params;
    const { availability } = req.body;

    if (!Array.isArray(availability)) {
      return res.status(400).json({ ok: false, error: "availability must be an array" });
    }

    // Validate each row
    for (const row of availability) {
      if (row.day_of_week < 0 || row.day_of_week > 6) {
        return res.status(400).json({ ok: false, error: `Invalid day_of_week: ${row.day_of_week}` });
      }
      if (!row.start_time || !row.end_time) {
        return res.status(400).json({ ok: false, error: "start_time and end_time are required on each row" });
      }
      if (row.start_time >= row.end_time) {
        return res.status(400).json({ ok: false, error: `start_time must be before end_time on day ${row.day_of_week}` });
      }
    }

    // Delete existing rows
    const { error: delError } = await supabase
      .from("employee_availability")
      .delete()
      .eq("employee_id", id);

    if (delError) throw delError;

    // Insert new rows (if any)
    let inserted = [];
    if (availability.length > 0) {
      const rows = availability.map(a => ({
        employee_id: id,
        day_of_week: a.day_of_week,
        start_time:  a.start_time,
        end_time:    a.end_time,
      }));

      const { data, error: insError } = await supabase
        .from("employee_availability")
        .insert(rows)
        .select("day_of_week, start_time, end_time");

      if (insError) throw insError;
      inserted = data ?? [];
    }

    console.log(`✅ Availability updated for employee: ${id}`);
    return res.json({ ok: true, availability: inserted });
  } catch (e) {
    console.error("❌ upsertAvailability:", e.message);
    return res.status(500).json({ ok: false, error: e.message });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// EXTRA AVAILABILITY  (employee_extra_availability table — one-off date slots)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * GET /api/admin/staff/:id/extra-availability
 * Returns all extra availability entries for the employee,
 * ordered by date ascending.
 */
export async function listExtraAvailability(req, res) {
  try {
    const { id } = req.params;

    const { data, error } = await supabase
      .from("employee_extra_availability")
      .select("id, date, start_time, end_time, notes")
      .eq("employee_id", id)
      .order("date", { ascending: true })
      .order("start_time", { ascending: true });

    if (error) throw error;

    // Normalize times to HH:MM
    const normalized = (data ?? []).map(r => ({
      ...r,
      start_time: r.start_time.slice(0, 5),
      end_time:   r.end_time.slice(0, 5),
    }));

    return res.json({ ok: true, extra_availability: normalized });
  } catch (e) {
    console.error("❌ listExtraAvailability:", e.message);
    return res.status(500).json({ ok: false, error: e.message });
  }
}

/**
 * POST /api/admin/staff/:id/extra-availability
 * Creates a new one-off availability window.
 * Body: { date: "YYYY-MM-DD", start_time: "HH:MM", end_time: "HH:MM", notes? }
 */
export async function createExtraAvailability(req, res) {
  try {
    const { id } = req.params;
    const { date, start_time, end_time, notes } = req.body;

    if (!date || !start_time || !end_time) {
      return res.status(400).json({ ok: false, error: "date, start_time and end_time are required" });
    }
    if (start_time >= end_time) {
      return res.status(400).json({ ok: false, error: "start_time must be before end_time" });
    }

    const { data, error } = await supabase
      .from("employee_extra_availability")
      .insert({
        employee_id: id,
        date,
        start_time,
        end_time,
        notes: notes ?? null,
      })
      .select("id, date, start_time, end_time, notes")
      .single();

    if (error) throw error;

    const normalized = {
      ...data,
      start_time: data.start_time.slice(0, 5),
      end_time:   data.end_time.slice(0, 5),
    };

    console.log(`✅ Extra availability created for employee: ${id} on ${date}`);
    return res.status(201).json({ ok: true, extra_availability: normalized });
  } catch (e) {
    console.error("❌ createExtraAvailability:", e.message);
    return res.status(500).json({ ok: false, error: e.message });
  }
}

/**
 * DELETE /api/admin/staff/:id/extra-availability/:extraId
 * Removes a single extra availability entry.
 */
export async function deleteExtraAvailability(req, res) {
  try {
    const { id, extraId } = req.params;

    const { error } = await supabase
      .from("employee_extra_availability")
      .delete()
      .eq("id", extraId)
      .eq("employee_id", id); // ensure ownership

    if (error) throw error;

    console.log(`🗑️  Extra availability deleted: ${extraId} for employee: ${id}`);
    return res.json({ ok: true });
  } catch (e) {
    console.error("❌ deleteExtraAvailability:", e.message);
    return res.status(500).json({ ok: false, error: e.message });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// TIME OFF  (employee_time_off table)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * GET /api/admin/staff/:id/time-off
 * Returns all upcoming time-off for the employee.
 */
export async function listTimeOff(req, res) {
  try {
    const { id } = req.params;

    const { data, error } = await supabase
      .from("employee_time_off")
      .select("id, start_date, end_date, reason, notes")
      .eq("employee_id", id)
      .order("start_date");

    if (error) throw error;
    return res.json({ ok: true, time_off: data ?? [] });
  } catch (e) {
    console.error("❌ listTimeOff:", e.message);
    return res.status(500).json({ ok: false, error: e.message });
  }
}

/**
 * POST /api/admin/staff/:id/time-off
 * Creates a new time-off block.
 * Body: { start_date, end_date, reason?, notes? }
 */
export async function createTimeOff(req, res) {
  try {
    const { id } = req.params;
    const { start_date, end_date, reason, notes } = req.body;

    if (!start_date || !end_date) {
      return res.status(400).json({ ok: false, error: "start_date and end_date are required" });
    }
    if (end_date < start_date) {
      return res.status(400).json({ ok: false, error: "end_date must be >= start_date" });
    }

    const { data, error } = await supabase
      .from("employee_time_off")
      .insert({
        employee_id: id,
        start_date,
        end_date,
        reason: reason ?? null,
        notes:  notes  ?? null,
      })
      .select("id, start_date, end_date, reason, notes")
      .single();

    if (error) throw error;

    console.log(`✅ Time-off created for employee: ${id} (${start_date} → ${end_date})`);
    return res.status(201).json({ ok: true, time_off: data });
  } catch (e) {
    console.error("❌ createTimeOff:", e.message);
    return res.status(500).json({ ok: false, error: e.message });
  }
}

/**
 * DELETE /api/admin/staff/:id/time-off/:timeOffId
 * Removes a single time-off block.
 */
export async function deleteTimeOff(req, res) {
  try {
    const { id, timeOffId } = req.params;

    const { error } = await supabase
      .from("employee_time_off")
      .delete()
      .eq("id", timeOffId)
      .eq("employee_id", id); // ensure ownership

    if (error) throw error;

    console.log(`🗑️  Time-off deleted: ${timeOffId} for employee: ${id}`);
    return res.json({ ok: true });
  } catch (e) {
    console.error("❌ deleteTimeOff:", e.message);
    return res.status(500).json({ ok: false, error: e.message });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// EXCEPTIONS  (employee_exceptions table — partial-day or full-day absences)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * GET /api/admin/staff/:id/exceptions
 * Returns all exceptions for the employee, ordered by date ascending.
 */
export async function listExceptions(req, res) {
  try {
    const { id } = req.params;

    const { data, error } = await supabase
      .from("employee_exceptions")
      .select("id, exception_date, start_time, end_time, all_day, reason, exception_type, created_at")
      .eq("employee_id", id)
      .order("exception_date", { ascending: true })
      .order("start_time",     { ascending: true });

    if (error) throw error;

    const normalized = (data ?? []).map(r => ({
      ...r,
      start_time: r.start_time ? r.start_time.slice(0, 5) : null,
      end_time:   r.end_time   ? r.end_time.slice(0, 5)   : null,
    }));

    return res.json({ ok: true, exceptions: normalized });
  } catch (e) {
    console.error("❌ listExceptions:", e.message);
    return res.status(500).json({ ok: false, error: e.message });
  }
}

/**
 * POST /api/admin/staff/:id/exceptions
 * Creates a new exception (full-day or partial).
 * Body: { exception_date, all_day?, start_time?, end_time?, reason?, exception_type? }
 *
 * Rules:
 *  - If all_day is true, start_time/end_time are ignored (stored as null).
 *  - If all_day is false/omitted, start_time and end_time are required.
 */
export async function createException(req, res) {
  try {
    const { id } = req.params;
    const { exception_date, all_day = false, start_time, end_time, reason, exception_type = "unavailable" } = req.body;

    if (!exception_date) {
      return res.status(400).json({ ok: false, error: "exception_date is required" });
    }

    if (!all_day) {
      if (!start_time || !end_time) {
        return res.status(400).json({ ok: false, error: "start_time and end_time are required when all_day is false" });
      }
      if (start_time >= end_time) {
        return res.status(400).json({ ok: false, error: "start_time must be before end_time" });
      }
    }

    const { data, error } = await supabase
      .from("employee_exceptions")
      .insert({
        employee_id:    id,
        exception_date,
        all_day:        !!all_day,
        start_time:     all_day ? null : start_time,
        end_time:       all_day ? null : end_time,
        reason:         reason ?? null,
        exception_type: exception_type ?? "unavailable",
      })
      .select("id, exception_date, start_time, end_time, all_day, reason, exception_type, created_at")
      .single();

    if (error) throw error;

    const normalized = {
      ...data,
      start_time: data.start_time ? data.start_time.slice(0, 5) : null,
      end_time:   data.end_time   ? data.end_time.slice(0, 5)   : null,
    };

    console.log(`✅ Exception created for employee: ${id} on ${exception_date} (all_day=${all_day})`);
    return res.status(201).json({ ok: true, exception: normalized });
  } catch (e) {
    console.error("❌ createException:", e.message);
    return res.status(500).json({ ok: false, error: e.message });
  }
}

/**
 * DELETE /api/admin/staff/:id/exceptions/:exceptionId
 */
export async function deleteException(req, res) {
  try {
    const { id, exceptionId } = req.params;

    const { error } = await supabase
      .from("employee_exceptions")
      .delete()
      .eq("id", exceptionId)
      .eq("employee_id", id);

    if (error) throw error;

    console.log(`🗑️  Exception deleted: ${exceptionId} for employee: ${id}`);
    return res.json({ ok: true });
  } catch (e) {
    console.error("❌ deleteException:", e.message);
    return res.status(500).json({ ok: false, error: e.message });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// AVAILABILITY CHECK  (used by assign-modal)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * GET /api/admin/staff/availability-check
 * Returns which employees are available on a given date+time.
 * Query: date (YYYY-MM-DD), start_time (HH:MM), end_time (HH:MM)
 *
 * Rules applied:
 *  1. Employee must be active.
 *  2. Must NOT have time-off covering that date.
 *  3a. Must have a recurring weekly slot for that day-of-week covering the range, OR
 *  3b. Must have an extra availability entry for that exact date covering the range.
 *      Extra availability acts as an override / supplement to the weekly schedule.
 */
export async function checkAvailability(req, res) {
  try {
    const { date, start_time, end_time } = req.query;

    if (!date) {
      return res.status(400).json({ ok: false, error: "date is required" });
    }

    const dayOfWeek = new Date(date + "T12:00:00").getDay(); // 0=Sun … 6=Sat

    // ── 1. Fetch all active employees ────────────────────────────────────────
    const { data: employees, error: empErr } = await supabase
      .from("employees")
      .select("id, name, email, phone, is_team_leader, has_license, hourly_work_rate, hourly_travel_rate")
      .eq("is_active", true)
      .order("name");

    if (empErr) throw empErr;

    const empIds = employees.map(e => e.id);

    // ── 2. Fetch recurring weekly availability rows for that day-of-week ────
    const { data: avail, error: availErr } = await supabase
      .from("employee_availability")
      .select("employee_id, day_of_week, start_time, end_time")
      .in("employee_id", empIds)
      .eq("day_of_week", dayOfWeek);

    if (availErr) throw availErr;

    // ── 3. Fetch extra (one-off) availability rows for that exact date ───────
    const { data: extraAvail, error: extraErr } = await supabase
      .from("employee_extra_availability")
      .select("employee_id, start_time, end_time")
      .in("employee_id", empIds)
      .eq("date", date);

    if (extraErr) throw extraErr;

    // ── 4. Fetch time-off blocks covering this date ──────────────────────────
    const { data: timeOffs, error: toErr } = await supabase
      .from("employee_time_off")
      .select("employee_id")
      .in("employee_id", empIds)
      .lte("start_date", date)
      .gte("end_date", date);

    if (toErr) throw toErr;

    // ── 4b. Fetch exceptions for this exact date ─────────────────────────────
    const { data: exceptions, error: excErr } = await supabase
      .from("employee_exceptions")
      .select("employee_id, all_day, start_time, end_time")
      .in("employee_id", empIds)
      .eq("exception_date", date)
      .eq("exception_type", "unavailable");

    if (excErr) throw excErr;

    // ── 5. Build lookup sets ─────────────────────────────────────────────────
    const timeOffSet = new Set(timeOffs?.map(t => t.employee_id) ?? []);

    // Exceptions: all_day blocks the whole day; partial blocks if it overlaps
    // the requested window (overlap: ex.start < req.end AND ex.end > req.start).
    const exceptionBlockedSet = new Set(
      (exceptions ?? [])
        .filter(ex => {
          if (ex.all_day) return true;
          if (!start_time || !end_time) return false;
          return ex.start_time < end_time && ex.end_time > start_time;
        })
        .map(ex => ex.employee_id)
    );

    // Weekly availability: employee has *any* slot for this day-of-week
    const weeklyAvailSet = new Set(avail?.map(a => a.employee_id) ?? []);

    // Extra availability: employee has *any* extra slot for this date
    const extraAvailSet = new Set(extraAvail?.map(a => a.employee_id) ?? []);

    // Combined: available via weekly OR extra
    const anyAvailSet = new Set([...weeklyAvailSet, ...extraAvailSet]);

    // When start_time + end_time provided, also check shift coverage
    let weeklyByShift = weeklyAvailSet;
    let extraByShift  = extraAvailSet;

    if (start_time && end_time) {
      weeklyByShift = new Set(
        (avail ?? [])
          .filter(a => a.start_time <= start_time && a.end_time >= end_time)
          .map(a => a.employee_id)
      );
      extraByShift = new Set(
        (extraAvail ?? [])
          .filter(a => a.start_time <= start_time && a.end_time >= end_time)
          .map(a => a.employee_id)
      );
    }

    // An employee covers the shift via weekly OR via extra
    const coversShift = new Set([...weeklyByShift, ...extraByShift]);

    // ── 6. Classify each employee ────────────────────────────────────────────
    const result = employees.map(emp => {
      const hasTimeOff      = timeOffSet.has(emp.id);
      const hasException    = exceptionBlockedSet.has(emp.id);
      const hasAnyAvail     = anyAvailSet.has(emp.id);
      const shiftCovered    = coversShift.has(emp.id);

      let blocked_reason = null;
      if (hasTimeOff) {
        blocked_reason = "time_off";
      } else if (hasException) {
        blocked_reason = "exception";
      } else if (!hasAnyAvail) {
        blocked_reason = "no_availability";
      } else if (!shiftCovered) {
        blocked_reason = "outside_hours";
      }

      return {
        ...emp,
        is_available: !hasTimeOff && !hasException && shiftCovered,
        blocked_reason,
        // Expose which source(s) cover this employee (useful for UI hints)
        availability_source: shiftCovered
          ? weeklyByShift.has(emp.id) && extraByShift.has(emp.id)
            ? "both"
            : weeklyByShift.has(emp.id)
            ? "weekly"
            : "extra"
          : null,
      };
    });

    return res.json({ ok: true, date, day_of_week: dayOfWeek, employees: result });
  } catch (e) {
    console.error("❌ checkAvailability:", e.message);
    return res.status(500).json({ ok: false, error: e.message });
  }
}