import { supabase } from "../services/supabaseService.js";
import { getLeadEstimatedHours } from "../services/supabaseService.js";
import { DateTime } from "luxon";
import { getCalendarClient } from "../services/googleCalendarClient.js";
import { getProgramacionesData } from "../services/googleSheetsService.js";
import {
  groupSlotsIntoWindows,
  trimWindowToRequired,
  findCoveringSlotIds,
} from "../services/availabilityService.js";
import { convertLeadToClient } from "../services/convertLeadToClient.js";
import {
  getWorkWindow,
  getOperationalSettings,
} from "../services/settingsService.js";

const TZ = process.env.BOOKING_TIMEZONE || "America/Vancouver";
const MIN_HOURS = 1.5;
// ✅ WORK_END_HOUR y BUFFER_MINUTES ya no se hardcodean acá: se leen desde
// `settings` (vía el settingsService compartido) al comienzo de cada
// request, en getAvailability() y bookAvailability() respectivamente.

// ---------------------------------------------------------------------------
// Cleaner ↔ email mappings
// ---------------------------------------------------------------------------
const CLEANER_TO_EMAIL = {
  Clara: "clara.suarez.novoa@gmail.com",
  Javi: "javiermartoch@gmail.com",
  Sofi: "sofiacadena3085@gmail.com",
  Marcela: "marcela608@gmail.com",
  Jhony: "jhony.blanco.higuera@gmail.com",
  Esther: "wusuestherca2025@gmail.com",
  Gael: "gaelcruzwk@gmail.com",
  Vanesa: "vanesa-mares-95@hotmail.com",
};

const EMAIL_TO_CLEANER = Object.fromEntries(
  Object.entries(CLEANER_TO_EMAIL).map(([name, email]) => [
    email.toLowerCase(),
    name,
  ]),
);

function safeParseJson(str, fallback) {
  try {
    return JSON.parse(str);
  } catch {
    return fallback;
  }
}

function uniqEmails(emails) {
  const seen = new Set();
  const out = [];
  for (const e of emails) {
    const email = String(e || "").trim();
    if (!email) continue;
    const key = email.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(email);
  }
  return out;
}

async function getAvailableTeamMembers(teamEmails, slotDate) {
  try {
    const progData = await getProgramacionesData();
    const dayKey = DateTime.fromISO(slotDate).setZone(TZ).toISODate();

    const availableCleaners = [];
    for (const email of teamEmails) {
      const cleanerName = EMAIL_TO_CLEANER[email.toLowerCase()];
      if (!cleanerName) continue;

      const hasAvailability = progData.some((row) => {
        const rowDate = row[0];
        const rowCleaner = row[1];
        const freeHours = parseFloat(row[4]) || 0;

        return (
          rowDate === dayKey && rowCleaner === cleanerName && freeHours >= 1.75
        );
      });

      if (hasAvailability) availableCleaners.push({ email, name: cleanerName });
    }

    return availableCleaners.slice(0, 2);
  } catch (error) {
    console.error("❌ Error reading Programaciones for attendees:", error);
    return teamEmails.slice(0, 2).map((email) => ({
      email,
      name: EMAIL_TO_CLEANER[email.toLowerCase()] || "Unknown",
    }));
  }
}

// ---------------------------------------------------------------------------
// reCAPTCHA v3
// ---------------------------------------------------------------------------
const RECAPTCHA_SECRET = process.env.RECAPTCHA_SECRET_KEY;

async function verifyRecaptcha(token, remoteIp) {
  if (!RECAPTCHA_SECRET) return false;

  const params = new URLSearchParams({
    secret: RECAPTCHA_SECRET,
    response: token,
  });
  if (remoteIp) params.append("remoteip", remoteIp);
  const r = await fetch("https://www.google.com/recaptcha/api/siteverify", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: params,
  });
  const data = await r.json();
  return data.success && (data.score || 0) >= 0.5;
}

// ---------------------------------------------------------------------------
// GET /api/availability[?leadId=X]
// ---------------------------------------------------------------------------

export async function getAvailability(req, res) {
  console.log("🧊 HIT getAvailability", DateTime.now().toUTC().toISO());

  try {
    const leadId = req.query.leadId || null;

    const { workEndHour: WORK_END_HOUR } = await getWorkWindow();

    const nowIso = DateTime.now().toUTC().toISO(); // ya existe Luxon en el import
    const cutoffIso = DateTime.now().toUTC().plus({ hours: 24 }).toISO();

    const { data, error } = await supabase
      .from("cleaning_availability")
      .select("id, team, start_at, end_at")
      .eq("status", "available")
      .gte("start_at", cutoffIso) // <-- era nowIso
      .order("start_at", { ascending: true });

    if (error) throw error;

    const rawSlots = data || [];

    console.log(
      `[getAvailability] leadId=${leadId || "none"} | raw slots from DB: ${rawSlots.length}`,
    );
    for (const s of rawSlots) {
      const startUTC = DateTime.fromISO(s.start_at, { zone: "utc" });
      const endUTC = DateTime.fromISO(s.end_at, { zone: "utc" });
      const startLocal = startUTC.setZone(TZ);
      const endLocal = endUTC.setZone(TZ);
      const durationH = endUTC.diff(startUTC, "hours").hours.toFixed(2);
      console.log(
        `  slot team=${s.team} | UTC: ${startUTC.toISO()} → ${endUTC.toISO()} | ${TZ}: ${startLocal.toFormat("EEE MMM d HH:mm")} → ${endLocal.toFormat("HH:mm")} | duration=${durationH}h`,
      );
    }

    if (!leadId) {
      const windows = groupSlotsIntoWindows(rawSlots);
      const filtered = windows
        .filter((w) => {
          if (w.durationHours < MIN_HOURS) return false;
          const trimmedEnd = DateTime.fromISO(w.start_at, { zone: "utc" })
            .plus({ hours: MIN_HOURS })
            .setZone(TZ);
          return (
            trimmedEnd.hour < WORK_END_HOUR ||
            (trimmedEnd.hour === WORK_END_HOUR && trimmedEnd.minute === 0)
          );
        })
        .map((w) => trimWindowToRequired(w, MIN_HOURS));

      return res.json({ ok: true, slots: filtered, requiredHours: MIN_HOURS });
    }

    let requiredHours = MIN_HOURS;
    try {
      const hrsPerPerson = await getLeadEstimatedHours(leadId);
      if (hrsPerPerson && hrsPerPerson > 0)
        requiredHours = Math.max(MIN_HOURS, hrsPerPerson);
    } catch (leadErr) {
      console.warn(
        "⚠️ Could not read lead hours, using MIN_HOURS:",
        leadErr.message,
      );
    }

    const windows = groupSlotsIntoWindows(rawSlots);
    const qualifying = windows
      .filter((w) => {
        if (w.durationHours < requiredHours) return false;
        const trimmedEnd = DateTime.fromISO(w.start_at, { zone: "utc" })
          .plus({ hours: requiredHours })
          .setZone(TZ);
        return (
          trimmedEnd.hour < WORK_END_HOUR ||
          (trimmedEnd.hour === WORK_END_HOUR && trimmedEnd.minute === 0)
        );
      })
      .map((w) => trimWindowToRequired(w, requiredHours));

    console.log(`[getAvailability] qualifying windows: ${qualifying.length}`);
    for (const w of qualifying) {
      const startLocal = DateTime.fromISO(w.start_at, { zone: "utc" }).setZone(
        TZ,
      );
      const endLocal = DateTime.fromISO(w.end_at, { zone: "utc" }).setZone(TZ);
      console.log(
        `  → team=${w.team} ${startLocal.toFormat("EEE MMM d HH:mm")} → ${endLocal.toFormat("HH:mm")} (${w.durationHours}h) ids=${w.slotIds?.length}`,
      );
    }

    return res.json({ ok: true, slots: qualifying, requiredHours });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message });
  }
}

// ---------------------------------------------------------------------------
// POST /api/availability/book
// ---------------------------------------------------------------------------

export async function bookAvailability(req, res) {
  console.log("🔥 HIT bookAvailability", {
    time: DateTime.now().toUTC().toISO(),
    ip: req.ip,
    bodyKeys: Object.keys(req.body || {}),
  });

  try {
    const {
      leadId,
      startIso,
      team,
      name,
      phone,
      address,
      email = null,
      recaptchaToken,
    } = req.body || {};

    const { serviceBufferMinutes: BUFFER_MINUTES } =
      await getOperationalSettings();

    // FIX 3: validación unificada, eliminada la redundante con slotId
    if (!leadId || !startIso || !team || !name || !phone || !address) {
      return res.status(400).json({
        ok: false,
        error: "Missing fields: leadId, startIso, team, name, phone, address",
      });
    }

    if (!recaptchaToken) {
      return res
        .status(400)
        .json({ ok: false, error: "Missing recaptchaToken" });
    }

    const isHuman = await verifyRecaptcha(recaptchaToken, req.ip);
    if (!isHuman) {
      return res
        .status(400)
        .json({ ok: false, error: "Failed reCAPTCHA validation" });
    }

    // ── Resolve required duration from lead ────────────────────────────────
    let requiredHours = MIN_HOURS;
    try {
      const hrsPerPerson = await getLeadEstimatedHours(leadId);
      if (hrsPerPerson && hrsPerPerson > 0)
        requiredHours = Math.max(MIN_HOURS, hrsPerPerson);
    } catch (leadErr) {
      console.warn(
        "⚠️ Could not read lead hours, using MIN_HOURS:",
        leadErr.message,
      );
    }

    const startDt = DateTime.fromISO(startIso, { zone: "utc" });
    const endDt = startDt.plus({ hours: requiredHours });
    const endIso = endDt.toISO();

    const minAllowedStart = DateTime.now().toUTC().plus({ hours: 24 });
    if (startDt < minAllowedStart) {
      return res.status(400).json({
        ok: false,
        error: "Bookings must be made at least 24 hours in advance",
      });
    }
    // ── Fetch all team slots that intersect [startIso, endIso) ────────────
    const { data: coveredSlots, error: fetchErr } = await supabase
      .from("cleaning_availability")
      .select("id, start_at, end_at, status")
      .eq("team", team)
      .lt("start_at", endIso)
      .gt("end_at", startIso)
      .order("start_at", { ascending: true });

    if (fetchErr) throw fetchErr;

    const allTeamSlots = coveredSlots || [];
    const availableSlots = allTeamSlots.filter((s) => s.status === "available");

    console.log(
      `[bookAvailability] fetched ${allTeamSlots.length} team slots (${availableSlots.length} available, ${allTeamSlots.length - availableSlots.length} other)`,
    );
    for (const s of allTeamSlots) {
      const sLocal = DateTime.fromISO(s.start_at, { zone: "utc" }).setZone(TZ);
      const eLocal = DateTime.fromISO(s.end_at, { zone: "utc" }).setZone(TZ);
      console.log(
        `  slot ${s.id?.slice(0, 8)} status=${s.status} | ${sLocal.toFormat("EEE MMM d HH:mm")} → ${eLocal.toFormat("HH:mm")}`,
      );
    }

    // ── Reject if any booked slot overlaps the requested range ─────────────
    const conflict = allTeamSlots.find((s) => {
      if (s.status !== "booked") return false;
      const sStart = DateTime.fromISO(s.start_at, { zone: "utc" });
      const sEnd = DateTime.fromISO(s.end_at, { zone: "utc" });
      return sStart < endDt && sEnd > startDt;
    });

    if (conflict) {
      return res.status(409).json({
        ok: false,
        error: "Slot already booked — please choose another time",
      });
    }

    const slotIds = findCoveringSlotIds(availableSlots, startIso, bufferEndIso);

    console.log(
      `[bookAvailability] findCoveringSlotIds → ${slotIds.length} slots to book:`,
      slotIds.map((id) => id.slice(0, 8)),
    );

    if (slotIds.length === 0) {
      return res.status(409).json({
        ok: false,
        error:
          "No available slots cover the requested range — already booked or unavailable",
      });
    }

    // ── Verify window starts at or before startIso ─────────────────────────
    const firstStart = DateTime.fromISO(availableSlots[0].start_at, {
      zone: "utc",
    });
    if (firstStart.diff(startDt, "minutes").minutes > 1) {
      return res.status(409).json({ ok: false, error: "Slot start mismatch" });
    }

    // ── Verify no gaps within the booking range ────────────────────────────
    let cursor = startDt;
    for (const s of availableSlots) {
      const sStart = DateTime.fromISO(s.start_at, { zone: "utc" });
      const sEnd = DateTime.fromISO(s.end_at, { zone: "utc" });
      if (sStart.diff(cursor, "minutes").minutes > 1) {
        return res.status(409).json({
          ok: false,
          error: "Gap detected in slot range — not fully available",
        });
      }
      if (sEnd > cursor) cursor = sEnd;
    }

    if (cursor.diff(endDt, "minutes").minutes < -1) {
      return res.status(409).json({
        ok: false,
        error: "Available window ends before the required duration",
      });
    }

    // ── Atomic update: mark all covered slots as booked ───────────────────
    const nowIso = DateTime.now().toUTC().toISO();

    const { data: bookedRows, error: updateErr } = await supabase
      .from("cleaning_availability")
      .update({
        status: "booked",
        booked_at: nowIso,
        booked_name: name,
        booked_phone: phone,
        booked_address: address,
        booked_email: email,
      })
      .in("id", slotIds)
      .eq("status", "available")
      .select("id");

    if (updateErr) throw updateErr;

    if (!bookedRows || bookedRows.length !== slotIds.length) {
      return res.status(409).json({
        ok: false,
        error:
          "Slot already booked (race condition) — please choose another time",
      });
    }

    // ── Google Calendar event ─────────────────────────────────────────────
    let googleEventId = null;

    try {
      const calendar = getCalendarClient();
      const calendarId = process.env.TEAM_CALENDAR_IDS?.split(",")[0]?.trim();

      if (!calendarId) {
        console.warn("⚠️ No TEAM_CALENDAR_IDS, skipping Calendar event");
      } else {
        // Obtener config del team desde DB
        const { data: teamCfgRow } = await supabase
          .from("teams")
          .select("color_ids, emojis")
          .eq("id", team)
          .single();

        const teamEmoji = teamCfgRow?.emojis?.[0] ?? "📅";
        const eventColor = teamCfgRow?.color_ids?.[0] ?? null;

        // Obtener emails del team para la fecha del slot desde daily_team_assignments
        const slotDate = DateTime.fromISO(startIso, { zone: TZ }).toISODate();
        const { data: memberRows } = await supabase
          .from("daily_team_assignments")
          .select("employees(email)")
          .eq("team_id", team)
          .eq("date", slotDate);

        const teamEmails = (memberRows ?? [])
          .map((r) => r.employees?.email)
          .filter(Boolean);

        const availableMembers = await getAvailableTeamMembers(
          teamEmails,
          startIso,
        );
        const attendees = availableMembers.map((m) => ({ email: m.email }));

        console.log("📩 Calendar attendees resolved", {
          team,
          poolSize: teamEmails.length,
          availableMembers: availableMembers.map((m) => m.name),
        });

        const teamNumber = team.replace("team_", "");

        const event = {
          summary: `${teamEmoji} WEB BOOKING: ${name} #${teamNumber}`,
          description: [
            `Client: ${name}`,
            `Phone: ${phone}`,
            `Address: ${address}`,
            `Email: ${email || "N/A"}`,
            `Lead ID: ${leadId}`,
            ``,
            `Team assigned: ${availableMembers.map((m) => m.name).join(", ")}`,
            `Duration: ${requiredHours}h`,
            ``,
            `Booked via web on ${DateTime.fromISO(nowIso).setZone(TZ).toLocaleString(DateTime.DATETIME_FULL)}`,
          ].join("\n"),
          location: address,
          start: { dateTime: startIso, timeZone: TZ },
          end: { dateTime: endIso, timeZone: TZ },
          colorId: eventColor,
          attendees,
          guestsCanModify: false,
          guestsCanInviteOthers: false,
          guestsCanSeeOtherGuests: true,
        };

        const createdEvent = await calendar.events.insert({
          calendarId,
          resource: event,
          sendUpdates: "all",
        });

        googleEventId = createdEvent.data.id;
        console.log(`✅ Calendar event created: ${googleEventId}`);

        await supabase
          .from("cleaning_availability")
          .update({ google_event_id: googleEventId })
          .in("id", slotIds);
      }
    } catch (calErr) {
      console.error("❌ Failed to create Calendar event:", calErr);
    }

    // ── Lead → Client conversion ──────────────────────────────────────────
    let conversionResult = null;

    if (leadId) {
      try {
        conversionResult = await convertLeadToClient(leadId, {
          name,
          phone,
          address,
          email,
        });
        console.log(
          `🔄 Lead ${leadId} → Client ${conversionResult.client.id}` +
            (conversionResult.wasExisting
              ? " (existing client updated)"
              : " (new client created)"),
        );
      } catch (conversionErr) {
        // Non-fatal: el booking ya está confirmado, no rompemos la respuesta.
        console.error(
          "❌ Lead conversion failed (booking still confirmed):",
          conversionErr.message,
        );
      }
    }

    // ── Response ───────────────────────────────────────────────────────────
    return res.json({
      ok: true,
      bookedSlotIds: slotIds,
      startIso,
      endIso,
      requiredHours,
      bufferEndsAt: endDt.plus({ minutes: BUFFER_MINUTES }).toISO(),
      googleEventId,
      clientId: conversionResult?.client?.id ?? null,
      wasNewClient: conversionResult ? !conversionResult.wasExisting : null,
    });
  } catch (e) {
    console.error("❌ bookAvailability error:", e);
    return res.status(500).json({ ok: false, error: e.message });
  }
}
