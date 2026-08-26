import { supabase } from '../supabaseClient.js';
import {
  buildPublicBlogUrl,
  buildSectionsFromMarkdown,
  mapPayloadToPostRow,
} from './seoBlogIngestMapper.js';

export {
  buildPublicBlogUrl,
  getPublicSiteUrl,
  mapPayloadToPostRow,
  validateSeoBlogPayload,
} from './seoBlogIngestMapper.js';

async function findPostByExternalId(externalId) {
  const { data, error } = await supabase
    .from('blog_posts')
    .select('id, slug, external_id')
    .eq('external_id', externalId)
    .maybeSingle();

  if (error) throw error;
  return data;
}

async function findPostBySlug(slug) {
  const { data, error } = await supabase
    .from('blog_posts')
    .select('id, slug, external_id')
    .eq('slug', slug)
    .maybeSingle();

  if (error) throw error;
  return data;
}

async function replaceSections(postId, sections) {
  const { error: delError } = await supabase
    .from('blog_sections')
    .delete()
    .eq('post_id', postId);

  if (delError) throw delError;

  const payload = sections.map((s) => ({
    post_id: postId,
    ...s,
  }));

  const { error: insError } = await supabase
    .from('blog_sections')
    .insert(payload);

  if (insError) throw insError;
}

/**
 * Crea o actualiza un post (idempotente por external_id).
 */
export async function ingestSeoBlog(payload) {
  const postRow = mapPayloadToPostRow(payload);
  const sections = buildSectionsFromMarkdown(payload.body_markdown);

  const existing = await findPostByExternalId(payload.external_id);

  if (existing) {
    const slugOwner = await findPostBySlug(postRow.slug);
    if (slugOwner && slugOwner.id !== existing.id) {
      return {
        ok: false,
        status: 409,
        error: 'Slug already taken by another post with a different external_id',
        details: { slug: postRow.slug, conflicting_post_id: slugOwner.id },
      };
    }

    const { data: updated, error: updateError } = await supabase
      .from('blog_posts')
      .update(postRow)
      .eq('id', existing.id)
      .select('id, slug')
      .single();

    if (updateError) throw updateError;

    await replaceSections(updated.id, sections);

    return {
      ok: true,
      status: 200,
      action: 'updated',
      post_id: updated.id,
      slug: updated.slug,
      public_url: buildPublicBlogUrl(updated.slug),
    };
  }

  const slugOwner = await findPostBySlug(postRow.slug);
  if (slugOwner) {
    return {
      ok: false,
      status: 409,
      error: 'Slug already taken by another post with a different external_id',
      details: { slug: postRow.slug, conflicting_post_id: slugOwner.id },
    };
  }

  const { data: created, error: insertError } = await supabase
    .from('blog_posts')
    .insert(postRow)
    .select('id, slug')
    .single();

  if (insertError) {
    if (insertError.code === '23505') {
      return {
        ok: false,
        status: 409,
        error: 'Unique constraint violation (slug or external_id)',
        details: { message: insertError.message },
      };
    }
    throw insertError;
  }

  await replaceSections(created.id, sections);

  return {
    ok: true,
    status: 201,
    action: 'created',
    post_id: created.id,
    slug: created.slug,
    public_url: buildPublicBlogUrl(created.slug),
  };
}
