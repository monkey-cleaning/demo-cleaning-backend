// Reads service events from Google Calendar and upserts them into:
//   - appointments          (one row per GCal event)
//   - appointment_teams     (one row per employee on that event)
//   - appointment_history   (one row per field that changed on update)
//
// Design decisions:
//   - Idempotent: safe to run multiple times (upsert on google_calendar_event_id).
//   - Non-destructive: cancelled GCal events flip status → "cancelled"; no hard deletes.
//   - Employee matching: attendee emails → employees.email. Falls back to
//     "Team: Name1, Name2" in description.
//
//   - CLIENT MATCHING (4 levels, in order of confidence):
//       1. Exact name    — ilike full name match on clients table             → high confidence
//       2. Fuzzy name    — token overlap ratio ≥ FUZZY_THRESHOLD              → medium confidence, logged
//       3. Address tie-break — when fuzzy returns 2+ candidates, property_address
//                          is used to disambiguate (safe: name already narrowed the set)
//       4. No match      — appointment saved with placeholder client_id
//                          ("Unknown / Pending Review") and sync_notes records
//                          what was tried so staff can fix it manually.
//
//   - History: only written for updates (not inserts), only for fields that changed.

import { DateTime } from "luxon";
import { getCalendarClient } from "./googleCalendarClient.js";
import { supabase } from "./supabaseService.js";
import { isNonServiceEvent } from "./eventClassification.js";

const TZ = process.env.BOOKING_TIMEZONE || "America/Vancouver";

// ── Helpers ────────────────────────────────────────────────────────────────────

function normalizeEmail(e) {
  return String(e || "")
    .trim()
    .toLowerCase();
}

function toIso(dt) {
  return dt.toUTC().toISO({ suppressMilliseconds: true });
}

// Compara dos timestamps por VALOR, no por string. Supabase devuelve
// timestamptz con sufijo "+00:00"; toIso() (Luxon, en UTC) devuelve "Z" —
// el mismo instante, string distinto. Comparar como string marcaba cada
// appointment como "changed" en el 100% de las corridas, generando writes
// innecesarios en cada sync — y, más grave, disparando constantemente el
// recálculo de `status` (ver fix de "resurrección de cancelados", ago 2026).
function timesEqual(a, b) {
  if (a === b) return true;
  if (!a || !b) return false;
  const ta = DateTime.fromISO(a).toMillis();
  const tb = DateTime.fromISO(b).toMillis();
  return Number.isFinite(ta) && Number.isFinite(tb) && ta === tb;
}

// Extract "Team: Alex Cruz, Vanesa Mares" from description
function parseTeamFromDescription(description) {
  if (!description) return [];
  const match = description.match(/Team:\s*(.+)/i);
  if (!match) return [];
  return match[1]
    .split(",")
    .map((n) => n.trim())
    .filter(Boolean);
}

// Extract "Client: Fiona Prince" from description or summary
function parseClientNameFromEvent(event) {
  // Try description first
  if (event.description) {
    const m = event.description.match(/Client:\s*(.+)/i);
    if (m) return m[1].trim();
  }
  // Fall back to summary: "Fiona Prince - House Cleaning #1"
  if (event.summary) {
    const m = event.summary.match(/^([^–\-]+?)(?:\s*[-–]\s*)/);
    if (m) return m[1].trim();
  }
  return null;
}

// Detect service type from summary
function detectServiceType(summary) {
  const s = (summary || "").toLowerCase();
  if (s.includes("deep clean")) return "Deep Cleaning";
  if (
    s.includes("move-in") ||
    s.includes("move in") ||
    s.includes("move-out") ||
    s.includes("move out")
  )
    return "Move-in/Move-out";
  if (s.includes("post-construction") || s.includes("post construction"))
    return "Post-construction";
  if (s.includes("commercial")) return "Commercial Cleaning";
  if (s.includes("recurring")) return "Recurring";
  if (s.includes("house") || s.includes("residential") || s.includes("home"))
    return "Residential Cleaning";
  return "Residential Cleaning"; // safe default for cleaning events
}

// Determine if a GCal event is a service (vs admin/block)
const SKIP_KEYWORDS = [
  "lunch",
  "meeting",
  "admin",
  "training",
  "break",
  "holiday",
  "cerrado",
  "day off",
  "invoice",
  "facturas",
  "facturacion",
];

function isServiceEvent(event) {
  // Clasificación por color (colorId Flamingo / non_service_color_id) — ver
  // services/eventClassification.js. Se chequea antes que SKIP_KEYWORDS: un
  // evento marcado nunca debe convertirse en fila de `appointments`, sin
  // importar su texto.
  if (isNonServiceEvent(event)) return false;
  const s = (event.summary || "").toLowerCase();
  return !SKIP_KEYWORDS.some((k) => s.includes(k));
}

// List events from GCal (non-cancelled, single-instance expansion)
async function listServiceEvents(calendar, calendarId, timeMinIso, timeMaxIso) {
  const r = await calendar.events.list({
    calendarId,
    timeMin: timeMinIso,
    timeMax: timeMaxIso,
    singleEvents: true,
    orderBy: "startTime",
    maxResults: 2500,
    timeZone: TZ,
    fields:
      "items(id,summary,description,status,start,end,colorId,location,attendees(email),organizer(email))",
  });

  const items = r.data.items || [];
  return items.filter((e) => e.status !== "cancelled" && isServiceEvent(e));
}

// ── Employee resolution ────────────────────────────────────────────────────────

/**
 * Builds a map of normalizedEmail → employee DB row.
 * Used to resolve attendee emails to employee UUIDs.
 */
async function buildEmployeeEmailMap() {
  const { data, error } = await supabase
    .from("employees")
    .select("id, name, email")
    .eq("is_active", true);

  if (error) throw error;

  const map = new Map();
  for (const emp of data || []) {
    if (emp.email) map.set(normalizeEmail(emp.email), emp);
  }
  return map;
}

/**
 * Builds a map of normalizedName → employee DB row.
 * Used as fallback when matching "Team: Alex Cruz, Vanesa Mares" from description.
 */
function buildEmployeeNameMap(employees) {
  const map = new Map();
  for (const emp of employees) {
    map.set(emp.name.trim().toLowerCase(), emp);
  }
  return map;
}

/**
 * Given a GCal event, returns the list of matched employee DB rows.
 * Strategy:
 *   1. Attendee emails → employees.email
 *   2. "Team: Name1, Name2" in description → employees.name (case-insensitive)
 */
function resolveEmployeesForEvent(event, emailMap, nameMap) {
  const resolved = new Map(); // id → employee (deduplicated)

  // Strategy 1: attendee emails
  for (const attendee of event.attendees || []) {
    const email = normalizeEmail(attendee.email);
    const emp = emailMap.get(email);
    if (emp) resolved.set(emp.id, emp);
  }

  // Strategy 2: "Team:" line in description
  if (resolved.size === 0) {
    const names = parseTeamFromDescription(event.description);
    for (const name of names) {
      const emp = nameMap.get(name.toLowerCase());
      if (emp) resolved.set(emp.id, emp);
    }
  }

  return [...resolved.values()];
}

// ── Client resolution — 4-level matching ──────────────────────────────────────

// Minimum token overlap ratio to accept a fuzzy match (0–1).
// 0.5 means at least half the tokens in the shorter name must appear in the longer one.
const FUZZY_THRESHOLD = 0.65;

/**
 * Tokenise a name into lowercase words, stripping punctuation.
 * "Fiona & John Prince" → ["fiona", "john", "prince"]
 */
function tokenise(name) {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter(Boolean);
}

/**
 * Classic Levenshtein edit distance between two strings.
 */
function levenshtein(a, b) {
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;

  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    const curr = [i];
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(
        curr[j - 1] + 1, // insertion
        prev[j] + 1, // deletion
        prev[j - 1] + cost, // substitution
      );
    }
    prev = curr;
  }
  return prev[n];
}

// Max allowed edit distance for a token to count as a "close" (partial) match,
// keyed by the length of the shorter of the two tokens being compared.
// Short tokens (<=3 letters, e.g. "Jon", "Ana") get no tolerance — a 1-letter
// edit there usually changes the name entirely, not just the spelling.
function maxEditDistanceForTokenLength(len) {
  if (len <= 3) return 0;
  if (len === 4) return 1;
  return 2; // 5+ letters
}

// Weight given to a "close" token match relative to an exact one (1.0).
// Keeps a name with 1 close token + N exact tokens below the 0.99 threshold
// used for auto-"exact" confidence, so it still needs the fuzzy-review path.
const CLOSE_TOKEN_WEIGHT = 0.85;

/**
 * Token overlap ratio between two name strings (Jaccard-style, direction-aware).
 * Returns a value 0–1. Uses the shorter token set as the denominator so that
 * "Fiona Prince" (2 tokens) matching against "Fiona & John Prince" (3 tokens)
 * scores 2/2 = 1.0 rather than 2/3.
 *
 * Tokens that aren't identical but are a small edit distance apart (e.g.
 * "davies" vs "davis") count as a partial match instead of zero, so a single
 * misspelled surname doesn't sink an otherwise-clear match. See
 * maxEditDistanceForTokenLength() for the per-length tolerance.
 */
function fuzzyScore(a, b) {
  const ta = new Set(tokenise(a));
  const tb = new Set(tokenise(b));
  if (ta.size === 0 || tb.size === 0) return 0;

  const tbRemaining = new Set(tb);
  let overlap = 0;

  for (const t of ta) {
    if (tbRemaining.has(t)) {
      overlap += 1;
      tbRemaining.delete(t);
      continue;
    }

    // Look for the closest not-yet-used token in b within tolerance.
    let bestCandidate = null;
    let bestDistance = Infinity;
    for (const candidate of tbRemaining) {
      const maxAllowed = Math.min(
        maxEditDistanceForTokenLength(t.length),
        maxEditDistanceForTokenLength(candidate.length),
      );
      if (maxAllowed === 0) continue;
      const dist = levenshtein(t, candidate);
      if (dist <= maxAllowed && dist < bestDistance) {
        bestCandidate = candidate;
        bestDistance = dist;
      }
    }
    if (bestCandidate) {
      overlap += CLOSE_TOKEN_WEIGHT;
      tbRemaining.delete(bestCandidate);
    }
  }

  return overlap / Math.min(ta.size, tb.size);
}
/**
 * Resolves a client_id from a GCal event using a 4-level cascade:
 *
 *   Level 1 — Exact ilike:  "Fiona Prince" → clients.first_name + last_name exact (case-insensitive)
 *   Level 2 — Fuzzy name:   token overlap ≥ FUZZY_THRESHOLD against ALL clients (loaded once)
 *   Level 3 — Address tie:  when fuzzy yields 2+ candidates, property_address narrows it to 1
 *   Level 4 — Placeholder:  returns { id: placeholderClientId, confidence: "none" }
 *
 * @param {object} event             GCal event object
 * @param {Map}    clientCache       name.toLowerCase() → { id, confidence, matchedName }
 * @param {Array}  allClients        all clients from DB ({ id, first_name, last_name, email })
 * @param {string} placeholderClientId  UUID of the "Unknown / Pending Review" client row
 * @param {string|null} eventAddress property_address extracted from event.location
 * @returns {{ id: string, confidence: "exact"|"fuzzy"|"address"|"none", matchedName?: string, syncNote?: string }}
 */
async function resolveClient(
  event,
  clientCache,
  allClients,
  placeholderClientId,
  eventAddress,
) {
  const rawName = parseClientNameFromEvent(event);
  const cacheKey = rawName ? rawName.toLowerCase() : "__no_name__";

  if (clientCache.has(cacheKey)) return clientCache.get(cacheKey);

  // Level 0: explicit alias — a human already told us this event name
  // belongs to this client (e.g. a commercial name like "Westshore", or
  // an alternate name the same client uses for other jobs). Checked before
  // name-based scoring because an alias is a stronger signal than any
  // computed score.
  if (rawName) {
    const normalized = rawName.toLowerCase().trim();
    const aliasMatch = allClients.find((c) =>
      (c.event_aliases || []).some(
        (alias) => alias.toLowerCase().trim() === normalized,
      ),
    );
    if (aliasMatch) {
      const result = {
        id: aliasMatch.id,
        confidence: "exact",
        matchedName: `alias: ${rawName}`,
      };
      clientCache.set(cacheKey, result);
      return result;
    }
  }

  // ── Level 1+2: score against allClients in one pass ──────────────────────
  // Previously Level 1 ran a separate ilike query for the *full* name against
  // first_name/last_name individually — since those are separate columns, a
  // two-word name never matched either column on its own, so "exact" never
  // fired and everything fell through to fuzzy (or worse, to the placeholder
  // when a lower-scoring second candidate blocked the scored.length === 1
  // check below). Reusing the already-loaded `allClients` list removes the
  // broken query and lets a near-perfect match win outright even if a
  // lower-scoring candidate is also in range.
  if (rawName && allClients.length > 0) {
    const scored = allClients
      .map((c) => {
        const fullName = `${c.first_name || ""} ${c.last_name || ""}`.trim();
        return { client: c, score: fuzzyScore(rawName, fullName), fullName };
      })
      .filter((s) => s.score >= FUZZY_THRESHOLD)
      .sort((a, b) => b.score - a.score);

    // Level 1: near-perfect match that clearly beats the runner-up (or is the
    // only candidate) — treat as "exact" even without a second-place tie.
    if (
      scored[0]?.score >= 0.99 &&
      (scored.length === 1 || scored[0].score - scored[1].score >= 0.2)
    ) {
      const { client, fullName } = scored[0];
      const result = {
        id: client.id,
        confidence: "exact",
        matchedName: fullName,
      };
      clientCache.set(cacheKey, result);
      return result;
    }

    if (scored.length === 1) {
      const { client, fullName, score } = scored[0];
      console.log(
        `[AppointmentSync] Fuzzy match: "${rawName}" → "${fullName}" (score=${score.toFixed(2)})`,
      );
      const result = {
        id: client.id,
        confidence: "fuzzy",
        matchedName: fullName,
        syncNote: `Fuzzy match: event="${rawName}" matched="${fullName}" score=${score.toFixed(2)}`,
      };
      clientCache.set(cacheKey, result);
      return result;
    }

    // ── Level 3: Address tie-break ──────────────────────────────────────────
    if (scored.length >= 2 && eventAddress) {
      // Fetch property_address history for candidate client IDs
      const candidateIds = scored.slice(0, 10).map((s) => s.client.id);
      const { data: addrMatches } = await supabase
        .from("appointments")
        .select("client_id")
        .in("client_id", candidateIds)
        .ilike("property_address", `%${eventAddress}%`)
        .limit(5);

      const addrClientIds = [
        ...new Set((addrMatches || []).map((r) => r.client_id)),
      ];

      if (addrClientIds.length === 1) {
        const winner = scored.find((s) => s.client.id === addrClientIds[0]);
        if (winner) {
          console.log(
            `[AppointmentSync] Address tie-break: "${rawName}" + "${eventAddress}" → "${winner.fullName}"`,
          );
          const result = {
            id: winner.client.id,
            confidence: "address",
            matchedName: winner.fullName,
            syncNote: `Address tie-break: event="${rawName}" address="${eventAddress}" matched="${winner.fullName}"`,
          };
          clientCache.set(cacheKey, result);
          return result;
        }
      }

      // Multiple candidates remain — log for auditing but fall through to placeholder
      console.warn(
        `[AppointmentSync] Ambiguous fuzzy match for "${rawName}": ` +
          scored
            .slice(0, 3)
            .map((s) => `"${s.fullName}"(${s.score.toFixed(2)})`)
            .join(", "),
      );
    }
  }

  // ── Level 4: Placeholder ──────────────────────────────────────────────────
  const tried = rawName
    ? `No client match for name="${rawName}"${eventAddress ? ` address="${eventAddress}"` : ""}`
    : "No client name found in event summary/description";

  console.warn(`[AppointmentSync] Using placeholder client. ${tried}`);

  const result = {
    id: placeholderClientId,
    confidence: "none",
    syncNote: tried,
  };
  clientCache.set(cacheKey, result);
  return result;
}

// ── Appointment history ────────────────────────────────────────────────────────

const TRACKED_FIELDS = [
  "starts_at",
  "ends_at",
  "status",
  "service_type",
  "property_address",
  "special_instructions",
];

async function writeHistory(appointmentId, oldRow, newRow) {
  const changes = [];

  for (const field of TRACKED_FIELDS) {
    const oldVal = String(oldRow[field] ?? "");
    const newVal = String(newRow[field] ?? "");
    if (oldVal !== newVal) {
      changes.push({
        appointment_id: appointmentId,
        changed_field: field,
        old_value: oldVal || null,
        new_value: newVal || null,
        changed_by: "appointment_sync_job",
      });
    }
  }

  if (!changes.length) return 0;

  const { error } = await supabase.from("appointment_history").insert(changes);
  if (error)
    console.error("⚠️  appointment_history insert error:", error.message);
  return changes.length;
}

// ── Liberar confirmation_slots huérfanos ─────────────────────────────────────
// Si un evento "CONFIRMAR" se borra o cancela directamente en Google Calendar
// (sin pasar por deleteCalendarEvent/updateCalendarEvent en
// controllers/calendarController.js), este sync es el único lugar que se
// entera — vía orphanedIds (hard delete) o cancelledGcalIds (cancelado en
// GCal). Sin este paso, el confirmation_slot vinculado queda 'offered' para
// siempre y confirmationReminderJob/confirmationReleaseJob seguirían
// actuando sobre un evento que ya no existe (mandando el email de
// recordatorio, por ejemplo).
//
// Mismo criterio que releaseConfirmationSlotIfOffered() en
// calendarController.js (Paso 9) — no se importa esa función acá a propósito:
// este archivo vive en services/ y esa vive en controllers/, importar en esa
// dirección invierte la dependencia y arriesga un ciclo. Se duplica la
// query, que es chica y estable.
async function releaseConfirmationSlotsForGoneEvents(gcalEventIds) {
  const ids = [...new Set(gcalEventIds)].filter(Boolean);
  if (!ids.length) return 0;

  const { data, error } = await supabase
    .from("confirmation_slots")
    .update({ status: "released", resolved_at: new Date().toISOString() })
    .in("google_calendar_event_id", ids)
    .eq("status", "offered")
    .select("id");

  if (error) {
    console.error(
      "⚠️  releaseConfirmationSlotsForGoneEvents: update failed:",
      error.message,
    );
    return 0;
  }
  if (data?.length) {
    console.log(
      `♻️  [AppointmentSync] ${data.length} confirmation_slot(s) released — event gone from GCal.`,
    );
  }
  return data?.length ?? 0;
}

// ── Main sync function ─────────────────────────────────────────────────────────

/**
 * Syncs service events from Google Calendar into the appointments tables.
 *
 * @param {object} opts
 * @param {number} [opts.rangeDays=60] - how many days forward to sync
 * @param {number} [opts.pastDays=7]   - how many days back to sync (for same-day updates)
 * @returns {object} stats
 */
export async function syncAppointmentsFromGoogle({
  rangeDays = 60,
  pastDays = 7,
} = {}) {
  console.log(
    `[AppointmentSync] Starting sync (past=${pastDays}d, future=${rangeDays}d)…`,
  );

  const calendar = getCalendarClient();

  const idsRaw = process.env.TEAM_CALENDAR_IDS || "";
  const calendarIds = idsRaw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (!calendarIds.length) throw new Error("Missing TEAM_CALENDAR_IDS env");

  const calendarId = calendarIds[0];

  const now = DateTime.now().setZone(TZ);
  const startRange = now.minus({ days: pastDays }).startOf("day");
  const endRange = now.plus({ days: rangeDays }).endOf("day");

  const timeMinIso = toIso(startRange);
  const timeMaxIso = toIso(endRange);

  // ── Fetch data in parallel ─────────────────────────────────────────────────

  const [
    events,
    { data: existingAppts },
    employeeRows,
    clientRows,
    placeholderRow,
  ] = await Promise.all([
    listServiceEvents(calendar, calendarId, timeMinIso, timeMaxIso),

    // Fetch all existing appointments in the range to diff against
    supabase
      .from("appointments")
      .select(
        "id, google_calendar_event_id, starts_at, ends_at, status, service_type, property_address, special_instructions, client_id, sync_notes, gcal_summary",
      )
      .gte("starts_at", timeMinIso)
      .lte("starts_at", timeMaxIso),

    supabase.from("employees").select("id, name, email").eq("is_active", true),

    // Load ALL clients once for fuzzy matching (avoids N queries per event)
    supabase
      .from("clients")
      .select("id, first_name, last_name, email, event_aliases"),

    // Lookup the "Unknown / Pending Review" placeholder client
    supabase
      .from("clients")
      .select("id")
      .eq("email", "unknown@pending.review")
      .maybeSingle(),
  ]);

  if (employeeRows.error) throw employeeRows.error;
  if (clientRows.error) throw clientRows.error;

  const employees = employeeRows.data || [];
  const allClients = clientRows.data || [];
  const emailMap = buildEmployeeEmailMap_sync(employees);
  const nameMap = buildEmployeeNameMap(employees);

  // Placeholder client — must exist in DB. Fail loudly if missing so devs notice.
  const placeholderClientId = placeholderRow?.data?.id;
  if (!placeholderClientId) {
    throw new Error(
      '[AppointmentSync] Placeholder client "Unknown / Pending Review" not found. ' +
        "Run the seed script or insert a client row with email=unknown@pending.review.",
    );
  }

  // Index existing appointments by gcal_event_id for O(1) lookup
  const existingByGcalId = new Map(
    (existingAppts || []).map((a) => [a.google_calendar_event_id, a]),
  );

  // Client cache to avoid repeated lookups for the same name within a sync run
  // key: rawName.toLowerCase() → { id, confidence, matchedName?, syncNote? }
  const clientCache = new Map();

  // ── Also fetch cancelled events to flip their status ──────────────────────
  const cancelledEvents = await listCancelledEvents(
    calendar,
    calendarId,
    timeMinIso,
    timeMaxIso,
  );
  const cancelledGcalIds = new Set(cancelledEvents.map((e) => e.id));

  // ── Stats ──────────────────────────────────────────────────────────────────
  const stats = {
    inserted: 0,
    updated: 0,
    cancelled: 0,
    skipped: 0,
    unresolved: 0,
    historyRows: 0,
    teamRows: 0,
    confirmationSlotsReleased: 0,
  };

  // ── Reconcile: appointments whose GCal event no longer qualifies as a
  //    service (renamed to "Lunch", "Meeting", etc.) or vanished from the
  //    range without appearing in cancelledEvents. Without this, they stay
  //    "pending" forever and keep blocking those employees in busyIds.
  const fetchedGcalIds = new Set(events.map((e) => e.id));
  const orphanedIds = (existingAppts || [])
    .filter(
      (a) =>
        a.status !== "cancelled" &&
        !fetchedGcalIds.has(a.google_calendar_event_id) &&
        !cancelledGcalIds.has(a.google_calendar_event_id),
    )
    .map((a) => a.google_calendar_event_id);

  if (orphanedIds.length) {
    const { error: orphanErr } = await supabase
      .from("appointments")
      .update({ status: "cancelled", updated_at: new Date().toISOString() })
      .in("google_calendar_event_id", orphanedIds);
    if (orphanErr)
      console.error(
        "⚠️ orphaned appointments cancel error:",
        orphanErr.message,
      );
    else stats.cancelled += orphanedIds.length;

    stats.confirmationSlotsReleased +=
      await releaseConfirmationSlotsForGoneEvents(orphanedIds);
  }

  // ── Process active events ──────────────────────────────────────────────────

  for (const event of events) {
    try {
      const startRaw = event.start?.dateTime || event.start?.date;
      const endRaw = event.end?.dateTime || event.end?.date;
      if (!startRaw || !endRaw) {
        stats.skipped++;
        continue;
      }

      const startDt = DateTime.fromISO(startRaw).setZone(TZ);
      const endDt = DateTime.fromISO(endRaw).setZone(TZ);

      const startsAt = toIso(startDt);
      const endsAt = toIso(endDt);

      const nowInTz = DateTime.now().setZone(TZ);
      const shouldBeCompleted = startDt < nowInTz;

      const address = event.location || null;
      const notes = event.description || null;
      const serviceType = detectServiceType(event.summary);

      const clientResolution = await resolveClient(
        event,
        clientCache,
        allClients,
        placeholderClientId,
        address,
      );
      const clientId = clientResolution.id;

      // Log fuzzy / ambiguous matches for audit trail
      if (clientResolution.confidence !== "exact") {
        console.log(
          `[AppointmentSync] Client resolution: confidence="${clientResolution.confidence}" ` +
            `event="${event.summary}" note="${clientResolution.syncNote ?? ""}"`,
        );
      }
      if (clientResolution.confidence === "none") stats.unresolved++;

      const existing = existingByGcalId.get(event.id);

      const appointmentRow = {
        google_calendar_event_id: event.id,
        client_id: clientId,
        starts_at: startsAt,
        ends_at: endsAt,
        scheduled_date: startDt.toISODate(),
        scheduled_start_time: startDt.toFormat("HH:mm:ss"),
        scheduled_end_time: endDt.toFormat("HH:mm:ss"),
        service_type: serviceType,
        property_address: address ?? (existing?.property_address || "TBD"),
        special_instructions: notes,
        status: shouldBeCompleted ? "completed" : "pending",
        completed_at: shouldBeCompleted ? endsAt : null,
        timezone: TZ,
        // proper
        // ty_size_range is required by DB; default to smallest bucket
        property_size_range: existing?.property_size_range || "0-999",
        // Audit note: populated when client match is fuzzy, address-based, or not found
        sync_notes: clientResolution.syncNote ?? null,
        gcal_summary: event.summary || null,
      };

      let appointmentId;

      if (!existing) {
        // ── INSERT ────────────────────────────────────────────────────────
        const { data: inserted, error: insertErr } = await supabase
          .from("appointments")
          .insert(appointmentRow)
          .select("id")
          .single();

        if (insertErr) {
          console.error(
            `[AppointmentSync] Insert error for "${event.summary}":`,
            insertErr.message,
          );
          stats.skipped++;
          continue;
        }

        appointmentId = inserted.id;
        stats.inserted++;
      } else {
        // ── UPDATE (only if something changed) ────────────────────────────
        appointmentId = existing.id;

        // Un appointment 'cancelled' es un estado terminal. Si el evento
        // sigue apareciendo como activo en GCal, lo más probable es que un
        // calendar.events.delete() anterior haya fallado en silencio (ver
        // fix en confirmationReleaseJob.js). NO lo revivimos automáticamente.
        if (existing.status === "cancelled") {
          console.warn(
            `⚠️ [AppointmentSync] "${event.summary}" (gcal_id=${event.id}) sigue activo en GCal pero está 'cancelled' en Supabase — posible borrado fallido. Requiere revisión manual.`,
          );
          stats.skipped++;
          continue;
        }

        const changed =
          !timesEqual(existing.starts_at, startsAt) ||
          !timesEqual(existing.ends_at, endsAt) ||
          existing.service_type !== serviceType ||
          existing.property_address !== appointmentRow.property_address ||
          existing.special_instructions !== notes ||
          existing.sync_notes !== (clientResolution.syncNote ?? null) ||
          existing.gcal_summary !== (event.summary || null) ||
          shouldBeCompleted !== (existing.status === "completed");

        if (changed) {
          const { error: updateErr } = await supabase
            .from("appointments")
            .update({
              starts_at: startsAt,
              ends_at: endsAt,
              service_type: serviceType,
              property_address: appointmentRow.property_address,
              special_instructions: notes,
              sync_notes: clientResolution.syncNote ?? null,
              gcal_summary: event.summary || null,
              updated_at: new Date().toISOString(),
              status:
                startDt < DateTime.now().setZone(TZ) ? "completed" : "pending",
              completed_at:
                startDt < DateTime.now().setZone(TZ) ? endsAt : null,
            })
            .eq("id", appointmentId);

          if (updateErr) {
            console.error(
              `[AppointmentSync] Update error for "${event.summary}":`,
              updateErr.message,
            );
          } else {
            const histCount = await writeHistory(
              appointmentId,
              existing,
              appointmentRow,
            );
            stats.historyRows += histCount;
            stats.updated++;
          }
        }
      }

      // ── Sync appointment_teams ─────────────────────────────────────────
      const resolvedEmployees = resolveEmployeesForEvent(
        event,
        emailMap,
        nameMap,
      );

      if (resolvedEmployees.length > 0) {
        // Fetch current team members to avoid unnecessary writes
        const { data: currentTeam } = await supabase
          .from("appointment_teams")
          .select("employee_id")
          .eq("appointment_id", appointmentId);

        const currentIds = new Set(
          (currentTeam || []).map((r) => r.employee_id),
        );
        const newIds = new Set(resolvedEmployees.map((e) => e.id));

        // Insert only new members (upsert ignores existing)
        const toInsert = resolvedEmployees
          .filter((e) => !currentIds.has(e.id))
          .map((e, idx) => ({
            appointment_id: appointmentId,
            employee_id: e.id,
            role: idx === 0 ? "leader" : "member",
          }));

        // Remove members no longer on the event
        const toRemove = [...currentIds].filter((id) => !newIds.has(id));

        if (toInsert.length) {
          const { error: teamInsertErr } = await supabase
            .from("appointment_teams")
            .insert(toInsert);
          if (teamInsertErr)
            console.error(
              "⚠️ appointment_teams insert:",
              teamInsertErr.message,
            );
          else stats.teamRows += toInsert.length;
        }

        if (toRemove.length) {
          const { error: teamDelErr } = await supabase
            .from("appointment_teams")
            .delete()
            .eq("appointment_id", appointmentId)
            .in("employee_id", toRemove);
          if (teamDelErr)
            console.error("⚠️ appointment_teams delete:", teamDelErr.message);
        }
      }
    } catch (e) {
      console.error(
        `[AppointmentSync] Unexpected error for event "${event.summary}":`,
        e.message,
      );
      stats.skipped++;
    }
  }

  // ── Mark cancelled events ──────────────────────────────────────────────────

  for (const gcalId of cancelledGcalIds) {
    const existing = existingByGcalId.get(gcalId);
    if (!existing || existing.status === "cancelled") continue;

    const { error } = await supabase
      .from("appointments")
      .update({ status: "cancelled", updated_at: new Date().toISOString() })
      .eq("id", existing.id);

    if (!error) {
      await writeHistory(existing.id, existing, {
        ...existing,
        status: "cancelled",
      });
      stats.cancelled++;
    }
  }

  stats.confirmationSlotsReleased +=
    await releaseConfirmationSlotsForGoneEvents([...cancelledGcalIds]);

  console.log(
    `[AppointmentSync] Done. inserted=${stats.inserted} updated=${stats.updated} ` +
      `cancelled=${stats.cancelled} skipped=${stats.skipped} unresolved=${stats.unresolved} ` +
      `teamRows=${stats.teamRows} historyRows=${stats.historyRows} ` +
      `confirmationSlotsReleased=${stats.confirmationSlotsReleased}`,
  );

  return stats;
}

// ── Helpers that need the full employees array (sync version) ─────────────────

function buildEmployeeEmailMap_sync(employees) {
  const map = new Map();
  for (const emp of employees) {
    if (emp.email) map.set(normalizeEmail(emp.email), emp);
  }
  return map;
}

async function listCancelledEvents(
  calendar,
  calendarId,
  timeMinIso,
  timeMaxIso,
) {
  try {
    const r = await calendar.events.list({
      calendarId,
      timeMin: timeMinIso,
      timeMax: timeMaxIso,
      singleEvents: true,
      showDeleted: true,
      maxResults: 2500,
      fields: "items(id,status,summary)",
    });
    return (r.data.items || []).filter((e) => e.status === "cancelled");
  } catch {
    return [];
  }
}
