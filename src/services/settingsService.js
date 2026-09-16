import { DateTime } from "luxon";
import { supabase } from "../supabaseClient.js";

// ─────────────────────────────────────────────────────────────────────────────
// Shared settings reader.
//
// Centraliza la lectura de la tabla `settings` (con defaults y cache en
// memoria) para que calendarController.js, availabilityController.js y
// calendarAvailabilitySync.js no dupliquen la misma lógica de "leer settings
// con fallback" cada uno por su lado.
//
// Uso típico:
//   import { getWorkWindow, getOperationalSettings } from "./settingsService.js";
//   const { workStartHour, workEndHour } = await getWorkWindow();
// ─────────────────────────────────────────────────────────────────────────────

const DEFAULTS = {
  inactivity_risk_days: "21",
  inactivity_inactive_days: "30",
  exclude_adhoc_clients: "false",
  team_default_size: "2",
  service_buffer_minutes: "30",
  max_simultaneous_teams: "2",
  keep_stable_pair: "false",
  work_start_hour: "7",
  work_end_hour: "19",
  // Ticket "Confirmación automática de servicios pendientes (CONFIRMAR)" —
  // sin estas 4 keys acá, getRawSettings() nunca las trae de la tabla (el
  // query de abajo filtra por Object.keys(DEFAULTS)), y los jobs terminan
  // usando siempre su fallback hardcodeado (`settings.x ?? "2"`) sin
  // importar lo que diga `settings` en Supabase.
  confirmation_reminder_days_before: "2",
  confirmation_release_hours_before: "24",
  confirmation_pairing_grace_minutes: "60",
  ops_alert_email: "",
  // LAB275: colchón agregado sobre el tiempo de traslado real calculado por
  // distanceService, y kill-switch para volver a la regla fija sin redeploy
  // si ORS empieza a fallar o a devolver basura.
  travel_time_buffer_minutes: "10",
  distance_validation_enabled: "true",
  // LAB413 (encuesta de satisfacción): URL de Google Reviews que se le muestra
  // a un cliente que puntuó 5/5. Fallback a la env GOOGLE_REVIEW_URL.
  google_review_url: "",
  // LAB427 — bloqueo temporal de reservas web de corto plazo cuando no hay
  // disponibilidad de personal. Cantidad de semanas (contando la actual) que
  // quedan cerradas a reserva: "2" = esta semana y la próxima. "0" = sin
  // bloqueo (default). Ventana rodante anclada al lunes de la semana actual
  // (ver getBookingBlackout); para revertir, volver a "0" desde AdminSettings.
  booking_blackout_weeks: "0",
  // Contacto/redes sociales públicos del sitio — Footer, /contact-us y el CTA
  // de WhatsApp los leen vía GET /api/public/site-settings (sin auth), y se
  // editan desde AdminSettings → "Contact & Social Links". contact_phone es
  // texto libre (se muestra tal cual); whatsapp_number es solo dígitos con
  // código de país (se usa para armar el link wa.me/<número>). Las URLs de
  // redes sociales pueden quedar vacías para ocultar ese ícono en el sitio.
  contact_phone: "1 (604) 555-0142",
  contact_email: "contact@democleaning.co",
  contact_address: "123 Main St, Victoria, BC V9A 0H7, Canada",
  whatsapp_number: "16045550142",
  social_instagram_url: "",
  social_facebook_url: "",
};

// Cache corta en memoria: evita pegarle a Supabase en cada request (ej. cada
// booking, cada carga del calendario admin). 30s es suficiente para que un
// cambio en el AdminDashboard se refleje casi de inmediato, y de todas
// formas invalidateSettingsCache() la limpia apenas se guarda un cambio.
const CACHE_TTL_MS = 30_000;
let cache = { data: null, expiresAt: 0 };

function parseIntSafe(v, fallback) {
  const n = parseInt(v, 10);
  return Number.isInteger(n) ? n : fallback;
}

/**
 * Devuelve el mapa completo de settings (key → raw string value), con
 * defaults aplicados para cualquier key faltante en la tabla.
 * Cachea el resultado por CACHE_TTL_MS.
 */
export async function getRawSettings({ forceRefresh = false } = {}) {
  const now = Date.now();
  if (!forceRefresh && cache.data && cache.expiresAt > now) {
    return cache.data;
  }

  const { data, error } = await supabase
    .from("settings")
    .select("key, value")
    .in("key", Object.keys(DEFAULTS));

  if (error) {
    console.warn(
      "⚠️ [settingsService] No se pudo leer settings, usando defaults/cache previa:",
      error.message,
    );
    // Fail-open: si había cache vieja la reusamos antes de caer 100% a defaults.
    return cache.data ?? { ...DEFAULTS };
  }

  const map = Object.fromEntries((data ?? []).map((r) => [r.key, r.value]));
  const merged = { ...DEFAULTS, ...map };

  cache = { data: merged, expiresAt: now + CACHE_TTL_MS };
  return merged;
}

/**
 * Invalida la cache en memoria. Debe llamarse justo después de un PATCH
 * exitoso en /api/admin/settings, para que el próximo request (booking,
 * sync, assign modal) ya vea el valor nuevo sin esperar el TTL.
 */
export function invalidateSettingsCache() {
  cache = { data: null, expiresAt: 0 };
}

// ── Helpers tipados ──────────────────────────────────────────────────────

/**
 * Ventana laboral (work_start_hour / work_end_hour). Valida que ambos sean
 * enteros 0-23 y que start < end; si no, devuelve los defaults (7-19) y
 * loggea un warning — así un valor corrupto en la tabla nunca rompe el sync
 * ni las rutas de disponibilidad.
 */
export async function getWorkWindow() {
  const s = await getRawSettings();
  const start = parseIntSafe(s.work_start_hour, 7);
  const end = parseIntSafe(s.work_end_hour, 19);

  const isValid =
    Number.isInteger(start) &&
    Number.isInteger(end) &&
    start >= 0 &&
    start <= 23 &&
    end >= 0 &&
    end <= 23 &&
    start < end;

  if (isValid) {
    return { workStartHour: start, workEndHour: end };
  }

  console.warn(
    `⚠️ [settingsService] Ventana laboral inválida en settings (start=${s.work_start_hour}, end=${s.work_end_hour}). Usando defaults 7-19.`,
  );
  return { workStartHour: 7, workEndHour: 19 };
}

/**
 * Parámetros operativos usados por el assignment modal y por el cálculo de
 * disponibilidad/booking: buffer entre servicios, máximo de teams
 * simultáneos, y si se prioriza mantener el mismo par de cleaners en el día.
 */
export async function getOperationalSettings() {
  const s = await getRawSettings();
  return {
    serviceBufferMinutes: parseIntSafe(s.service_buffer_minutes, 30),
    maxSimultaneousTeams: parseIntSafe(s.max_simultaneous_teams, 2),
    keepStablePair: s.keep_stable_pair === "true",
    travelTimeBufferMinutes: parseIntSafe(s.travel_time_buffer_minutes, 10),
    distanceValidationEnabled: s.distance_validation_enabled !== "false",
  };
}

/**
 * URL de Google Reviews para el funnel de la encuesta de satisfacción (LAB413).
 * Prioridad: setting `google_review_url` → env `GOOGLE_REVIEW_URL` → "".
 */
export async function getGoogleReviewUrl() {
  const s = await getRawSettings();
  const fromSetting = String(s.google_review_url || "").trim();
  return fromSetting || String(process.env.GOOGLE_REVIEW_URL || "").trim();
}

/**
 * LAB427 — bloqueo temporal de reservas web de corto plazo.
 *
 * `booking_blackout_weeks` = cuántas semanas (contando la actual) quedan
 * cerradas a reserva. "2" cierra esta semana y la próxima; "0" (default)
 * no bloquea nada. La ventana es rodante: se ancla al lunes de la semana
 * actual (zona BOOKING_TIMEZONE) y se corre sola con el calendario, así que
 * no hay una fecha de vencimiento — para levantar el bloqueo hay que volver
 * a poner "0" en AdminSettings.
 *
 * Devuelve:
 *   { active, weeks, earliestBookingIso, earliestBookingDate }
 * donde `earliestBookingIso` es el instante UTC (ISO) a partir del cual se
 * puede reservar, y `earliestBookingDate` la fecha local "YYYY-MM-DD" para
 * mostrarle al cliente. Con `active:false` ambos son null.
 */
export async function getBookingBlackout() {
  const s = await getRawSettings();
  const weeks = parseIntSafe(s.booking_blackout_weeks, 0);

  if (!Number.isInteger(weeks) || weeks < 1) {
    return {
      active: false,
      weeks: 0,
      earliestBookingIso: null,
      earliestBookingDate: null,
    };
  }

  const tz = process.env.BOOKING_TIMEZONE || "America/Vancouver";
  const earliest = DateTime.now()
    .setZone(tz)
    .startOf("week") // lunes (ISO) de la semana actual
    .plus({ weeks })
    .startOf("day");

  return {
    active: true,
    weeks,
    earliestBookingIso: earliest.toUTC().toISO(),
    earliestBookingDate: earliest.toISODate(),
  };
}

/**
 * Contacto y redes sociales públicos del sitio (Footer, /contact-us, CTA de
 * WhatsApp). Consumido por GET /api/public/site-settings — nunca expone el
 * resto de `settings` (parámetros operativos internos).
 */
export async function getPublicSiteSettings() {
  const s = await getRawSettings();
  return {
    contact_phone: s.contact_phone,
    contact_email: s.contact_email,
    contact_address: s.contact_address,
    whatsapp_number: s.whatsapp_number,
    social_instagram_url: s.social_instagram_url,
    social_facebook_url: s.social_facebook_url,
  };
}

/**
 * Umbrales de inactividad de clientes, usados por el módulo de reportes /
 * dashboard de clientes.
 */
export async function getInactivityThresholds() {
  const s = await getRawSettings();
  return {
    riskDays: parseIntSafe(s.inactivity_risk_days, 21),
    inactiveDays: parseIntSafe(s.inactivity_inactive_days, 30),
    excludeAdhocClients: s.exclude_adhoc_clients === "true",
  };
}