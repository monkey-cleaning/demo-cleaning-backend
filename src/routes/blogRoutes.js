import express from 'express';
import { supabase } from '../supabaseClient.js';

const router = express.Router();

/**
 * GET /api/blogs
 * Lista de posts publicados (para la sección de cards)
 */
router.get('/', async (_req, res) => {
  try {
    const { data, error } = await supabase
      .from('blog_posts')
      .select('id, slug, title, excerpt, hero_image_url, hero_image_alt, tag, author, published_at, seo_title, seo_description')
      .eq('status', 'published')
      .order('published_at', { ascending: false });

    if (error) {
      console.error('Supabase error /blogs:', error);
      return res.status(500).json({ error: 'Error fetching blog posts' });
    }

    const mapped = (data || []).map((p) => ({
      id: p.id,
      slug: p.slug,
      title: p.title,
      excerpt: p.excerpt,
      image: p.hero_image_url,
      imageAlt: p.hero_image_alt,
      tag: p.tag,
      author: p.author,
      date: p.published_at,
      seoTitle: p.seo_title,
      seoDescription: p.seo_description,
    }));

    res.json(mapped);
  } catch (err) {
    console.error('Server error /blogs:', err);
    res.status(500).json({ error: 'Unexpected error' });
  }
});

/**
 * GET /api/blogs/:slug
 * Detalle del post + secciones + related
 */
router.get('/:slug', async (req, res) => {
  const { slug } = req.params;

  try {
    // Post principal
    const { data: posts, error: postError } = await supabase
      .from('blog_posts')
      .select('id, slug, title, excerpt, hero_image_url, hero_image_alt, tag, author, published_at, seo_title, seo_description')
      .eq('slug', slug)
      .eq('status', 'published')
      .limit(1);

    if (postError) {
      console.error('Supabase error /blogs/:slug post:', postError);
      return res.status(500).json({ error: 'Error fetching blog post' });
    }

    const post = posts?.[0];
    if (!post) {
      return res.status(404).json({ error: 'Post not found' });
    }

    // Secciones
    const { data: sections, error: secsError } = await supabase
      .from('blog_sections')
      .select('id, section_order, heading, body, body_html, image_url, image_alt')
      .eq('post_id', post.id)
      .order('section_order', { ascending: true });

    if (secsError) {
      console.error('Supabase error /blogs/:slug sections:', secsError);
      return res.status(500).json({ error: 'Error fetching sections' });
    }

    // Related
    const { data: relatedRaw, error: relatedError } = await supabase
      .from('blog_posts')
      .select('id, slug, title, excerpt, hero_image_url, hero_image_alt, tag, author, published_at, seo_title, seo_description')
      .eq('status', 'published')
      .neq('id', post.id)
      .order('published_at', { ascending: false })
      .limit(3);

    if (relatedError) {
      console.error('Supabase error /blogs/:slug related:', relatedError);
      return res.status(500).json({ error: 'Error fetching related posts' });
    }

    res.json({
      post: {
        id: post.id,
        slug: post.slug,
        title: post.title,
        excerpt: post.excerpt,
        image: post.hero_image_url,
        imageAlt: post.hero_image_alt,
        tag: post.tag,
        author: post.author,
        date: post.published_at,
        seoTitle: post.seo_title,
        seoDescription: post.seo_description,
      },
      sections: (sections || []).map((s) => ({
        id: s.id,
        order: s.section_order,
        heading: s.heading,
        body: s.body,
        body_html: s.body_html,
        image_url: s.image_url,
        image_alt: s.image_alt,
      })),
      related: (relatedRaw || []).map((p) => ({
        id: p.id,
        slug: p.slug,
        title: p.title,
        excerpt: p.excerpt,
        image: p.hero_image_url,
        imageAlt: p.hero_image_alt,
        tag: p.tag,
        author: p.author,
        date: p.published_at,
        seoTitle: p.seo_title,
        seoDescription: p.seo_description,
      })),
    });
  } catch (err) {
    console.error('Server error /blogs/:slug:', err);
    res.status(500).json({ error: 'Unexpected error' });
  }
});

export default router;