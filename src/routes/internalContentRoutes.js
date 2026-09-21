import express from 'express';
import { requireSeoBlogPlatformToken } from '../middleware/requireSeoBlogPlatformToken.js';
import { loadBlogModeForIngest } from '../middleware/requireEffectiveAutoBlog.js';
import {
  ingestSeoBlog,
  validateSeoBlogPayload,
} from '../services/seoBlogIngestService.js';
import { supabase } from '../supabaseClient.js';
import {
  getBlogModeSnapshot,
  setAutoAddonStatus,
  AUTO_ADDON_STATUSES,
} from '../services/blogModeService.js';

const router = express.Router();

/**
 * GET /api/internal/content/status
 * Auth: Bearer SEO_BLOG_PLATFORM_SERVICE_TOKEN
 * Responde aunque el modo no sea auto (lo consulta seo-blog-platform).
 */
router.get('/status', requireSeoBlogPlatformToken, async (_req, res) => {
  try {
    const snap = await getBlogModeSnapshot();
    return res.json({
      mode: snap.effective_mode,
      entitled: snap.entitled,
      auto_addon_status: snap.auto_addon_status,
    });
  } catch (err) {
    console.error('[seo-blog-platform] GET /status:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * PUT /api/internal/content/addon
 * Auth: Bearer service token
 * Body: { auto_addon_status: 'inactive'|'requested'|'active'|'past_due' }
 *
 * Única vía para pasar a 'active'. Aquí se enchufa el webhook de cobro
 * (Stripe / Mercado Pago) cuando exista: el provider llama este endpoint
 * (o setAutoAddonStatus) tras payment_succeeded / subscription_cancelled.
 */
router.put('/addon', requireSeoBlogPlatformToken, async (req, res) => {
  try {
    const status = req.body?.auto_addon_status;
    if (!AUTO_ADDON_STATUSES.includes(status)) {
      return res.status(400).json({
        success: false,
        error: 'Invalid auto_addon_status',
        details: [
          `auto_addon_status must be one of: ${AUTO_ADDON_STATUSES.join(', ')}`,
        ],
      });
    }

    const snap = await setAutoAddonStatus(status);
    return res.json({
      success: true,
      blog_mode: snap.blog_mode,
      effective_mode: snap.effective_mode,
      auto_addon_status: snap.auto_addon_status,
      entitled: snap.entitled,
    });
  } catch (err) {
    console.error('[seo-blog-platform] PUT /addon:', err);
    return res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

/**
 * POST /api/internal/content/blogs
 * Recepción server-to-server desde seo-blog-platform.
 *
 * Si el modo efectivo no es 'auto':
 *   - Permitido solo status "draft" sobre un external_id YA existente (despublicar).
 *   - Crear o publicar → 409 blog_auto_disabled.
 */
router.post(
  '/blogs',
  requireSeoBlogPlatformToken,
  loadBlogModeForIngest,
  async (req, res) => {
    try {
      const validationErrors = validateSeoBlogPayload(req.body);
      if (validationErrors.length > 0) {
        return res.status(400).json({
          success: false,
          error: 'Invalid payload',
          details: validationErrors,
        });
      }

      const snap = req.blogMode;
      const wantsDraft = (req.body.status || 'draft') === 'draft';
      const externalId = req.body.external_id;

      if (snap.effective_mode !== 'auto') {
        // Fuera de auto: solo despublicar (draft) un post existente.
        if (!wantsDraft) {
          return res.status(409).json({
            success: false,
            code: 'blog_auto_disabled',
            mode: snap.effective_mode,
          });
        }

        const { data: existing, error: findErr } = await supabase
          .from('blog_posts')
          .select('id')
          .eq('external_id', externalId)
          .maybeSingle();

        if (findErr) throw findErr;

        if (!existing) {
          return res.status(409).json({
            success: false,
            code: 'blog_auto_disabled',
            mode: snap.effective_mode,
          });
        }
        // existing + draft → seguir al ingest (update → unpublished)
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
  },
);

export default router;
