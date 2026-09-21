const KEBAB_SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const ALLOWED_STATUS = new Set(["draft", "published"]);

/**
 * @param {unknown} title
 * @returns {string|null} error message or null if ok
 */
export function validateBlogTitle(title) {
  if (typeof title !== "string" || !title.trim()) {
    return "title is required and must be a non-empty string";
  }
  return null;
}

/**
 * @param {unknown} slug
 * @returns {string|null}
 */
export function validateBlogSlugFormat(slug) {
  if (typeof slug !== "string" || !slug.trim()) {
    return "slug is required and must be a non-empty string";
  }
  if (!KEBAB_SLUG_RE.test(slug.trim())) {
    return "slug must be kebab-case (lowercase letters, numbers, hyphens)";
  }
  return null;
}

/**
 * @param {unknown} status
 * @returns {string|null}
 */
export function validateBlogStatus(status) {
  if (status == null || status === "") return null; // optional on PUT
  if (!ALLOWED_STATUS.has(status)) {
    return 'status must be "draft" or "published"';
  }
  return null;
}

/**
 * @param {unknown} publishedAt
 * @returns {string|null}
 */
export function validatePublishedAt(publishedAt) {
  if (publishedAt == null || publishedAt === "") return null;
  if (typeof publishedAt !== "string") {
    return "publishedAt must be an ISO date string or null";
  }
  const t = Date.parse(publishedAt);
  if (Number.isNaN(t)) {
    return "publishedAt must be a valid ISO date string";
  }
  return null;
}

export { KEBAB_SLUG_RE, ALLOWED_STATUS };
