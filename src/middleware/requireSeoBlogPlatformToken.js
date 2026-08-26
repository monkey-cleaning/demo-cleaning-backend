const SERVICE_TOKEN = process.env.SEO_BLOG_PLATFORM_SERVICE_TOKEN;

/**
 * Auth server-to-server para seo-blog-platform.
 * Header: Authorization: Bearer <SEO_BLOG_PLATFORM_SERVICE_TOKEN>
 */
export function requireSeoBlogPlatformToken(req, res, next) {
  if (!SERVICE_TOKEN) {
    console.error('[seo-blog-platform] SEO_BLOG_PLATFORM_SERVICE_TOKEN no configurado');
    return res.status(500).json({ error: 'Service token not configured' });
  }

  const auth = req.get('authorization') || req.get('Authorization') || '';
  const expected = `Bearer ${SERVICE_TOKEN}`;

  if (auth.trim() !== expected) {
    console.warn('[seo-blog-platform] Intento de auth fallido', {
      ip: req.ip,
      path: req.originalUrl,
      hasAuthHeader: Boolean(auth),
    });
    return res.status(401).json({ error: 'Unauthorized' });
  }

  next();
}
