import express from 'express';
import { supabase } from '../supabaseClient.js';
import { requireAdmin } from '../middleware/requireAdmin.js';
import { getEffectiveBlogMode } from '../services/blogModeService.js';
import { getDefaultBlogAuthor } from '../config/site.js';
import {
  validateBlogTitle,
  validateBlogSlugFormat,
  validateBlogStatus,
  validatePublishedAt,
} from '../utils/blogValidation.js';

const router = express.Router();

router.use(requireAdmin);

const BLOG_BUCKET = 'blog-images';
const PLATFORM_SOURCE = 'seo-blog-platform';

// Helper para extraer el path de storage desde una URL pública
function extractStoragePathFromPublicUrl(url) {
  if (!url) return null;

  const marker = '/storage/v1/object/public/';
  const idx = url.indexOf(marker);
  if (idx === -1) return null;

  const after = url.slice(idx + marker.length); // "blog-images/hero/archivo.jpg"
  const bucketPrefix = `${BLOG_BUCKET}/`;

  if (!after.startsWith(bucketPrefix)) return null;

  return after.slice(bucketPrefix.length); // "hero/archivo.jpg"
}

async function rejectIfBlogOff(_req, res) {
  const mode = await getEffectiveBlogMode();
  if (mode === 'off') {
    res.status(403).json({
      error: 'Blog is disabled',
      code: 'blog_disabled',
    });
    return true;
  }
  return false;
}

function isPlatformManaged(post) {
  return post?.source === PLATFORM_SOURCE;
}

async function rejectIfPlatformLocked(post, res) {
  const mode = await getEffectiveBlogMode();
  if (mode === 'auto' && isPlatformManaged(post)) {
    res.status(403).json({
      error: 'Post managed by seo-blog-platform',
      code: 'blog_managed_by_platform',
    });
    return true;
  }
  return false;
}

async function findSlugConflict(slug, excludeId = null) {
  let q = supabase.from('blog_posts').select('id').eq('slug', slug).limit(1);
  if (excludeId) q = q.neq('id', excludeId);
  const { data, error } = await q.maybeSingle();
  if (error && error.code !== 'PGRST116') throw error;
  return data || null;
}

/**
 * GET /api/admin/blogs
 * Lista TODOS los posts (draft + published) para el dashboard
 */
router.get('/', async (_req, res) => {
  try {
    if (await rejectIfBlogOff(_req, res)) return;

    const { data, error } = await supabase
      .from('blog_posts')
      .select('*')
      .order('created_at', { ascending: false });

    if (error) {
      console.error('Supabase error admin GET /blogs:', error);
      return res.status(500).json({ error: 'Error fetching blog posts' });
    }

    res.json(data);
  } catch (err) {
    console.error('Server error admin GET /blogs:', err);
    res.status(500).json({ error: 'Unexpected error' });
  }
});

/**
 * GET /api/admin/blogs/:id
 * Devuelve post + secciones (para editar)
 */
router.get('/:id', async (req, res) => {
  const { id } = req.params;

  try {
    if (await rejectIfBlogOff(req, res)) return;

    const { data: posts, error: postError } = await supabase
      .from('blog_posts')
      .select('*')
      .eq('id', id)
      .limit(1);

    if (postError) {
      console.error('Supabase error admin GET /blogs/:id post:', postError);
      return res.status(500).json({ error: 'Error fetching blog post' });
    }

    const post = posts?.[0];
    if (!post) {
      return res.status(404).json({ error: 'Post not found' });
    }

    const { data: sections, error: secsError } = await supabase
      .from('blog_sections')
      .select('id, section_order, heading, body, body_html, image_url, image_alt')
      .eq('post_id', id)
      .order('section_order', { ascending: true });

    if (secsError) {
      console.error('Supabase error admin GET /blogs/:id sections:', secsError);
      return res.status(500).json({ error: 'Error fetching sections' });
    }

    res.json({ post, sections });
  } catch (err) {
    console.error('Server error admin GET /blogs/:id:', err);
    res.status(500).json({ error: 'Unexpected error' });
  }
});

/**
 * POST /api/admin/blogs
 * Crea un nuevo post (sin secciones o con secciones opcionales)
 */
router.post('/', async (req, res) => {
  const {
    slug,
    title,
    excerpt,
    heroImageUrl,
    heroImageAlt,
    tag,
    author,
    status = 'draft',
    publishedAt,
    seoTitle,
    seoDescription,
    sections = [],
  } = req.body;

  try {
    if (await rejectIfBlogOff(req, res)) return;

    const errors = [
      validateBlogTitle(title),
      validateBlogSlugFormat(slug),
      validateBlogStatus(status),
      validatePublishedAt(publishedAt),
    ].filter(Boolean);

    if (errors.length > 0) {
      return res.status(400).json({ error: errors[0], details: errors });
    }

    const conflict = await findSlugConflict(slug.trim());
    if (conflict) {
      return res.status(409).json({
        error: 'Slug already taken',
        code: 'slug_conflict',
        details: { slug: slug.trim(), conflicting_post_id: conflict.id },
      });
    }

    const { data: inserted, error: insertError } = await supabase
      .from('blog_posts')
      .insert({
        slug: slug.trim(),
        title: title.trim(),
        excerpt,
        hero_image_url: heroImageUrl,
        hero_image_alt: heroImageAlt,
        tag,
        author: author || getDefaultBlogAuthor(),
        status,
        published_at: publishedAt || null,
        seo_title: seoTitle || null,
        seo_description: seoDescription || null,
        source: 'admin',
      })
      .select('*')
      .single();

    if (insertError) {
      if (insertError.code === '23505') {
        return res.status(409).json({
          error: 'Slug already taken',
          code: 'slug_conflict',
        });
      }
      console.error('Supabase error admin POST /blogs:', insertError);
      return res.status(500).json({ error: 'Error creating blog post' });
    }

    const postId = inserted.id;

    if (Array.isArray(sections) && sections.length > 0) {
      const sectionsPayload = sections.map((s, idx) => ({
        post_id: postId,
        section_order: s.order ?? idx + 1,
        heading: s.heading,
        body: s.body || null,
        body_html: s.body_html || null,
        image_url: s.image_url || null,
        image_alt: s.image_alt || null,
      }));

      const { error: secsError } = await supabase
        .from('blog_sections')
        .insert(sectionsPayload);

      if (secsError) {
        console.error('Supabase error admin POST /blogs sections:', secsError);
      }
    }

    res.status(201).json(inserted);
  } catch (err) {
    console.error('Server error admin POST /blogs:', err);
    res.status(500).json({ error: 'Unexpected error' });
  }
});

/**
 * PUT /api/admin/blogs/:id
 * Actualiza post + reemplaza secciones
 */
router.put('/:id', async (req, res) => {
  const { id } = req.params;
  const {
    slug,
    title,
    excerpt,
    heroImageUrl,
    heroImageAlt,
    tag,
    author,
    status,
    publishedAt,
    seoTitle,
    seoDescription,
    sections,
  } = req.body;

  try {
    if (await rejectIfBlogOff(req, res)) return;

    const { data: existing, error: existingErr } = await supabase
      .from('blog_posts')
      .select('id, slug, source')
      .eq('id', id)
      .maybeSingle();

    if (existingErr) {
      console.error('Supabase error admin PUT /blogs find:', existingErr);
      return res.status(500).json({ error: 'Error finding blog post' });
    }
    if (!existing) {
      return res.status(404).json({ error: 'Post not found' });
    }

    if (await rejectIfPlatformLocked(existing, res)) return;

    const errors = [];
    if (title !== undefined) {
      const e = validateBlogTitle(title);
      if (e) errors.push(e);
    }
    if (status !== undefined) {
      const e = validateBlogStatus(status);
      if (e) errors.push(e);
    }
    if (publishedAt !== undefined) {
      const e = validatePublishedAt(publishedAt);
      if (e) errors.push(e);
    }

    // Validar formato kebab solo si el slug CAMBIA respecto al guardado
    const slugChanging =
      slug !== undefined && String(slug).trim() !== existing.slug;
    if (slugChanging) {
      const e = validateBlogSlugFormat(slug);
      if (e) errors.push(e);
    }

    if (errors.length > 0) {
      return res.status(400).json({ error: errors[0], details: errors });
    }

    if (slugChanging) {
      const conflict = await findSlugConflict(slug.trim(), id);
      if (conflict) {
        return res.status(409).json({
          error: 'Slug already taken',
          code: 'slug_conflict',
          details: { slug: slug.trim(), conflicting_post_id: conflict.id },
        });
      }
    }

    const patch = {
      updated_at: new Date().toISOString(),
    };
    if (slugChanging) patch.slug = slug.trim();
    if (title !== undefined) patch.title = title.trim();
    if (excerpt !== undefined) patch.excerpt = excerpt;
    if (heroImageUrl !== undefined) patch.hero_image_url = heroImageUrl;
    if (heroImageAlt !== undefined) patch.hero_image_alt = heroImageAlt;
    if (tag !== undefined) patch.tag = tag;
    if (author !== undefined) patch.author = author;
    if (status !== undefined) patch.status = status;
    if (publishedAt !== undefined) patch.published_at = publishedAt || null;
    if (seoTitle !== undefined) patch.seo_title = seoTitle || null;
    if (seoDescription !== undefined) patch.seo_description = seoDescription || null;

    const { data: updated, error: updateError } = await supabase
      .from('blog_posts')
      .update(patch)
      .eq('id', id)
      .select('*')
      .single();

    if (updateError) {
      if (updateError.code === '23505') {
        return res.status(409).json({
          error: 'Slug already taken',
          code: 'slug_conflict',
        });
      }
      console.error('Supabase error admin PUT /blogs:', updateError);
      return res.status(500).json({ error: 'Error updating blog post' });
    }

    if (Array.isArray(sections)) {
      const { error: delError } = await supabase
        .from('blog_sections')
        .delete()
        .eq('post_id', id);

      if (delError) {
        console.error('Supabase error admin PUT /blogs delete sections:', delError);
      } else if (sections.length > 0) {
        const payload = sections.map((s, idx) => ({
          post_id: id,
          section_order: s.order ?? idx + 1,
          heading: s.heading,
          body: s.body || null,
          body_html: s.body_html || null,
          image_url: s.image_url || null,
          image_alt: s.image_alt || null,
        }));

        const { error: insError } = await supabase
          .from('blog_sections')
          .insert(payload);

        if (insError) {
          console.error('Supabase error admin PUT /blogs insert sections:', insError);
        }
      }
    }

    res.json(updated);
  } catch (err) {
    console.error('Server error admin PUT /blogs:', err);
    res.status(500).json({ error: 'Unexpected error' });
  }
});

/**
 * DELETE /api/admin/blogs/:id
 * Elimina post + secciones + imágenes del storage
 */
router.delete('/:id', async (req, res) => {
  const { id } = req.params;

  try {
    if (await rejectIfBlogOff(req, res)) return;

    const { data: post, error: postError } = await supabase
      .from('blog_posts')
      .select('id, hero_image_url, source')
      .eq('id', id)
      .single();

    if (postError) {
      console.error('Supabase error admin DELETE /blogs find post:', postError);
      return res.status(500).json({ error: 'Error finding blog post' });
    }

    if (!post) {
      return res.status(404).json({ error: 'Post not found' });
    }

    if (await rejectIfPlatformLocked(post, res)) return;

    const { data: sections, error: secsError } = await supabase
      .from('blog_sections')
      .select('image_url')
      .eq('post_id', id);

    if (secsError) {
      console.error('Supabase error admin DELETE /blogs sections:', secsError);
    }

    const urls = [];

    if (post.hero_image_url) urls.push(post.hero_image_url);
    (sections || []).forEach((s) => {
      if (s.image_url) urls.push(s.image_url);
    });

    const paths = urls
      .map(extractStoragePathFromPublicUrl)
      .filter((p) => !!p);

    if (paths.length > 0) {
      const { error: storageError } = await supabase
        .storage
        .from(BLOG_BUCKET)
        .remove(paths);

      if (storageError) {
        console.error('Supabase storage delete error:', storageError);
      }
    }

    const { error: delSecsError } = await supabase
      .from('blog_sections')
      .delete()
      .eq('post_id', id);

    if (delSecsError) {
      console.error('Error deleting sections:', delSecsError);
    }

    const { error } = await supabase
      .from('blog_posts')
      .delete()
      .eq('id', id);

    if (error) {
      console.error('Supabase error admin DELETE /blogs:', error);
      return res.status(500).json({ error: 'Error deleting blog post' });
    }

    return res.status(204).send();
  } catch (err) {
    console.error('Server error admin DELETE /blogs:', err);
    res.status(500).json({ error: 'Unexpected error' });
  }
});

export default router;
