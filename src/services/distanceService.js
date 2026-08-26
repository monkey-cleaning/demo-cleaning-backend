// services/distanceService.js
//
// LAB275: estimación de tiempo de traslado real entre dos direcciones,
// usada por getAvailableStaff() (calendarController.js) para reemplazar la
// ventana fija service_buffer_minutes por una validación basada en distancia.
//
// No-fatal por diseño: cualquier falla (sin API key, geocode sin resultado,
// error/timeout de ORS) resuelve a `null`. El caller SIEMPRE debe interpretar
// `null` como "no pude calcular, aplicá la regla fija" (criterio 6 del ticket).
// Esta función nunca tira.

const ORS_API_KEY = process.env.ORS_API_KEY || "";
const ORS_GEOCODE_URL = "https://api.openrouteservice.org/geocode/search";
const ORS_MATRIX_URL = "https://api.openrouteservice.org/v2/matrix/driving-car";

const FETCH_TIMEOUT_MS = 4000; // nunca bloquear la respuesta del assign-modal

// Geocode cache: address string -> [lon, lat], sin TTL (una dirección no se mueve).
const geocodeCache = new Map();

// Travel-time cache: "lon,lat|lon,lat" -> minutos, TTL 7 días. ORS usa routing
// estático sobre OSM (sin tráfico en vivo), así que un valor de días no pierde
// precisión relevante para este uso — evita pegarle a la API en cada request.
const TRAVEL_CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const travelCache = new Map();

function withTimeout(promise, ms) {
  return Promise.race([
    promise,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error("ORS timeout")), ms),
    ),
  ]);
}

const VICTORIA_FOCUS = { lat: 48.4284, lon: -123.3656 };
const MIN_GEOCODE_CONFIDENCE = 0.5;

// Layers de Pelias que representan una ubicación lo bastante precisa como
// para calcular traslado real. "locality"/"localadmin"/"region"/"country"
// son fallbacks a nivel ciudad/región — inútiles acá y peor que no tener dato,
// porque devuelven un "0min" que parece válido sin serlo.
const VALID_GEOCODE_LAYERS = new Set(["address", "street", "venue"]);

// LAB275: el campo `property_address` viene de gcalEvent.location, tipeado a
// mano por los admins — el nombre de ciudad puede estar mal (ej. direcciones
// reales de Saanich guardadas como "..., Victoria, BC ...") mientras que la
// calle y el código postal sí son confiables. Pelias falla en matchear
// calle-real + ciudad-equivocada y cae al centroide de la ciudad (locality),
// devolviendo 0min falsos. Solución: sacar el segmento de ciudad del texto
// de búsqueda y dejar que focus.point + boundary.country desambigüen.
function stripUnreliableCity(rawAddress) {
  const parts = rawAddress
    .split(",")
    .map((p) => p.trim())
    .filter(Boolean);
  // Sin al menos 3 segmentos no hay ciudad separable para sacar (ej. "1036
  // Hampshire Road" o "581 baxter ave") — se manda tal cual.
  if (parts.length <= 2) return rawAddress;
  const [street, , ...rest] = parts; // parts[1] = ciudad, se descarta
  return [street, ...rest].join(", ");
}

async function geocode(address) {
  const key = address.trim().toLowerCase();
  if (geocodeCache.has(key)) return geocodeCache.get(key);

  const searchText = stripUnreliableCity(address);
  const url =
    `${ORS_GEOCODE_URL}?api_key=${ORS_API_KEY}` +
    `&text=${encodeURIComponent(searchText)}&size=1&boundary.country=CA` +
    `&focus.point.lat=${VICTORIA_FOCUS.lat}&focus.point.lon=${VICTORIA_FOCUS.lon}`;

  const resp = await withTimeout(fetch(url), FETCH_TIMEOUT_MS);
  if (!resp.ok) throw new Error(`ORS geocode ${resp.status}`);

  const data = await resp.json();
  const feature = data?.features?.[0];
  const coords = feature?.geometry?.coordinates; // [lon, lat]
  if (!coords) throw new Error(`ORS geocode: sin resultado para "${address}"`);

  const confidence = feature?.properties?.confidence ?? 0;
  const layer = feature?.properties?.layer ?? "unknown";
  const label = feature?.properties?.label ?? "";

  // LAB275: un match de baja confianza (ej. cayó a nivel "locality" porque
  // no encontró la calle) es peor que no tener dato — devolvería un travel
  // time falso en vez de caer al fallback. Lo tratamos como fallo explícito.
  if (confidence < MIN_GEOCODE_CONFIDENCE || !VALID_GEOCODE_LAYERS.has(layer)) {
    throw new Error(
      `match no confiable (confidence=${confidence}, layer=${layer}) para "${address}" → "${label}"`,
    );
  }

  console.log(
    `[distanceService] geocode "${address}" → "${label}" (confidence=${confidence}, layer=${layer})`,
  );

  geocodeCache.set(key, coords);
  return coords;
}

/**
 * Devuelve el tiempo de traslado estimado en auto (minutos, redondeado hacia
 * arriba) entre dos direcciones, o `null` si no se pudo calcular. Nunca tira.
 */
export async function getTravelTimeMinutes(addressA, addressB) {
  if (!ORS_API_KEY) {
    console.warn(
      "⚠️ [distanceService] ORS_API_KEY no configurada — fallback a regla fija.",
    );
    return null;
  }
  if (!addressA?.trim() || !addressB?.trim()) return null;

  try {
    const [coordsA, coordsB] = await Promise.all([
      geocode(addressA),
      geocode(addressB),
    ]);

    const cacheKey = `${coordsA.join(",")}|${coordsB.join(",")}`;
    const cached = travelCache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) return cached.minutes;

    const resp = await withTimeout(
      fetch(ORS_MATRIX_URL, {
        method: "POST",
        headers: {
          Authorization: ORS_API_KEY,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          locations: [coordsA, coordsB],
          metrics: ["duration"],
        }),
      }),
      FETCH_TIMEOUT_MS,
    );
    if (!resp.ok) throw new Error(`ORS matrix ${resp.status}`);

    const data = await resp.json();
    const seconds = data?.durations?.[0]?.[1];
    if (typeof seconds !== "number")
      throw new Error("ORS matrix: respuesta sin duración");

    const minutes = Math.ceil(seconds / 60);
    travelCache.set(cacheKey, {
      minutes,
      expiresAt: Date.now() + TRAVEL_CACHE_TTL_MS,
    });

    console.log(
      `[distanceService] "${addressA}" → "${addressB}": ${minutes}min`,
    );
    return minutes;
  } catch (e) {
    console.warn(
      `⚠️ [distanceService] Fallo calculando distancia (fallback a regla fija): ${e.message}`,
    );
    return null;
  }
}
