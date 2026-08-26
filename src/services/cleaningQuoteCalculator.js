// ─── CONFIG ─────────────────────────────────────────────────────────
const CONFIG = {
  HOURLY_RATE: 45,
  HOURLY_RATE_MOVE_IN_OUT: 50,
  TEAM_SIZE:   2,
  MIN_HOURS:   3,
  extras: {
    fridge:  0.5,
    freezer: 0.25,
    oven:    0.25,
  },
};

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
