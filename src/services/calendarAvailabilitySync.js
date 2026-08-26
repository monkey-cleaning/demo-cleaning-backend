import { DateTime } from "luxon";
import { getCalendarClient } from "./googleCalendarClient.js";
import { supabase } from "./supabaseService.js";
import { getProgramacionesData } from "./googleSheetsService.js";
import { getWorkWindow, getOperationalSettings } from "./settingsService.js";
import { isNonServiceEvent, detectTeamByColor } from "./eventClassification.js";

const TZ = process.env.BOOKING_TIMEZONE || "America/Vancouver";

// CLEANING_AVAILABILITY_TABLE_NAME permite apuntar a una tabla de prueba
// (ej. "cleaning_availability_duplicate") sin tocar código — usar solo para
// testing, en producción no debe estar seteada (default:
// "cleaning_availability"). syncAvailabilityFromGoogle() hace DELETE +
// UPDATE + UPSERT reales sobre esta tabla, así que conviene aislarla antes
// de correr el pipeline completo contra datos de prueba.
const CLEANING_AVAILABILITY_TABLE =
  process.env.CLEANING_AVAILABILITY_TABLE_NAME || "cleaning_availability";

// Ventana laboral y buffer entre servicios
// ✅ Ambos configurables desde la tabla `settings` vía el AdminDashboard
// (work_start_hour / work_end_hour / service_buffer_minutes). Estos valores
// son sólo el fallback inicial — loadOperationalConfigFromDB() los
// sobreescribe al comienzo de cada sync usando el settingsService compartido.
let WORK_START_HOUR = 7; // 07:00
let WORK_END_HOUR = 19; // 19:00
let BUFFER_MINUTES = Number(process.env.BUFFER_MINUTES || 30); // "transporte" después de cada servicio

// Reglas
const MIN_SLOT_HOURS = 1.5; // para considerar una ventana libre útil

// Slot reservable fijo de 90 minutos (1.5h)
const BOOKING_SLOT_MINUTES = Number(process.env.BOOKING_SLOT_MINUTES || 90);
// Granularidad: cada cuánto ofrecemos un nuevo inicio posible
const SLOT_STEP_MINUTES = Number(process.env.SLOT_STEP_MINUTES || 15);

// ── Configuración de teams y membresía ────────────────────────────────────────
// Ambos se cargan desde Supabase al inicio de cada sync:
//   - tabla `teams`                  → TEAMS_CONFIG, ALL_TEAM_IDS
//   - tabla `daily_team_assignments` → TEAMS (teamId → Set<email>)
// Único keyword que sigue detectándose por texto — ver detectTeamFromEvent
// para el porqué (lunch NO bloquea disponibilidad, se reacomoda a mano).
// "office"/"meeting"/"admin"/"training"/"break" ya NO viven acá: pasaron a
// detectarse por color (colorId Flamingo, non_service_color_id en
// eventClassification.js) — LAB-XXX ago 2026.
const LUNCH_KEYWORD = "lunch";

// ── Teams config + membership — cargados desde DB antes de cada sync ──────────
let TEAMS_CONFIG = {};
let ALL_TEAM_IDS = [];
let TEAMS = {}; // teamId → Set<email>

export function getAllTeamIds() {
  return ALL_TEAM_IDS;
}

export { TZ };

export async function loadTeamsFromDB() {
  // TEAMS_TABLE_NAME permite apuntar a una tabla de prueba (ej.
  // "teams_duplicate") sin tocar código — usar solo para testing, en
  // producción no debe estar seteada (default: "teams").
  const teamsTable = process.env.TEAMS_TABLE_NAME || "teams";
  const { data: teamsData, error: teamsErr } = await supabase
    .from(teamsTable)
    .select("id, label, color, color_ids, emojis, none_color")
    .eq("is_active", true);

  if (teamsErr || !teamsData?.length) {
    console.warn("⚠️ No se pudo cargar teams desde DB:", teamsErr?.message);
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
  } else {
    TEAMS_CONFIG = Object.fromEntries(
      teamsData.map((t) => [
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
  }

  ALL_TEAM_IDS = Object.keys(TEAMS_CONFIG);
  console.log("✅ [Sync] TEAMS_CONFIG cargado:", ALL_TEAM_IDS);
}

/**
 * ✅ Carga la ventana laboral y el buffer entre servicios desde `settings`
 * (vía el settingsService compartido, con cache y defaults ya resueltos),
 * en vez de duplicar la query acá. Fail-open: si settingsService no puede
 * leer la tabla, ya devuelve los defaults por su cuenta.
 */
async function loadOperationalConfigFromDB() {
  const { workStartHour, workEndHour } = await getWorkWindow();
  const { serviceBufferMinutes } = await getOperationalSettings();

  WORK_START_HOUR = workStartHour;
  WORK_END_HOUR = workEndHour;
  BUFFER_MINUTES = serviceBufferMinutes;

  console.log(
    `✅ [Sync] Ventana laboral: ${WORK_START_HOUR}:00 - ${WORK_END_HOUR}:00 | Buffer: ${BUFFER_MINUTES} min`,
  );
}

/**
 * Clasifica un evento y devuelve { team, reason }.
 *
 * team puede ser:
 *   - un teamId ("team_1", "team_2", ...)  → bloquea sólo ese team
 *   - "ignore"                              → NO bloquea a NADIE (lunch, o
 *                                              cualquier evento no-servicio
 *                                              vía color Flamingo — ver abajo)
 *   - null                                  → no clasificable por team específico.
 *                                              El evento sigue existiendo y ocupa
 *                                              UN team de todas formas — se resuelve
 *                                              por solapamiento en buildBusyByDayByTeam.
 *
 * Prioridad de detección:
 *   1. "lunch" en el título (case-insensitive) → "ignore". El lunch se
 *      reacomoda a mano si un cliente reserva justo en ese horario — no
 *      tiene sentido que bloquee disponibilidad de antemano. Se chequea por
 *      TEXTO, no color, porque un lunch puede llevar el color de un equipo
 *      (agrupación visual) sin que eso deba bloquear nada.
 *   2. Evento no-servicio (colorId Flamingo, ver eventClassification.js) →
 *      "ignore". Mismo motivo que el resto de los ex-BLOCK_BOTH_KEYWORDS
 *      (office/meeting/admin/training/break): ya no bloquean disponibilidad.
 *   3. colorId de equipo (team_1/team_2, ver TEAMS_CONFIG) → ese teamId.
 *   4. null (unknown — sin color reconocible).
 *
 * Mismo criterio que detectTeam() en calendarController.js (admin dashboard),
 * para que la clasificación sea consistente en todo el sistema — con la
 * salvedad de "ignore", que es específico de este archivo (acá sí importa si
 * un evento bloquea o no un horario reservable; el dashboard admin no calcula
 * disponibilidad).
 */
export function detectTeamFromEvent(e) {
  const summary = String(e.summary || "").trim();

  // 1) Lunch — nunca bloquea, se chequea por texto a propósito.
  if (summary.toLowerCase().includes(LUNCH_KEYWORD)) {
    return { team: "ignore", reason: "lunch_no_block" };
  }

  // 2) No-servicio por color (ex-keywords admin) — tampoco bloquea.
  if (isNonServiceEvent(e)) {
    return { team: "ignore", reason: "non_service_color_no_block" };
  }

  // 3) Color de equipo
  const teamId = detectTeamByColor(e, TEAMS_CONFIG);
  if (teamId) {
    return { team: teamId, reason: `color:${e.colorId}` };
  }

  // 4) Sin color reconocible → unknown, igual ocupa un team
  return { team: null, reason: "unknown" };
}

function normalizeEmail(e) {
  return String(e || "")
    .trim()
    .toLowerCase();
}

async function loadTeamMembersFromDB(date) {
  const { data, error } = await supabase
    .from("daily_team_assignments")
    .select("team_id, employees(email)")
    .eq("date", date);

  if (error) {
    console.warn(
      `⚠️ [Sync] No se pudo cargar team members para ${date}:`,
      error.message,
    );
    return;
  }

  // Reinicializar los Sets
  TEAMS = Object.fromEntries(ALL_TEAM_IDS.map((id) => [id, new Set()]));

  for (const row of data ?? []) {
    const email = normalizeEmail(row.employees?.email ?? "");
    if (email && TEAMS[row.team_id]) {
      TEAMS[row.team_id].add(email);
    }
  }

  const summary = Object.fromEntries(
    Object.entries(TEAMS).map(([id, set]) => [id, set.size]),
  );
  console.log(`✅ [Sync] TEAM_MEMBERS cargados para ${date}:`, summary);
}

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

function getTeamCleaners(team) {
  const emails = TEAMS[team] || new Set();
  const cleaners = [];
  for (const [cleanerName, email] of Object.entries(CLEANER_TO_EMAIL)) {
    if (emails.has(normalizeEmail(email))) cleaners.push(cleanerName);
  }
  return cleaners;
}

function toIso(dt) {
  return dt.toUTC().toISO({ suppressMilliseconds: true });
}

function clampToWorkWindow(day, dt) {
  const start = day.set({
    hour: WORK_START_HOUR,
    minute: 0,
    second: 0,
    millisecond: 0,
  });
  const end = day.set({
    hour: WORK_END_HOUR,
    minute: 0,
    second: 0,
    millisecond: 0,
  });
  if (dt < start) return start;
  if (dt > end) return end;
  return dt;
}

function mergeIntervals(intervals) {
  if (!intervals.length) return [];
  const sorted = [...intervals].sort(
    (a, b) => a.start.toMillis() - b.start.toMillis(),
  );
  const merged = [sorted[0]];
  for (let i = 1; i < sorted.length; i++) {
    const last = merged[merged.length - 1];
    const cur = sorted[i];
    if (cur.start <= last.end) {
      last.end = DateTime.max(last.end, cur.end);
    } else {
      merged.push(cur);
    }
  }
  return merged;
}

/**
 * Devuelve ventanas libres para un día dado, recortadas a la jornada laboral
 * y filtradas por mínimo MIN_SLOT_HOURS.
 */
function computeFreeWindowsForDay(day, busyIntervals) {
  day = day.setZone(TZ);

  const workStart = day.set({
    hour: WORK_START_HOUR,
    minute: 0,
    second: 0,
    millisecond: 0,
  });
  const workEnd = day.set({
    hour: WORK_END_HOUR,
    minute: 0,
    second: 0,
    millisecond: 0,
  });

  const clipped = busyIntervals
    .map((i) => ({
      start: clampToWorkWindow(day, i.start),
      end: clampToWorkWindow(day, i.end),
    }))
    .filter((i) => i.end > i.start);

  const merged = mergeIntervals(clipped);

  const free = [];
  let cursor = workStart;

  for (const b of merged) {
    if (b.start > cursor) free.push({ start: cursor, end: b.start });
    cursor = DateTime.max(cursor, b.end);
  }

  if (cursor < workEnd) free.push({ start: cursor, end: workEnd });

  // filtrar ventanas de al menos 1.5h
  return free.filter(
    (f) => f.end.diff(f.start, "hours").hours >= MIN_SLOT_HOURS,
  );
}

/**
 * Convierte una ventana libre en slots reservables de BOOKING_SLOT_MINUTES,
 * con nuevos starts cada SLOT_STEP_MINUTES.
 */
function windowToBookableSlots(freeWindow) {
  const slots = [];
  const duration = { minutes: BOOKING_SLOT_MINUTES };
  const step = { minutes: SLOT_STEP_MINUTES };

  let cursor = freeWindow.start;

  const dayEnd = freeWindow.start
    .setZone(TZ) // Asegurar zona BC
    .set({ hour: WORK_END_HOUR, minute: 0, second: 0, millisecond: 0 });

  while (
    cursor.plus(duration) <= freeWindow.end &&
    cursor.plus(duration) <= dayEnd
  ) {
    const slotStart = cursor;
    const slotEnd = cursor.plus(duration);

    slots.push({ start: slotStart, end: slotEnd });

    cursor = cursor.plus(step);
  }

  return slots;
}

async function listEvents(calendar, calendarId, timeMinIso, timeMaxIso) {
  const r = await calendar.events.list({
    calendarId,
    timeMin: timeMinIso,
    timeMax: timeMaxIso,
    singleEvents: true,
    orderBy: "startTime",
    maxResults: 2500,
    fields:
      "items(id,summary,status,start,end,colorId,attendees(email),organizer(email),creator(email))",
  });

  const items = r.data.items || [];
  return items.filter((e) => e.status !== "cancelled");
}

function getEventEmails(e) {
  const emails = new Set();
  for (const a of e.attendees || []) {
    if (a?.email) emails.add(normalizeEmail(a.email));
  }
  if (e.organizer?.email) emails.add(normalizeEmail(e.organizer.email));
  if (e.creator?.email) emails.add(normalizeEmail(e.creator.email));
  return emails;
}

/**
 * Convierte una lista de eventos en un mapa de busy intervals por team y día.
 *
 * Dos pasadas:
 *
 *   1ª — Eventos con team conocido (#N) o block_both (keywords admin) se
 *        registran directamente. buffer en AMBOS extremos del evento.
 *
 *   2ª — Eventos unknown: se asigna al primer team que NO tenga solapamiento
 *        ya registrado en esa franja exacta (conocidos + unknowns previos).
 *        Si todos los teams ya están ocupados → bloquea todos.
 *
 * Garantía: nunca puede haber más eventos simultáneos que teams configurados.
 */
function buildBusyByDayByTeam(events) {
  const busyByDayByTeam = new Map();

  function addInterval(team, start, end, meta) {
    let cursorDay = start.setZone(TZ).startOf("day");
    const lastDay = end.setZone(TZ).startOf("day");

    while (cursorDay <= lastDay) {
      const dayKey = cursorDay.toISODate();
      const dayEnd = cursorDay.endOf("day");
      const clStart = DateTime.max(start, cursorDay);
      const clEnd = DateTime.min(end, dayEnd);

      if (clEnd > clStart) {
        const mapKey = `${team}|${dayKey}`;
        if (!busyByDayByTeam.has(mapKey)) busyByDayByTeam.set(mapKey, []);
        busyByDayByTeam
          .get(mapKey)
          .push({ start: clStart, end: clEnd, ...meta });
      }

      cursorDay = cursorDay.plus({ days: 1 });
    }
  }

  function intervalsOverlap(aStart, aEnd, bStart, bEnd) {
    return aStart < bEnd && bStart < aEnd;
  }

  // Chequea si `team` ya tiene algún intervalo registrado (conocido o
  // unknown ya asignado) que se solape con [start, end). Usado por la 2ª
  // pasada (unknown) para decidir a qué team asignar — ahí SÍ queremos
  // comparar contra el rango con buffer, porque un evento unknown no debe
  // caer en un team que ya tiene a alguien ocupado (ni siquiera "casi
  // pegado" sin margen de traslado).
  function teamHasOverlap(team, start, end) {
    let cursorDay = start.startOf("day");
    const lastDay = end.startOf("day");

    while (cursorDay <= lastDay) {
      const dayKey = cursorDay.toISODate();
      const intervals = busyByDayByTeam.get(`${team}|${dayKey}`) || [];
      if (
        intervals.some((iv) => intervalsOverlap(start, end, iv.start, iv.end))
      ) {
        return true;
      }
      cursorDay = cursorDay.plus({ days: 1 });
    }
    return false;
  }

  // rawByTeam: `${team}|${dayKey}` → intervals[] SIN buffer. Estructura
  // paralela a busyByDayByTeam (que sí tiene buffer), usada exclusivamente
  // para detectar conflictos reales de double-booking dentro de un mismo
  // team. Comparar tiempos reales contra tiempos reales evita el falso
  // positivo de comparar un rango sin buffer contra uno con buffer, que
  // disparaba "conflicto" entre eventos que en realidad solo coincidían
  // dentro del margen de traslado (BUFFER_MINUTES).
  const rawByTeam = new Map();

  function addRawInterval(team, rawStart, rawEnd, summary) {
    let cursorDay = rawStart.startOf("day");
    const lastDay = rawEnd.startOf("day");

    while (cursorDay <= lastDay) {
      const dayKey = cursorDay.toISODate();
      const dayEnd = cursorDay.endOf("day");
      const clStart = DateTime.max(rawStart, cursorDay);
      const clEnd = DateTime.min(rawEnd, dayEnd);

      if (clEnd > clStart) {
        const mapKey = `${team}|${dayKey}`;
        if (!rawByTeam.has(mapKey)) rawByTeam.set(mapKey, []);
        rawByTeam.get(mapKey).push({ start: clStart, end: clEnd, summary });
      }

      cursorDay = cursorDay.plus({ days: 1 });
    }
  }

  // Chequea conflicto REAL (sin buffer) dentro de un team: ¿ya hay un
  // evento real de este team que se solape en horario real con [rawStart,
  // rawEnd)? A diferencia de teamHasOverlap, esto ignora el buffer por
  // completo en ambos lados de la comparación. Devuelve el intervalo
  // conflictivo (con summary, para poder loguear cuál es el otro evento)
  // o null si no hay conflicto.
  function findTeamRawOverlap(team, rawStart, rawEnd) {
    let cursorDay = rawStart.startOf("day");
    const lastDay = rawEnd.startOf("day");

    while (cursorDay <= lastDay) {
      const dayKey = cursorDay.toISODate();
      const intervals = rawByTeam.get(`${team}|${dayKey}`) || [];
      const hit = intervals.find((iv) =>
        intervalsOverlap(rawStart, rawEnd, iv.start, iv.end),
      );
      if (hit) return hit;
      cursorDay = cursorDay.plus({ days: 1 });
    }
    return null;
  }

  // Pre-parsear todos los eventos una sola vez
  const parsed = [];
  for (const e of events) {
    const startStr = e.start?.dateTime || e.start?.date;
    const endStr = e.end?.dateTime || e.end?.date;
    if (!startStr || !endStr) continue;

    // Buffer en ambos extremos: protege el traslado antes de llegar a este
    // evento y después de salir de él. Antes solo se aplicaba "hacia adelante",
    // por lo que una reserva nueva podía terminar justo cuando empieza otro
    // evento ya existente en Calendar (caso "Carolyn Green" pegada al booking).
    const rawStart = DateTime.fromISO(startStr, { zone: TZ });
    const rawEnd = DateTime.fromISO(endStr, { zone: TZ });
    const start = rawStart.minus({ minutes: BUFFER_MINUTES });
    const end = rawEnd.plus({ minutes: BUFFER_MINUTES });
    const meta = { summary: e.summary || "", colorId: e.colorId || null };
    const { team, reason } = detectTeamFromEvent(e);

    parsed.push({ start, end, rawStart, rawEnd, meta, team, reason });
  }

  // 1ª pasada: eventos con team conocido o block_both ocupan su(s) team(s)
  // de inmediato, para que los unknown (2ª pasada) vean qué ya está ocupado.
  // "ignore" (lunch, no-servicio) se saltea por completo — no ocupa ningún
  // team, ni siquiera se registra para la 2ª pasada de unknown.
  for (const p of parsed) {
    if (p.team === "ignore") continue;
    // block_both ya no lo emite detectTeamFromEvent (LAB-XXX ago 2026) —
    // se deja este branch como red de seguridad por si algo lo reintroduce.
    if (p.team === "block_both") {
      for (const t of ALL_TEAM_IDS)
        addInterval(t, p.start, p.end, { ...p.meta, reason: p.reason });
    } else if (p.team !== null) {
      // ✅ FIX: comparar rango real (sin buffer) contra rangos reales ya
      // registrados (rawByTeam), no contra los rangos con buffer guardados
      // en busyByDayByTeam. Antes se usaba teamHasOverlap (que compara
      // contra intervalos CON buffer), lo que disparaba "conflicto real"
      // entre dos eventos del mismo team que solo coincidían dentro del
      // margen de traslado (BUFFER_MINUTES) y no en su horario real —
      // y al bloquear todos los teams, terminaba apagando la
      // disponibilidad de otros teams sin ningún conflicto propio.
      const conflict = findTeamRawOverlap(p.team, p.rawStart, p.rawEnd);
      if (conflict) {
        // Solapamiento real (sin buffer) — bloqueamos todos los teams.
        // Probable doble-booking: dos eventos del mismo team a la misma
        // hora. Lo señalamos explícitamente para que sea fácil detectarlo
        // sin tener que leer los busy intervals a mano.
        const overlapStart = DateTime.max(p.rawStart, conflict.start);
        const overlapEnd = DateTime.min(p.rawEnd, conflict.end);
        console.warn(
          `⚠️ [conflict] ${p.team} tiene 2+ eventos reales solapados: ` +
            `${(conflict.summary || "").trim()} / ${(p.meta.summary || "").trim()} ` +
            `(${overlapStart.toFormat("HH:mm")}-${overlapEnd.toFormat("HH:mm")})`,
        );
        for (const t of ALL_TEAM_IDS)
          addInterval(t, p.start, p.end, {
            ...p.meta,
            reason: `real-overlap-same-team→block_all`,
          });
      } else {
        addInterval(p.team, p.start, p.end, { ...p.meta, reason: p.reason });
      }
      // Registrar el rango real de este evento para que el PRÓXIMO evento
      // del mismo team se compare correctamente (raw vs raw).
      addRawInterval(p.team, p.rawStart, p.rawEnd, p.meta.summary);
    }
  }

  // 2ª pasada: eventos unknown — se asignan al primer team SIN solapamiento
  // ya registrado en su rango horario exacto (conocido o unknown previo).
  // Si todos los teams ya están ocupados en ese rango exacto → bloquea todos.
  for (const p of parsed) {
    if (p.team !== null) continue; // ya procesado en la 1ª pasada

    const assignedTeam = ALL_TEAM_IDS.find(
      (t) => !teamHasOverlap(t, p.start, p.end),
    );

    if (!assignedTeam) {
      for (const t of ALL_TEAM_IDS)
        addInterval(t, p.start, p.end, {
          ...p.meta,
          reason: "unknown:overflow→block_all",
        });
    } else {
      addInterval(assignedTeam, p.start, p.end, {
        ...p.meta,
        reason: `unknown:assigned→${assignedTeam}`,
      });
    }
  }

  return busyByDayByTeam;
}

/**
 * ✅ NUEVO: Valida si el team tiene disponibilidad real según Programaciones
 * Chequea que AL MENOS UN cleaner del team tenga un bloque DISPONIBLE ≥1.75h
 *
 * Fail-open strategy (para no quedarnos con 0 slots por fallas de data):
 *   - Si progData está vacío (Sheet no accesible)            → true
 *   - Si no hay ninguna fila para el día                     → true (Sheet no actualizado aún)
 *   - Si hay filas del día pero ninguna matchea teamCleaners → true (posible mismatch de nombres)
 *   - Si hay filas del team pero todas <1.75h                → false (sí bloqueamos; evidencia negativa)
 *
 * Cuando devolvemos `true` por un caso "sin evidencia", loggeamos el motivo la primera vez
 * para poder diagnosticar mismatches de formato sin spammear.
 */
const _progDiag = {
  loggedNoRowForDay: 0,
  loggedNoTeamMatch: 0,
  loggedInsufficient: 0,
};

async function hasTeamAvailabilityInProgramaciones(team, dayKey, progData) {
  if (!progData || progData.length === 0) return true; // fail-open: sheet no accesible

  const teamCleaners = getTeamCleaners(team);
  if (teamCleaners.length === 0) {
    if (_progDiag.loggedNoTeamMatch < 1) {
      console.warn(
        `⚠️ getTeamCleaners('${team}') vacío. Revisá TEAM_MEMBERS_JSON vs CLEANER_TO_EMAIL.`,
      );
      _progDiag.loggedNoTeamMatch++;
    }
    return true; // fail-open
  }

  // 1) Todas las filas del día (sin filtro de team)
  const rowsForDay = progData.filter((row) => row[0] === dayKey);
  if (rowsForDay.length === 0) {
    if (_progDiag.loggedNoRowForDay < 3) {
      console.log(
        `📋 Programaciones: sin filas para ${dayKey} → fail-open (${team})`,
      );
      _progDiag.loggedNoRowForDay++;
    }
    return true;
  }

  // 2) Filas del día que son de este team
  const rowsForDayAndTeam = rowsForDay.filter((row) =>
    teamCleaners.includes(row[1]),
  );
  if (rowsForDayAndTeam.length === 0) {
    if (_progDiag.loggedNoTeamMatch < 3) {
      console.warn(
        `⚠️ Programaciones ${dayKey}: hay ${rowsForDay.length} filas pero ninguna matchea ${team} (${teamCleaners.join(", ")}). ` +
          `Nombres en Sheet ese día:`,
        rowsForDay.map((r) => r[1]),
      );
      _progDiag.loggedNoTeamMatch++;
    }
    return true; // fail-open por probable mismatch de nombres
  }

  // 3) Al menos uno tiene ≥1.75h libre
  const anyAvailable = rowsForDayAndTeam.some(
    (row) => (parseFloat(row[4]) || 0) >= 1.75,
  );
  if (!anyAvailable && _progDiag.loggedInsufficient < 3) {
    console.log(
      `📋 Programaciones ${dayKey}/${team}: filas encontradas pero ninguna con ≥1.75h.`,
      rowsForDayAndTeam.map((r) => ({ cleaner: r[1], freeHours: r[4] })),
    );
    _progDiag.loggedInsufficient++;
  }

  return anyAvailable;
}

/**
 * Genera slots "available" (reservables) para cada team y los guarda en Supabase.
 */
export async function syncAvailabilityFromGoogle({ rangeDays = 30 } = {}) {
  const calendar = getCalendarClient();

  await loadTeamsFromDB();
  await loadOperationalConfigFromDB();
  const syncDate = DateTime.now().setZone(TZ).toISODate();
  await loadTeamMembersFromDB(syncDate);

  const teamCalendarIds = (process.env.TEAM_CALENDAR_IDS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (teamCalendarIds.length < 1)
    throw new Error("Missing TEAM_CALENDAR_IDS env");

  const calendarId = teamCalendarIds[0];

  const now = DateTime.now().setZone(TZ);
  const startRange = now.startOf("day");
  const endRange = now.plus({ days: rangeDays }).endOf("day");

  const timeMinIso = toIso(startRange);
  const timeMaxIso = toIso(endRange);

  // ✅ NUEVO: Obtener datos de Programaciones (Sheet)
  let progData = [];
  try {
    progData = await getProgramacionesData();
    console.log(`📋 Programaciones data: ${progData.length} rows`);
    if (progData.length > 0) {
      console.log("📋 Programaciones sample rows (first 3):");
      progData.slice(0, 3).forEach((row, i) => console.log(`   [${i}]`, row));
      for (const team of ALL_TEAM_IDS) {
        console.log(`📋 getTeamCleaners('${team}'):`, getTeamCleaners(team));
      }
    }
  } catch (err) {
    console.warn(
      "⚠️ No se pudo obtener Programaciones. Se usará solo Calendar:",
      err.message,
    );
  }
  // reset diagnostic counters en cada sync
  _progDiag.loggedNoRowForDay = 0;
  _progDiag.loggedNoTeamMatch = 0;
  _progDiag.loggedInsufficient = 0;

  // 1) Limpiar availability futura (solo available; no tocar booked).
  //    Usamos startRange (inicio del día actual) para poder rerun el sync el mismo día
  //    sin dejar duplicados a medio borrar (el sync regenera desde las 07:00, así que
  //    un delete "desde NOW" dejaría slots residuales del inicio del día).
  {
    const { error } = await supabase
      .from(CLEANING_AVAILABILITY_TABLE)
      .delete()
      .eq("status", "available")
      .gte("start_at", toIso(startRange));

    if (error) throw error;
  }

  // 2) Buscar eventos en Google Calendar
  const events = await listEvents(calendar, calendarId, timeMinIso, timeMaxIso);

  // ── Liberar slots cuyo evento GCal fue eliminado ──────────────────────────
  const activeGcalIds = new Set(events.map((e) => e.id));

  const { data: bookedWithEventId, error: fetchBookedErr } = await supabase
    .from(CLEANING_AVAILABILITY_TABLE)
    .select("id, google_event_id")
    .eq("status", "booked")
    .not("google_event_id", "is", null)
    .gte("start_at", toIso(startRange));

  if (fetchBookedErr) {
    console.error(
      "⚠️ Error fetching booked slots for orphan check:",
      fetchBookedErr.message,
    );
  } else {
    const toRelease = (bookedWithEventId ?? []).filter(
      (r) => !activeGcalIds.has(r.google_event_id),
    );

    if (toRelease.length) {
      const { error: releaseErr } = await supabase
        .from(CLEANING_AVAILABILITY_TABLE)
        .update({
          status: "available",
          google_event_id: null,
          booked_name: null,
          booked_phone: null,
          booked_email: null,
          booked_address: null,
          booked_at: null,
        })
        .in(
          "id",
          toRelease.map((r) => r.id),
        );

      if (releaseErr)
        console.error(
          "❌ Error liberando slots huérfanos:",
          releaseErr.message,
        );
      else
        console.log(
          `♻️ Liberados ${toRelease.length} slots huérfanos (evento eliminado de GCal)`,
        );
    } else {
      console.log("✅ No hay slots huérfanos para liberar");
    }
  }

  // Debug distribución de eventos por team
  const dist = Object.fromEntries(
    [...ALL_TEAM_IDS, "block_both", "unknown", "ignore"].map((k) => [k, 0]),
  );
  const reasonDist = {};
  const colorDist = {};
  const unknownSamples = [];

  for (const e of events) {
    const { team, reason } = detectTeamFromEvent(e);

    if (team && dist[team] !== undefined) dist[team]++;
    else if (team === null) {
      dist.unknown++;
      if (unknownSamples.length < 10) {
        unknownSamples.push({
          summary: e.summary,
          start: e.start?.dateTime || e.start?.date,
          colorId: e.colorId || null,
        });
      }
    }

    reasonDist[reason] = (reasonDist[reason] || 0) + 1;
    const colorKey = e.colorId || "none";
    colorDist[colorKey] = (colorDist[colorKey] || 0) + 1;
  }

  console.log("📊 Event distribution:", dist);
  console.log("📊 Classification reasons:", reasonDist);
  console.log("🎨 ColorId distribution:", colorDist);
  console.log("⚙️ TEAMS_CONFIG in use:", TEAMS_CONFIG);
  if (unknownSamples.length)
    console.log("🟡 Sample UNKNOWN events:", unknownSamples);

  // 3) Construir mapa de busy intervals por team/día
  const busyByDayByTeam = buildBusyByDayByTeam(events);

  // 4) Generar slots reservables por día/team
  let day = startRange.setZone(TZ);
  const rowsToInsert = [];

  const teamDayStats = Object.fromEntries(
    ALL_TEAM_IDS.map((t) => [
      t,
      { passedProg: 0, skippedProg: 0, noFreeWindows: 0, slotsGenerated: 0 },
    ]),
  );

  while (day <= endRange) {
    if (day.weekday === 7) {
      // domingo
      day = day.plus({ days: 1 });
      continue;
    }

    const dayKey = day.toISODate();

    for (const team of ALL_TEAM_IDS) {
      // ✅ VALIDAR: chequear si el team tiene disponibilidad real en Programaciones
      const hasAvailability = await hasTeamAvailabilityInProgramaciones(
        team,
        dayKey,
        progData,
      );

      if (!hasAvailability) {
        teamDayStats[team].skippedProg++;
        continue;
      }
      teamDayStats[team].passedProg++;

      const busy = busyByDayByTeam.get(`${team}|${dayKey}`) || [];
      const freeWindows = computeFreeWindowsForDay(day, busy);

      if (freeWindows.length === 0) teamDayStats[team].noFreeWindows++;

      for (const w of freeWindows) {
        for (const slot of windowToBookableSlots(w)) {
          teamDayStats[team].slotsGenerated++;
          rowsToInsert.push({
            team,
            start_at: toIso(slot.start),
            end_at: toIso(slot.end),
            status: "available",
          });
        }
      }
    }

    day = day.plus({ days: 1 });
  }

  console.log("📊 Team/day stats:", teamDayStats);

  // 5a) Dedupe interno
  const seenKeys = new Set();
  const deduped = [];
  const internalDupSamples = [];
  for (const r of rowsToInsert) {
    const key = `${r.team}|${r.start_at}|${r.end_at}`;
    if (seenKeys.has(key)) {
      if (internalDupSamples.length < 5) internalDupSamples.push(r);
      continue;
    }
    seenKeys.add(key);
    deduped.push(r);
  }
  const internalDups = rowsToInsert.length - deduped.length;
  if (internalDups > 0) {
    console.warn(
      `⚠️ Dedupe interno: ${internalDups} duplicados dentro de rowsToInsert (bug de generación). ` +
        `Muestra:`,
      internalDupSamples,
    );
  }

  // 5b) Excluir conflictos con filas existentes (booked/completed/cancelled)
  let rowsToInsertFinal = deduped;
  let droppedByExisting = 0;
  let existingRowsCount = 0;

  if (deduped.length) {
    const { data: existingRows, error: existingErr } = await supabase
      .from(CLEANING_AVAILABILITY_TABLE)
      .select("team, start_at, end_at, status")
      .neq("status", "available")
      .gte("start_at", toIso(startRange))
      .lte("start_at", toIso(endRange));

    if (existingErr) throw existingErr;
    existingRowsCount = existingRows?.length || 0;

    if (existingRowsCount > 0) {
      const existingSet = new Set(
        existingRows.map((r) => `${r.team}|${r.start_at}|${r.end_at}`),
      );
      rowsToInsertFinal = deduped.filter(
        (r) => !existingSet.has(`${r.team}|${r.start_at}|${r.end_at}`),
      );
      droppedByExisting = deduped.length - rowsToInsertFinal.length;
      if (droppedByExisting > 0) {
        console.log(
          `⏭️ Excluidos ${droppedByExisting} slots que conflictan con ${existingRowsCount} filas ` +
            `con status != 'available'.`,
        );
      }
    }
  }

  // 6) Upsert con ignoreDuplicates como safety net
  if (rowsToInsertFinal.length) {
    const { error } = await supabase
      .from(CLEANING_AVAILABILITY_TABLE)
      .upsert(rowsToInsertFinal, {
        onConflict: "team,start_at,end_at",
        ignoreDuplicates: true,
      });
    if (error) throw error;
  }

  console.log(
    `✅ Sync completado. Insertados ${rowsToInsertFinal.length} slots reservables ` +
      `(generados=${rowsToInsert.length}, dedup_internos=${internalDups}, ` +
      `excluidos_por_existentes=${droppedByExisting}, existentes_neq_available=${existingRowsCount}, ` +
      `dur=${BOOKING_SLOT_MINUTES}m step=${SLOT_STEP_MINUTES}m buffer=${BUFFER_MINUTES}m).`,
  );

  return {
    ok: true,
    inserted: rowsToInsertFinal.length,
    generated: rowsToInsert.length,
    internalDups,
    droppedByExisting,
  };
}