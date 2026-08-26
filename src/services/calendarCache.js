// services/calendarCache.js
//
// In-memory cache layer for Google Calendar events.
// Eliminates redundant GCal API calls and supports:
//   - TTL-based expiry per month bucket
//   - Incremental sync (nextSyncToken per calendar window)
//   - Manual invalidation after writes (create/update/delete)
//
// Shape of each cache entry:
//   {
//     events:        MappedEvent[],   ← mapped frontend shape
//     fetchedAt:     number,          ← Date.now() at fill time
//     nextSyncToken: string | null,   ← GCal incremental-sync token
//   }
//
// Cache keys are ISO year-month strings: "2026-05", "2026-06", etc.
// This lets the prefetcher warm adjacent months independently.

const CACHE_TTL_MS = (parseInt(process.env.GCAL_CACHE_TTL_MINUTES, 10) || 10) * 60 * 1000;

/** @type {Map<string, { events: object[], fetchedAt: number, nextSyncToken: string|null }>} */
const store = new Map();

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Build a canonical cache key from a year-month pair.
 * @param {number|string} year
 * @param {number|string} month  1-based
 */
export function cacheKey(year, month) {
  return `${year}-${String(month).padStart(2, "0")}`;
}

/**
 * Return cached entry if it exists and has not expired.
 * @param {string} key
 * @returns {{ events: object[], fetchedAt: number, nextSyncToken: string|null } | null}
 */
export function getFromCache(key) {
  const entry = store.get(key);
  if (!entry) return null;
  if (Date.now() - entry.fetchedAt > CACHE_TTL_MS) {
    store.delete(key);
    return null;
  }
  return entry;
}

/**
 * Write (or overwrite) an entry into the cache.
 * @param {string}        key
 * @param {object[]}      events          Mapped events array
 * @param {string|null}   nextSyncToken   Token returned by GCal for future incremental syncs
 */
export function setInCache(key, events, nextSyncToken = null) {
  store.set(key, {
    events,
    fetchedAt: Date.now(),
    nextSyncToken,
  });
}

/**
 * Retrieve the stored nextSyncToken for a cache key (even if the events TTL
 * has expired). Used by incremental sync to avoid a full re-fetch.
 * @param {string} key
 * @returns {string|null}
 */
export function getSyncToken(key) {
  return store.get(key)?.nextSyncToken ?? null;
}

/**
 * Merge incremental changes returned by GCal events.list (syncToken request)
 * into an existing cache entry, then refresh its TTL.
 *
 * GCal incremental responses include:
 *   - New events       → add to cache
 *   - Updated events   → replace in cache (matched by id)
 *   - Cancelled events → remove from cache (status === "cancelled")
 *
 * @param {string}      key
 * @param {object[]}    changedRawEvents   Raw GCal items from the incremental response
 * @param {Function}    mapEvent           The shared mapEvent() function from the controller
 * @param {string|null} newSyncToken       The updated nextSyncToken from GCal
 */
export function applyIncrementalUpdate(key, changedRawEvents, mapEvent, newSyncToken) {
  const existing = store.get(key);
  const baseEvents = existing?.events ?? [];

  // Index existing events by id for O(1) lookups
  const eventMap = new Map(baseEvents.map(e => [e.id, e]));

  for (const raw of changedRawEvents) {
    if (raw.status === "cancelled") {
      eventMap.delete(raw.id);
    } else {
      eventMap.set(raw.id, mapEvent(raw));
    }
  }

  // Re-sort by startIso after merge
  const merged = Array.from(eventMap.values()).sort((a, b) =>
    a.startIso < b.startIso ? -1 : a.startIso > b.startIso ? 1 : 0
  );

  store.set(key, {
    events:        merged,
    fetchedAt:     Date.now(),
    nextSyncToken: newSyncToken ?? existing?.nextSyncToken ?? null,
  });
}

/**
 * Invalidate one or more cache keys.
 * Call this after every write (create / update / delete) so the next read
 * triggers a fresh fetch from GCal.
 * @param {...string} keys
 */
export function invalidateCache(...keys) {
  for (const k of keys) {
    store.delete(k);
    console.log(`[Cache] Invalidated key: ${k}`);
  }
}

/**
 * Wipe the entire cache (useful in tests or forced-refresh scenarios).
 */
export function clearAllCache() {
  store.clear();
  console.log("[Cache] Full cache cleared.");
}

/**
 * Debug helper — returns a summary of all live entries.
 */
export function cacheStats() {
  const now = Date.now();
  return Array.from(store.entries()).map(([k, v]) => ({
    key:           k,
    count:         v.events.length,
    ageSeconds:    Math.round((now - v.fetchedAt) / 1000),
    ttlSeconds:    Math.round(CACHE_TTL_MS / 1000),
    hasSyncToken:  !!v.nextSyncToken,
  }));
}