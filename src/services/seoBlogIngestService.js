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
  resolveExcerpt,
  stripMarkdownToPlain,
  truncateAtWord,
  REQUIRED_FIELDS,
} from './seoBlogIngestMapper.js';

/**
 * Mapea errores Postgres a respuesta HTTP tipada (nunca 500 sin code).
 * @returns {{ status: number, code: string, error: string, details?: object } | null}
 */
export function mapIngestDbError(err) {
  if (!err || typeof err !== 'object') return null;
  const pgCode = err.code;

  if (pgCode === '23505') {
    return {
      status: 409,
      code: 'conflict',
      error: 'Unique constraint violation (slug or external_id)',
      details: { message: err.message, constraint: err.details ?? null },
    };
  }

  if (pgCode === '23502') {
    return {
      status: 400,
      code: 'db_not_null',
      error: 'Missing required database field',
      details: { message: err.message, column: err.details ?? null },
    };
  }

  if (typeof pgCode === 'string' && /^23/.test(pgCode)) {
    return {
      status: 400,
      code: 'db_constraint',
      error: 'Database constraint violation',
      details: { message: err.message, pg_code: pgCode },
    };
  }

  return null;
}

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
        code: 'slug_conflict',
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

    if (updateError) {
      const mapped = mapIngestDbError(updateError);
      if (mapped) return { ok: false, ...mapped };
      throw updateError;
    }

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
      code: 'slug_conflict',
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
    const mapped = mapIngestDbError(insertError);
    if (mapped) return { ok: false, ...mapped };
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
