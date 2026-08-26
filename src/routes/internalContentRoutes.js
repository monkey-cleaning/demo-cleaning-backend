import express from 'express';
import { requireSeoBlogPlatformToken } from '../middleware/requireSeoBlogPlatformToken.js';
import {
  ingestSeoBlog,
  validateSeoBlogPayload,
} from '../services/seoBlogIngestService.js';

const router = express.Router();

/**
 * POST /api/internal/content/blogs
 * Recepción server-to-server desde seo-blog-platform.
 */
router.post('/blogs', requireSeoBlogPlatformToken, async (req, res) => {
  try {
    const validationErrors = validateSeoBlogPayload(req.body);
    if (validationErrors.length > 0) {
      return res.status(400).json({
        success: false,
        error: 'Invalid payload',
        details: validationErrors,
      });
    }

    const result = await ingestSeoBlog(req.body);

    if (!result.ok) {
      return res.status(result.status).json({
        success: false,
        error: result.error,
        details: result.details,
      });
    }

    return res.status(result.status).json({
      success: true,
      post_id: result.post_id,
      slug: result.slug,
      public_url: result.public_url,
      action: result.action,
    });
  } catch (err) {
    console.error('[seo-blog-platform] Error en POST /api/internal/content/blogs:', err);
    return res.status(500).json({
      success: false,
      error: 'Internal server error',
    });
  }
});

export default router;
