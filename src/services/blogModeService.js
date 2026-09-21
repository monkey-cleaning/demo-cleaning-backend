// ─────────────────────────────────────────────────────────────────────────────
// blogModeService.js
//
// Lee site_settings (singleton) y calcula el modo efectivo de blog.
// Cache en memoria ~30s; se invalida en PUT de settings / addon.
// Fail-open: si la lectura falla, reusa el último valor cacheado; si no hay,
// 'manual'. Nunca cachea el fallback.
// ─────────────────────────────────────────────────────────────────────────────

import { supabase } from "../supabaseClient.js";
import { hasAutoBlogEntitlement } from "./entitlements.js";

export const BLOG_MODES = Object.freeze(["off", "manual", "auto"]);
export const AUTO_ADDON_STATUSES = Object.freeze([
  "inactive",
  "requested",
  "active",
  "past_due",
]);

const CACHE_TTL_MS = 30_000;

/** @type {{ row: object | null, expiresAt: number } | null} */
let cache = null;

const FALLBACK_ROW = Object.freeze({
  blog_mode: "manual",
  auto_addon_status: "inactive",
});

/**
 * @param {string} blogMode stored preference
 * @param {boolean} entitled
 * @returns {'off'|'manual'|'auto'}
 */
export function computeEffectiveBlogMode(blogMode, entitled) {
  const mode = BLOG_MODES.includes(blogMode) ? blogMode : "manual";
  if (mode === "auto" && !entitled) return "manual";
  return mode;
}

/**
 * @param {object} row
 */
function snapshotFromRow(row) {
  const blog_mode = BLOG_MODES.includes(row.blog_mode)
    ? row.blog_mode
    : "manual";
  const auto_addon_status = AUTO_ADDON_STATUSES.includes(row.auto_addon_status)
    ? row.auto_addon_status
    : "inactive";
  const entitled = hasAutoBlogEntitlement({ auto_addon_status });
  const effective_mode = computeEffectiveBlogMode(blog_mode, entitled);
  return {
    blog_mode,
    auto_addon_status,
    entitled,
    effective_mode,
    updated_at: row.updated_at ?? null,
  };
}

/**
 * Carga la fila singleton. No cachea fallos.
 * @param {{ forceRefresh?: boolean }} [opts]
 */
export async function getSiteSettingsRow({ forceRefresh = false } = {}) {
  const now = Date.now();
  if (!forceRefresh && cache?.row && cache.expiresAt > now) {
    return cache.row;
  }

  const { data, error } = await supabase
    .from("site_settings")
    .select("blog_mode, auto_addon_status, updated_at")
    .eq("id", 1)
    .maybeSingle();

  if (error) {
    console.error(
      "[blogMode] Error leyendo site_settings (fail-open):",
      error.message,
    );
    if (cache?.row) return cache.row;
    return { ...FALLBACK_ROW };
  }

  if (!data) {
    console.warn(
      "[blogMode] site_settings sin fila id=1 — fail-open a manual (no se cachea)",
    );
    if (cache?.row) return cache.row;
    return { ...FALLBACK_ROW };
  }

  cache = { row: data, expiresAt: now + CACHE_TTL_MS };
  return data;
}

/**
 * Snapshot tipado: modo guardado, efectivo, entitlement, addon status.
 */
export async function getBlogModeSnapshot({ forceRefresh = false } = {}) {
  const row = await getSiteSettingsRow({ forceRefresh });
  return snapshotFromRow(row);
}

/**
 * Modo efectivo ('off' | 'manual' | 'auto').
 */
export async function getEffectiveBlogMode({ forceRefresh = false } = {}) {
  const snap = await getBlogModeSnapshot({ forceRefresh });
  return snap.effective_mode;
}

export function invalidateBlogModeCache() {
  cache = null;
}

/**
 * Actualiza solo blog_mode. Si eligen 'auto' sin entitlement → requested.
 * @param {'off'|'manual'|'auto'} blogMode
 */
export async function updateBlogMode(blogMode) {
  if (!BLOG_MODES.includes(blogMode)) {
    throw new Error(`Invalid blog_mode: ${blogMode}`);
  }

  const current = await getSiteSettingsRow({ forceRefresh: true });
  const entitled = hasAutoBlogEntitlement(current);

  const patch = {
    blog_mode: blogMode,
    updated_at: new Date().toISOString(),
  };

  // Cliente pide auto pero aún no tiene addon activo → marcar requested.
  if (blogMode === "auto" && !entitled && current.auto_addon_status !== "active") {
    patch.auto_addon_status = "requested";
  }

  const { data, error } = await supabase
    .from("site_settings")
    .update(patch)
    .eq("id", 1)
    .select("blog_mode, auto_addon_status, updated_at")
    .single();

  if (error) throw error;

  invalidateBlogModeCache();
  cache = { row: data, expiresAt: Date.now() + CACHE_TTL_MS };
  return snapshotFromRow(data);
}

/**
 * Única vía de producto para cambiar auto_addon_status (endpoint interno).
 * Aquí se enchufaría el webhook de cobro (Stripe / Mercado Pago).
 * @param {'inactive'|'requested'|'active'|'past_due'} status
 */
export async function setAutoAddonStatus(status) {
  if (!AUTO_ADDON_STATUSES.includes(status)) {
    throw new Error(`Invalid auto_addon_status: ${status}`);
  }

  const { data, error } = await supabase
    .from("site_settings")
    .update({
      auto_addon_status: status,
      updated_at: new Date().toISOString(),
    })
    .eq("id", 1)
    .select("blog_mode, auto_addon_status, updated_at")
    .single();

  if (error) throw error;

  invalidateBlogModeCache();
  cache = { row: data, expiresAt: Date.now() + CACHE_TTL_MS };
  return snapshotFromRow(data);
}
