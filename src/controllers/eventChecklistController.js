// controllers/eventChecklistController.js
// LAB457 — checklist de indicaciones por evento/serie, con fotos de staff
// (ver db/migrations/20260918_lab457_event_checklist.sql para el porqué de
// series_key vs event_id). Compartido por admin (CRUD de items, ver
// calendarRoutes.js) y staff (lectura + check-off + fotos, ver
// staffCalendarRoutes.js).
import { DateTime } from "luxon";
import { supabase } from "../supabaseClient.js";
import { TZ } from "../config/timezone.js";

// El staff solo puede marcar/subir fotos mientras el evento está en curso y
// hasta esta cantidad de minutos después de terminado.
export const CHECKLIST_GRACE_MINUTES = 60;

const MAX_LABEL_LEN = 300;
const BUCKET = "checklist-photos";
const MAX_PHOTOS_PER_ITEM = 10;
// Las acciones offline se pueden sincronizar con retraso, pero no indefinido.
const MAX_ACTED_AT_AGE_DAYS = 3;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CLIENT_REF_RE = /^[A-Za-z0-9-]{8,64}$/;

// actedAt (ISO) que manda la cola offline: la hora real de la acción. Se acota
// a [ahora - 3 días, ahora]; fuera de ese rango (o inválido) se ignora y vale
// la hora del servidor, así un reloj mal puesto no abre la ventana.
export function parseActedAt(raw) {
  if (!raw) return null;
  const dt = DateTime.fromISO(String(raw));
  if (!dt.isValid) return null;
  const now = DateTime.now();
  if (dt > now.plus({ minutes: 2 })) return null;
  if (dt < now.minus({ days: MAX_ACTED_AT_AGE_DAYS })) return null;
  return dt > now ? now : dt;
}

// client_ref: UUID que genera el celular por foto/envío para que un reintento
// no duplique (ver migración 20260923_lab463_offline_idempotency.sql).
export function parseClientRef(raw) {
  const ref = String(raw ?? "").trim();
  return CLIENT_REF_RE.test(ref) ? ref : null;
}

async function resolveEmployeeByEmail(email) {
  if (!email) return null;
  const { data, error } = await supabase
    .from("employees")
    .select("id, name")
    .ilike("email", email)
    .maybeSingle();
  if (error) {
    console.warn("⚠️  resolveEmployeeByEmail failed:", error.message);
    return null;
  }
  return data || null;
}

// Regla de ventana (pura, para poder testearla sin base): editable desde el
// inicio del evento hasta `graceMinutes` después de su fin. Devuelve null si se
// puede editar, o { code, error } si no.
export function evaluateChecklistWindow(start, end, now = DateTime.now(), graceMinutes = CHECKLIST_GRACE_MINUTES) {
  if (now < start) {
    return { code: "EVENT_NOT_STARTED", error: "This visit hasn't started yet, so its checklist can't be updated." };
  }
  if (now > end.plus({ minutes: graceMinutes })) {
    return { code: "EVENT_CLOSED", error: "This visit is over: the checklist can only be updated until 1 hour after it ends." };
  }
  return null;
}

// Lee el appointment (fuente de verdad) y aplica la ventana de escritura del
// staff. Devuelve { blocked, ev }: `blocked` es null si el staff puede escribir
// ahora, o { status, code, error }; `ev` trae lo que necesitan también los
// envíos a central para copiar título/dirección/cliente:
// { id, seriesId, summary, location, clientId, startIso, endIso }.
export async function loadEventForWrite(eventId, actedAt = null) {
  const notFound = { blocked: { status: 404, code: "EVENT_NOT_FOUND", error: "Event not found." }, ev: null };
  if (!UUID_RE.test(String(eventId))) return notFound;
  const { data: row, error } = await supabase
    .from("appointments")
    .select("id, series_id, gcal_summary, property_address, client_id, starts_at, ends_at, status")
    .eq("id", eventId)
    .maybeSingle();
  if (error) throw error;
  if (!row || row.status === "cancelled") return notFound;

  const ev = {
    id: row.id,
    seriesId: row.series_id ?? null,
    summary: row.gcal_summary ?? null,
    location: row.property_address ?? null,
    clientId: row.client_id ?? null,
    startIso: row.starts_at,
    endIso: row.ends_at,
  };
  const start = row.starts_at ? DateTime.fromISO(row.starts_at, { zone: TZ }) : null;
  const end = row.ends_at ? DateTime.fromISO(row.ends_at, { zone: TZ }) : null;
  if (!start?.isValid || !end?.isValid) {
    return { blocked: { status: 500, code: "EVENT_TIME_UNKNOWN", error: "Could not read the event's time." }, ev };
  }
  // LAB463 — acciones hechas offline se validan contra la hora en que el
  // cleaner las hizo (actedAt), no contra la hora en que llegan al servidor;
  // si no, algo hecho dentro de la ventana pero sincronizado horas después
  // (casa sin señal) se rechazaría.
  const window = evaluateChecklistWindow(start, end, actedAt ?? DateTime.now());
  return { blocked: window ? { status: 403, ...window } : null, ev };
}

export const GENERAL_SERIES_KEY = "__general__";
const ITEM_COLS = "id, label, sort_order, is_general, require_photo";

function toItem(row) {
  return {
    id: row.id,
    label: row.label,
    sort_order: row.sort_order,
    isGeneral: !!(row.is_general ?? row.isGeneral),
    requirePhoto: !!(row.require_photo ?? row.requirePhoto),
  };
}

// Lista viva: items generales (por sort_order) y después los específicos de la
// serie. Es lo que ve el staff hasta que la visita tiene snapshot.
export async function loadLiveChecklistItems(seriesKey) {
  const [general, specific] = await Promise.all([
    supabase
      .from("event_checklist_items")
      .select(ITEM_COLS)
      .eq("is_general", true)
      .is("archived_at", null)
      .order("sort_order", { ascending: true }),
    supabase
      .from("event_checklist_items")
      .select(ITEM_COLS)
      .eq("series_key", seriesKey)
      .eq("is_general", false)
      .is("archived_at", null)
      .order("sort_order", { ascending: true }),
  ]);
  if (general.error) throw general.error;
  if (specific.error) throw specific.error;
  return [...(general.data ?? []), ...(specific.data ?? [])].map(toItem);
}

// Snapshots de un set de eventos: Map(eventId -> items[]).
export async function loadSnapshots(eventIds) {
  const out = new Map();
  for (let i = 0; i < eventIds.length; i += 100) {
    const { data, error } = await supabase
      .from("event_checklist_snapshots")
      .select("event_id, items")
      .in("event_id", eventIds.slice(i, i + 100));
    if (error) throw error;
    for (const row of data ?? []) out.set(row.event_id, (row.items ?? []).map(toItem));
  }
  return out;
}

// La lista que corresponde a una ocurrencia: su snapshot si ya existe (la
// visita ya empezó a ejecutarse), si no la lista viva.
export async function resolveChecklist(seriesKey, eventId) {
  const snaps = await loadSnapshots([eventId]);
  if (snaps.has(eventId)) return { items: snaps.get(eventId), fromSnapshot: true };
  return { items: await loadLiveChecklistItems(seriesKey), fromSnapshot: false };
}

// Congela la lista la primera vez que el staff escribe en la ocurrencia. Si dos
// cleaners escriben a la vez gana el primero (ignoreDuplicates).
async function ensureSnapshot(eventId, seriesKey, resolved) {
  if (resolved.fromSnapshot) return;
  const { error } = await supabase.from("event_checklist_snapshots").upsert(
    { event_id: eventId, series_key: seriesKey, items: resolved.items },
    { onConflict: "event_id", ignoreDuplicates: true },
  );
  if (error) throw error;
}

async function findPhotoByRef(itemId, eventId, clientRef) {
  const { data, error } = await supabase
    .from("event_checklist_photos")
    .select("id, photo_url")
    .eq("item_id", itemId)
    .eq("event_id", eventId)
    .eq("client_ref", clientRef)
    .maybeSingle();
  if (error) throw error;
  return data;
}

function extractStoragePath(url) {
  if (!url) return null;
  const marker = "/storage/v1/object/public/";
  const idx = url.indexOf(marker);
  if (idx === -1) return null;
  const after = url.slice(idx + marker.length);
  const prefix = `${BUCKET}/`;
  if (!after.startsWith(prefix)) return null;
  return after.slice(prefix.length);
}

// GET /api/{admin,staff}/calendar/events/checklist?seriesKey=...&eventId=...
// Sin eventId: solo los items específicos de la serie (el admin editando el
// evento; el general se edita aparte). Con eventId: la lista completa de esa
// ocurrencia (general + específicos, o su snapshot) con el estado de cada item.
export async function listChecklist(req, res) {
  try {
    const seriesKey = req.query.seriesKey;
    const eventId = req.query.eventId || null;
    if (!seriesKey) {
      return res.status(400).json({ ok: false, error: "seriesKey is required" });
    }

    let items;
    if (eventId) {
      items = (await resolveChecklist(seriesKey, eventId)).items;
    } else {
      const { data, error } = await supabase
        .from("event_checklist_items")
        .select(ITEM_COLS)
        .eq("series_key", seriesKey)
        .eq("is_general", false)
        .is("archived_at", null)
        .order("sort_order", { ascending: true });
      if (error) throw error;
      items = (data ?? []).map(toItem);
    }

    if (!eventId || !items.length) {
      return res.json({ ok: true, items: items.map((i) => ({ ...i, completed: false, completedAt: null, photos: [] })) });
    }

    const itemIds = items.map((i) => i.id);
    const [{ data: completions, error: compErr }, { data: photos, error: photoErr }] = await Promise.all([
      supabase
        .from("event_checklist_completions")
        .select("item_id, completed_at, employee:employees(name)")
        .eq("event_id", eventId)
        .in("item_id", itemIds),
      supabase
        .from("event_checklist_photos")
        .select("id, item_id, photo_url")
        .eq("event_id", eventId)
        .in("item_id", itemIds)
        .order("created_at", { ascending: true }),
    ]);
    if (compErr) throw compErr;
    if (photoErr) throw photoErr;

    const completionByItem = new Map((completions ?? []).map((c) => [c.item_id, c]));
    const photosByItem = new Map();
    for (const p of photos ?? []) {
      if (!photosByItem.has(p.item_id)) photosByItem.set(p.item_id, []);
      photosByItem.get(p.item_id).push({ id: p.id, url: p.photo_url });
    }
    const merged = items.map((i) => {
      const c = completionByItem.get(i.id);
      return {
        ...i,
        completed: !!c?.completed_at,
        completedAt: c?.completed_at ?? null,
        completedBy: c?.completed_at ? c?.employee?.name ?? null : null,
        photos: photosByItem.get(i.id) ?? [],
      };
    });
    return res.json({ ok: true, items: merged });
  } catch (e) {
    console.error("❌ listChecklist:", e.message);
    return res.status(500).json({ ok: false, error: e.message });
  }
}

function validateLabel(raw) {
  const label = String(raw ?? "").trim();
  if (!label) return { error: "label is required" };
  if (label.length > MAX_LABEL_LEN) return { error: `Label is too long (max ${MAX_LABEL_LEN} characters)` };
  return { label };
}

async function nextSortOrder(seriesKey) {
  const { data } = await supabase
    .from("event_checklist_items")
    .select("sort_order")
    .eq("series_key", seriesKey)
    .order("sort_order", { ascending: false })
    .limit(1)
    .maybeSingle();
  return (data?.sort_order ?? -1) + 1;
}

// Alta de un item. `general` = true crea un item del checklist general.
async function insertItem(req, res, general) {
  try {
    const seriesKey = general ? GENERAL_SERIES_KEY : String(req.body?.seriesKey || "").trim();
    const { label, error: labelErr } = validateLabel(req.body?.label);
    if (!seriesKey || labelErr) {
      return res.status(400).json({ ok: false, error: labelErr ?? "seriesKey and label are required" });
    }
    const { data, error } = await supabase
      .from("event_checklist_items")
      .insert({
        series_key: seriesKey,
        label,
        sort_order: await nextSortOrder(seriesKey),
        is_general: general,
        require_photo: !!req.body?.requirePhoto,
      })
      .select(ITEM_COLS)
      .single();
    if (error) throw error;
    return res.json({ ok: true, item: { ...toItem(data), completed: false, completedAt: null, photos: [] } });
  } catch (e) {
    console.error("❌ addChecklistItem:", e.message);
    return res.status(500).json({ ok: false, error: e.message });
  }
}

async function patchItem(req, res, general) {
  try {
    const { itemId } = req.params;
    const patch = {};
    if (req.body?.label !== undefined) {
      const { label, error: labelErr } = validateLabel(req.body.label);
      if (labelErr) return res.status(400).json({ ok: false, error: labelErr });
      patch.label = label;
    }
    if (req.body?.sortOrder !== undefined) patch.sort_order = Number(req.body.sortOrder);
    if (req.body?.requirePhoto !== undefined) patch.require_photo = !!req.body.requirePhoto;
    if (!Object.keys(patch).length) {
      return res.status(400).json({ ok: false, error: "nothing to update" });
    }
    const { data, error } = await supabase
      .from("event_checklist_items")
      .update(patch)
      .eq("id", itemId)
      .eq("is_general", general)
      .select(ITEM_COLS)
      .single();
    if (error) throw error;
    return res.json({ ok: true, item: toItem(data) });
  } catch (e) {
    console.error("❌ updateChecklistItem:", e.message);
    return res.status(500).json({ ok: false, error: e.message });
  }
}

// Soft delete — conserva las fotos/historial ya cargados por staff y los
// snapshots que lo referencian; solo deja de aparecer en la lista viva.
async function archiveItem(req, res, general) {
  try {
    const { error } = await supabase
      .from("event_checklist_items")
      .update({ archived_at: new Date().toISOString() })
      .eq("id", req.params.itemId)
      .eq("is_general", general);
    if (error) throw error;
    return res.json({ ok: true });
  } catch (e) {
    console.error("❌ archiveChecklistItem:", e.message);
    return res.status(500).json({ ok: false, error: e.message });
  }
}

// POST /api/admin/calendar/events/checklist  { seriesKey, label, requirePhoto? }
export const addChecklistItem = (req, res) => insertItem(req, res, false);
// PATCH /api/admin/calendar/events/checklist/:itemId  { label?, sortOrder?, requirePhoto? }
export const updateChecklistItem = (req, res) => patchItem(req, res, false);
// DELETE /api/admin/calendar/events/checklist/:itemId
export const archiveChecklistItem = (req, res) => archiveItem(req, res, false);

// ── Checklist general (aplica a todas las limpiezas) ─────────────────────
// GET /api/admin/calendar/checklist/general
export async function listGeneralChecklist(_req, res) {
  try {
    const { data, error } = await supabase
      .from("event_checklist_items")
      .select(ITEM_COLS)
      .eq("is_general", true)
      .is("archived_at", null)
      .order("sort_order", { ascending: true });
    if (error) throw error;
    return res.json({ ok: true, items: (data ?? []).map(toItem) });
  } catch (e) {
    console.error("❌ listGeneralChecklist:", e.message);
    return res.status(500).json({ ok: false, error: e.message });
  }
}
export const addGeneralChecklistItem = (req, res) => insertItem(req, res, true);
export const updateGeneralChecklistItem = (req, res) => patchItem(req, res, true);
export const archiveGeneralChecklistItem = (req, res) => archiveItem(req, res, true);

// PUT /api/admin/calendar/checklist/general/order  { ids: [...] }
// Reasigna sort_order según la posición en `ids`.
export async function reorderGeneralChecklist(req, res) {
  try {
    const ids = req.body?.ids;
    if (!Array.isArray(ids) || !ids.length || ids.some((i) => typeof i !== "string")) {
      return res.status(400).json({ ok: false, error: "ids must be a non-empty array" });
    }
    await Promise.all(
      ids.map((id, idx) =>
        supabase
          .from("event_checklist_items")
          .update({ sort_order: idx })
          .eq("id", id)
          .eq("is_general", true)
          .then(({ error }) => {
            if (error) throw error;
          }),
      ),
    );
    return res.json({ ok: true });
  } catch (e) {
    console.error("❌ reorderGeneralChecklist:", e.message);
    return res.status(500).json({ ok: false, error: e.message });
  }
}

// PATCH /api/staff/calendar/events/checklist/:itemId/completion  { eventId, completed }
// Requiere requireCleaner — compartido por todo el equipo asignado a la
// visita (cualquiera lo puede marcar/desmarcar, no hay estado por-persona).
// Un item con foto obligatoria no se puede completar sin al menos una foto.
export async function setChecklistCompletion(req, res) {
  try {
    const { itemId } = req.params;
    const eventId = String(req.body?.eventId || "").trim();
    const completed = !!req.body?.completed;
    if (!eventId) {
      return res.status(400).json({ ok: false, error: "eventId is required" });
    }
    const actedAt = parseActedAt(req.body?.actedAt);
    const { blocked, ev } = await loadEventForWrite(eventId, actedAt);
    if (blocked) return res.status(blocked.status).json({ ok: false, code: blocked.code, error: blocked.error });

    const seriesKey = ev.seriesId || ev.id;
    const resolved = await resolveChecklist(seriesKey, eventId);
    const item = resolved.items.find((i) => i.id === itemId);
    if (!item) return res.status(404).json({ ok: false, error: "Checklist item not found for this visit" });

    if (completed && item.requirePhoto) {
      const { count, error: countErr } = await supabase
        .from("event_checklist_photos")
        .select("id", { count: "exact", head: true })
        .eq("item_id", itemId)
        .eq("event_id", eventId);
      if (countErr) throw countErr;
      if (!count) {
        return res.status(400).json({
          ok: false,
          code: "PHOTO_REQUIRED",
          error: "This item needs a photo before it can be marked as completed.",
        });
      }
    }

    await ensureSnapshot(eventId, seriesKey, resolved);
    const employee = await resolveEmployeeByEmail(req.cleaner?.email);
    const actionIso = (actedAt ?? DateTime.now()).toUTC().toISO();

    // Última acción gana por hora real: si otro cleaner (o este mismo desde otro
    // dispositivo) ya escribió algo más nuevo, la acción offline atrasada se
    // descarta en vez de pisarlo. Solo aplica cuando viene actedAt.
    if (actedAt) {
      const { data: existing, error: exErr } = await supabase
        .from("event_checklist_completions")
        .select("completed_at, updated_at, employee:employees(name)")
        .eq("item_id", itemId)
        .eq("event_id", eventId)
        .maybeSingle();
      if (exErr) throw exErr;
      if (existing && new Date(existing.updated_at) > new Date(actionIso)) {
        return res.json({
          ok: true,
          ignored: true,
          completed: !!existing.completed_at,
          completedAt: existing.completed_at,
          completedBy: existing.completed_at ? existing.employee?.name ?? null : null,
        });
      }
    }

    const { data, error } = await supabase
      .from("event_checklist_completions")
      .upsert(
        {
          item_id: itemId,
          event_id: eventId,
          employee_id: employee?.id ?? null,
          completed_at: completed ? actionIso : null,
          updated_at: actionIso,
        },
        { onConflict: "item_id,event_id" },
      )
      .select("item_id, completed_at")
      .single();
    if (error) throw error;

    return res.json({
      ok: true,
      completed: !!data.completed_at,
      completedAt: data.completed_at,
      completedBy: data.completed_at ? employee?.name ?? null : null,
    });
  } catch (e) {
    console.error("❌ setChecklistCompletion:", e.message);
    return res.status(500).json({ ok: false, error: e.message });
  }
}

// POST /api/staff/calendar/events/checklist/:itemId/photo-upload-url  { eventId }
// El staff nunca tiene una key con permiso de escritura al bucket — el
// backend firma una URL de subida de un solo uso, acotada a un path que
// arranca con eventId/itemId/ (attachChecklistPhoto valida ese prefijo antes
// de guardar nada).
export async function getChecklistPhotoUploadUrl(req, res) {
  try {
    const { itemId } = req.params;
    const eventId = String(req.body?.eventId || "").trim();
    if (!eventId) {
      return res.status(400).json({ ok: false, error: "eventId is required" });
    }

    const { blocked } = await loadEventForWrite(eventId, parseActedAt(req.body?.actedAt));
    if (blocked) return res.status(blocked.status).json({ ok: false, code: blocked.code, error: blocked.error });

    const clientRef = parseClientRef(req.body?.clientRef);
    const { count, error: countErr } = await supabase
      .from("event_checklist_photos")
      .select("id", { count: "exact", head: true })
      .eq("item_id", itemId)
      .eq("event_id", eventId);
    if (countErr) throw countErr;
    if ((count ?? 0) >= MAX_PHOTOS_PER_ITEM) {
      // Un reintento de una foto que ya quedó guardada no es una foto nueva.
      const already = clientRef && (await findPhotoByRef(itemId, eventId, clientRef));
      if (!already) {
        return res.status(400).json({ ok: false, error: `Max ${MAX_PHOTOS_PER_ITEM} photos per item` });
      }
    }

    // Con clientRef el path es determinista (reintentar sobrescribe el mismo
    // archivo en vez de dejar huérfanos); sin él, el random de siempre.
    const path = clientRef
      ? `${eventId}/${itemId}/${clientRef}.jpg`
      : `${eventId}/${itemId}/${Date.now()}-${Math.random().toString(36).slice(2, 8)}.jpg`;
    const { data, error } = await supabase.storage.from(BUCKET).createSignedUploadUrl(path, { upsert: true });
    if (error) throw error;

    return res.json({ ok: true, path, token: data.token, signedUrl: data.signedUrl });
  } catch (e) {
    console.error("❌ getChecklistPhotoUploadUrl:", e.message);
    return res.status(500).json({ ok: false, error: e.message });
  }
}

// PATCH /api/staff/calendar/events/checklist/:itemId/photo  { eventId, path }
// Suma una foto al item (puede haber varias). NO toca el check-off: marcar
// el item como hecho es siempre una acción manual del cleaner.
export async function attachChecklistPhoto(req, res) {
  try {
    const { itemId } = req.params;
    const eventId = String(req.body?.eventId || "").trim();
    const path = String(req.body?.path || "").trim();
    if (!eventId || !path) {
      return res.status(400).json({ ok: false, error: "eventId and path are required" });
    }
    if (!path.startsWith(`${eventId}/${itemId}/`)) {
      return res.status(400).json({ ok: false, error: "path does not match eventId/itemId" });
    }
    const actedAt = parseActedAt(req.body?.actedAt);
    const clientRef = parseClientRef(req.body?.clientRef);
    const { blocked, ev } = await loadEventForWrite(eventId, actedAt);
    if (blocked) return res.status(blocked.status).json({ ok: false, code: blocked.code, error: blocked.error });

    // Reintento de una foto que ya se guardó: devolver la misma, no duplicar.
    if (clientRef) {
      const existing = await findPhotoByRef(itemId, eventId, clientRef);
      if (existing) return res.json({ ok: true, duplicate: true, photo: { id: existing.id, url: existing.photo_url } });
    }

    const seriesKey = ev.seriesId || ev.id;
    const resolved = await resolveChecklist(seriesKey, eventId);
    if (!resolved.items.some((i) => i.id === itemId)) {
      return res.status(404).json({ ok: false, error: "Checklist item not found for this visit" });
    }
    await ensureSnapshot(eventId, seriesKey, resolved);

    const { data: pub } = supabase.storage.from(BUCKET).getPublicUrl(path);
    const employee = await resolveEmployeeByEmail(req.cleaner?.email);

    const { data, error } = await supabase
      .from("event_checklist_photos")
      .insert({
        item_id: itemId,
        event_id: eventId,
        employee_id: employee?.id ?? null,
        photo_url: pub.publicUrl,
        client_ref: clientRef,
        ...(actedAt ? { created_at: actedAt.toUTC().toISO() } : {}),
      })
      .select("id, photo_url")
      .single();
    if (error) {
      // Dos reintentos en paralelo: gana uno, el otro recibe la misma fila.
      if (error.code === "23505" && clientRef) {
        const existing = await findPhotoByRef(itemId, eventId, clientRef);
        if (existing) return res.json({ ok: true, duplicate: true, photo: { id: existing.id, url: existing.photo_url } });
      }
      throw error;
    }

    return res.json({ ok: true, photo: { id: data.id, url: data.photo_url } });
  } catch (e) {
    console.error("❌ attachChecklistPhoto:", e.message);
    return res.status(500).json({ ok: false, error: e.message });
  }
}

// DELETE /api/staff/calendar/events/checklist/:itemId/photos/:photoId
// Reemplaza al viejo "retomar foto": ahora se borra la que salió mal y se
// sube otra. Cualquiera del equipo puede borrar (mismo criterio compartido
// que el check-off). Si era la última foto de un item con foto obligatoria que
// estaba completado, el item vuelve a pendiente (no puede quedar completado
// sin foto).
export async function deleteChecklistPhoto(req, res) {
  try {
    const { itemId, photoId } = req.params;
    const { data: photo, error } = await supabase
      .from("event_checklist_photos")
      .select("id, photo_url, event_id")
      .eq("id", photoId)
      .eq("item_id", itemId)
      .maybeSingle();
    if (error) throw error;
    if (!photo) return res.status(404).json({ ok: false, error: "Photo not found" });

    const { blocked, ev } = await loadEventForWrite(photo.event_id);
    if (blocked) return res.status(blocked.status).json({ ok: false, code: blocked.code, error: blocked.error });

    const path = extractStoragePath(photo.photo_url);
    if (path) {
      const { error: removeErr } = await supabase.storage.from(BUCKET).remove([path]);
      if (removeErr) console.warn("⚠️  deleteChecklistPhoto storage.remove:", removeErr.message);
    }
    const { error: delErr } = await supabase.from("event_checklist_photos").delete().eq("id", photoId);
    if (delErr) throw delErr;

    let uncompleted = false;
    const { items } = await resolveChecklist(ev.seriesId || ev.id, photo.event_id);
    if (items.find((i) => i.id === itemId)?.requirePhoto) {
      const { count, error: countErr } = await supabase
        .from("event_checklist_photos")
        .select("id", { count: "exact", head: true })
        .eq("item_id", itemId)
        .eq("event_id", photo.event_id);
      if (countErr) throw countErr;
      if (!count) {
        const { error: upErr } = await supabase
          .from("event_checklist_completions")
          .update({ completed_at: null, updated_at: new Date().toISOString() })
          .eq("item_id", itemId)
          .eq("event_id", photo.event_id)
          .not("completed_at", "is", null);
        if (upErr) throw upErr;
        uncompleted = true;
      }
    }

    return res.json({ ok: true, uncompleted });
  } catch (e) {
    console.error("❌ deleteChecklistPhoto:", e.message);
    return res.status(500).json({ ok: false, error: e.message });
  }
}

// Llamado desde calendarController.deleteCalendarEvent — las fotos de una
// ocurrencia puntual dejan de tener sentido si esa ocurrencia se borra del
// calendario (los items de la serie, en cambio, se conservan: si es un
// evento recurrente siguen valiendo para la próxima instancia). No falla el
// delete del evento si esto falla — es best-effort, mismo criterio que el
// resto de la limpieza secundaria en deleteCalendarEvent.
export async function cleanupChecklistPhotosForEvents(eventIds) {
  if (!eventIds?.length) return;
  try {
    const { data: photos, error } = await supabase
      .from("event_checklist_photos")
      .select("photo_url")
      .in("event_id", eventIds);
    if (error) throw error;

    const paths = (photos ?? []).map((p) => extractStoragePath(p.photo_url)).filter(Boolean);
    if (paths.length) {
      const { error: removeErr } = await supabase.storage.from(BUCKET).remove(paths);
      if (removeErr) console.warn("⚠️  cleanupChecklistPhotosForEvents storage.remove:", removeErr.message);
    }

    const { error: photoDelErr } = await supabase
      .from("event_checklist_photos")
      .delete()
      .in("event_id", eventIds);
    if (photoDelErr) throw photoDelErr;

    const { error: delErr } = await supabase
      .from("event_checklist_completions")
      .delete()
      .in("event_id", eventIds);
    if (delErr) throw delErr;

    const { error: snapErr } = await supabase
      .from("event_checklist_snapshots")
      .delete()
      .in("event_id", eventIds);
    if (snapErr) throw snapErr;
  } catch (e) {
    console.warn("⚠️  cleanupChecklistPhotosForEvents failed:", e.message);
  }
}
