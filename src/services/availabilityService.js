import { supabase } from "./supabaseService.js";
import { DateTime } from "luxon";

const DEFAULT_TZ = process.env.BOOKING_TIMEZONE || "America/Vancouver";

function hoursBetween(startIso, endIso) {
  const s = new Date(startIso).getTime();
  const e = new Date(endIso).getTime();
  return (e - s) / (1000 * 60 * 60);
}

export function formatSlotRange(slot, tz = DEFAULT_TZ) {
  const start = new Date(slot.start_at);
  const end = new Date(slot.end_at);

  const dateFmt = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    weekday: "short",
    month: "short",
    day: "numeric",
  });

  const timeFmt = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hour: "numeric",
    minute: "2-digit",
  });

  return `${dateFmt.format(start)} — ${timeFmt.format(start)} to ${timeFmt.format(end)}`;
}

// ---------------------------------------------------------------------------
// Public: fuse contiguous OR overlapping base-slots into free windows
// ---------------------------------------------------------------------------

/**
 * Given an array of raw DB slots (sorted by start_at ascending), fuses
 * consecutive slots that belong to the same team and whose ranges overlap
 * or are contiguous (gap ≤ 1 min tolerance).
 *
 * Handles both contiguous slots (end_at[n] == start_at[n+1]) and
 * overlapping/sliding-window slots (end_at[n] > start_at[n+1]).
 *
 * Works with BOTH slot formats:
 *   - Contiguous (end_at[n] === start_at[n+1]): classic non-overlapping segments
 *   - Overlapping sliding-window (e.g. 90-min slots stepping every 15 min):
 *       slot 1: 00:15 → 01:45
 *       slot 2: 00:30 → 02:00   ← overlaps slot 1, extends the window
 *       slot 3: 00:45 → 02:15   ← overlaps slot 2, extends further
 *
 * Merge condition: next slot starts BEFORE current window ends (overlap),
 * OR starts within 1 minute after (contiguous). This covers both formats.
 *
 * The window's end_at is always the MAXIMUM end_at seen across all merged slots,
 * so the true available range is never underestimated.
 *
 * Returns an array of window objects:
 *   { team, start_at, end_at, slotIds: string[], durationHours: number }
 */
export function groupSlotsIntoWindows(slots) {
  if (!slots.length) return [];

  // Sort by team first, then start_at — keeps each team's slots grouped
  const sorted = [...slots].sort((a, b) => {
    if (a.team < b.team) return -1;
    if (a.team > b.team) return  1;
    return DateTime.fromISO(a.start_at).valueOf() - DateTime.fromISO(b.start_at).valueOf();
  });

  console.log("[groupSlotsIntoWindows] input slots:", slots.length, "| teams:", [...new Set(slots.map(s=>s.team))]);
  slots.forEach(s => console.log(`  slot ${s.id?.slice(0,8)} team=${s.team} start=${s.start_at} end=${s.end_at}`));

  const windows = [];
  let current = null;

  for (const slot of sorted) {
    if (!current) {
      current = {
        team:     slot.team,
        start_at: slot.start_at,
        end_at:   slot.end_at,
        slotIds:  [slot.id],
      };
      continue;
    }

    const curEnd    = DateTime.fromISO(current.end_at,  { zone: "utc" });
    const nextStart = DateTime.fromISO(slot.start_at,   { zone: "utc" });
    const nextEnd   = DateTime.fromISO(slot.end_at,     { zone: "utc" });
    const gapMin    = nextStart.diff(curEnd, "minutes").minutes;
    const sameTeam  = slot.team === current.team;

    // Merge if same team AND next slot starts before (or at) current window end.
    // gapMin <= 1 handles both contiguous (≈0) and overlapping (negative) gaps.
    if (sameTeam && gapMin <= 1) {
      // Only extend end_at if this slot ends later than the current window end
      if (nextEnd > curEnd) {
        current.end_at = slot.end_at;
      }
      current.slotIds.push(slot.id);
    } else {
      console.log(`  [split] closing window team=${current.team} start=${current.start_at} end=${current.end_at} ids=${current.slotIds.length} | reason: sameTeam=${sameTeam} gapMin=${gapMin.toFixed(1)}`);
      // Close current window, start a new one
      windows.push({
        ...current,
        durationHours: hoursBetween(current.start_at, current.end_at),
      });
      current = {
        team:     slot.team,
        start_at: slot.start_at,
        end_at:   slot.end_at,
        slotIds:  [slot.id],
      };
    }
  }

  if (current) {
    windows.push({
      ...current,
      durationHours: hoursBetween(current.start_at, current.end_at),
    });
  }

  console.log("[groupSlotsIntoWindows] output windows:", windows.length);
  windows.forEach(w => console.log(`  window team=${w.team} start=${w.start_at} end=${w.end_at} durationHours=${w.durationHours?.toFixed(2)} ids=${w.slotIds.length}`));
  return windows;
}

// ---------------------------------------------------------------------------
// Public: trim a window to exactly `requiredHours` from its start
// ---------------------------------------------------------------------------

/**
 * Returns a new window object with end_at trimmed to start_at + requiredHours,
 * and durationHours updated accordingly.
 * slotIds is preserved (all base slots are still needed to lock the range).
 */
export function trimWindowToRequired(window, requiredHours) {
  const newEnd = DateTime.fromISO(window.start_at, { zone: "utc" })
    .plus({ hours: requiredHours })
    .toISO();

  return {
    ...window,
    end_at:        newEnd,
    durationHours: requiredHours,
  };
}

// ---------------------------------------------------------------------------
// Public: find all slot IDs that cover a booking range (overlapping-safe)
// ---------------------------------------------------------------------------

/**
 * Given the full list of available slots for a team, returns the IDs of every
 * slot that overlaps with [rangeStart, rangeEnd).
 *
 * A slot overlaps the range if:
 *   slot.start_at < rangeEnd  AND  slot.end_at > rangeStart
 *
 * This works regardless of whether slots are contiguous or overlapping.
 * Used by bookAvailability to find which slots to mark as "booked".
 *
 * @param {Array}  slots      - raw DB slots for the team (any status, caller filters)
 * @param {string} rangeStart - ISO string (UTC)
 * @param {string} rangeEnd   - ISO string (UTC)
 * @returns {string[]} array of slot IDs
 */
export function findCoveringSlotIds(slots, rangeStart, rangeEnd) {
  const start = DateTime.fromISO(rangeStart, { zone: "utc" });
  const end   = DateTime.fromISO(rangeEnd,   { zone: "utc" });

  return slots
    .filter(s => {
      const sStart = DateTime.fromISO(s.start_at, { zone: "utc" });
      const sEnd   = DateTime.fromISO(s.end_at,   { zone: "utc" });
      // Classic interval overlap: slot starts before range ends AND slot ends after range starts
      return sStart < end && sEnd > start;
    })
    .map(s => s.id);
}

// ---------------------------------------------------------------------------
// Public: getSuggestedSlots — used when building the quote email
// ---------------------------------------------------------------------------

/**
 * Fetches the next available base-slots, fuses them into free windows, and
 * returns up to `count` windows whose duration >= minHours, each trimmed to
 * exactly minHours so the email shows the correct range.
 *
 * @param {object} opts
 * @param {number} [opts.count=3]      - max windows to return
 * @param {number} [opts.minHours=1.5] - minimum/required hours per person
 */
export async function getSuggestedSlots({ count = 3, minHours = 1.5 } = {}) {
  const nowIso = DateTime.now().toUTC().toISO();

  const { data, error } = await supabase
    .from("cleaning_availability")
    .select("id, team, start_at, end_at, status")
    .eq("status", "available")
    .gte("start_at", new Date().toISOString())
    .order("start_at", { ascending: true })
    .limit(50);

  if (error) throw error;

  console.log("[getSuggestedSlots] raw slots from DB:", (data||[]).length, "| minHours:", minHours);

  const windows = groupSlotsIntoWindows(data || []);

  const qualifying = windows
    .filter((w) => {
      const ok = w.durationHours >= minHours;
      if (!ok) console.log(`  [filter] REJECTED window team=${w.team} start=${w.start_at} durationHours=${w.durationHours?.toFixed(2)} < minHours=${minHours}`);
      return ok;
    })
    .slice(0, count)
    .map((w) => trimWindowToRequired(w, minHours));

  console.log("[getSuggestedSlots] qualifying windows returned:", qualifying.length);
  qualifying.forEach(w => console.log(`  → team=${w.team} start=${w.start_at} end=${w.end_at} (${w.durationHours}h)`));
  return qualifying;
}