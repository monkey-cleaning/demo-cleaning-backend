import { DateTime } from "luxon";
import { TZ } from "../config/timezone.js";

// ─── CONFIG ─────────────────────────────────────────────────────────
const CONFIG = {
  HOURLY_RATE: 45,
  HOURLY_RATE_MOVE_IN_OUT: 50,
  TEAM_SIZE:   2,
  MIN_HOURS:   3,
  // Feriado estatutario de BC: 1.5x. Solo lo usa payrollLaborRulesService (pago de
  // feriados al cleaner); el quote y la facturación de Demo no recargan feriados.
  HOLIDAY_MULTIPLIER: 1.5,
  extras: {
    fridge:  0.5,
    freezer: 0.25,
    oven:    0.25,
  },
};

// Reexportadas para el módulo de payroll: recalcular cuánto se le cobró al
// cliente por un evento YA ocurrido con las mismas tarifas del quote.
export const HOURLY_RATE = CONFIG.HOURLY_RATE;
export const HOURLY_RATE_MOVE_IN_OUT = CONFIG.HOURLY_RATE_MOVE_IN_OUT;
export const HOLIDAY_MULTIPLIER = CONFIG.HOLIDAY_MULTIPLIER;

// ─── parsers para los strings del frontend ──────────────────────────
function parseBedrooms(v) {
  const s = String(v || '').toLowerCase();
  if (s.includes('studio'))  return 0;
  if (s.includes('one'))     return 1;
  if (s.includes('two'))     return 2;
  if (s.includes('three'))   return 3;
  if (s.includes('four'))    return 4;
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function parseFullBaths(v) {
  const s = String(v || '');
  // "2 Bathrooms", "4+ Bathrooms", etc.
  const match = s.match(/^(\d+)\+?/);
  if (match) return parseInt(match[1], 10);
  const n = parseInt(s, 10);
  return Number.isFinite(n) ? n : 1;
}

function parseHalfBaths(v) {
  const s = String(v || '');
  // "0 Half Bathrooms", "2 Half Bathrooms", "3+ Half Bathrooms"
  const match = s.match(/^(\d+)\+?/);
  if (match) return parseInt(match[1], 10);
  const n = parseInt(s, 10);
  return Number.isFinite(n) ? n : 0;
}

function parsePropertySize(v) {
  const s = String(v || '');
  // "1000 - 1499 Sq Ft" → "1000 - 1499"
  // "2000 - 2499 Sq Ft" o "2500+ Sq Ft" → empieza con "2000" o "2500"
  if (s.startsWith('2000') || s.startsWith('2500')) return '2000+';
  // Para el bonus area solo nos importa si es 2000+, el resto no suma
  return s; // guardamos el string para el check de is2000 abajo
}

// ─── helpers ────────────────────────────────────────────────────────
function yes(v) {
  return String(v || '').trim().toLowerCase() === 'yes';
}

function roundToHalf(n) {
  return Math.round(n * 2) / 2;
}

function roundToCents(n) {
  return Math.round(n * 100) / 100;
}

function formatPerPerson(hrsPerPerson) {
  const whole = Math.floor(hrsPerPerson);
  const mins  = Math.round((hrsPerPerson % 1) * 60);
  if (mins === 0) return `${whole}h each`;
  return `${whole}h ${mins}min each`;
}

// ─── Calc Type ───────────────────────────────────────────────────────
function calcType(lead) {
  const freq = String(lead.cleaningFrequency || lead.frequency || '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();

  const isMove =
    freq.includes('move in') ||
    freq.includes('move out') ||
    freq.includes('move-in') ||
    freq.includes('move-out') ||
    freq === 'move in/out';

  return isMove ? 'Move In/Out' : 'Standard';
}

// ─── Raw Hours ───────────────────────────────────────────────────────
function rawHours(lead, type) {
  const beds = parseBedrooms(lead.bedrooms);
  const full = parseFullBaths(lead.fullBaths ?? lead.fullBathrooms);
  const half = parseHalfBaths(lead.halfBaths ?? lead.halfBathrooms);
  const size = parsePropertySize(lead.areaSqFt ?? lead.propertySize ?? '');
  const is2000    = size === '2000+';
  const areaBonus = (is2000 && beds <= 2) ? 0.5 : 0;

  if (type === 'Move In/Out') {
    return 4 + beds + full + half * 0.5;
  }

  const base = 2 + beds + full + half * 0.5
    + (yes(lead.fridge   ?? lead.insideFridge)   ? CONFIG.extras.fridge  : 0)
    + (yes(lead.freezer  ?? lead.insideFreezer)  ? CONFIG.extras.freezer : 0)
    + (yes(lead.oven     ?? lead.insideOven)     ? CONFIG.extras.oven    : 0)
    + areaBonus;

  return Math.max(CONFIG.MIN_HOURS, base);
}

// ─── Feriados estatutarios de British Columbia ─────────────────────────
// Los 10 feriados generales de BC (Employment Standards Act) — algunos son
// fecha fija, otros "el N-ésimo lunes del mes", y Good Friday depende de
// Pascua. No hay corrimiento "in-lieu" a otro día: lo que importa acá es si
// el cliente eligió reservar justo ESE día del calendario, no si la oficina
// lo observa otro día.
function nthWeekdayOfMonth(year, month, weekday, n) {
  // weekday: 1=lunes … 7=domingo (convención de Luxon).
  let d = DateTime.fromObject({ year, month, day: 1 }, { zone: TZ });
  let offset = weekday - d.weekday;
  if (offset < 0) offset += 7;
  return d.plus({ days: offset + (n - 1) * 7 });
}

// Domingo de Pascua (calendario gregoriano) — algoritmo de Meeus/Jones/Butcher.
function easterSunday(year) {
  const a = year % 19;
  const b = Math.floor(year / 100);
  const c = year % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return DateTime.fromObject({ year, month, day }, { zone: TZ });
}

// Función pura — devuelve el nombre del feriado si `dateIso` (YYYY-MM-DD) cae
// en uno de BC, o null. Se recalcula cada vez (nada hardcodeado por año).
export function bcStatutoryHoliday(dateIso) {
  const date = DateTime.fromISO(dateIso, { zone: TZ });
  if (!date.isValid) return null;
  const year = date.year;
  const iso = date.toISODate();

  const fixed = {
    [`${year}-01-01`]: "New Year's Day",
    [`${year}-07-01`]: "Canada Day",
    [`${year}-09-30`]: "National Day for Truth and Reconciliation",
    [`${year}-11-11`]: "Remembrance Day",
    [`${year}-12-25`]: "Christmas Day",
  };
  if (fixed[iso]) return fixed[iso];

  if (iso === easterSunday(year).minus({ days: 2 }).toISODate()) return "Good Friday";
  if (iso === nthWeekdayOfMonth(year, 2, 1, 3).toISODate()) return "Family Day";
  // Victoria Day: el lunes ANTERIOR al 25 de mayo — si el 25 es lunes, es el
  // lunes previo (ej. 2020: el 25/5 cayó lunes y Victoria Day fue el 18/5).
  const may25 = DateTime.fromObject({ year, month: 5, day: 25 }, { zone: TZ });
  const victoriaDay = may25.minus({ days: may25.weekday === 1 ? 7 : may25.weekday - 1 });
  if (iso === victoriaDay.toISODate()) return "Victoria Day";
  if (iso === nthWeekdayOfMonth(year, 8, 1, 1).toISODate()) return "BC Day";
  if (iso === nthWeekdayOfMonth(year, 9, 1, 1).toISODate()) return "Labour Day";
  if (iso === nthWeekdayOfMonth(year, 10, 1, 2).toISODate()) return "Thanksgiving";

  return null;
}

// ─── Función principal ───────────────────────────────────────────────
export function calculateQuote(lead) {
  const type          = calcType(lead);
  const rawHrs        = rawHours(lead, type);
  const roundedHrs    = roundToHalf(rawHrs);
  const adjustmentHrs = Number(lead.adjustmentHrs) || 0;
  const totalHrs      = roundToHalf(roundedHrs + adjustmentHrs);
  const hourlyRate    = type === 'Move In/Out'
    ? CONFIG.HOURLY_RATE_MOVE_IN_OUT
    : CONFIG.HOURLY_RATE;
  const hrsPerPerson  = totalHrs / CONFIG.TEAM_SIZE;
  const perPersonText = formatPerPerson(hrsPerPerson);
  const totalAmount   = roundToCents(totalHrs * hourlyRate);

  return {
    calcType:      type,
    rawHrs,
    roundedHrs,
    adjustmentHrs,
    totalHrs,
    hourlyRate,
    hrsPerPerson,
    perPersonText,
    totalAmount,
  };
}
