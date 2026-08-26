import { markdownToSections } from '../utils/markdownToSections.js';

const ALLOWED_CLIENT_SLUGS = new Set(['monkey']);
const ALLOWED_STATUSES = new Set(['draft', 'published']);

export function getPublicSiteUrl() {
  return (
    process.env.PUBLIC_SITE_URL ||
    process.env.FRONTEND_URL ||
    'https://monkeycleaning.com'
  ).replace(/\/$/, '');
}

export function buildPublicBlogUrl(slug) {
  return `${getPublicSiteUrl()}/blog/${slug}`;
}

/**
 * Valida el payload entrante de seo-blog-platform.
 * @returns {string[]} lista de errores (vacía si es válido)
 */
export function validateSeoBlogPayload(body) {
  const errors = [];

  if (!body || typeof body !== 'object') {
    return ['body must be a JSON object'];
  }

  if (!body.external_id || typeof body.external_id !== 'string') {
    errors.push('external_id is required and must be a string');
  }
  if (!body.slug || typeof body.slug !== 'string') {
    errors.push('slug is required and must be a string');
  }
  if (!body.title || typeof body.title !== 'string') {
    errors.push('title is required and must be a string');
  }
  if (!body.body_markdown || typeof body.body_markdown !== 'string') {
    errors.push('body_markdown is required and must be a string');
  }

  if (body.client_slug != null && !ALLOWED_CLIENT_SLUGS.has(body.client_slug)) {
    errors.push(`client_slug must be one of: ${[...ALLOWED_CLIENT_SLUGS].join(', ')}`);
  }

  if (body.status != null && !ALLOWED_STATUSES.has(body.status)) {
    errors.push('status must be "draft" or "published"');
  }

  if (body.keywords != null && !Array.isArray(body.keywords)) {
    errors.push('keywords must be an array of strings');
  }

  if (body.seo_score != null && typeof body.seo_score !== 'number') {
    errors.push('seo_score must be a number');
  }

  if (body.published_at != null && typeof body.published_at !== 'string') {
    errors.push('published_at must be an ISO date string or null');
  }

  return errors;
}

export function mapPayloadToPostRow(payload) {
  const status = payload.status || 'draft';
  const publishedAt =
    payload.published_at ??
    (status === 'published' ? new Date().toISOString() : null);

  return {
    slug: payload.slug.trim(),
    title: payload.title.trim(),
    excerpt: payload.meta_description?.trim() || null,
    hero_image_url: payload.featured_image_url || null,
    hero_image_alt: payload.title.trim(),
    tag: Array.isArray(payload.keywords) && payload.keywords.length > 0
      ? String(payload.keywords[0])
      : 'Blog',
    author: process.env.SEO_BLOG_DEFAULT_AUTHOR || 'Monkey Cleaning',
    status,
    published_at: publishedAt,
    seo_title: payload.title.trim(),
    seo_description: payload.meta_description?.trim() || null,
    external_id: payload.external_id,
    source: payload.source || 'seo-blog-platform',
    seo_score: payload.seo_score ?? null,
    language: payload.language || 'es',
    keywords: normalizeKeywords(payload.keywords),
    updated_at: new Date().toISOString(),
  };
}

/**
 * Normaliza keywords para columna JSONB en blog_posts.
 */
export function normalizeKeywords(keywords) {
  if (keywords == null) return null;
  if (!Array.isArray(keywords)) return null;
  return keywords.map(String);
}

export function buildSectionsFromMarkdown(bodyMarkdown) {
  return markdownToSections(bodyMarkdown);
}
