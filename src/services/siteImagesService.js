// ─────────────────────────────────────────────────────────────────────────────
// siteImagesService.js  (LAB447)
//
// Overrides de las imágenes de la landing. Los archivos viven en el bucket
// público 'site-images' y la tabla site_images mapea slot → URL. Los slots los
// define el frontend (src/config/siteImages.ts); acá solo se valida el formato.
// ─────────────────────────────────────────────────────────────────────────────

import { supabase } from "../supabaseClient.js";

export const SITE_IMAGES_BUCKET = "site-images";
export const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
export const SLOT_RE = /^[a-z0-9][a-z0-9._-]{0,79}$/;

const EXT_BY_MIME = Object.freeze({
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/avif": "avif",
});
export const ALLOWED_MIME = Object.keys(EXT_BY_MIME);

let bucketReady = false;

async function ensureBucket() {
  if (bucketReady) return;
  const { data: buckets, error } = await supabase.storage.listBuckets();
  if (error) throw error;
  if (!buckets.some((b) => b.name === SITE_IMAGES_BUCKET)) {
    const { error: createErr } = await supabase.storage.createBucket(
      SITE_IMAGES_BUCKET,
      { public: true, fileSizeLimit: MAX_IMAGE_BYTES },
    );
    // Carrera entre dos requests: si ya existe, ok.
    if (createErr && !/already exists/i.test(createErr.message)) throw createErr;
  }
  bucketReady = true;
}

/** { [slot]: url } — la URL lleva ?v=<updated_at> para invalidar caches del CDN/browser. */
export async function listSiteImages() {
  const { data, error } = await supabase
    .from("site_images")
    .select("slot, url, updated_at");
  if (error) throw error;
  const out = {};
  for (const row of data ?? []) {
    out[row.slot] = `${row.url}?v=${new Date(row.updated_at).getTime()}`;
  }
  return out;
}

export async function setSiteImage(slot, buffer, mime) {
  const ext = EXT_BY_MIME[mime];
  await ensureBucket();

  const { data: prev } = await supabase
    .from("site_images")
    .select("storage_path")
    .eq("slot", slot)
    .maybeSingle();

  // Path único por subida: evita servir la versión vieja desde cache.
  const storagePath = `${slot}/${Date.now()}.${ext}`;
  const { error: upErr } = await supabase.storage
    .from(SITE_IMAGES_BUCKET)
    .upload(storagePath, buffer, { contentType: mime, cacheControl: "31536000" });
  if (upErr) throw upErr;

  const { data: pub } = supabase.storage
    .from(SITE_IMAGES_BUCKET)
    .getPublicUrl(storagePath);

  const { error: dbErr } = await supabase.from("site_images").upsert({
    slot,
    url: pub.publicUrl,
    storage_path: storagePath,
    updated_at: new Date().toISOString(),
  });
  if (dbErr) {
    await supabase.storage.from(SITE_IMAGES_BUCKET).remove([storagePath]);
    throw dbErr;
  }

  if (prev?.storage_path) {
    await supabase.storage.from(SITE_IMAGES_BUCKET).remove([prev.storage_path]);
  }
}

/** Vuelve al default: borra fila y archivo. Idempotente. */
export async function resetSiteImage(slot) {
  const { data: prev } = await supabase
    .from("site_images")
    .select("storage_path")
    .eq("slot", slot)
    .maybeSingle();
  if (!prev) return;
  const { error } = await supabase.from("site_images").delete().eq("slot", slot);
  if (error) throw error;
  await supabase.storage.from(SITE_IMAGES_BUCKET).remove([prev.storage_path]);
}
