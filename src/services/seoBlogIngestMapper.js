import { markdownToSections } from '../utils/markdownToSections.js';
import {
  buildPublicBlogUrl,
  getDefaultBlogAuthor,
  getPublicSiteUrl,
} from '../config/site.js';

export { buildPublicBlogUrl, getPublicSiteUrl };

const ALLOWED_STATUSES = new Set(['draft', 'published']);
const REQUIRED_FIELDS = ['external_id', 'slug', 'title', 'body_markdown'];
const EXCERPT_MAX = 160;

function getAllowedClientSlugs() {
  const raw = process.env.SEO_BLOG_ALLOWED_CLIENT_SLUGS;
  if (!raw || !String(raw).trim()) return null;
  return new Set(
    String(raw)
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  );
}

/**
 * Quita sintaxis markdown básica → texto plano para excerpt.
 */
export function stripMarkdownToPlain(markdown) {
  return String(markdown || '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`[^`]*`/g, ' ')
    .replace(/!\[[^\]]*]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]*)]\([^)]*\)/g, '$1')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/^>\s+/gm, '')
    .replace(/[*_~]+/g, '')
    .replace(/^\s*[-*+]\s+/gm, '')
    .replace(/^\s*\d+\.\s+/gm, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Corta en ~max chars sin partir una palabra (si hay espacio razonable).
 */
export function truncateAtWord(text, max = EXCERPT_MAX) {
  const s = String(text || '').trim();
  if (s.length <= max) return s;
  const cut = s.slice(0, max);
  const lastSpace = cut.lastIndexOf(' ');
  const out = (lastSpace > Math.floor(max * 0.4) ? cut.slice(0, lastSpace) : cut).trim();
  return out || s.slice(0, max).trim();
}

/**
 * excerpt nunca null:
 * (a) meta_description
 * (b) ~160 chars del body_markdown plano, corte en palabra
 * (c) title
 */
export function resolveExcerpt(payload) {
  const meta =
    typeof payload.meta_description === 'string'
      ? payload.meta_description.trim()
      : '';
  if (meta) return meta;

  const plain = stripMarkdownToPlain(payload.body_markdown);
  if (plain) return truncateAtWord(plain, EXCERPT_MAX);

  const title =
    typeof payload.title === 'string' ? payload.title.trim() : '';
  return title || 'Blog';
}

/**
 * Valida el payload entrante de seo-blog-platform.
 * @returns {{ ok: boolean, errors: string[], fields: string[] }}
 */
export function validateSeoBlogPayload(body) {
  const errors = [];
  const fields = [];

  if (!body || typeof body !== 'object') {
    return {
      ok: false,
      errors: ['body must be a JSON object'],
      fields: ['body'],
    };
  }

  for (const key of REQUIRED_FIELDS) {
    if (!body[key] || typeof body[key] !== 'string') {
      fields.push(key);
      errors.push(`${key} is required and must be a string`);
    }
  }

  if (body.client_slug != null) {
    if (typeof body.client_slug !== 'string') {
      fields.push('client_slug');
      errors.push('client_slug must be a string');
    } else {
      const allowed = getAllowedClientSlugs();
      if (allowed && !allowed.has(body.client_slug)) {
        fields.push('client_slug');
        errors.push(
          `client_slug must be one of: ${[...allowed].join(', ')}`,
        );
      }
    }
  }

  if (body.status != null && !ALLOWED_STATUSES.has(body.status)) {
    fields.push('status');
    errors.push('status must be "draft" or "published"');
  }

  if (body.keywords != null && !Array.isArray(body.keywords)) {
    fields.push('keywords');
    errors.push('keywords must be an array of strings');
  }

  if (body.seo_score != null && typeof body.seo_score !== 'number') {
    fields.push('seo_score');
    errors.push('seo_score must be a number');
  }

  if (body.published_at != null && typeof body.published_at !== 'string') {
    fields.push('published_at');
    errors.push('published_at must be an ISO date string or null');
  }

  return { ok: errors.length === 0, errors, fields };
}

export function mapPayloadToPostRow(payload) {
  const status = payload.status || 'draft';
  const publishedAt =
    payload.published_at ??
    (status === 'published' ? new Date().toISOString() : null);

  const title = String(payload.title || '').trim();
  const excerpt = resolveExcerpt(payload);
  const keywords = normalizeKeywords(payload.keywords);

  return {
    slug: String(payload.slug).trim(),
    title,
    excerpt,
    hero_image_url: payload.featured_image_url || null,
    hero_image_alt: title || 'Blog',
    tag:
      Array.isArray(payload.keywords) && payload.keywords.length > 0
        ? String(payload.keywords[0])
        : 'Blog',
    author: getDefaultBlogAuthor(),
    status,
    published_at: publishedAt,
    seo_title: title || 'Blog',
    // Misma cascada que excerpt por si la columna es NOT NULL
    seo_description: excerpt,
    external_id: payload.external_id,
    source: 'seo-blog-platform',
    seo_score: payload.seo_score ?? null,
    language:
      typeof payload.language === 'string' && payload.language.trim()
        ? payload.language.trim()
        : 'es',
    keywords,
    updated_at: new Date().toISOString(),
  };
}

/**
 * Normaliza keywords para JSONB — siempre array (nunca null).
 */
export function normalizeKeywords(keywords) {
  if (keywords == null) return [];
  if (!Array.isArray(keywords)) return [];
  return keywords.map(String);
}

export function buildSectionsFromMarkdown(bodyMarkdown) {
  return markdownToSections(bodyMarkdown);
}

export { REQUIRED_FIELDS };
