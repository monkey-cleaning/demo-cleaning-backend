// ─────────────────────────────────────────────────────────────────────────────
// config/site.js
//
// Config de marca / sitio público para white-label. Todo sale de env (o
// defaults neutros). Sin hardcodes de Monkey Cleaning.
// ─────────────────────────────────────────────────────────────────────────────

const DEFAULT_STATIC_ROUTES = Object.freeze([{ path: "/", priority: "1.0" }]);

function trimSlash(url) {
  return String(url || "").replace(/\/$/, "");
}

/**
 * Nombre de marca (emails de cotización, etc. pueden reutilizarlo).
 */
export function getBrandName() {
  return process.env.BRAND_NAME || "Cleaning Co.";
}

/**
 * Autor por defecto de posts ingestados / admin.
 */
export function getDefaultBlogAuthor() {
  return (
    process.env.SEO_BLOG_DEFAULT_AUTHOR ||
    process.env.BRAND_NAME ||
    "Blog"
  );
}

/**
 * Dominio público del frontend (sin trailing slash).
 * Vacío si no está seteado — validatePublicSiteUrl() falla en production.
 */
export function getPublicSiteUrl() {
  const raw =
    process.env.PUBLIC_SITE_URL || process.env.FRONTEND_URL || "";
  return trimSlash(raw);
}

/**
 * URL canónica de un post: {PUBLIC_SITE_URL}/blog/{slug}
 */
export function buildPublicBlogUrl(slug) {
  const base = getPublicSiteUrl();
  if (!base) {
    throw new Error(
      "PUBLIC_SITE_URL (or FRONTEND_URL) is required to build public blog URLs",
    );
  }
  return `${base}/blog/${encodeURIComponent(slug)}`;
}

/**
 * Rutas estáticas del sitemap (sin /blog — se agrega dinámicamente si el
 * modo efectivo de blog != off).
 *
 * Env SITE_SITEMAP_STATIC_ROUTES: JSON array
 *   [{"path":"/","priority":"1.0"},{"path":"/contact-us","priority":"0.9"}]
 * Default: solo "/".
 */
export function getSitemapStaticRoutes() {
  const raw = process.env.SITE_SITEMAP_STATIC_ROUTES;
  if (!raw || !String(raw).trim()) {
    return [...DEFAULT_STATIC_ROUTES];
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(
      `SITE_SITEMAP_STATIC_ROUTES must be valid JSON (got parse error: ${err.message})`,
    );
  }

  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw new Error(
      "SITE_SITEMAP_STATIC_ROUTES must be a non-empty JSON array of { path, priority }",
    );
  }

  return parsed.map((r, i) => {
    if (!r || typeof r.path !== "string" || !r.path.startsWith("/")) {
      throw new Error(
        `SITE_SITEMAP_STATIC_ROUTES[${i}].path must be a string starting with /`,
      );
    }
    return {
      path: r.path,
      priority: r.priority != null ? String(r.priority) : "0.5",
    };
  });
}

/**
 * En production exige PUBLIC_SITE_URL (o FRONTEND_URL). Llamar al boot.
 */
export function validatePublicSiteUrl() {
  if (process.env.NODE_ENV !== "production") return;

  const url = getPublicSiteUrl();
  if (!url) {
    throw new Error(
      "PUBLIC_SITE_URL is required when NODE_ENV=production (used for sitemap and blog public_url). Set it to the public frontend origin, e.g. https://example.com",
    );
  }
  try {
    // eslint-disable-next-line no-new
    new URL(url);
  } catch {
    throw new Error(`PUBLIC_SITE_URL is not a valid URL: ${url}`);
  }
}
