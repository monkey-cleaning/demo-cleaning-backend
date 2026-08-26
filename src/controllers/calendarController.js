// Optimizations added (performance task):
//
//  1. CACHE LAYER         – In-memory cache (calendarCache.js) with configurable TTL.
//                           GET requests are served from cache when available.
//
//  2. PREFETCHING         – After serving a GET response, the adjacent months
//                           (prev / next) are warmed asynchronously so calendar
//                           navigation is instant.
//
//  3. INCREMENTAL SYNC    – When a cache entry exists but its TTL has expired,
//                           the controller uses GCal's nextSyncToken to fetch only
//                           changed events instead of re-downloading everything.
//
//  4. DEBOUNCING          – A per-key in-flight promise map prevents duplicate
//                           concurrent fetches (e.g. rapid month changes).
//                           The first request triggers the GCal call; subsequent
//                           requests for the same key await the same promise.
//
//  5. CACHE INVALIDATION  – Every write (create / update / delete) invalidates the
//                           affected month(s) so stale data is never served.

import { getCalendarClient } from "../services/googleCalendarClient.js";
import { supabase } from "../supabaseClient.js";
import { getOperationalSettings } from "../services/settingsService.js";
import { getTravelTimeMinutes } from "../services/distanceService.js";
import { DateTime } from "luxon";
import {
  cacheKey,
  getFromCache,
  setInCache,
  getSyncToken,
  applyIncrementalUpdate,
  invalidateCache,
  cacheStats,
} from "../services/calendarCache.js";
import { sendBookingWebNotification } from "../services/leadNotificationService.js";
import {
  sendUrgentAssignmentEmail,
  sendCancellationEmail,
  sanitizeNotes,
  DIGEST_CUTOFF_HOUR,
} from "../services/employeeNotificationService.js";
import {
  findTeamOverlaps,
  findOverCapacity,
} from "../services/conflictDetection.js";
import {
  isNonServiceEvent,
  isPendingConfirmation,
  detectTeamByColor,
  isIndividualAssignment,
  loadClassificationConfig,
  isLunchEvent,
} from "../services/eventClassification.js";

// ─────────────────────────────────────────────────────────────────────────────
// mapWithConcurrency: como Promise.all(items.map(fn)) pero limitando cuántas
// promesas corren en paralelo a la vez.
//
// Por qué existe: fetchFromGCal dispara el sync de daily_team_assignments
// fire-and-forget para CADA fecha del rango vía Promise.all sin límite
// (allDatesInRange.map(...)). Para un mes eso son ~30 bloques withDateLock en
// paralelo, cada uno con 3-5 llamadas secuenciales a Supabase — y como el
// cache además prefetchea el mes anterior y el siguiente casi al mismo
// tiempo, en la práctica eran ~90 bloques simultáneos. Eso satura conexiones
// salientes (visto como ráfagas de "TypeError: fetch failed" en local/
// Windows). withDateLock ya serializa correctamente DENTRO de una fecha;
// esto limita cuántas fechas distintas se procesan a la vez.
// ─────────────────────────────────────────────────────────────────────────────
async function mapWithConcurrency(items, limit, fn) {
  const results = new Array(items.length);
  let nextIndex = 0;

  async function worker() {
    while (nextIndex < items.length) {
      const i = nextIndex++;
      results[i] = await fn(items[i], i);
    }
  }

  const workers = Array.from({ length: Math.min(limit, items.length) }, () =>
    worker(),
  );
  await Promise.all(workers);
  return results;
}

// Cuántas fechas del rango se sincronizan en paralelo dentro de fetchFromGCal
// (ver mapWithConcurrency arriba). 6 es conservador a propósito: cada fecha
// hace 3-5 llamadas secuenciales a Supabase, y esto puede correr para hasta
// 3 meses casi al mismo tiempo (mes actual + prefetch prev/next), así que el
// techo real de conexiones simultáneas queda en ~18 en vez de ~90+.
const DATE_SYNC_CONCURRENCY = 6;

const TZ = process.env.BOOKING_TIMEZONE || "America/Vancouver";
export const CALENDAR_ID = process.env.TEAM_CALENDAR_IDS || "primary";

// Eventos "espejo" de Google Tasks: Google los muestra en el calendario pero
// no permite editar título/descripción/adjuntos vía la Events API — cualquier
// PATCH a esos campos se revierte en el próximo sync (ver popup nativo de
// GCal: "Changes made to the title, description, or attachments will not
// be saved"). Se identifican porque GCal siempre les pone esta descripción.
function isGoogleTaskEvent(description) {
  return (
    typeof description === "string" &&
    description.includes("tasks.google.com/task/")
  );
}

// ── Teams config — loaded from DB (table: teams) ──────────────────────────────
// Populated at startup via initTeamsConfig(); used as module-level constant.
let TEAMS_CONFIG = {};

export async function initTeamsConfig() {
  // TEAMS_TABLE_NAME permite apuntar a una tabla de prueba (ej.
  // "teams_duplicate") sin tocar código — usar solo para testing, en
  // producción no debe estar seteada (default: "teams").
  const teamsTable = process.env.TEAMS_TABLE_NAME || "teams";
  const { data, error } = await supabase
    .from(teamsTable)
    .select("id, label, color, color_ids, emojis, none_color")
    .eq("is_active", true);

  if (error || !data?.length) {
    console.warn(
      "⚠️ No se pudo cargar teams desde DB, usando fallback hardcodeado.",
      error?.message,
    );
    // El esquema de color de equipos NO cambia (sigue
    // siendo Basil/Grape, igual que siempre) — lo único que cambia es que
    // ahora se LEE por colorId en vez de por texto "#N" del título. Este
    // fallback es el último recurso si Supabase no responde, no el valor
    // primario. Ver services/eventClassification.js para confirmar_color_id
    // / non_service_color_id (colorIds "5" / "4", no viven acá porque no son
    // equipos).
    TEAMS_CONFIG = {
      team_1: {
        colorIds: ["10"],
        emojis: ["🟢"],
        noneColor: false,
        label: "Team 1",
        color: "#0b8043",
      },
      team_2: {
        colorIds: ["3"],
        emojis: ["🟣"],
        noneColor: false,
        label: "Team 2",
        color: "#7b2d8b",
      },
      team_3: {
        colorIds: [],
        emojis: [],
        noneColor: false,
        label: "Team 3",
        color: "#f5511d",
      },
    };
    return;
  }

  TEAMS_CONFIG = Object.fromEntries(
    data.map((t) => [
      t.id,
      {
        label: t.label,
        color: t.color,
        colorIds: t.color_ids ?? [],
        emojis: t.emojis ?? [],
        noneColor: t.none_color ?? false,
      },
    ]),
  );
  console.log("✅ TEAMS_CONFIG cargado desde DB:", Object.keys(TEAMS_CONFIG));
}

// ── Team membership: email → teamId — loaded from daily_team_assignments ──────
// Populated at startup via initTeamMembersMap(); refreshed on demand.
let TEAM_MEMBERS_MAP = {};

export async function initTeamMembersMap(date = null) {
  const targetDate = date ?? DateTime.now().setZone(TZ).toISODate();

  const { data, error } = await supabase
    .from("daily_team_assignments")
    .select("team_id, employees(email)")
    .eq("date", targetDate);

  if (error) {
    console.warn(
      "⚠️ No se pudo cargar TEAM_MEMBERS_MAP desde DB:",
      error.message,
    );
    return;
  }

  TEAM_MEMBERS_MAP = {};
  for (const row of data ?? []) {
    const email = row.employees?.email?.toLowerCase();
    if (email) TEAM_MEMBERS_MAP[email] = row.team_id;
  }
  console.log(
    `✅ TEAM_MEMBERS_MAP cargado para ${targetDate}:`,
    TEAM_MEMBERS_MAP,
  );
}

initTeamsConfig();
initTeamMembersMap();
loadClassificationConfig();

// Returns the first colorId for a given teamId (used when assigning cleaners)
function colorIdForTeam(teamId) {
  return TEAMS_CONFIG[teamId]?.colorIds?.[0] ?? null;
}

// Google Calendar color hex map (colorId → hex)
const GCAL_COLOR_HEX = {
  1: "#7986cb",
  2: "#33b679",
  3: "#8e24aa",
  4: "#e67c73",
  5: "#f6bf26",
  6: "#f5511d",
  7: "#039be5",
  8: "#616161",
  9: "#3f51b5",
  10: "#0b8043",
  11: "#d60000",
};

// ── teamId embedded in the description by AssignModal ────────────────────────
// When a cleaner is assigned, AssignModal writes a "Team: Name1, Name2" line
// and also patches colorId.  For events that pre-date that flow (or whose
// colorId was later overwritten) we parse the teamId from a "team_id:team_1"
// tag that mapEvent now writes into the description on save (see writeTeamTag).
// The tag format is:   team_id:team_1   or   team_id:team_2
const TEAM_ID_TAG_RE = /\bteam_id:([\w]+)/i;

function parseTeamIdFromDescription(description) {
  if (!description) return null;
  const m = String(description).match(TEAM_ID_TAG_RE);
  if (!m) return null;
  const candidate = m[1].toLowerCase();
  return Object.keys(TEAMS_CONFIG).includes(candidate) ? candidate : null;
}

// ── detectTeam ─────────────────────────────────────────────
export function detectTeam(e) {
  // isGoogleTaskEvent es un criterio aparte (link de Google Tasks en la
  // descripción, no depende de color) — se mantiene como red de seguridad
  // adicional además de isNonServiceEvent.
  if (
    isNonServiceEvent(e) ||
    isPendingConfirmation(e) ||
    isIndividualAssignment(e) ||
    isGoogleTaskEvent(e.description)
  )
    return null;

  return detectTeamByColor(e, TEAMS_CONFIG);
}

// isPendingConfirmation ahora vive en eventClassification.js (color-based) —
// se re-exporta acá para no romper los imports existentes
// (jobs/confirmationPairingJob.js) que hacen
// `import { isPendingConfirmation } from "../controllers/calendarController.js"`.
export { isPendingConfirmation };

function teamColor(teamId, colorId) {
  if (colorId && GCAL_COLOR_HEX[String(colorId)])
    return GCAL_COLOR_HEX[String(colorId)];
  if (teamId && TEAMS_CONFIG[teamId]?.color) return TEAMS_CONFIG[teamId].color;
  return "#6b7280";
}

// Resuelve teamId a partir de un colorId de GCal — usado como fallback
// cuando el título todavía no tiene "#N" (ej: recién elegido en el selector
// "Team / Color", antes de guardar).
function teamIdFromColorId(colorId) {
  return colorId
    ? (Object.keys(TEAMS_CONFIG).find((tid) =>
        TEAMS_CONFIG[tid]?.colorIds?.includes(String(colorId)),
      ) ?? null)
    : null;
}

// ── withTeamTag ────────────────────────────────────────────────────────────
// LAB-233: "#N" en el título es la ÚNICA fuente de verdad para detectTeam()
// (el fallback por color quedó fuera de esa función a propósito). Si el
// admin elige un equipo en "Team / Color" pero el título no trae su "#N",
// lo agregamos acá — así cualquier otra parte del sistema que dependa del
// título (no del selector) reconoce el equipo correctamente desde el vamos.
function withTeamTag(summary, teamId) {
  if (!teamId) return summary;
  const m = teamId.match(/team_(\d+)/);
  if (!m) return summary;
  const num = m[1];
  if (/#\s*\d+/.test(summary)) {
    return summary.replace(/#\s*\d+/, `#${num}`); // reemplaza el N viejo
  }
  return `${summary} #${num}`;
}

// ── Emails que nunca deben aparecer como cleaners ─────────────────────────────
const EXCLUDED_ATTENDEE_EMAILS = new Set([
  "contact@monkeycleaning.com",
  // Agregar acá otros emails institucionales si aparecen en el futuro
]);

// ── Same-day urgent alert (DoD #3 — see jobs/dailyDigestJob.js) ──────────────
// Fires ONLY when both are true:
//   1. The affected occurrence is TODAY in Vancouver time.
//   2. It's already past DIGEST_CUTOFF_HOUR — i.e. this cleaner's morning
//      digest has already gone out, so they need an instant heads-up instead
//      of silently waiting for tomorrow's digest to (never) mention it.
// Time-based rather than a "digest ran" flag on purpose: simpler, and still
// correct even if the cron itself failed to fire that morning.
async function notifyUrgentAssignmentIfNeeded(
  gcalEvent,
  attendees,
  changeMap = new Map(),
) {
  if (isNonServiceEvent(gcalEvent) || isGoogleTaskEvent(gcalEvent.description))
    return;

  const startIso = gcalEvent.start?.dateTime || gcalEvent.start?.date;
  if (!startIso || !attendees?.length) return;

  const nowVan = DateTime.now().setZone(TZ);
  const apptStart = DateTime.fromISO(startIso, { zone: TZ });
  const isToday = apptStart.toISODate() === nowVan.toISODate();
  const pastDigestCutoff = nowVan.hour >= DIGEST_CUTOFF_HOUR;
  if (!isToday || !pastDigestCutoff) return;

  const emails = attendees
    .map((a) => String(a.email ?? "").toLowerCase())
    .filter(Boolean);
  if (!emails.length) return;

  const { data: employees, error } = await supabase
    .from("employees")
    .select("id, name, email")
    .in("email", emails);

  if (error) {
    console.error(
      "⚠️  notifyUrgentAssignmentIfNeeded: employees lookup failed:",
      error.message,
    );
    return;
  }

  const matchedEmails = new Set(
    (employees ?? []).map((e) => e.email.toLowerCase()),
  );
  const unmatched = emails.filter((email) => !matchedEmails.has(email));
  if (unmatched.length) {
    console.warn(
      `⚠️  notifyUrgentAssignmentIfNeeded: attendee(s) con no matching employees row — ` +
        `no notification sent to: ${unmatched.join(", ")}. Agregalos en /admin/staff primero.`,
    );
  }

  const endIso = gcalEvent.end?.dateTime || gcalEvent.end?.date;
  const notes = sanitizeNotes(gcalEvent.description); // ← nuevo

  await Promise.all(
    (employees ?? []).map((emp) => {
      const change = changeMap.get(emp.email.toLowerCase()) || {};
      const task = {
        startTime: apptStart.toFormat("h:mm a"),
        endTime: endIso
          ? DateTime.fromISO(endIso, { zone: TZ }).toFormat("h:mm a")
          : null,
        summary: gcalEvent.summary || "Cleaning service",
        address: gcalEvent.location || "",
        notes,
        changeType: change.changeType,
        previousTimeLabel: change.previousTimeLabel,
      };
      return sendUrgentAssignmentEmail(emp, task);
    }),
  );
}

// ── Same-day cancellation alert — mismo criterio que notifyUrgentAssignmentIfNeeded:
// solo dispara si el evento borrado es HOY y ya pasó el DIGEST_CUTOFF_HOUR.
async function notifyCancellationIfNeeded(gcalEvent, attendees) {
  if (isNonServiceEvent(gcalEvent) || isGoogleTaskEvent(gcalEvent?.description))
    return;

  const startIso = gcalEvent?.start?.dateTime || gcalEvent?.start?.date;
  if (!startIso || !attendees?.length) return;

  const nowVan = DateTime.now().setZone(TZ);
  const apptStart = DateTime.fromISO(startIso, { zone: TZ });
  const isToday = apptStart.toISODate() === nowVan.toISODate();
  const pastDigestCutoff = nowVan.hour >= DIGEST_CUTOFF_HOUR;
  if (!isToday || !pastDigestCutoff) return;

  const emails = attendees
    .map((a) => String(a.email ?? "").toLowerCase())
    .filter(Boolean);
  if (!emails.length) return;

  const { data: employees, error } = await supabase
    .from("employees")
    .select("id, name, email")
    .in("email", emails);

  if (error) {
    console.error(
      "⚠️  notifyCancellationIfNeeded: employees lookup failed:",
      error.message,
    );
    return;
  }

  const endIso = gcalEvent.end?.dateTime || gcalEvent.end?.date;
  const task = {
    startTime: apptStart.toFormat("h:mm a"),
    endTime: endIso
      ? DateTime.fromISO(endIso, { zone: TZ }).toFormat("h:mm a")
      : null,
    summary: gcalEvent.summary || "Cleaning service",
    address: gcalEvent.location || "",
  };

  await Promise.all(
    (employees ?? []).map((emp) => sendCancellationEmail(emp, task)),
  );
}

// ── Confirmation slot release-on-manual-edit ──────────────────────────────
// Ticket "Confirmación automática de servicios pendientes (CONFIRMAR)" — Paso 9.
// Si el admin borra o reagenda (PATCH) a mano un evento que todavía tiene un
// confirmation_slot 'offered', lo marca 'released' acá mismo — así
// confirmationReminderJob / confirmationReleaseJob nunca actúan sobre algo
// que el admin ya resolvió manualmente.
//
// Solo se engancha para eventos NO recurrentes (ver los call sites): los
// eventos "CONFIRMAR" son citas puntuales esperando que el cliente elija,
// nunca series recurrentes, así que scope="all"/"following" no llaman a esto.
//
// Nunca lanza — misma regla que el resto de los hooks de notificación/
// limpieza de este archivo: una falla acá no puede romper la escritura de
// calendario que la disparó.
async function releaseConfirmationSlotIfOffered(gcalEventIds) {
  const ids = Array.isArray(gcalEventIds) ? gcalEventIds : [gcalEventIds];
  if (!ids.length) return;
  try {
    const { data, error } = await supabase
      .from("confirmation_slots")
      .update({ status: "released", resolved_at: new Date().toISOString() })
      .in("google_calendar_event_id", ids)
      .eq("status", "offered")
      .select("id");
    if (error) {
      console.error(
        "⚠️  releaseConfirmationSlotIfOffered: update failed:",
        error.message,
      );
      return;
    }
    if (data?.length) {
      console.log(
        `♻️  [ConfirmationSlot] ${data.length} slot(s) released — admin edited the event manually (${ids.join(", ")}).`,
      );
    }
  } catch (e) {
    console.error("⚠️  releaseConfirmationSlotIfOffered failed:", e.message);
  }
}

// ── Resolver nombre de attendee desde employees en Supabase ──────────────────
// Se usa en mapEvent de forma síncrona: los names vienen del campo displayName
// que GCal devuelve en el attendee object cuando el invitado tiene perfil.
// Si no tiene displayName, se usa la parte local del email como fallback.
function attendeeDisplayName(attendee) {
  if (attendee.displayName?.trim()) return attendee.displayName.trim();
  // Fallback: capitalizar la parte antes del @
  const local = (attendee.email || "").split("@")[0];
  return local.charAt(0).toUpperCase() + local.slice(1);
}

// ── Extraer cleaners desde los attendees del evento ───────────────────────────
// Excluye emails institucionales y al organizador si coincide con un attendee.
function parseAssignedCleaners(e) {
  const attendees = e.attendees || [];
  const organizerEmail = e.organizer?.email?.toLowerCase() ?? "";
  const eventId = e.id ?? "no-id";

  const result = [];
  for (const a of attendees) {
    const email = String(a.email || "").toLowerCase();
    const name = attendeeDisplayName(a);
    result.push(name);
  }

  return result;
}

// Google Calendar tiene un bug documentado: para instancias de eventos
// recurrentes, el campo `dateTime` devuelve la hora de pared CORRECTA
// pero con el offset CONGELADO al momento de creación de la serie (ej.
// "-07:00" de octubre, incluso en instancias de noviembre que ya deberían
// ser "-08:00"). Si parseamos respetando ese offset, el instante UTC
// calculado queda corrido 1h tras un cambio de DST.
// Fix: ignorar el offset del string, parsear solo la hora de pared
// (YYYY-MM-DDTHH:mm:ss) e interpretarla directamente en la IANA zone del
// evento — así Luxon calcula el offset correcto para esa fecha puntual.
function parseGCalDateTime(raw, zone = TZ) {
  if (!raw) return null;
  // Fecha pura (evento all-day, "e.start.date"): no tiene offset, se
  // parsea tal cual.
  if (!raw.includes("T")) return DateTime.fromISO(raw, { zone });
  const wallClock = raw.slice(0, 19); // corta cualquier offset/"Z" final
  return DateTime.fromISO(wallClock, { zone });
}

// ── Shared mapper: raw GCal event → frontend shape ────────────────────────────
function mapEvent(e, clientIdByGcalId = {}, confirmationStatusByGcalId = {}) {
  const startRaw = e.start?.dateTime || e.start?.date;
  const endRaw = e.end?.dateTime || e.end?.date;
  const isAllDay = !e.start?.dateTime;

  const start = parseGCalDateTime(startRaw);
  const end = parseGCalDateTime(endRaw);
  const teamId = detectTeam(e);
  const teamCfg = teamId ? TEAMS_CONFIG[teamId] : null;
  const cleaners = parseAssignedCleaners(e);

  return {
    id: e.id,
    summary: e.summary || "(No title)",
    // Color-based — ver services/eventClassification.js. No cuenta como
    // servicio para asignación de equipo, notificaciones, ni (vía
    // appointmentSyncService) disponibilidad de personal.
    isNonService: isNonServiceEvent(e) || isGoogleTaskEvent(e.description),
    isIndividualAssignment: isIndividualAssignment(e),
    description: e.description || null,
    location: e.location || null,
    colorId: e.colorId || null,
    color: GCAL_COLOR_HEX[String(e.colorId)] ?? "#6b7280",
    teamId,
    teamLabel: teamCfg?.label || null,
    assignedCleaners: cleaners,
    isAllDay,
    startIso: start.toISO(),
    endIso: end.toISO(),
    startDate: start.toISODate(),
    startHour: start.hour + start.minute / 60,
    endHour: end.hour + end.minute / 60,
    durationH: end.diff(start, "hours").hours,
    organizer: e.organizer?.email || null,
    attendees: (e.attendees || []).map((a) => a.email).filter(Boolean),
    htmlLink: e.htmlLink || null,
    // Timestamp de creación del evento en GCal — usado por el resolver de
    // conflictos de over-capacity para priorizar "quién agendó primero".
    createdIso: e.created || null,
    clientId: clientIdByGcalId[e.id] ?? null,
    recurringEventId: e.recurringEventId || null,
    recurrence: e.recurrence || null,
    // Paso 10: estado del confirmation_slots vinculado — "offered" (esperando
    // que el cliente elija), "confirmed", "released", o null si el evento
    // nunca tuvo "CONFIRMAR" en el título (nunca se generó un slot para él).
    confirmationStatus: confirmationStatusByGcalId[e.id] ?? null,
  };
}

// ── Debounce: in-flight promise registry ─────────────────────────────────────
// Maps cacheKey → Promise<MappedEvent[]>
// Prevents concurrent duplicate fetches for the same month window.
const inFlightFetches = new Map();

// ── Core fetcher: full page-through GCal list for a time window ───────────────
async function fetchFromGCal(timeMin, timeMax, { syncDailyTeams = true } = {}) {
  const calendar = getCalendarClient();
  console.log(`📅 GCal fetch (full): ${timeMin} → ${timeMax}`);

  let events = [];
  let pageToken;
  let nextSyncToken;

  do {
    const resp = await calendar.events.list({
      calendarId: CALENDAR_ID,
      timeMin,
      timeMax,
      singleEvents: true,
      orderBy: "startTime",
      maxResults: 250,
      pageToken,
      timeZone: TZ,
    });

    events = events.concat(resp.data.items || []);
    pageToken = resp.data.nextPageToken;
    nextSyncToken = resp.data.nextSyncToken; // only set on the last page
  } while (pageToken);

  const gcalIds = events.map((e) => e.id).filter(Boolean);
  let clientIdByGcalId = {};
  let confirmationStatusByGcalId = {};

  if (gcalIds.length > 0) {
    const { data: appts } = await supabase
      .from("appointments")
      .select("google_calendar_event_id, client_id")
      .in("google_calendar_event_id", gcalIds);

    for (const a of appts ?? []) {
      if (a.google_calendar_event_id && a.client_id) {
        clientIdByGcalId[a.google_calendar_event_id] = a.client_id;
      }
    }

    // Paso 10: estado de confirmación por evento (ver mapEvent). Solo
    // relevante para eventos que alguna vez tuvieron "CONFIRMAR" en el
    // título — la mayoría de gcalIds no va a tener fila acá, es esperado.
    const { data: slots, error: slotsErr } = await supabase
      .from("confirmation_slots")
      .select("google_calendar_event_id, status")
      .in("google_calendar_event_id", gcalIds);

    if (slotsErr) {
      console.warn(
        "⚠️  fetchFromGCal: no se pudo leer confirmation_slots:",
        slotsErr.message,
      );
    } else {
      for (const s of slots ?? []) {
        if (s.google_calendar_event_id) {
          confirmationStatusByGcalId[s.google_calendar_event_id] = s.status;
        }
      }
    }
  }

  // Sync daily_team_assignments for all events with attendees + known teamId.
  // Fire-and-forget: errors are logged but never block the calendar response.
  //
  // IMPORTANT: process sequentially (not via Promise.allSettled) to avoid a
  // race condition where two events on the same date share an attendee and both
  // pass the "does this employee already have an assignment?" check before either
  // insert commits — resulting in the employee ending up in two teams for the
  // same day. Grouping by date and awaiting each event in order ensures the
  // SELECT-then-INSERT in syncDailyTeamAssignments is never interleaved for the
  // same (employee, date) pair.
  const eventsWithAttendees = events.filter(
    (e) =>
      (e.attendees || []).length > 0 &&
      !isNonServiceEvent(e) &&
      !isGoogleTaskEvent(e.description),
  );
  if (syncDailyTeams) {
    // Group by date so we process all events of each date together, sequentially.
    const byDate = {};
    for (const e of eventsWithAttendees) {
      const teamId =
        detectTeam(e) ??
        (e.colorId
          ? Object.keys(TEAMS_CONFIG).find((tid) =>
              TEAMS_CONFIG[tid]?.colorIds?.includes(String(e.colorId)),
            )
          : null) ??
        null;
      if (!teamId) continue;
      const date = (e.start?.dateTime || e.start?.date || "").slice(0, 10);
      if (!date) continue;
      if (!byDate[date]) byDate[date] = [];
      byDate[date].push({ e, teamId });
    }

    // Cleanup pass needs every date in the fetched window, not just the
    // ones with a qualifying event today — a date that HAD assignments
    // before but has none now (everyone unassigned / event deleted) is
    // exactly the stale case we need to clear. See cleanupStaleDailyTeamAssignments.
    const rangeStart = DateTime.fromISO(timeMin, { zone: TZ }).startOf("day");
    const rangeEnd = DateTime.fromISO(timeMax, { zone: TZ }).startOf("day");
    const allDatesInRange = [];
    for (let d = rangeStart; d <= rangeEnd; d = d.plus({ days: 1 })) {
      allDatesInRange.push(d.toISODate());
    }

    (async () => {
      // Each date's sync+cleanup runs as one locked unit (see withDateLock)
      // so a concurrent fetchFromGCal for the same date can't interleave
      // with it — different dates still run in parallel, but capped via
      // mapWithConcurrency (was an unbounded Promise.all: for a full month
      // that's ~30 date-blocks x 3-5 sequential Supabase calls each, and with
      // the adjacent-month prefetch firing at nearly the same time it could
      // spike to ~90 simultaneous outbound connections — root cause of the
      // "TypeError: fetch failed" bursts seen locally on Windows).
      await mapWithConcurrency(allDatesInRange, DATE_SYNC_CONCURRENCY, (date) =>
        withDateLock(date, async () => {
          const dateGroup = byDate[date] ?? [];
          const touched = new Set();
          for (const { e, teamId } of dateGroup) {
            const employeeIds = await syncDailyTeamAssignments(e, teamId).catch(
              (err) => {
                console.warn(`[syncDTA batch] ${e.id}:`, err.message);
                return [];
              },
            );
            for (const id of employeeIds) touched.add(id);
          }
          // Now remove anything left over in daily_team_assignments that
          // isn't backed by a qualifying event anymore — e.g. an employee
          // removed from their only event that day, or the event itself
          // got deleted. syncDailyTeamAssignments only ever moves/inserts,
          // it never deletes on its own when an employee simply drops off
          // the schedule.
          await cleanupStaleDailyTeamAssignments(date, touched).catch((err) =>
            console.warn(`[syncDTA cleanup] ${date}:`, err.message),
          );
        }),
      );
      console.log(
        `[syncDTA batch] done for ${eventsWithAttendees.length} events`,
      );
    })();
  }

  return {
    mapped: events.map((e) =>
      mapEvent(e, clientIdByGcalId, confirmationStatusByGcalId),
    ),
    nextSyncToken,
  };
}

// ── Incremental fetcher: only changed events since last sync token ─────────────
async function fetchIncremental(syncToken) {
  const calendar = getCalendarClient();
  console.log(
    `♻️  GCal incremental sync (syncToken: ${syncToken.slice(0, 20)}…)`,
  );

  try {
    let changedItems = [];
    let pageToken;
    let newSyncToken;

    do {
      const resp = await calendar.events.list({
        calendarId: CALENDAR_ID,
        syncToken: pageToken ? undefined : syncToken, // only on first page
        pageToken,
        singleEvents: true,
        maxResults: 250,
        timeZone: TZ,
      });

      changedItems = changedItems.concat(resp.data.items || []);
      pageToken = resp.data.nextPageToken;
      newSyncToken = resp.data.nextSyncToken;
    } while (pageToken);

    return { changedItems, newSyncToken: newSyncToken || null };
  } catch (err) {
    // GCal returns 410 Gone when the sync token has expired → fall back to full fetch
    if (err.code === 410 || err?.response?.status === 410) {
      console.warn(
        "[Cache] Sync token expired (410). Will perform full fetch.",
      );
      return null; // caller should do a full fetch
    }
    throw err;
  }
}

// ── Month-level cache getter (with incremental sync + debounce) ───────────────
/**
 * Returns mapped events for the given month, using the cache when possible.
 * Strategy:
 *   HIT  (fresh)        → return cached events immediately
 *   HIT  (stale, token) → incremental sync to refresh, return merged events
 *   HIT  (stale, no tk) → full fetch, update cache
 *   MISS                → full fetch, populate cache
 *
 * The debounce guard ensures that if two concurrent requests target the same
 * month (e.g. rapid user navigation), only one GCal call is made.
 */
export async function getEventsForMonth(year, month) {
  const key = cacheKey(year, month);

  // 1. Serve from cache if still fresh
  const cached = getFromCache(key);
  if (cached) {
    console.log(
      `[Cache] HIT (fresh) for ${key} — ${cached.events.length} events`,
    );
    return cached.events;
  }

  // 2. Debounce: if a fetch for this key is already in flight, await it
  if (inFlightFetches.has(key)) {
    console.log(`[Cache] Debounce — awaiting in-flight fetch for ${key}`);
    return inFlightFetches.get(key);
  }

  // 3. Build the time window for this month
  const start = DateTime.fromObject(
    { year, month, day: 1 },
    { zone: TZ },
  ).startOf("month");
  const end = start.endOf("month");
  const timeMin = start.toISO();
  const timeMax = end.toISO();

  // 4. Register an in-flight promise so concurrent requests share it
  const fetchPromise = (async () => {
    try {
      const syncToken = getSyncToken(key);

      if (syncToken) {
        // ── Incremental sync path ──────────────────────────────────────────
        const result = await fetchIncremental(syncToken);

        if (result) {
          applyIncrementalUpdate(
            key,
            result.changedItems,
            mapEvent,
            result.newSyncToken,
          );
          const updated = getFromCache(key);
          console.log(
            `[Cache] Incremental update for ${key}: ${result.changedItems.length} changes applied`,
          );
          return updated?.events ?? [];
        }
        // syncToken expired (410) — fall through to full fetch
      }

      // ── Full fetch path ────────────────────────────────────────────────
      const { mapped, nextSyncToken } = await fetchFromGCal(timeMin, timeMax);
      setInCache(key, mapped, nextSyncToken);
      console.log(
        `[Cache] MISS → full fetch for ${key}: ${mapped.length} events cached`,
      );
      return mapped;
    } finally {
      inFlightFetches.delete(key);
    }
  })();

  inFlightFetches.set(key, fetchPromise);
  return fetchPromise;
}

// ── Prefetcher: warm adjacent months asynchronously ──────────────────────────
/**
 * Fire-and-forget: pre-populate the cache for the previous and next months
 * relative to the requested month so navigation is instant.
 */
function prefetchAdjacentMonths(year, month) {
  const current = DateTime.fromObject({ year, month, day: 1 });
  const prev = current.minus({ months: 1 });
  const next = current.plus({ months: 1 });

  for (const dt of [prev, next]) {
    const key = cacheKey(dt.year, dt.month);
    if (!getFromCache(key) && !inFlightFetches.has(key)) {
      console.log(`[Cache] Prefetching ${key}…`);
      getEventsForMonth(dt.year, dt.month).catch((err) =>
        console.warn(`[Cache] Prefetch failed for ${key}:`, err.message),
      );
    }
  }
}

// ── Helper: extract year/month from an ISO string ────────────────────────────
function isoToYearMonth(isoString) {
  // Para ISO strings que genera NUESTRO propio código (timeMin/timeMax de
  // la query, req.body.startIso) — ya traen un offset/Z real y correcto,
  // a diferencia de los que vienen crudos de GCal. Parseo normal.
  const dt = DateTime.fromISO(isoString, { zone: TZ });
  return { year: dt.year, month: dt.month };
}

// Variante para fechas que vienen CRUDAS de la API de Google
// (e.start.dateTime / instance.start.dateTime) — sufren el bug de offset
// congelado en DST, así que hay que ignorar el offset y tomar la hora de
// pared (ver parseGCalDateTime más arriba).
function isoToYearMonthFromGCal(rawGCalDateTime) {
  const dt = parseGCalDateTime(rawGCalDateTime);
  return { year: dt.year, month: dt.month };
}

// If the caller doesn't supply an explicit end (count or until), defaults to
// one year from today so a series doesn't recur forever by accident. An
// explicit user-provided `until` is always respected, even past that default.
function toRRuleUntil(isoString) {
  return DateTime.fromISO(isoString, { zone: "utc" }).toFormat(
    "yyyyMMdd'T'HHmmss'Z'",
  );
}

function buildRRule({ freq, interval, count, until }) {
  const FREQ_MAP = { WEEKLY: "WEEKLY", BIWEEKLY: "WEEKLY", MONTHLY: "MONTHLY" };
  const gcalFreq = FREQ_MAP[freq];
  if (!gcalFreq) throw new Error(`Unsupported recurrence frequency: ${freq}`);
  const gcalInterval = freq === "BIWEEKLY" ? 2 : (interval ?? 1);

  const parts = [`FREQ=${gcalFreq}`, `INTERVAL=${gcalInterval}`];
  if (count) {
    parts.push(`COUNT=${count}`);
  } else if (until) {
    parts.push(`UNTIL=${toRRuleUntil(until)}`);
  } else {
    const defaultCap = DateTime.now().setZone(TZ).plus({ years: 1 });
    parts.push(`UNTIL=${toRRuleUntil(defaultCap.toISO())}`);
  }
  return `RRULE:${parts.join(";")}`;
}

// Reverso de buildRRule — usado por el Edit modal para mostrar/prefillear el
// patrón actual de una serie (las instancias nunca traen `recurrence`, solo
// el maestro, así que esto se llama contra el masterId).
function parseRRule(rruleString) {
  const raw = rruleString.replace(/^RRULE:/, "");
  const parts = Object.fromEntries(raw.split(";").map((p) => p.split("=")));
  const gcalFreq = parts.FREQ ?? "WEEKLY";
  const interval = parseInt(parts.INTERVAL ?? "1", 10);
  const freq = gcalFreq === "WEEKLY" && interval === 2 ? "BIWEEKLY" : gcalFreq;

  if (parts.COUNT) {
    return {
      freq,
      endType: "count",
      count: parseInt(parts.COUNT, 10),
      until: null,
    };
  }
  if (parts.UNTIL) {
    const until = DateTime.fromFormat(parts.UNTIL, "yyyyMMdd'T'HHmmss'Z'", {
      zone: "utc",
    })
      .setZone(TZ)
      .toISODate();
    return { freq, endType: "until", count: null, until };
  }
  return { freq, endType: "never", count: null, until: null };
}

// Reconstruye un RRULE reemplazando su UNTIL (y descartando COUNT si tenía)
// — usado para truncar la serie vieja al hacer scope="following".
function withUntil(rruleString, untilIso) {
  const parts = rruleString
    .replace(/^RRULE:/, "")
    .split(";")
    .filter((p) => !p.startsWith("COUNT=") && !p.startsWith("UNTIL="));
  parts.push(`UNTIL=${toRRuleUntil(untilIso)}`);
  return `RRULE:${parts.join(";")}`;
}

// Extrae FREQ/INTERVAL de un RRULE existente, para que la serie nueva
// herede el mismo patrón de recurrencia que la vieja.
function extractFreqInterval(rruleString) {
  const raw = rruleString.replace(/^RRULE:/, "");
  const freq = raw.match(/FREQ=(\w+)/)?.[1] ?? "WEEKLY";
  const interval = parseInt(raw.match(/INTERVAL=(\d+)/)?.[1] ?? "1", 10);
  return { freq, interval };
}

// ── resolveSeriesSplit ────────────────────────────────────────────────────────
// LAB-233 (scope="following"): dado el anchor real del maestro (su propio
// DTSTART en Google) y la fecha ORIGINAL de la ocurrencia que se está
// editando/borrando, determina si hay algo antes del corte (si no, no hace
// falta una segunda serie — es un caso scope="all" disfrazado) y, si lo hay,
// el UNTIL exacto para truncar la serie vieja más la fecha de fin real de la
// serie completa (se hereda tal cual, no se recalcula count/until de nuevo).
//
// isFirstOccurrence se compara contra el DTSTART real del maestro en
// Google — NUNCA contra Supabase. `appointments` es un espejo con su propia
// ventana de sync y puede no tener el historial completo de la serie (p.ej.
// una serie corriendo desde junio puede no tener filas de junio/julio si
// nunca se sincronizaron), lo que antes hacía ver a una ocurrencia bien
// entrada en la serie como si fuera la primera — y esa rama mueve el
// DTSTART del maestro directo, sin el chequeo de "hay que dividir la serie"
// que sí tiene la rama de abajo. Google termina rechazando ese movimiento
// (p.ej. por instancias-excepción que quedan antes del nuevo DTSTART) con
// el mismo "Invalid start time." genérico.
function resolveSeriesSplit(masterDTStartDate, splitDateIso) {
  const isFirstOccurrence = splitDateIso <= masterDTStartDate;
  const oldSeriesUntil = DateTime.fromISO(splitDateIso, { zone: TZ })
    .minus({ days: 1 })
    .endOf("day")
    .toISO();
  return { isFirstOccurrence, oldSeriesUntil };
}

// Última fecha de ocurrencia que Supabase conoce para esta serie — solo se
// usa para el UNTIL de la serie NUEVA en un split real, nunca para decidir
// isFirstOccurrence. Clampeada a splitDateIso: si `appointments` quedó
// desactualizada (menos filas futuras de las que realmente hay en GCal), un
// UNTIL anterior al startIso nuevo también dispara el mismo "Invalid start
// time." al hacer insert().
async function resolveSeriesEndDate(masterEventId, splitDateIso) {
  const { data: rows, error } = await supabase
    .from("appointments")
    .select("scheduled_date")
    .eq("recurring_event_id", masterEventId)
    .neq("status", "cancelled");
  if (error) throw error;

  const dates = (rows ?? []).map((r) => r.scheduled_date).sort();
  return dates.length && dates[dates.length - 1] >= splitDateIso
    ? dates[dates.length - 1]
    : splitDateIso;
}

// Fetches and syncs every instance of a recurring series into Supabase
// (appointments — client/service/value/recurrence_rule only). Used both
// right after creating a recurring event and after a scope="all"/"following"
// edit, since GCal's insert/patch on the master only returns the master
// object — individual instances have to be fetched separately via
// events.instances().
//
// Team assignment (appointment_teams / daily_team_assignments) is
// deliberately NOT propagated across the whole series here — the cleaners
// on a given day can be different from the ones the same client gets next
// visit, so baking today's team into every future occurrence was both a
// business-rule bug and the reason this used to hang on long-horizon series
// (each instance triggered its own team "move" writes, awaited one by one —
// a biweekly series with no end date can mean 100+ sequential writes). Only
// the first occurrence — the one the admin is actually looking at — gets
// the initial team, if one was provided; every later occurrence is left
// unassigned for AssignModal / auto-assign, same as any other event.
async function syncRecurringSeries(
  calendar,
  masterEvent,
  { clientId, serviceType, value, employeeIds, teamId, pruneStale = false },
) {
  const recurrenceRule = masterEvent.recurrence?.[0] ?? null;
  let pageToken;
  let total = 0;
  let isFirstInstance = true;
  const touchedMonths = new Set();
  const syncedGcalIds = new Set();

  // Tope defensivo: nunca expandir/escribir más de ~18 meses hacia adelante
  // en una sola corrida (incidente ago 2026 — series sin UNTIL generaron
  // filas hasta 2040+). Es también el límite que usa staleUpperBound abajo
  // para podar huérfanos: solo se cancela lo que esta corrida efectivamente
  // consultó a GCal, nunca lo que está fuera de esta ventana.
  const instancesTimeMax = DateTime.now()
    .setZone(TZ)
    .plus({ months: 18 })
    .toISO();

  do {
    const resp = await calendar.events.instances({
      calendarId: CALENDAR_ID,
      eventId: masterEvent.id,
      maxResults: 250,
      pageToken,
      timeMax: instancesTimeMax,
    });

    for (const instance of resp.data.items || []) {
      await syncAppointment(
        instance,
        clientId,
        serviceType,
        value,
        recurrenceRule,
      );
      syncedGcalIds.add(instance.id);
      if (isFirstInstance) {
        if (employeeIds?.length)
          await syncAppointmentTeams(instance.id, employeeIds);
        const firstDate = (
          instance.start?.dateTime ||
          instance.start?.date ||
          ""
        ).slice(0, 10);
        if (firstDate) {
          // Same lock as fetchFromGCal — a prefetch/resync could be syncing
          // this exact date concurrently.
          await withDateLock(firstDate, () =>
            syncDailyTeamAssignments(instance, teamId),
          );
        } else {
          await syncDailyTeamAssignments(instance, teamId);
        }
        isFirstInstance = false;
      }

      const startDt = instance.start?.dateTime || instance.start?.date;
      if (startDt) {
        const { year, month } = isoToYearMonthFromGCal(startDt);
        touchedMonths.add(cacheKey(year, month));
      }
      total++;
    }
    pageToken = resp.data.nextPageToken;
  } while (pageToken);

  invalidateCache(...touchedMonths);
  console.log(
    `✅ Synced ${total} instance(s) of recurring series ${masterEvent.id}` +
      (employeeIds?.length || teamId
        ? " (team applied to first occurrence only)"
        : ""),
  );

  // LAB-XXX (ago 2026): cancela en Supabase las filas que dejaron de
  // matchear el patrón nuevo tras un cambio de recurrencia/DTSTART. Solo
  // dentro de la ventana que ESTA corrida realmente pidió a GCal
  // (instancesTimeMax) — más allá de eso no sabemos si la instancia sigue
  // vigente o no, así que nunca se toca (validado contra series
  // indefinidas reales con filas a 2040+, ver test ago 2026).
  if (pruneStale) {
    const staleUpperBound = DateTime.fromISO(instancesTimeMax, {
      zone: TZ,
    }).toISODate();

    let staleQuery = supabase
      .from("appointments")
      .select("id, scheduled_date, status, google_calendar_event_id")
      .eq("recurring_event_id", masterEvent.id)
      .neq("status", "cancelled")
      .gte("scheduled_date", DateTime.now().setZone(TZ).toISODate())
      .lte("scheduled_date", staleUpperBound);

    if (syncedGcalIds.size > 0) {
      staleQuery = staleQuery.not(
        "google_calendar_event_id",
        "in",
        `(${[...syncedGcalIds].join(",")})`,
      );
    }

    const { data: staleRows, error: staleErr } = await staleQuery;
    if (staleErr) {
      console.error(
        `⚠️ syncRecurringSeries: no se pudo chequear filas huérfanas para ${masterEvent.id}:`,
        staleErr.message,
      );
    } else if (staleRows?.length) {
      console.log(
        `🧹 Cancelando ${staleRows.length} appointment(s) huérfanos de la serie ${masterEvent.id} ` +
          `(ya no matchean el patrón nuevo, dentro de la ventana ${staleUpperBound}): ` +
          staleRows
            .map((r) => `${r.id}(${r.scheduled_date}, was ${r.status})`)
            .join(", "),
      );
      const { error: cancelErr } = await supabase
        .from("appointments")
        .update({ status: "cancelled", updated_at: new Date().toISOString() })
        .in(
          "id",
          staleRows.map((r) => r.id),
        );
      if (cancelErr) {
        console.error(
          `⚠️ syncRecurringSeries: falló la cancelación de huérfanos para ${masterEvent.id}:`,
          cancelErr.message,
        );
      }
    }
  }

  return total;
}

// ─────────────────────────────────────────────────────────────────────────────
// Helper: resolve client_id from a GCal event
// ─────────────────────────────────────────────────────────────────────────────
async function resolveClientId(gcalEvent, explicitClientId = null) {
  if (explicitClientId) return explicitClientId;

  const desc = gcalEvent.description || "";
  const match = desc.match(
    /client_id:\s*([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i,
  );
  if (match) return match[1];

  // TODO (E3-S1): fuzzy-match against clients table

  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Helper: upsert appointment row in Supabase
// ─────────────────────────────────────────────────────────────────────────────
async function syncAppointment(
  gcalEvent,
  clientId = null,
  serviceType = null,
  value = null,
  recurrenceRule = null,
  teamId = null,
) {
  const resolvedClientId = await resolveClientId(gcalEvent, clientId);

  if (!resolvedClientId) {
    console.log(
      `[Sync] Skipping appointments upsert for "${gcalEvent.summary}" — no client_id resolved`,
    );
    return;
  }

  const startRaw = gcalEvent.start?.dateTime || gcalEvent.start?.date;
  const endRaw = gcalEvent.end?.dateTime || gcalEvent.end?.date;

  const startsAt = parseGCalDateTime(startRaw).toISO();
  const endsAt = parseGCalDateTime(endRaw).toISO();

  const scheduledDate = parseGCalDateTime(startRaw).toISODate();
  const scheduledStartTime = parseGCalDateTime(startRaw).toFormat("HH:mm:ss");
  const scheduledEndTime = parseGCalDateTime(endRaw).toFormat("HH:mm:ss");

  const row = {
    google_calendar_event_id: gcalEvent.id,
    client_id: resolvedClientId,
    scheduled_date: scheduledDate,
    scheduled_start_time: scheduledStartTime,
    scheduled_end_time: scheduledEndTime,
    starts_at: startsAt,
    ends_at: endsAt,
    timezone: TZ,
    special_instructions: gcalEvent.description || null,
    property_address: gcalEvent.location || "",
    gcal_summary: gcalEvent.summary || null, // ← NUEVO
    status: "pending",
    updated_at: new Date().toISOString(),
    recurring_event_id: gcalEvent.recurringEventId || null,
    recurrence_rule: recurrenceRule,
    team_id: teamId ?? null,
    ...(serviceType && { service_type: serviceType }),
    ...(value && { value }),
  };

  const { error } = await supabase
    .from("appointments")
    .upsert(row, { onConflict: "google_calendar_event_id" });

  if (error) console.error("⚠️  syncAppointment upsert error:", error.message);
}

// ─────────────────────────────────────────────────────────────────────────────
// Helper: assign employees to appointment_teams
// ─────────────────────────────────────────────────────────────────────────────
export async function syncAppointmentTeams(gcalEventId, employeeIds = []) {
  const { data: appt, error: fetchErr } = await supabase
    .from("appointments")
    .select("id")
    .eq("google_calendar_event_id", gcalEventId)
    .single();

  if (fetchErr || !appt) {
    console.error(
      "⚠️  syncAppointmentTeams: appointment not found for",
      gcalEventId,
    );
    return;
  }

  await supabase
    .from("appointment_teams")
    .delete()
    .eq("appointment_id", appt.id);

  if (!employeeIds.length) return;

  const rows = employeeIds.map((empId, idx) => ({
    appointment_id: appt.id,
    employee_id: empId,
    role: idx === 0 ? "leader" : "member",
  }));

  const { error: insertErr } = await supabase
    .from("appointment_teams")
    .insert(rows);
  if (insertErr)
    console.error("⚠️  syncAppointmentTeams insert error:", insertErr.message);
}

// ─────────────────────────────────────────────────────────────────────────────
// Helper BATCH: igual que syncAppointmentTeams pero para N eventos de una sola
// vez — 3 round-trips a Supabase TOTALES en vez de 3 por evento. Pensado para
// el auto-apply semanal (LAB-233 perf), donde antes cada patch job encadenaba
// su propio select/delete/insert de forma serializada dentro del worker.
// ─────────────────────────────────────────────────────────────────────────────
export async function syncAppointmentTeamsBatch(jobs) {
  // A diferencia de antes, NO filtramos por employeeIds.length acá — un job
  // con employeeIds:[] significa "vaciar cleaners" y su appointment_id igual
  // necesita pasar por el delete, aunque no tenga inserts después.
  const eligible = jobs ?? [];
  if (!eligible.length) return new Map();

  const gcalIds = [...new Set(eligible.map((j) => j.gcalEventId))];

  const { data: appts, error: fetchErr } = await supabase
    .from("appointments")
    .select("id, google_calendar_event_id")
    .in("google_calendar_event_id", gcalIds);

  if (fetchErr) {
    console.error(
      "⚠️  syncAppointmentTeamsBatch: fetch error:",
      fetchErr.message,
    );
    return new Map();
  }

  const apptIdByGcalId = new Map(
    (appts ?? []).map((a) => [a.google_calendar_event_id, a.id]),
  );
  const missing = gcalIds.filter((id) => !apptIdByGcalId.has(id));
  if (missing.length) {
    console.error(
      "⚠️  syncAppointmentTeamsBatch: appointment not found for",
      missing,
    );
  }

  const apptIds = [...apptIdByGcalId.values()];
  if (apptIds.length) {
    const { error: delErr } = await supabase
      .from("appointment_teams")
      .delete()
      .in("appointment_id", apptIds);
    if (delErr)
      console.error(
        "⚠️  syncAppointmentTeamsBatch: delete error:",
        delErr.message,
      );
  }

  const rows = [];
  for (const job of eligible) {
    const apptId = apptIdByGcalId.get(job.gcalEventId);
    if (!apptId) continue;
    job.employeeIds.forEach((empId, idx) => {
      rows.push({
        appointment_id: apptId,
        employee_id: empId,
        role: idx === 0 ? "leader" : "member",
      });
    });
  }

  if (rows.length) {
    const { error: insErr } = await supabase
      .from("appointment_teams")
      .insert(rows);
    if (insErr)
      console.error(
        "⚠️  syncAppointmentTeamsBatch: insert error:",
        insErr.message,
      );
  }

  return new Map(
    eligible.map((j) => [j.gcalEventId, apptIdByGcalId.has(j.gcalEventId)]),
  );
}

// ── Per-date lock for daily_team_assignments sync ──────────────────────────
// Multiple fetchFromGCal calls can — and do, per production logs — run
// concurrently over overlapping ranges: initial load, adjacent-month
// prefetch, and a cache-invalidating force-resync can all fire within the
// same second. Each spawns its own fire-and-forget sync IIFE. The
// "process sequentially" loop inside ONE of those IIFEs only serializes
// work within that single invocation — it does nothing to stop a second,
// independent invocation from reading/writing the same (employee, date)
// concurrently. That's what produced the SELECT/INSERT ping-pong and
// "duplicate key value violates unique_date_team_employee" noise in the logs.
//
// dateSyncLocks chains a promise per date key so that, regardless of which
// fetchFromGCal call queues the work, only one sync+cleanup pass is ever
// touching a given date's daily_team_assignments rows at a time. Different
// dates still run fully in parallel.
const dateSyncLocks = new Map();

function withDateLock(date, fn) {
  const prev = dateSyncLocks.get(date) ?? Promise.resolve();
  // Chain off `prev` regardless of whether it resolved or rejected, so one
  // failed pass never permanently jams the lock for that date.
  const settled = prev.then(fn, fn);
  dateSyncLocks.set(
    date,
    settled.catch(() => {}),
  );
  return settled;
}

// ─────────────────────────────────────────────────────────────────────────────
// Helper: upsert daily_team_assignments from a GCal event's attendees.
//
// Called after every create/update that touches attendees, and fire-and-forget
// during full GCal fetches, so TeamHeader and AssignModal "Reuse today's pair"
// always reflect the real team composition from GCal.
//
// Strategy per employee:
//   - If already assigned to the SAME team that day → skip (already correct).
//   - If assigned to a DIFFERENT team that day → delete old row, insert new.
//     (GCal is source of truth; a re-assignment overrides the old team.)
//   - If not assigned at all → insert.
//
// This prevents duplicates: an employee can only belong to one team per day.
// ─────────────────────────────────────────────────────────────────────────────
async function syncDailyTeamAssignments(gcalEvent, resolvedTeamId) {
  const attendees = gcalEvent.attendees || [];
  if (!resolvedTeamId || attendees.length === 0) return [];

  const startRaw = gcalEvent.start?.dateTime || gcalEvent.start?.date;
  if (!startRaw) return [];
  const date = DateTime.fromISO(startRaw, { zone: TZ }).toISODate();

  const organizerEmail = gcalEvent.organizer?.email?.toLowerCase() ?? "";
  const cleanerEmails = attendees
    .map((a) => String(a.email || "").toLowerCase())
    .filter(
      (email) =>
        email &&
        !EXCLUDED_ATTENDEE_EMAILS.has(email) &&
        email !== organizerEmail,
    );

  if (cleanerEmails.length === 0) return [];

  const { data: employees, error: empErr } = await supabase
    .from("employees")
    .select("id, email")
    .in("email", cleanerEmails);

  if (empErr) {
    console.error("[syncDTA] employees lookup error:", empErr.message);
    return [];
  }
  if (!employees || employees.length === 0) return [];

  for (const emp of employees) {
    // Check current assignment for this employee on this date
    const { data: existing } = await supabase
      .from("daily_team_assignments")
      .select("id, team_id")
      .eq("date", date)
      .eq("employee_id", emp.id)
      .maybeSingle();

    if (existing) {
      if (existing.team_id === resolvedTeamId) {
        // Already correct — nothing to do
        continue;
      }
      // Wrong team → delete before re-inserting (prevents duplicates)
      await supabase
        .from("daily_team_assignments")
        .delete()
        .eq("id", existing.id);

      console.log(
        `[syncDTA] Moved ${emp.email}: ${existing.team_id} → ${resolvedTeamId} on ${date}`,
      );
    }

    const { error: insertErr } = await supabase
      .from("daily_team_assignments")
      .insert({ date, team_id: resolvedTeamId, employee_id: emp.id });

    if (insertErr) {
      console.error(
        `[syncDTA] insert error for ${emp.email} → ${resolvedTeamId} on ${date}:`,
        insertErr.message,
      );
    } else {
      console.log(`[syncDTA] ✅ ${emp.email} → ${resolvedTeamId} on ${date}`);
    }
  }

  // Every employee in `employees` genuinely is a cleaner on a qualifying
  // event today, regardless of whether their individual write above
  // succeeded — the caller uses this as the "keep" list for the cleanup
  // pass, and a transient insert/delete error here shouldn't make a real
  // attendee look stale.
  return employees.map((emp) => emp.id);
}

// ─────────────────────────────────────────────────────────────────────────────
// Deletes daily_team_assignments rows for `date` whose employee isn't in
// `keepEmployeeIds` — i.e. rows left over from a previous sync that are no
// longer backed by any qualifying event today. syncDailyTeamAssignments only
// ever inserts or moves a row; it has no way to notice "this employee simply
// isn't on any event today anymore" (removed from their only event, or the
// event itself got deleted), so without this pass those rows live on
// forever and TeamHeader keeps showing someone who isn't actually assigned.
// ─────────────────────────────────────────────────────────────────────────────
async function cleanupStaleDailyTeamAssignments(date, keepEmployeeIds) {
  const { data: existing, error: fetchErr } = await supabase
    .from("daily_team_assignments")
    .select("id, employee_id")
    .eq("date", date);

  if (fetchErr) {
    console.error(
      `[syncDTA cleanup] fetch error for ${date}:`,
      fetchErr.message,
    );
    return;
  }
  if (!existing || existing.length === 0) return;

  const staleIds = existing
    .filter((row) => !keepEmployeeIds.has(row.employee_id))
    .map((row) => row.id);

  if (staleIds.length === 0) return;

  const { error: deleteErr } = await supabase
    .from("daily_team_assignments")
    .delete()
    .in("id", staleIds);

  if (deleteErr) {
    console.error(
      `[syncDTA cleanup] delete error for ${date}:`,
      deleteErr.message,
    );
    return;
  }

  console.log(
    `[syncDTA cleanup] Removed ${staleIds.length} stale assignment(s) on ${date}`,
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Operational settings (service_buffer_minutes, max_simultaneous_teams,
// keep_stable_pair) ahora se leen desde el settingsService compartido
// (services/settingsService.js), que centraliza la lectura de `settings`
// con cache y defaults para todo el backend — ver getOperationalSettings().
// ─────────────────────────────────────────────────────────────────────────────

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/calendar/events
// Query params: timeMin (ISO), timeMax (ISO)
//
// Performance path:
//   1. Derive the year/month from timeMin.
//   2. Serve from cache (fresh hit) or fetch/refresh (miss / stale).
//   3. Filter the cached month's events down to the requested [timeMin, timeMax]
//      window (supports week-view requests within a cached month).
//   4. Kick off prefetching of adjacent months asynchronously.
// ─────────────────────────────────────────────────────────────────────────────
export async function getCalendarEvents(req, res) {
  try {
    const { timeMin, timeMax } = req.query;
    if (!timeMin || !timeMax) {
      return res
        .status(400)
        .json({ error: "timeMin and timeMax are required" });
    }

    const tMin = DateTime.fromISO(timeMin, { zone: TZ });
    const tMax = DateTime.fromISO(timeMax, { zone: TZ });

    const startYM = isoToYearMonth(timeMin);
    const endYM = isoToYearMonth(tMax.minus({ seconds: 1 }).toISO()); // tMax is exclusive

    // ── Fetch month(s) — usually one, two when a week spans a month boundary ──
    const monthFetches = [getEventsForMonth(startYM.year, startYM.month)];

    const crossesMonth =
      startYM.year !== endYM.year || startYM.month !== endYM.month;

    if (crossesMonth) {
      monthFetches.push(getEventsForMonth(endYM.year, endYM.month));
    }

    const monthArrays = await Promise.all(monthFetches);

    // Merge and deduplicate by event id (in case the same event appears in
    // both month caches — e.g. a recurring event instance that GCal returns
    // in both windows).
    const seen = new Set();
    const allEvents = [];
    for (const arr of monthArrays) {
      for (const e of arr) {
        if (!seen.has(e.id)) {
          seen.add(e.id);
          allEvents.push(e);
        }
      }
    }

    // Filter to the exact requested window
    const events = allEvents.filter((e) => {
      const start = DateTime.fromISO(e.startIso, { zone: TZ });
      return start >= tMin && start < tMax;
    });

    // Prefetch adjacent months in the background (fire and forget)
    prefetchAdjacentMonths(startYM.year, startYM.month);
    if (crossesMonth) {
      prefetchAdjacentMonths(endYM.year, endYM.month);
    }

    return res.json({ ok: true, events, tz: TZ });
  } catch (e) {
    console.error("❌ getCalendarEvents:", e.message);
    return res.status(500).json({ ok: false, error: e.message });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/calendar/events
// Body: { summary, startIso, endIso, description?, location?, colorId?,
//         clientId?, serviceType?, value?, employeeIds? }
// ─────────────────────────────────────────────────────────────────────────────
export async function createCalendarEvent(req, res) {
  try {
    const {
      summary,
      startIso,
      endIso,
      description,
      location,
      colorId,
      clientId,
      serviceType,
      value,
      employeeIds = [],
      recurrence,
    } = req.body;

    if (!summary || !startIso || !endIso) {
      return res
        .status(400)
        .json({ error: "summary, startIso and endIso are required" });
    }

    // Resolver employeeIds → attendees de GCal (email) para avisarles por
    // mail al crear el evento. Si algún id no tiene email cargado, se
    // omite (no se puede invitar sin email) y se deja constancia en logs.
    let attendees;
    if (employeeIds.length) {
      const { data: assignedEmployees, error: empErr } = await supabase
        .from("employees")
        .select("id, name, email")
        .in("id", employeeIds);

      if (empErr) {
        console.warn(
          "⚠️ No se pudieron resolver emails de employeeIds para attendees:",
          empErr.message,
        );
      } else {
        const withoutEmail = (assignedEmployees ?? []).filter((e) => !e.email);
        if (withoutEmail.length) {
          console.warn(
            "⚠️ Empleados sin email, no se los invita al evento:",
            withoutEmail.map((e) => `${e.id} (${e.name})`).join(", "),
          );
        }
        attendees = (assignedEmployees ?? [])
          .filter((e) => e.email)
          .map((e) => ({ email: e.email }));
      }
    }

    const calendar = getCalendarClient();
    const teamIdFromColor = teamIdFromColorId(colorId);
    const gcalBody = {
      summary: withTeamTag(summary, teamIdFromColor),
      description: description || undefined,
      location: location || undefined,
      colorId: colorId || undefined,
      start: { dateTime: startIso, timeZone: TZ },
      end: { dateTime: endIso, timeZone: TZ },
      attendees: attendees?.length ? attendees : undefined,
      recurrence: recurrence ? [buildRRule(recurrence)] : undefined,
    };

    const resp = await calendar.events.insert({
      calendarId: CALENDAR_ID,
      requestBody: gcalBody,
      // Google's own invite/update emails are silenced everywhere in this
      // controller — cleaners get their schedule via the daily digest job
      // (jobs/dailyDigestJob.js) instead. See notifyUrgentAssignment() for
      // the same-day-after-digest exception.
      sendUpdates: "none",
    });
    const created = resp.data;

    const createdTeamId = detectTeam(created) ?? teamIdFromColor ?? null;

    if (recurrence) {
      // `created` is the SERIES MASTER — its id may not match the id GCal
      // assigns the first instance in events.instances(), so we don't sync it
      // directly. syncRecurringSeries fetches and syncs every real instance,
      // including the first, uniformly (and invalidates their months).
      await syncRecurringSeries(calendar, created, {
        clientId,
        serviceType,
        value,
        employeeIds,
        teamId: createdTeamId,
      });
    } else {
      await syncAppointment(
        created,
        clientId,
        serviceType,
        value,
        null,
        createdTeamId,
      );
      if (employeeIds.length)
        await syncAppointmentTeams(created.id, employeeIds);
      await syncDailyTeamAssignments(created, createdTeamId);

      const { year, month } = isoToYearMonth(startIso);
      invalidateCache(cacheKey(year, month));
    }

    console.log(
      `✅ Created GCal event: ${created.id} — "${summary}"` +
        (attendees?.length
          ? ` — avisados: ${attendees.map((a) => a.email).join(", ")}`
          : ""),
    );

    // ── Notificación interna a contact@monkeycleaning.com ─────────────────
    {
      let clientData = null;
      if (clientId) {
        const { data: client } = await supabase
          .from("clients")
          .select("first_name, last_name, email, phone, default_address")
          .eq("id", clientId)
          .maybeSingle();
        clientData = client ?? null;
      }

      const notifName = clientData
        ? [clientData.first_name, clientData.last_name]
            .filter(Boolean)
            .join(" ") || summary
        : summary;

      const notifPhone = clientData?.phone || "—";
      const notifAddress = clientData?.default_address || location || "—";
      const notifEmail = clientData?.email || null;

      const durationHours = parseFloat(
        DateTime.fromISO(created.end?.dateTime || endIso, { zone: TZ })
          .diff(
            DateTime.fromISO(created.start?.dateTime || startIso, { zone: TZ }),
            "hours",
          )
          .hours.toFixed(2),
      );

      sendBookingWebNotification({
        name: notifName,
        phone: notifPhone,
        address: notifAddress,
        email: notifEmail,
        team: createdTeamId || "team_1",
        startIso: created.start?.dateTime || startIso,
        endIso: created.end?.dateTime || endIso,
        requiredHours: durationHours,
        leadId: null,
        googleEventId: created.id,
      }).catch((err) =>
        console.error(
          "❌ [AdminBookingNotif] Failed to send notification:",
          err.message,
        ),
      );
    }

    return res.status(201).json({ ok: true, event: mapEvent(created) });
  } catch (e) {
    console.error("❌ createCalendarEvent:", e.message);
    return res.status(500).json({ ok: false, error: e.message });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// PATCH /api/calendar/events/:id
// Body: { summary?, startIso?, endIso?, description?, location?,
//         colorId?, clientId?, serviceType?, value?, employeeIds? }
// ─────────────────────────────────────────────────────────────────────────────
export async function updateCalendarEvent(req, res) {
  try {
    const { id } = req.params;
    const {
      summary,
      startIso,
      endIso,
      description,
      location,
      colorId,
      clientId,
      serviceType,
      value,
      employeeIds,
      recurrence,
      scope = "single",
    } = req.body;

    // Fetch current event so we only overwrite provided fields
    const calendar = getCalendarClient();

    // Fetch current event so we only overwrite provided fields
    const current = await calendar.events.get({
      calendarId: CALENDAR_ID,
      eventId: id,
      timezone: TZ,
    });
    const existing = current.data;

    // Cambiar la recurrencia solo tiene sentido para toda la serie —
    // "single" y "following" apuntan a un evento distinto del maestro, así que
    // un RRULE nuevo ahí no significaría lo que el admin espera.
    const isPartOfSeries = !!(existing.recurrence || existing.recurringEventId);
    if (recurrence !== undefined) {
      if (scope === "following") {
        return res.status(400).json({
          ok: false,
          error:
            'Changing recurrence isn\'t supported with "This and following events". Choose "All recurring events" instead.',
        });
      }
      if (isPartOfSeries && scope !== "all") {
        return res.status(400).json({
          ok: false,
          error:
            'To change how often this event repeats, choose "All recurring events".',
        });
      }
    }

    // scope="all" edits the series master instead of just this occurrence.
    // Patching an instance's own id would only detach that one date as an
    // exception; patching the master applies the change to the whole series.
    const targetId = scope === "all" ? existing.recurringEventId || id : id;

    // LAB-233: for scope="all" we need the MASTER's own anchor date (its
    // DTSTART), not the date of whatever instance the admin happened to open.
    // `existing` above was fetched by `id`, which may be an instance — if the
    // resolved target differs, fetch the master separately.
    let masterAnchor = existing;
    if (scope === "all" && targetId !== id) {
      const masterResp = await calendar.events.get({
        calendarId: CALENDAR_ID,
        eventId: targetId,
        timezone: TZ,
      });
      masterAnchor = masterResp.data;
    }

    // colorId: undefined = keep existing | "" or null = remove color | "10" etc = set color
    const resolvedColorId =
      colorId === undefined ? existing.colorId : colorId || null; // "" → null (removes color in GCal)

    // Resolver employeeIds → attendees de GCal, solo si vienen en el body.
    // employeeIds === undefined significa "no tocar la asignación actual"
    // (ej: solo se está moviendo el horario). employeeIds === [] significa
    // "sacar a todos los cleaners asignados".
    let attendees;
    if (employeeIds !== undefined) {
      if (employeeIds.length) {
        const { data: assignedEmployees, error: empErr } = await supabase
          .from("employees")
          .select("id, name, email")
          .in("id", employeeIds);

        if (empErr) {
          console.warn(
            "⚠️ No se pudieron resolver emails de employeeIds para attendees:",
            empErr.message,
          );
          attendees = existing.attendees ?? []; // fallback: no tocar nada
        } else {
          const withoutEmail = (assignedEmployees ?? []).filter(
            (e) => !e.email,
          );
          if (withoutEmail.length) {
            console.warn(
              "⚠️ Empleados sin email, no se los invita al evento:",
              withoutEmail.map((e) => `${e.id} (${e.name})`).join(", "),
            );
          }
          attendees = (assignedEmployees ?? [])
            .filter((e) => e.email)
            .map((e) => ({ email: e.email }));
        }
      } else {
        attendees = []; // limpiar asignación de cleaners
      }
    }

    // ¿Cambió realmente el set de cleaners respecto al evento actual?
    // Evita disparar emails cuando employeeIds llega igual al asignado hoy.
    let cleanersChanged = false;
    if (attendees !== undefined) {
      const existingEmails = new Set(
        (existing.attendees ?? [])
          .map((a) => String(a.email ?? "").toLowerCase())
          .filter(Boolean),
      );
      const newEmails = new Set(attendees.map((a) => a.email.toLowerCase()));
      cleanersChanged =
        existingEmails.size !== newEmails.size ||
        [...newEmails].some((e) => !existingEmails.has(e));
    }

    // LAB-233: a scope="all" time change must preserve the master's original
    // anchor DATE — without an explicit BYDAY, RRULE derives its weekday
    // pattern from DTSTART, ...
    let adjustedStartIso = startIso;
    let adjustedEndIso = endIso;

    if (scope === "all" && startIso) {
      const anchorDate = DateTime.fromISO(masterAnchor.start.dateTime, {
        zone: TZ,
      });
      const newTime = DateTime.fromISO(startIso, { zone: TZ });

      if (anchorDate.weekday !== newTime.weekday) {
        return res.status(400).json({
          ok: false,
          error:
            "Changing the day of the week for the whole series isn't supported with " +
            "'All recurring events'. Use 'This and following events' to shift the day " +
            "from now on, or 'This event only' to move a single occurrence.",
        });
      }

      const anchorEnd = DateTime.fromISO(masterAnchor.end.dateTime, {
        zone: TZ,
      });
      const durationMin = endIso
        ? DateTime.fromISO(endIso, { zone: TZ }).diff(newTime, "minutes")
            .minutes
        : anchorEnd.diff(anchorDate, "minutes").minutes;

      const newAnchorStart = anchorDate.set({
        hour: newTime.hour,
        minute: newTime.minute,
        second: 0,
        millisecond: 0,
      });
      adjustedStartIso = newAnchorStart.toISO();
      adjustedEndIso = newAnchorStart.plus({ minutes: durationMin }).toISO();
    }

    // ¿Cambió la fecha/hora del evento? Se compara por instante real (no por
    // string) para no disparar falsos positivos por formato/timezone distinto
    // entre lo que manda el frontend y lo que devuelve GCal.
    const isoInstantChanged = (newIso, existingIso) => {
      if (newIso === undefined) return false;
      if (!existingIso) return true;
      return (
        DateTime.fromISO(newIso, { zone: TZ }).toMillis() !==
        DateTime.fromISO(existingIso, { zone: TZ }).toMillis()
      );
    };
    const timeChanged =
      isoInstantChanged(adjustedStartIso, existing.start?.dateTime) ||
      isoInstantChanged(adjustedEndIso, existing.end?.dateTime);

    // Attendees efectivos tras este PATCH (los nuevos si vinieron employeeIds,
    // si no los que ya tenía el evento) — solo tiene sentido avisar si hay
    // alguien invitado.
    const finalAttendees =
      attendees !== undefined ? attendees : (existing.attendees ?? []);
    const shouldNotify =
      finalAttendees.length > 0 && (cleanersChanged || timeChanged);

    // LAB-233: scope="following" — corta la serie en la fecha ORIGINAL de
    // esta ocurrencia y arranca una serie nueva desde el día/horario elegido.
    // A diferencia de scope="all", acá SÍ se permite cambiar de día de la
    // semana — es una serie nueva, no hay historial que proteger.
    if (scope === "following") {
      if (!startIso) {
        return res.status(400).json({
          ok: false,
          error:
            'startIso is required for scope="following" (need a new date/time to split from).',
        });
      }

      const masterId = existing.recurringEventId || id;
      const splitDateIso = (
        existing.start?.dateTime ||
        existing.start?.date ||
        ""
      ).slice(0, 10);

      // `existing` viene de calendar.events.get({eventId: id}) donde `id`
      // puede ser una INSTANCIA — y las instancias nunca traen `recurrence`,
      // solo el evento maestro lo tiene. Hay que leerlo del maestro directo,
      // y de paso su DTSTART real es lo que decide isFirstOccurrence (ver
      // resolveSeriesSplit) — no Supabase.
      const masterEvent = await calendar.events.get({
        calendarId: CALENDAR_ID,
        eventId: masterId,
        timezone: TZ,
      });
      const masterDTStartDate = (
        masterEvent.data.start?.dateTime ||
        masterEvent.data.start?.date ||
        ""
      ).slice(0, 10);
      const { isFirstOccurrence, oldSeriesUntil } = resolveSeriesSplit(
        masterDTStartDate,
        splitDateIso,
      );

      const teamIdFromColor = teamIdFromColorId(resolvedColorId);
      const finalSummary = withTeamTag(
        summary ?? existing.summary,
        teamIdFromColor,
      );
      const durationMin = endIso
        ? DateTime.fromISO(endIso, { zone: TZ }).diff(
            DateTime.fromISO(startIso, { zone: TZ }),
            "minutes",
          ).minutes
        : DateTime.fromISO(existing.end.dateTime, { zone: TZ }).diff(
            DateTime.fromISO(existing.start.dateTime, { zone: TZ }),
            "minutes",
          ).minutes;
      const newEndIso =
        endIso ??
        DateTime.fromISO(startIso, { zone: TZ })
          .plus({ minutes: durationMin })
          .toISO();

      if (isFirstOccurrence) {
        // Nada antes del corte — no hace falta una segunda serie, se patchea
        // el maestro directo (día incluido, es seguro porque no hay historial).
        // recurrence no viaja acá porque scope="following" + recurrence!==undefined
        // ya devuelve 400 más arriba, así que si llegamos hasta acá la serie NO
        // está cambiando de frecuencia — hay que pasar existing.recurrence
        // explícito o GCal puede llegar a tratarlo como "sin recurrencia" según
        // el evento de origen
        const resp = await calendar.events.patch({
          calendarId: CALENDAR_ID,
          eventId: masterId,
          requestBody: {
            summary: finalSummary,
            description: description ?? existing.description,
            location: location ?? existing.location,
            colorId: resolvedColorId,
            start: { dateTime: startIso, timeZone: TZ },
            end: { dateTime: newEndIso, timeZone: TZ },
            attendees: attendees !== undefined ? attendees : existing.attendees,
            recurrence: existing.recurrence,
          },
          // See createCalendarEvent: GCal emails are always silenced now.
          sendUpdates: "none",
        });
        await syncRecurringSeries(calendar, resp.data, {
          clientId,
          serviceType,
          value,
          employeeIds,
          teamId: teamIdFromColor,
          pruneStale: true,
        });
        return res.json({ ok: true, event: mapEvent(resp.data) });
      }

      const oldRule = masterEvent.data.recurrence?.[0];
      if (!oldRule) {
        return res.status(400).json({
          ok: false,
          error: "Could not read the series' recurrence rule.",
        });
      }

      // (postmortem ago 2026): el fin de la serie nueva se decide
      // leyendo el RRULE REAL del maestro (never/until/count) — NUNCA a
      // partir de lo que ya esté sincronizado en Supabase.
      // resolveSeriesEndDate() truncaba silenciosamente clientes con
      // recurrencia indefinida a la última fecha que el sync periódico
      // ya tenía guardada (a veces solo 1-2 semanas), cortando servicios
      // reales sin ninguna cancelación explícita. Afectó ~39 clientes
      // entre julio y agosto 2026.
      const { freq, interval } = extractFreqInterval(oldRule);
      const oldRuleParsed = parseRRule(oldRule);

      let newRule;
      if (oldRuleParsed.endType === "never") {
        // La serie original no tenía fin — la nueva tampoco. Es el caso
        // esperado para un cliente con contrato de limpieza recurrente
        // indefinido (la mayoría de los clientes).
        newRule = `RRULE:FREQ=${freq};INTERVAL=${interval}`;
      } else if (oldRuleParsed.endType === "until") {
        // La serie original SÍ tenía una fecha de fin real — se hereda
        // del RRULE de GCal, no de Supabase.
        const untilIso = DateTime.fromISO(oldRuleParsed.until, { zone: TZ })
          .endOf("day")
          .toISO();
        newRule = `RRULE:FREQ=${freq};INTERVAL=${interval};UNTIL=${toRRuleUntil(
          untilIso,
        )}`;
      } else {
        // endType === "count": recalcular cuántas ocurrencias quedan tras
        // el corte requeriría contar instancias reales entre el DTSTART
        // original y splitDateIso — fuera de alcance de este fix.
        // Fallback conservador: comportamiento previo (Supabase), con
        // warning explícito para revisión manual.
        console.warn(
          `⚠️ [scope=following] Serie ${masterId} usa COUNT en vez de UNTIL — ` +
            `no se recalcula automáticamente. Usando última fecha conocida ` +
            `en Supabase como fallback; revisar a mano si corresponde.`,
        );
        const seriesEndDate = await resolveSeriesEndDate(
          masterId,
          splitDateIso,
        );
        const newSeriesUntilIso = DateTime.fromISO(seriesEndDate, { zone: TZ })
          .endOf("day")
          .toISO();
        newRule = `RRULE:FREQ=${freq};INTERVAL=${interval};UNTIL=${toRRuleUntil(
          newSeriesUntilIso,
        )}`;
      }

      // Defensa final: si terminamos con un UNTIL explícito, tiene que ser
      // posterior al nuevo startIso — mejor un 400 explícito que el
      // "Invalid start time." crudo de Google. Series "never" no llevan
      // este chequeo: no hay UNTIL que pueda quedar antes de nada.
      if (newRule.includes("UNTIL=")) {
        const untilMatch = newRule.match(/UNTIL=(\d{8}T\d{6}Z)/);
        const untilDt = DateTime.fromFormat(
          untilMatch[1],
          "yyyyMMdd'T'HHmmss'Z'",
          {
            zone: "utc",
          },
        );
        if (untilDt < DateTime.fromISO(startIso, { zone: TZ })) {
          return res.status(400).json({
            ok: false,
            error:
              "Can't split the series here — no known future occurrences past this date. " +
              "The schedule may be out of sync; try 'Force sync' and then retry the edit.",
          });
        }
      }

      // LAB-XXX: crear la serie nueva PRIMERO, antes de tocar nada de la
      // vieja. Antes esto truncaba el maestro viejo y cancelaba en Supabase
      // ANTES de intentar el insert() — si el insert fallaba (como acá,
      // por el UNTIL/DTSTART inválido de arriba), la serie vieja quedaba
      // truncada y Supabase con las citas canceladas, sin ninguna serie
      // nueva que las reemplace: citas reales desaparecidas del admin y de
      // GCal. Con el insert primero, un fallo acá no modifica nada todavía.
      const insertResp = await calendar.events.insert({
        calendarId: CALENDAR_ID,
        requestBody: {
          summary: finalSummary,
          description: description ?? existing.description,
          location: location ?? existing.location,
          colorId: resolvedColorId || undefined,
          start: { dateTime: startIso, timeZone: TZ },
          end: { dateTime: newEndIso, timeZone: TZ },
          attendees: attendees !== undefined ? attendees : existing.attendees,
          recurrence: [newRule],
        },
        // See createCalendarEvent: GCal emails are always silenced now.
        sendUpdates: "none",
      });

      // Recién con la serie nueva confirmada en GCal: truncar la vieja y
      // cancelar en Supabase todo desde el corte en adelante. Si alguno de
      // estos dos pasos falla acá, la serie nueva ya existe (el admin ve el
      // cambio aplicado) — el peor caso es que la vieja quede sin truncar
      // y se solapen visualmente hasta el próximo force-sync, mucho más
      // seguro que perder citas.
      try {
        await calendar.events.patch({
          calendarId: CALENDAR_ID,
          eventId: masterId,
          requestBody: { recurrence: [withUntil(oldRule, oldSeriesUntil)] },
        });
        await supabase
          .from("appointments")
          .update({ status: "cancelled", updated_at: new Date().toISOString() })
          .eq("recurring_event_id", masterId)
          .gte("scheduled_date", splitDateIso);
      } catch (cleanupErr) {
        console.error(
          "⚠️ scope=following: new series created but failed to truncate the old one — they may overlap until force-sync:",
          cleanupErr.message,
        );
      }

      await syncRecurringSeries(calendar, insertResp.data, {
        clientId,
        serviceType,
        value,
        employeeIds,
        teamId: teamIdFromColor,
      });

      return res
        .status(200)
        .json({ ok: true, event: mapEvent(insertResp.data) });
    }

    const teamIdFromColor = teamIdFromColorId(resolvedColorId);
    const patchBody = {
      summary: withTeamTag(summary ?? existing.summary, teamIdFromColor),
      description: description ?? existing.description,
      location: location ?? existing.location,
      colorId: resolvedColorId,
      start: adjustedStartIso
        ? { dateTime: adjustedStartIso, timeZone: TZ }
        : existing.start,
      end: adjustedEndIso
        ? { dateTime: adjustedEndIso, timeZone: TZ }
        : existing.end,
      attendees: attendees !== undefined ? attendees : existing.attendees,
      // Esto faltaba por completo — sin esta línea,
      // PATCH nunca tocaba `recurrence` en GCal (semántica de partial update:
      // campo omitido = se conserva el valor actual), así que convertir un
      // evento suelto en recurrente (scope="single") o cambiar la frecuencia
      // de una serie (scope="all") no hacía NADA del lado de GCal. La serie
      // quedaba igual que antes y syncRecurringSeries ni se disparaba
      // (updated.recurrence seguía siendo el valor viejo/null).
      ...(recurrence !== undefined
        ? { recurrence: [buildRRule(recurrence)] }
        : {}),
    };

    const resp = await calendar.events.patch({
      calendarId: CALENDAR_ID,
      eventId: targetId,
      requestBody: patchBody,
      // See createCalendarEvent: GCal emails are always silenced now.
      // `shouldNotify` still drives OUR notification, not Google's — see
      // notifyUrgentAssignment() call below for the same-day exception.
      sendUpdates: "none",
    });
    const updated = resp.data;

    // Paso 9: reagendado/editado a mano por el admin — si este evento tenía
    // un confirmation_slot 'offered', se libera acá. Solo scope="single":
    // los eventos CONFIRMAR nunca son series recurrentes (ver
    // releaseConfirmationSlotIfOffered más arriba).
    // Paso 10: de paso, leemos el status resultante para devolverlo en la
    // respuesta — así el frontend ve el badge actualizado (ej. recién
    // liberado por este mismo PATCH) sin pegarle a /events de nuevo.
    let updatedConfirmationStatus = null;
    if (scope === "single") {
      await releaseConfirmationSlotIfOffered(id);
      const { data: slotRow } = await supabase
        .from("confirmation_slots")
        .select("status")
        .eq("google_calendar_event_id", id)
        .maybeSingle();
      updatedConfirmationStatus = slotRow?.status ?? null;
    }

    const updatedTeamId = detectTeam(updated) ?? teamIdFromColor ?? null;

    // Cubre tanto scope="all" sobre una serie existente como el caso nuevo
    // de convertir un evento suelto (scope="single") en recurrente recién.
    if (updated.recurrence) {
      // Patching the master doesn't touch individual instance rows in
      // Supabase — re-sync every instance so the whole series reflects the change.
      await syncRecurringSeries(calendar, updated, {
        clientId,
        serviceType,
        value,
        employeeIds,
        teamId: updatedTeamId,
        pruneStale: true,
      });
    } else {
      await syncAppointment(
        updated,
        clientId,
        serviceType,
        value,
        null,
        updatedTeamId,
      );
      if (employeeIds) await syncAppointmentTeams(updated.id, employeeIds);
      await syncDailyTeamAssignments(updated, updatedTeamId);
    }

    // Arma el contexto de cambio por cleaner para que el mail sea descriptivo:
    // "reassigned" si es nuevo en el evento, "rescheduled" + hora anterior si
    // ya estaba y cambió el horario.
    const changeMap = new Map();
    if (shouldNotify) {
      const previousEmails = new Set(
        (existing.attendees ?? [])
          .map((a) => String(a.email ?? "").toLowerCase())
          .filter(Boolean),
      );
      const finalEmails = new Set(
        finalAttendees.map((a) => String(a.email ?? "").toLowerCase()),
      );

      let previousTimeLabel = null;
      if (timeChanged && existing.start?.dateTime) {
        const prevStart = DateTime.fromISO(existing.start.dateTime, {
          zone: TZ,
        });
        const prevEnd = existing.end?.dateTime
          ? DateTime.fromISO(existing.end.dateTime, { zone: TZ }).toFormat(
              "h:mm a",
            )
          : null;
        previousTimeLabel = prevEnd
          ? `${prevStart.toFormat("h:mm a")} – ${prevEnd}`
          : prevStart.toFormat("h:mm a");
      }

      for (const email of finalEmails) {
        if (!previousEmails.has(email)) {
          changeMap.set(email, { changeType: "reassigned" });
        } else if (timeChanged) {
          changeMap.set(email, {
            changeType: "rescheduled",
            previousTimeLabel,
          });
        }
        // ya estaba y no cambió el horario → sin entry, cae al copy genérico
      }
    }

    // Same-day urgent exception (DoD #3): if this change affects today's
    // schedule for a cleaner and the morning digest has already gone out,
    // ping them instantly instead of waiting for tomorrow's digest.
    if (shouldNotify) {
      await notifyUrgentAssignmentIfNeeded(updated, finalAttendees, changeMap); // ← agregado changeMap
    }

    // Invalidate affected months (event may have moved across month boundary)
    const keysToInvalidate = new Set();
    if (startIso)
      keysToInvalidate.add(
        cacheKey(...Object.values(isoToYearMonth(startIso))),
      );
    if (existing.start?.dateTime)
      keysToInvalidate.add(
        cacheKey(
          ...Object.values(isoToYearMonthFromGCal(existing.start.dateTime)),
        ),
      );
    invalidateCache(...keysToInvalidate);

    console.log(
      `✅ Updated GCal event: ${id}` +
        (shouldNotify
          ? ` — avisados (${[
              cleanersChanged && "cleaners",
              timeChanged && "horario",
            ]
              .filter(Boolean)
              .join("+")}): ${finalAttendees.map((a) => a.email).join(", ")}`
          : ""),
    );
    return res.json({
      ok: true,
      event: mapEvent(updated, {}, { [id]: updatedConfirmationStatus }),
    });
  } catch (e) {
    console.error("❌ updateCalendarEvent:", e.message);
    const status = e.code === 404 ? 404 : 500;
    return res.status(status).json({ ok: false, error: e.message });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// getConflictsForEvent — lógica pura, sin req/res, reutilizada por el endpoint
// individual (GET /events/:id/conflicts) y por el batch
// (POST /events/conflicts/batch). Comportamiento idéntico al original.
// ─────────────────────────────────────────────────────────────────────────────
async function getConflictsForEvent(
  id,
  startIso,
  endIso,
  { checkDistance = true } = {},
) {
  const newStart = DateTime.fromISO(startIso, { zone: TZ });
  const newEnd = DateTime.fromISO(endIso, { zone: TZ });
  const dayOfWeek = newStart.weekday % 7; // luxon: 1=Mon…7=Sun → 0=Sun…6=Sat
  const dateStr = newStart.toISODate();

  // LAB275: mismos operational settings que getAvailableStaff — single
  // source of truth para buffer fijo, buffer de traslado y kill-switch.
  const {
    serviceBufferMinutes,
    travelTimeBufferMinutes,
    distanceValidationEnabled,
  } = await getOperationalSettings();
  const bufferedStart = newStart.minus({ minutes: serviceBufferMinutes });
  const bufferedEnd = newEnd.plus({ minutes: serviceBufferMinutes });

  // 1. Find employees currently assigned to this appointment
  const { data: appt } = await supabase
    .from("appointments")
    .select("id, property_address")
    .eq("google_calendar_event_id", id)
    .maybeSingle();

  if (!appt) return [];

  const targetAddress = appt.property_address || "";

  const { data: teams } = await supabase
    .from("appointment_teams")
    .select("employee_id, employees(id, name, email)")
    .eq("appointment_id", appt.id);

  if (!teams || teams.length === 0) return [];

  // 2. Check ALL employees IN PARALLEL (antes: secuencial, un await tras otro)
  const conflictResults = await Promise.all(
    teams.map(async (team) => {
      const empId = team.employee_id;
      const empName = team.employees?.name ?? empId;
      const reasons = [];

      // 2a. Fetch weekly availability and extra (one-off) availability in parallel
      const [{ data: avail }, { data: extraSlots }] = await Promise.all([
        supabase
          .from("employee_availability")
          .select("start_time, end_time")
          .eq("employee_id", empId)
          .eq("day_of_week", dayOfWeek)
          .maybeSingle(),
        supabase
          .from("employee_extra_availability")
          .select("start_time, end_time")
          .eq("employee_id", empId)
          .eq("date", dateStr)
          .maybeSingle(),
      ]);

      // Extra availability overrides the weekly schedule for this specific date.
      // If neither exists the employee is not scheduled at all.
      const effectiveAvail = extraSlots ?? avail;

      if (!effectiveAvail) {
        reasons.push({
          type: "schedule",
          message: `not scheduled on ${newStart.toFormat("cccc")}`,
        });
      } else {
        const availStart = DateTime.fromISO(
          `${dateStr}T${effectiveAvail.start_time}`,
          { zone: TZ },
        );
        const availEnd = DateTime.fromISO(
          `${dateStr}T${effectiveAvail.end_time}`,
          { zone: TZ },
        );
        if (
          newStart.toMillis() < availStart.toMillis() ||
          newEnd.toMillis() > availEnd.toMillis()
        ) {
          reasons.push({
            type: "schedule",
            message: `outside working hours (${effectiveAvail.start_time.slice(0, 5)}–${effectiveAvail.end_time.slice(0, 5)})`,
          });
        }
      }

      // 2b. Time off — is the date within any approved time-off period?
      const { data: timeOff } = await supabase
        .from("employee_time_off")
        .select("start_date, end_date, reason")
        .eq("employee_id", empId)
        .lte("start_date", dateStr)
        .gte("end_date", dateStr)
        .limit(1);

      if (timeOff && timeOff.length > 0) {
        const reason = timeOff[0].reason ? ` (${timeOff[0].reason})` : "";
        reasons.push({ type: "schedule", message: `on time off${reason}` });
      }

      // 2c. Other appointments — acotado a la MISMA fecha del evento en vez
      //     de traer todo el historial del empleado. Mismo criterio que ya
      //     se usa en getAvailableEmployeesForSlot (.eq("scheduled_date", dateStr)).
      const { data: otherAppts } = await supabase
        .from("appointment_teams")
        .select(
          "appointment_id, appointments!inner(id, google_calendar_event_id, starts_at, ends_at, status, property_address)",
        )
        .eq("employee_id", empId)
        .eq("appointments.scheduled_date", dateStr)
        .neq("appointment_id", appt.id)
        .neq("appointments.status", "cancelled");

      if (otherAppts) {
        for (const other of otherAppts) {
          const oa = other.appointments;
          if (!oa?.starts_at || !oa?.ends_at) continue;
          const oStart = DateTime.fromISO(oa.starts_at, { zone: TZ });
          const oEnd = DateTime.fromISO(oa.ends_at, { zone: TZ });
          // Solapamiento real: siempre conflicto, no hay traslado que lo salve.
          if (newStart < oEnd && newEnd > oStart) {
            reasons.push({
              type: "timing",
              message: `already assigned to another service at ${oStart.toFormat("h:mm a")}`,
            });
            break;
          }

          // LAB275: fuera de la ventana fija → sin conflicto, no evaluar más.
          if (!(bufferedStart < oEnd && bufferedEnd > oStart)) continue;

          // Caso límite dentro de la ventana fija. Si el chequeo por distancia
          // está deshabilitado (batch semanal, o kill-switch, o sin
          // direcciones para comparar) → regla fija, igual que antes.
          if (
            !checkDistance ||
            !distanceValidationEnabled ||
            !oa.property_address ||
            !targetAddress
          ) {
            reasons.push({
              type: "timing",
              message: `less than ${serviceBufferMinutes}min before/after another service at ${oStart.toFormat("h:mm a")}`,
            });
            break;
          }

          const gapMinutes =
            oEnd <= newStart
              ? newStart.diff(oEnd, "minutes").minutes
              : oStart.diff(newEnd, "minutes").minutes;

          const [earlierEnd, laterStart] =
            oEnd <= newStart ? [oEnd, newStart] : [newEnd, oStart];
          const lunchMinutes = findLunchMinutesBetween(
            team.employees?.email,
            earlierEnd,
            laterStart,
          );

          if (lunchMinutes === null) {
            // No se pudo determinar si hay lunch en el medio → regla fija.
            reasons.push({
              type: "timing",
              message: `less than ${serviceBufferMinutes}min before/after another service at ${oStart.toFormat("h:mm a")}`,
            });
            break;
          }

          const travelMinutes = await getTravelTimeMinutes(
            oa.property_address,
            targetAddress,
          );

          console.log(
            `[LAB275][reschedule] event=${id} employee=${empId} ` +
              `gap=${Math.round(gapMinutes)}min travel=${travelMinutes ?? "n/a"}min ` +
              `buffer=${travelTimeBufferMinutes}min lunch=${lunchMinutes}min → ` +
              `${travelMinutes !== null && gapMinutes >= travelMinutes + travelTimeBufferMinutes + lunchMinutes ? "LIBERADO" : "OCUPADO"} ` +
              `(regla fija: ${serviceBufferMinutes}min)`,
          );

          if (travelMinutes === null) {
            // ORS falló/no disponible → fallback a la regla fija (criterio 6)
            reasons.push(
              `less than ${serviceBufferMinutes}min before/after another service at ${oStart.toFormat("h:mm a")}`,
            );
            break;
          }

          const threshold =
            travelMinutes + travelTimeBufferMinutes + lunchMinutes;
          if (gapMinutes < threshold) {
            reasons.push({
              type: "timing",
              message:
                lunchMinutes > 0
                  ? `only ${Math.round(gapMinutes)}min available, ~${travelMinutes}min travel + ${lunchMinutes}min lunch needed to/from service at ${oStart.toFormat("h:mm a")}`
                  : `only ${Math.round(gapMinutes)}min available, ~${travelMinutes}min travel needed to/from service at ${oStart.toFormat("h:mm a")}`,
            });
            break;
          }
          // gap suficiente para el traslado real → liberado, seguir evaluando
        }
      }

      return reasons.length > 0
        ? { employeeId: empId, name: empName, reasons }
        : null;
    }),
  );

  return conflictResults.filter(Boolean);
}

// LAB337 (lunch): ¿hay un lunch de este empleado en el hueco entre dos
// servicios? Lee del cache mensual de GCal ya existente — nunca pega a la
// API. Si el mes no está cacheado, devuelve null ("no se pudo determinar")
// en vez de asumir que no hay lunch — el caller debe hacer fallback a la
// regla fija ante esa incertidumbre, mismo criterio que un fallo de ORS.
function findLunchMinutesBetween(employeeEmail, earlierEnd, laterStart) {
  if (!employeeEmail) return null;

  const monthKey = cacheKey(earlierEnd.year, earlierEnd.month);
  const cached = getFromCache(monthKey);
  if (!cached) return null;

  const lunch = cached.events.find((e) => {
    if (!isLunchEvent(e.summary)) return false;
    if (!e.attendees?.includes(employeeEmail)) return false;
    const lStart = DateTime.fromISO(e.startIso, { zone: TZ });
    const lEnd = DateTime.fromISO(e.endIso, { zone: TZ });
    return lStart >= earlierEnd && lEnd <= laterStart;
  });

  if (!lunch) return 0;
  const lStart = DateTime.fromISO(lunch.startIso, { zone: TZ });
  const lEnd = DateTime.fromISO(lunch.endIso, { zone: TZ });
  return Math.round(lEnd.diff(lStart, "minutes").minutes);
}

export async function checkEventConflicts(req, res) {
  try {
    const { id } = req.params;
    const { startIso, endIso } = req.query;

    if (!startIso || !endIso) {
      return res
        .status(400)
        .json({ error: "startIso and endIso are required" });
    }
    // Chequeo individual — el que dispara drag&drop y el EditModal al
    // cambiar horario. Corre la validación por distancia real.
    const conflicts = await getConflictsForEvent(id, startIso, endIso);
    return res.json({ ok: true, conflicts });
  } catch (e) {
    console.error("❌ checkEventConflicts:", e.message);
    return res.status(500).json({ ok: false, error: e.message });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/calendar/events/conflicts/batch
//
// Body: { events: [{ id, startIso, endIso }, ...] }
// Devuelve los conflictos de horario para varios eventos en una sola request,
// reemplazando N llamadas individuales a /events/:id/conflicts desde el
// cliente (usado por AdminCalendarPage y useOperationalData para chequear
// toda una semana de una vez en vez de evento por evento).
// ─────────────────────────────────────────────────────────────────────────────
export async function checkEventConflictsBatch(req, res) {
  try {
    const { events } = req.body ?? {};
    if (!Array.isArray(events) || events.length === 0) {
      return res
        .status(400)
        .json({ ok: false, error: "events array is required" });
    }
    if (events.length > 200) {
      return res
        .status(400)
        .json({ ok: false, error: "events array too large (max 200)" });
    }

    const results = await Promise.allSettled(
      // LAB275: vista semanal completa, hasta 200 eventos — sin distancia
      // real para no generar una ráfaga de requests a ORS. Se queda con la
      // regla fija (buffer configurable), igual que antes de este ticket.
      events.map((e) =>
        getConflictsForEvent(e.id, e.startIso, e.endIso, {
          checkDistance: false,
        }),
      ),
    );

    const conflictsByEventId = {};
    results.forEach((r, i) => {
      const eventId = events[i].id;
      conflictsByEventId[eventId] = r.status === "fulfilled" ? r.value : []; // non-blocking per-event, same criterio que el endpoint individual
    });

    return res.json({ ok: true, conflictsByEventId });
  } catch (e) {
    console.error("❌ checkEventConflictsBatch:", e.message);
    return res.status(500).json({ ok: false, error: e.message });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/calendar/events/conflicts/series
// LAB-233: pre-check de conflictos para una serie recurrente ANTES de crearla.
// Recibe fechas candidatas ya calculadas en el frontend (mismo día de
// semana/mes, mismo tope que buildRRule) y las compara contra `appointments`
// reales del mismo equipo. No bloquea nada — es puramente informativo.
// ─────────────────────────────────────────────────────────────────────────────
export async function checkSeriesConflictsPreview(req, res) {
  try {
    const {
      slots = [],
      colorId,
      excludeEventId,
      excludeRecurringEventId,
    } = req.body;
    if (!slots.length) return res.json({ ok: true, conflicts: [] });

    const teamId = teamIdFromColorId(colorId);
    if (!teamId) return res.json({ ok: true, conflicts: [] });

    const starts = slots.map((s) => s.startIso).sort();
    const ends = slots.map((s) => s.endIso).sort();
    const minDate = DateTime.fromISO(starts[0], { zone: TZ })
      .startOf("day")
      .toISO();
    const maxDate = DateTime.fromISO(ends[ends.length - 1], { zone: TZ })
      .endOf("day")
      .toISO();

    const { maxSimultaneousTeams } = await getOperationalSettings();

    // LAB-233: leído en vivo desde Google Calendar
    const { mapped: liveEvents } = await fetchFromGCal(minDate, maxDate, {
      syncDailyTeams: false,
    });

    const candidateEvents = slots.map((s, i) => ({
      id: `candidate-${i}`,
      summary: "(new series)",
      teamId,
      startIso: s.startIso,
      endIso: s.endIso,
    }));
    const existingEvents = liveEvents
      .filter((e) => e.teamId && !e.isAllDay && !e.isNonService)
      // LAB-233: al editar, el propio evento (o toda su serie, si scope
      // toca varias instancias) ya está en GCal con el equipo VIEJO — sin
      // este filtro se "choca contra sí mismo" apenas se le cambia/asigna
      // equipo.
      .filter(
        (e) =>
          e.id !== excludeEventId &&
          (!excludeRecurringEventId ||
            e.recurringEventId !== excludeRecurringEventId),
      )
      .map((e) => ({
        id: e.id,
        teamId: e.teamId,
        summary: e.summary,
        startIso: e.startIso,
        endIso: e.endIso,
      }));
    const allEvents = [...candidateEvents, ...existingEvents];

    const overlaps = findTeamOverlaps(allEvents).filter((o) =>
      o.eventId.startsWith("candidate-"),
    );
    const overCap = findOverCapacity(allEvents, maxSimultaneousTeams).filter(
      (f) => f.eventId.startsWith("candidate-"),
    );

    const conflicts = [
      ...overlaps.map((o) => ({
        dateIso: candidateEvents.find((c) => c.id === o.eventId).startIso,
        type: "team_overlap",
        detail: `Also booked: "${o.conflictingSummary}"`,
      })),
      ...overCap.map((f) => ({
        dateIso: candidateEvents.find((c) => c.id === f.eventId).startIso,
        type: "over_capacity",
        detail: `${f.simultaneousCount} simultaneous services, only ${f.maxTeams} team(s) available`,
      })),
    ];

    return res.json({ ok: true, conflicts });
  } catch (e) {
    console.error("❌ checkSeriesConflictsPreview:", e.message);
    return res.status(500).json({ ok: false, error: e.message });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/calendar/series/:masterId/recurrence
// Devuelve el patrón de recurrencia parseado del maestro — el Edit modal lo
// usa para mostrar/prefillear "Repeats: Weekly, ends on ..." cuando el admin
// abre una instancia (que nunca trae `recurrence` propio).
// ─────────────────────────────────────────────────────────────────────────────
export async function getSeriesRecurrence(req, res) {
  try {
    const { masterId } = req.params;
    const calendar = getCalendarClient();
    const master = await calendar.events.get({
      calendarId: CALENDAR_ID,
      eventId: masterId,
      timezone: TZ,
    });
    const rule = master.data.recurrence?.[0];
    if (!rule) {
      return res
        .status(404)
        .json({ ok: false, error: "This event has no recurrence rule." });
    }
    return res.json({ ok: true, recurrence: parseRRule(rule) });
  } catch (e) {
    console.error("❌ getSeriesRecurrence:", e.message);
    return res.status(500).json({ ok: false, error: e.message });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// DELETE /api/calendar/events/:id
// ─────────────────────────────────────────────────────────────────────────────
export async function deleteCalendarEvent(req, res) {
  try {
    const { id } = req.params;
    const { scope = "single" } = req.query; // "single" (default) | "all" — LAB-233
    const calendar = getCalendarClient();

    let monthKeys = new Set();
    let existingAttendees = [];
    let deletedEventSnapshot = null;
    let targetId = id;
    // For scope=single this is just [id]; for scope=all it's every instance's
    // own google_calendar_event_id, since that's what's stored per Supabase row.
    let seriesGcalIds = [id];

    try {
      const current = await calendar.events.get({
        calendarId: CALENDAR_ID,
        eventId: id,
        timezone: TZ,
      });
      existingAttendees = current.data?.attendees ?? [];
      deletedEventSnapshot = current.data;

      if (scope === "following") {
        const masterId = current.data?.recurringEventId || id;
        const splitDateIso = (
          current.data?.start?.dateTime ||
          current.data?.start?.date ||
          ""
        ).slice(0, 10);

        // `current` viene de calendar.events.get({eventId: id}) donde `id`
        // puede ser una instancia — hay que leer `recurrence` (y el DTSTART
        // real, para isFirstOccurrence) del maestro directo, no de Supabase.
        const masterEvent = await calendar.events.get({
          calendarId: CALENDAR_ID,
          eventId: masterId,
          timezone: TZ,
        });
        const masterDTStartDate = (
          masterEvent.data.start?.dateTime ||
          masterEvent.data.start?.date ||
          ""
        ).slice(0, 10);
        const { isFirstOccurrence, oldSeriesUntil } = resolveSeriesSplit(
          masterDTStartDate,
          splitDateIso,
        );

        if (!isFirstOccurrence) {
          // Solo truncar — nada que insertar, no hay campos que reagendar en
          // un delete. Se corta acá y no se sigue con el flujo genérico de
          // delete más abajo.
          const oldRule = masterEvent.data.recurrence?.[0];
          if (!oldRule) {
            return res.status(400).json({
              ok: false,
              error: "Could not read the series' recurrence rule.",
            });
          }
          await calendar.events.patch({
            calendarId: CALENDAR_ID,
            eventId: masterId,
            requestBody: { recurrence: [withUntil(oldRule, oldSeriesUntil)] },
          });

          const { error: cancelErr } = await supabase
            .from("appointments")
            .update({
              status: "cancelled",
              updated_at: new Date().toISOString(),
            })
            .eq("recurring_event_id", masterId)
            .gte("scheduled_date", splitDateIso);
          if (cancelErr)
            console.error(
              "⚠️  deleteCalendarEvent (following) Supabase update error:",
              cancelErr.message,
            );

          // Invalidar meses desde el corte en adelante — reusamos las fechas
          // que ya trajimos en resolveSeriesSplit indirectamente vía la
          // misma query de appointments, no hace falta volver a pegarle a GCal.
          const { data: futureDates } = await supabase
            .from("appointments")
            .select("scheduled_date")
            .eq("recurring_event_id", masterId)
            .gte("scheduled_date", splitDateIso);
          const monthsToInvalidate = new Set(
            (futureDates ?? []).map((r) =>
              cacheKey(...Object.values(isoToYearMonth(r.scheduled_date))),
            ),
          );
          invalidateCache(...monthsToInvalidate);

          return res.json({ ok: true });
        }
        // isFirstOccurrence → cae al flujo de "all" de abajo (no hay nada
        // antes del corte, es equivalente a borrar la serie completa).
      }

      if (scope === "all" || scope === "following") {
        targetId = current.data?.recurringEventId || id;
        const instancesResp = await calendar.events.instances({
          calendarId: CALENDAR_ID,
          eventId: targetId,
          maxResults: 300,
        });
        const items = instancesResp.data.items || [];
        seriesGcalIds = items.map((i) => i.id);
        for (const item of items) {
          const startDt = item.start?.dateTime || item.start?.date;
          if (startDt) {
            const { year, month } = isoToYearMonthFromGCal(startDt);
            monthKeys.add(cacheKey(year, month));
          }
        }
      } else {
        const startDt =
          current.data?.start?.dateTime || current.data?.start?.date;
        if (startDt) {
          const { year, month } = isoToYearMonthFromGCal(startDt);
          monthKeys.add(cacheKey(year, month));
        }
      }
    } catch {
      /* if get fails, proceed with delete anyway */
    }

    try {
      await calendar.events.delete({
        calendarId: CALENDAR_ID,
        eventId: targetId,
        // See createCalendarEvent: GCal emails are always silenced now.
        sendUpdates: "none",
      });
    } catch (delErr) {
      // 404/410 = the event is already gone from GCal (double-click, retry,
      // already deleted elsewhere). That's the state we want anyway — don't
      // abort before reconciling Supabase below, or the appointment row is
      // orphaned as "pending" forever.
      const alreadyGone = delErr.code === 404 || delErr.code === 410;
      if (!alreadyGone) throw delErr;
      console.warn(
        `⚠️  deleteCalendarEvent: GCal event ${targetId} already gone (${delErr.code}), reconciling Supabase anyway`,
      );
    }

    // Paso 9: borrado a mano por el admin — libera cualquier
    // confirmation_slot 'offered' de los eventos que se acaban de borrar,
    // para que los crons de recordatorio/release no actúen sobre ellos.
    await releaseConfirmationSlotIfOffered(seriesGcalIds);

    // Same-day cancellation alert — solo scope="single". Para "all"/"following"
    // se borra una serie completa a futuro; es una acción deliberada más rara
    // y avisar "hoy" ahí generaría ruido si el admin está limpiando fechas viejas.
    if (scope === "single" && deletedEventSnapshot) {
      await notifyCancellationIfNeeded(deletedEventSnapshot, existingAttendees);
    }

    // Mark as cancelled in Supabase (soft delete — preserves history).
    // scope=all cancels every instance's row; scope=single only this one.
    const { error } = await supabase
      .from("appointments")
      .update({ status: "cancelled", updated_at: new Date().toISOString() })
      .in("google_calendar_event_id", seriesGcalIds);

    if (error)
      console.error(
        "⚠️  deleteCalendarEvent Supabase update error:",
        error.message,
      );

    // Liberar slots de cleaning_availability vinculados a este evento
    const { error: releaseErr } = await supabase
      .from("cleaning_availability")
      .update({
        status: "available",
        google_event_id: null,
        booked_name: null,
        booked_phone: null,
        booked_email: null,
        booked_address: null,
        booked_at: null,
      })
      .in("google_event_id", seriesGcalIds);

    if (releaseErr)
      console.error(
        "⚠️  deleteCalendarEvent: error liberando slots:",
        releaseErr.message,
      );
    else
      console.log(
        `♻️  Slots de cleaning_availability liberados para evento: ${id}`,
      );

    // Invalidate cache for the affected month
    invalidateCache(...monthKeys);

    console.log(
      `🗑️  Deleted GCal event: ${id}` +
        (existingAttendees.length
          ? ` — attendees: ${existingAttendees.map((a) => a.email).join(", ")}`
          : ""),
    );
    return res.json({ ok: true });
  } catch (e) {
    console.error("❌ deleteCalendarEvent:", e.message);
    const status = e.code === 404 ? 404 : 500;
    return res.status(status).json({ ok: false, error: e.message });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/calendar/events/:id/available-staff
//
// Returns employees available for a given GCal event:
//   - All active employees
//   - Filtered by employee_availability (day_of_week + time window)
//   - Filtered out if on time_off that day
//   - Filtered out if already assigned to another overlapping appointment,
//     respecting the configured service_buffer_minutes between services
//   - Capped if max_simultaneous_teams is already reached for this slot
//   - preferredEmployeeId: the employee who has worked most with this client
//   - todayPairs: distinct pairs already assigned to other appointments today
//     (for the "Reuse today's pair" tab)
//   - keepStablePair: whether the modal should default to the "Reuse" tab
// ─────────────────────────────────────────────────────────────────────────────
export async function getAvailableStaff(req, res) {
  try {
    const { id } = req.params;

    // 0. Load operational settings in parallel with the GCal fetch
    const [gcalResp, settings] = await Promise.all([
      getCalendarClient().events.get({
        calendarId: CALENDAR_ID,
        eventId: id,
        timeZone: TZ,
      }),
      getOperationalSettings(),
    ]);

    const {
      serviceBufferMinutes,
      maxSimultaneousTeams,
      keepStablePair,
      travelTimeBufferMinutes,
      distanceValidationEnabled,
    } = settings;

    const gcalEvent = gcalResp.data;
    const startRaw = gcalEvent.start?.dateTime || gcalEvent.start?.date;
    const endRaw = gcalEvent.end?.dateTime || gcalEvent.end?.date;
    if (!startRaw || !endRaw) {
      return res
        .status(400)
        .json({ ok: false, error: "Event has no start/end time" });
    }

    const eventStart = DateTime.fromISO(startRaw, { zone: TZ });
    const eventEnd = DateTime.fromISO(endRaw, { zone: TZ });
    const dateStr = eventStart.toISODate();
    // luxon weekday: 1=Mon…7=Sun → convert to 0=Sun…6=Sat
    const dayOfWeek = eventStart.weekday % 7;

    const startTimeStr = eventStart.toFormat("HH:mm:ss");
    const endTimeStr = eventEnd.toFormat("HH:mm:ss");

    // Buffered window used for busy-check: exclude staff whose adjacent
    // appointment falls within [eventStart - buffer, eventEnd + buffer].
    const bufferedStart = eventStart.minus({ minutes: serviceBufferMinutes });
    const bufferedEnd = eventEnd.plus({ minutes: serviceBufferMinutes });

    // 1. Find the appointment linked to this GCal event (to get client_id)
    const { data: appt } = await supabase
      .from("appointments")
      .select("id, client_id")
      .eq("google_calendar_event_id", id)
      .maybeSingle();

    const appointmentId = appt?.id ?? null;
    const clientId = appt?.client_id ?? null;

    // 2. All active employees
    const { data: allEmployees, error: empErr } = await supabase
      .from("employees")
      .select("id, name, email, is_team_leader, hourly_work_rate")
      .eq("is_active", true)
      .order("name");
    if (empErr) throw empErr;

    // 3. Employees available this day/time
    const { data: avail, error: availErr } = await supabase
      .from("employee_availability")
      .select("employee_id")
      .eq("day_of_week", dayOfWeek)
      .lte("start_time", startTimeStr)
      .gte("end_time", endTimeStr);
    if (availErr) throw availErr;
    const availIds = new Set((avail ?? []).map((a) => a.employee_id));

    // 3b. Extra (one-off) availability for this exact date
    // Fetch all extra slots for this date and filter in JS (consistent with weekly check)
    const { data: extraAvailRaw, error: extraErr } = await supabase
      .from("employee_extra_availability")
      .select("employee_id, start_time, end_time")
      .eq("date", dateStr);
    if (extraErr) throw extraErr;

    const extraAvailIds = new Set(
      (extraAvailRaw ?? [])
        .filter((ea) => {
          const slotStart = DateTime.fromISO(`${dateStr}T${ea.start_time}`, {
            zone: TZ,
          });
          const slotEnd = DateTime.fromISO(`${dateStr}T${ea.end_time}`, {
            zone: TZ,
          });
          return (
            eventStart.toMillis() >= slotStart.toMillis() &&
            eventEnd.toMillis() <= slotEnd.toMillis()
          );
        })
        .map((ea) => ea.employee_id),
    );

    // Combined: available via weekly schedule OR extra one-off
    const combinedAvailIds = new Set([...availIds, ...extraAvailIds]);

    // 4. Employees on time-off this date
    const { data: timeOff, error: toErr } = await supabase
      .from("employee_time_off")
      .select("employee_id")
      .lte("start_date", dateStr)
      .gte("end_date", dateStr);
    if (toErr) throw toErr;
    const offIds = new Set((timeOff ?? []).map((t) => t.employee_id));

    // 5. Employees with overlapping appointments (excluding this event).
    //    Overlap is checked against the buffered window so staff aren't
    //    suggested if they'd have less than serviceBufferMinutes of travel time.
    const { data: busyTeams, error: busyErr } = await supabase
      .from("appointment_teams")
      .select(
        "employee_id, appointments!inner(starts_at, ends_at, google_calendar_event_id, status, property_address)",
      )
      .neq("appointments.google_calendar_event_id", id)
      .neq("appointments.status", "cancelled");
    if (busyErr) throw busyErr;

    // LAB337 (lunch): necesitamos el email de cada empleado para buscar su
    // lunch en el cache de GCal. Una sola query en batch, no por empleado.
    const busyEmployeeIds = [
      ...new Set((busyTeams ?? []).map((bt) => bt.employee_id)),
    ];
    const { data: busyEmployeesData } = busyEmployeeIds.length
      ? await supabase
          .from("employees")
          .select("id, email")
          .in("id", busyEmployeeIds)
      : { data: [] };
    const emailByEmployeeId = Object.fromEntries(
      (busyEmployeesData ?? []).map((e) => [e.id, e.email]),
    );

    // LAB275: la ventana bufferedStart/bufferedEnd (fija, serviceBufferMinutes)
    // sigue siendo el filtro grueso para saber qué appointments "cercanos" vale
    // la pena evaluar. Sobre esos casos límite, en vez de bloquear directo,
    // consultamos el traslado real entre direcciones (ORS) y comparamos contra
    // el gap real disponible + travelTimeBufferMinutes (criterios 1-3).
    const busyIds = new Set();
    const targetAddress = gcalEvent.location || "";
    for (const bt of busyTeams ?? []) {
      const oa = bt.appointments;
      if (!oa?.starts_at || !oa?.ends_at) continue;
      const oStart = DateTime.fromISO(oa.starts_at, { zone: TZ });
      const oEnd = DateTime.fromISO(oa.ends_at, { zone: TZ });

      // Solapamiento real: no hay traslado que lo salve, siempre ocupado.
      if (eventStart < oEnd && eventEnd > oStart) {
        busyIds.add(bt.employee_id);
        continue;
      }

      // Fuera incluso de la ventana fija: no está ocupado, ni vale la pena
      // pegarle a ORS para este caso.
      if (!(bufferedStart < oEnd && bufferedEnd > oStart)) continue;

      // Caso límite: dentro de la ventana fija pero sin solapamiento real.
      // Sin distancia habilitada o sin direcciones para comparar → regla fija
      // (criterio 6: fallback si no se puede calcular).
      if (
        !distanceValidationEnabled ||
        !oa.property_address ||
        !targetAddress
      ) {
        busyIds.add(bt.employee_id);
        continue;
      }

      const gapMinutes =
        oEnd <= eventStart
          ? eventStart.diff(oEnd, "minutes").minutes
          : oStart.diff(eventEnd, "minutes").minutes;

      const [earlierEnd, laterStart] =
        oEnd <= eventStart ? [oEnd, eventStart] : [eventEnd, oStart];
      const lunchMinutes = findLunchMinutesBetween(
        emailByEmployeeId[bt.employee_id],
        earlierEnd,
        laterStart,
      );

      if (lunchMinutes === null) {
        busyIds.add(bt.employee_id);
        continue;
      }

      const travelMinutes = await getTravelTimeMinutes(
        oa.property_address,
        targetAddress,
      );

      if (travelMinutes === null) {
        // ORS falló/no disponible → fallback a la regla fija (criterio 6)
        busyIds.add(bt.employee_id);
        continue;
      }

      // Criterio 7: loguear el cálculo para auditoría
      console.log(
        `[LAB275] employee=${bt.employee_id} gap=${Math.round(gapMinutes)}min ` +
          `travel=${travelMinutes}min buffer=${travelTimeBufferMinutes}min lunch=${lunchMinutes}min ` +
          `→ ${gapMinutes < travelMinutes + travelTimeBufferMinutes + lunchMinutes ? "OCUPADO" : "LIBERADO"} ` +
          `(regla fija: ${serviceBufferMinutes}min)`,
      );

      if (gapMinutes < travelMinutes + travelTimeBufferMinutes + lunchMinutes) {
        busyIds.add(bt.employee_id);
      }
    }

    // 6. Build available list
    const available = (allEmployees ?? [])
      .filter(
        (e) =>
          combinedAvailIds.has(e.id) && !offIds.has(e.id) && !busyIds.has(e.id),
      )
      .map((e) => ({
        id: e.id,
        name: e.name,
        email: String(e.email ?? "").toLowerCase(),
        is_team_leader: e.is_team_leader ?? false,
        teamId: TEAM_MEMBERS_MAP[String(e.email ?? "").toLowerCase()] ?? null,
      }));

    // 7. Check max_simultaneous_teams: count distinct teams already running
    //    during this event's time window (excluding this event itself).
    //    Only appointments with at least one employee in appointment_teams
    //    count as an active team - unassigned appointments don't consume capacity.
    const { data: concurrentAppts } = await supabase
      .from("appointments")
      .select(
        "id, starts_at, ends_at, google_calendar_event_id, appointment_teams(employee_id)",
      )
      .eq("scheduled_date", dateStr)
      .neq("google_calendar_event_id", id)
      .neq("status", "cancelled");

    let simultaneousTeamCount = 0;
    for (const ca of concurrentAppts ?? []) {
      if (!ca.starts_at || !ca.ends_at) continue;
      // Skip appointments with no assigned employees
      if (!ca.appointment_teams || ca.appointment_teams.length === 0) continue;
      const cStart = DateTime.fromISO(ca.starts_at, { zone: TZ });
      const cEnd = DateTime.fromISO(ca.ends_at, { zone: TZ });
      // True overlap (no buffer applied here — this is about team capacity,
      // not travel time)
      if (eventStart < cEnd && eventEnd > cStart) {
        simultaneousTeamCount++;
      }
    }

    const atCapacity = simultaneousTeamCount >= maxSimultaneousTeams;

    // 8. Preferred employee: most frequent with this client
    let preferredEmployeeId = null;
    if (clientId) {
      const { data: freq } = await supabase
        .from("appointment_teams")
        .select("employee_id, appointments!inner(client_id)")
        .eq("appointments.client_id", clientId);

      if (freq && freq.length > 0) {
        const counts = {};
        for (const f of freq) {
          counts[f.employee_id] = (counts[f.employee_id] ?? 0) + 1;
        }
        preferredEmployeeId =
          Object.entries(counts).sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
      }
    }

    // Sort: preferred first, then team leaders, then alphabetical
    available.sort((a, b) => {
      if (a.id === preferredEmployeeId) return -1;
      if (b.id === preferredEmployeeId) return 1;
      if (a.is_team_leader && !b.is_team_leader) return -1;
      if (!a.is_team_leader && b.is_team_leader) return 1;
      return a.name.localeCompare(b.name);
    });

    // 9. Today's pairs: other appointments this day with ≥1 assigned employee
    //    Used by "Reuse today's pair" tab
    const { data: todayAppts } = await supabase
      .from("appointments")
      .select(
        "id, google_calendar_event_id, starts_at, appointment_teams(employee_id, employees(id, name, is_team_leader))",
      )
      .eq("scheduled_date", dateStr)
      .neq("google_calendar_event_id", id)
      .neq("status", "cancelled");

    const todayPairs = [];
    for (const ta of todayAppts ?? []) {
      const members = (ta.appointment_teams ?? [])
        .filter((t) => t.employees)
        .map((t) => ({
          id: t.employees.id,
          name: t.employees.name,
          is_team_leader: t.employees.is_team_leader ?? false,
        }));
      if (members.length > 0) {
        todayPairs.push({
          appointmentId: ta.id,
          gcalEventId: ta.google_calendar_event_id,
          startsAt: ta.starts_at,
          members,
        });
      }
    }

    // Deduplicate pairs by sorted member IDs
    const seenPairs = new Set();
    const uniqueTodayPairs = todayPairs.filter((p) => {
      const key = p.members
        .map((m) => m.id)
        .sort()
        .join(",");
      if (seenPairs.has(key)) return false;
      seenPairs.add(key);
      return true;
    });

    // 10. currentAttendees: employees already assigned to THIS event in GCal.
    //     Always included regardless of schedule conflicts or atCapacity,
    //     so the frontend can show them in AssignModal with conflict badges.
    //     Each entry carries: id, name, email, is_team_leader, teamId,
    //     outsideWorkHours (true if not in availIds), busy (true if in busyIds).
    const EXCLUDED_ATT = new Set(EXCLUDED_ATTENDEE_EMAILS);
    EXCLUDED_ATT.add((gcalEvent.organizer?.email ?? "").toLowerCase());
    const attendeeEmails = (gcalEvent.attendees ?? [])
      .map((a) => String(a.email ?? "").toLowerCase())
      .filter((email) => email && !EXCLUDED_ATT.has(email));

    const currentAttendees = attendeeEmails.flatMap((email) => {
      const emp = (allEmployees ?? []).find(
        (e) => String(e.email ?? "").toLowerCase() === email,
      );
      if (!emp) return [];
      return [
        {
          id: emp.id,
          name: emp.name,
          email: String(emp.email ?? "").toLowerCase(),
          is_team_leader: emp.is_team_leader ?? false,
          teamId:
            TEAM_MEMBERS_MAP[String(emp.email ?? "").toLowerCase()] ?? null,
          outsideWorkHours: !combinedAvailIds.has(emp.id),
          busy: busyIds.has(emp.id),
        },
      ];
    });

    console.log(
      `[AssignModal] event=${id} buffer=${serviceBufferMinutes}min ` +
        `maxTeams=${maxSimultaneousTeams} simultaneous=${simultaneousTeamCount} ` +
        `atCapacity=${atCapacity} keepStablePair=${keepStablePair} ` +
        `available=${available.length} currentAttendees=${currentAttendees.length}`,
      `distanceValidationEnabled=${distanceValidationEnabled}`,
    );

    return res.json({
      ok: true,
      available: atCapacity ? [] : available,
      currentAttendees,
      preferredEmployeeId,
      todayPairs: uniqueTodayPairs,
      keepStablePair,
      // Expose context so the frontend can show a meaningful message
      atCapacity,
      simultaneousTeamCount,
      maxSimultaneousTeams,
      serviceBufferMinutes,
    });
  } catch (e) {
    console.error("❌ getAvailableStaff:", e.message);
    return res.status(500).json({ ok: false, error: e.message });
  }
}

export { TEAMS_CONFIG, TEAM_MEMBERS_MAP };

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/calendar/cache-stats  (debug / monitoring endpoint)
// ─────────────────────────────────────────────────────────────────────────────
export function getCalendarCacheStats(_req, res) {
  return res.json({ ok: true, cache: cacheStats() });
}

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/calendar/sync/force
//
// Fuerza una re-sincronización completa desde Google Calendar para el mes
// actual y los dos adyacentes (anterior y siguiente).  Invalida el caché
// in-memory y el syncToken guardado, luego descarga los eventos frescos.
//
// Útil para corregir desfases visibles sin necesidad de reiniciar el servidor.
// ─────────────────────────────────────────────────────────────────────────────
export async function forceResync(req, res) {
  try {
    const { year: qYear, month: qMonth, startDate, endDate } = req.query;

    let targets;
    if (startDate && endDate) {
      // Rango acotado (p.ej. la semana que acaba de auto-asignarse):
      // solo los meses que ese rango realmente toca, no ±1 mes fijo.
      const start = DateTime.fromISO(startDate, { zone: TZ });
      const end = DateTime.fromISO(endDate, { zone: TZ });
      const monthKeys = new Set();
      let cursor = start.startOf("month");
      while (cursor <= end) {
        monthKeys.add(cursor.toFormat("yyyy-LL"));
        cursor = cursor.plus({ months: 1 });
      }
      targets = [...monthKeys].map((k) =>
        DateTime.fromFormat(k, "yyyy-LL", { zone: TZ }),
      );
    } else {
      // Sin rango: comportamiento manual original (botón "Force resync"
      // del calendario) — mes visible ±1, para corregir desfases generales.
      const base =
        qYear && qMonth
          ? DateTime.fromObject(
              { year: Number(qYear), month: Number(qMonth), day: 1 },
              { zone: TZ },
            )
          : DateTime.now().setZone(TZ).startOf("month");
      targets = [base.minus({ months: 1 }), base, base.plus({ months: 1 })];
    }

    // 1. Invalidar caché de los tres meses (borra eventos Y syncToken)
    for (const dt of targets) {
      invalidateCache(cacheKey(dt.year, dt.month));
    }

    // 2. Re-descargar en paralelo directo desde GCal
    const results = await Promise.all(
      targets.map(async (dt) => {
        const start = dt.startOf("month");
        const end = dt.endOf("month");
        const { mapped, nextSyncToken } = await fetchFromGCal(
          start.toISO(),
          end.toISO(),
        );
        const key = cacheKey(dt.year, dt.month);
        setInCache(key, mapped, nextSyncToken);
        console.log(`[ForceResync] ${key}: ${mapped.length} eventos cargados`);
        return { month: key, count: mapped.length };
      }),
    );

    return res.json({ ok: true, resynced: results });
  } catch (e) {
    console.error("❌ forceResync:", e.message);
    return res.status(500).json({ ok: false, error: e.message });
  }
}

export async function getClientPreferences(req, res) {
  try {
    const { id } = req.params;

    // Buscar el appointment vinculado al evento de GCal
    const { data: appt } = await supabase
      .from("appointments")
      .select("client_id")
      .eq("google_calendar_event_id", id)
      .maybeSingle();

    if (!appt?.client_id) {
      return res.json({
        ok: true,
        clientId: null,
        preferred_days: null,
        preferred_time: null,
      });
    }

    const { data: client } = await supabase
      .from("clients")
      .select(
        "id, first_name, last_name, preferred_days, preferred_time, availability_windows",
      )
      .eq("id", appt.client_id)
      .single();

    return res.json({
      ok: true,
      clientId: client?.id ?? null,
      clientName:
        [client?.first_name, client?.last_name].filter(Boolean).join(" ") ||
        null,
      preferred_days: client?.preferred_days ?? null,
      preferred_time: client?.preferred_time ?? null,
      availability_windows: client?.availability_windows ?? null,
    });
  } catch (e) {
    console.error("❌ getClientPreferences:", e.message);
    return res.status(500).json({ ok: false, error: e.message });
  }
}
