import express from 'express';
import { supabase } from '../supabaseClient.js';
import { requireAdmin } from '../middleware/requireAdmin.js';

const router = express.Router();

router.use(requireAdmin);

const BLOG_BUCKET = 'blog-images';

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

/**
 * GET /api/admin/blogs
 * Lista TODOS los posts (draft + published) para el dashboard
 */
router.get('/', async (_req, res) => {
  try {
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
    sections = [], // opcional: array de secciones
  } = req.body;

  try {
    // Crear post
    const { data: inserted, error: insertError } = await supabase
      .from('blog_posts')
      .insert({
        slug,
        title,
        excerpt,
        hero_image_url: heroImageUrl,
        hero_image_alt: heroImageAlt,
        tag,
        author,
        status,
        published_at: publishedAt || null,
        seo_title: seoTitle || null,
        seo_description: seoDescription || null,
      })
      .select('*')
      .single();

    if (insertError) {
      console.error('Supabase error admin POST /blogs:', insertError);
      return res.status(500).json({ error: 'Error creating blog post' });
    }

    const postId = inserted.id;

    // Si vienen secciones, las insertamos
    if (Array.isArray(sections) && sections.length > 0) {
      const sectionsPayload = sections.map((s, idx) => ({
        post_id: postId,
        section_order: s.order ?? idx + 1,
        heading: s.heading,
        body: s.body || null,           // opcional: versión "plain text"
        body_html: s.body_html || null, // rich text HTML
        image_url: s.image_url || null,
        image_alt: s.image_alt || null,
      }));

      const { error: secsError } = await supabase
        .from('blog_sections')
        .insert(sectionsPayload);

      if (secsError) {
        console.error('Supabase error admin POST /blogs sections:', secsError);
        // no hacemos rollback, pero avisamos
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
    // Update post
    const { data: updated, error: updateError } = await supabase
      .from('blog_posts')
      .update({
        slug,
        title,
        excerpt,
        hero_image_url: heroImageUrl,
        hero_image_alt: heroImageAlt,
        tag,
        author,
        status,
        published_at: publishedAt || null,
        seo_title: seoTitle || null,
        seo_description: seoDescription || null,
        updated_at: new Date().toISOString(),
      })
      .eq('id', id)
      .select('*')
      .single();

    if (updateError) {
      console.error('Supabase error admin PUT /blogs:', updateError);
      return res.status(500).json({ error: 'Error updating blog post' });
    }

    // Si vienen secciones, hacemos un "replace": borramos y volvemos a insertar
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
    // 1) Traer post + secciones
    const { data: post, error: postError } = await supabase
      .from('blog_posts')
      .select('id, hero_image_url')
      .eq('id', id)
      .single();

    if (postError) {
      console.error('Supabase error admin DELETE /blogs find post:', postError);
      return res.status(500).json({ error: 'Error finding blog post' });
    }

    if (!post) {
      return res.status(404).json({ error: 'Post not found' });
    }

    const { data: sections, error: secsError } = await supabase
      .from('blog_sections')
      .select('image_url')
      .eq('post_id', id);

    if (secsError) {
      console.error('Supabase error admin DELETE /blogs sections:', secsError);
      // seguimos igual, pero logueamos
    }

    // 2) Construir lista de paths a borrar
    const urls = [];

    if (post.hero_image_url) urls.push(post.hero_image_url);
    (sections || []).forEach((s) => {
      if (s.image_url) urls.push(s.image_url);
    });

    const paths = urls
      .map(extractStoragePathFromPublicUrl)
      .filter((p) => !!p);

    // 3) Borrar imágenes del bucket (si hay)
    if (paths.length > 0) {
      const { error: storageError } = await supabase
        .storage
        .from(BLOG_BUCKET)
        .remove(paths);

      if (storageError) {
        console.error('Supabase storage delete error:', storageError);
        // No cortamos, pero queda logueado
      }
    }

    // 4) Borrar secciones (por si no tenés ON DELETE CASCADE)
    const { error: delSecsError } = await supabase
      .from('blog_sections')
      .delete()
      .eq('post_id', id);

    if (delSecsError) {
      console.error('Error deleting sections:', delSecsError);
      // seguimos, pero log
    }

    // 5) Borrar el post
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