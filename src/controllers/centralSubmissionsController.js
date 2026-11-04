// controllers/centralSubmissionsController.js
// LAB462 — "Send to Central": el cleaner manda fotos + un comentario corto a la
// oficina desde un evento, fuera del checklist (ver la migración
// 20260922_lab462_general_checklist_central.sql). El staff crea (namespace
// /api/staff/calendar) y el admin las lista y las marca como revisadas
// (namespace /api/calendar).
//
// Las fotos usan el mismo bucket y el mismo patrón de signed upload URL que
// las del checklist (eventChecklistController.js), bajo el prefijo
// central/<eventId>/. El evento y el cliente se copian a la fila del envío para
// que sobreviva aunque el evento se borre del calendario.
import { DateTime } from "luxon";
import { supabase } from "../supabaseClient.js";
import { loadEventForWrite, parseActedAt, parseClientRef } from "./eventChecklistController.js";
import { TZ } from "../config/timezone.js";
import { sendCentralSubmissionAlert } from "../services/opsNotificationService.js";

const BUCKET = "checklist-photos";
const MAX_PHOTOS = 10;
const MAX_COMMENT_LEN = 500;
const DEFAULT_RANGE_DAYS = 30;
const MAX_ROWS = 300;

const COLS =
  "id, event_id, client_id, client_name, event_summary, event_start, location, employee_name, comment, photo_urls, created_at, reviewed_at";

function toDto(r) {
  return {
    id: r.id,
    eventId: r.event_id,
    clientId: r.client_id,
    clientName: r.client_name,
    eventSummary: r.event_summary,
    eventStart: r.event_start,
    location: r.location,
    sentBy: r.employee_name,
    comment: r.comment,
    photos: r.photo_urls ?? [],
    createdAt: r.created_at,
    reviewedAt: r.reviewed_at,
  };
}

async function resolveEmployeeByEmail(email) {
  if (!email) return null;
  const { data, error } = await supabase
    .from("employees")
    .select("id, name")
    .ilike("email", email)
    .maybeSingle();
  if (error) {
    console.warn("⚠️  central resolveEmployeeByEmail failed:", error.message);
    return null;
  }
  return data || null;
}

async function resolveClientForEvent(eventId) {
  const { data: appt } = await supabase
    .from("appointments")
    .select("client_id")
    .eq("id", eventId)
    .not("client_id", "is", null)
    .limit(1)
    .maybeSingle();
  if (!appt?.client_id) return { clientId: null, clientName: null };
  // clients no tiene columna `name`: el nombre se arma con first_name + last_name.
  const { data: client, error } = await supabase
    .from("clients")
    .select("id, first_name, last_name")
    .eq("id", appt.client_id)
    .maybeSingle();
  if (error) console.warn("⚠️  central resolveClientForEvent failed:", error.message);
  const name = [client?.first_name, client?.last_name].filter(Boolean).join(" ").replace(/\s+/g, " ").trim();
  // Cliente placeholder de los appointments sin cliente real: no aporta nada.
  const clientName = name && name.toLowerCase() !== "unassigned unassigned" ? name : null;
  return { clientId: appt.client_id, clientName };
}

// POST /api/staff/calendar/events/central/photo-upload-url  { eventId }
export async function getCentralPhotoUploadUrl(req, res) {
  try {
    const eventId = String(req.body?.eventId || "").trim();
    if (!eventId) return res.status(400).json({ ok: false, error: "eventId is required" });

    const { blocked } = await loadEventForWrite(eventId, parseActedAt(req.body?.actedAt));
    if (blocked) return res.status(blocked.status).json({ ok: false, code: blocked.code, error: blocked.error });

    // LAB463 — con clientRef el path es determinista (`<ref>-<n>`): reintentar
    // sobrescribe el mismo archivo en vez de dejar huérfanos.
    const clientRef = parseClientRef(req.body?.clientRef);
    const index = Math.min(Math.max(parseInt(req.body?.index, 10) || 0, 0), MAX_PHOTOS - 1);
    const path = clientRef
      ? `central/${eventId}/${clientRef}-${index}.jpg`
      : `central/${eventId}/${Date.now()}-${Math.random().toString(36).slice(2, 8)}.jpg`;
    const { data, error } = await supabase.storage.from(BUCKET).createSignedUploadUrl(path, { upsert: true });
    if (error) throw error;
    return res.json({ ok: true, path, token: data.token, signedUrl: data.signedUrl });
  } catch (e) {
    console.error("❌ getCentralPhotoUploadUrl:", e.message);
    return res.status(500).json({ ok: false, error: e.message });
  }
}

// POST /api/staff/calendar/events/central  { eventId, comment?, paths: [...] }
// `paths` son los archivos ya subidos con las signed URLs de arriba. Requiere
// al menos una foto.
export async function createCentralSubmission(req, res) {
  try {
    const eventId = String(req.body?.eventId || "").trim();
    const comment = String(req.body?.comment || "").trim();
    const paths = Array.isArray(req.body?.paths) ? req.body.paths.map((p) => String(p).trim()) : [];
    if (!eventId) return res.status(400).json({ ok: false, error: "eventId is required" });
    if (!paths.length) return res.status(400).json({ ok: false, error: "Add at least one photo." });
    if (paths.length > MAX_PHOTOS) {
      return res.status(400).json({ ok: false, error: `Max ${MAX_PHOTOS} photos per message` });
    }
    if (comment.length > MAX_COMMENT_LEN) {
      return res.status(400).json({ ok: false, error: `Comment is too long (max ${MAX_COMMENT_LEN} characters)` });
    }
    if (paths.some((p) => !p.startsWith(`central/${eventId}/`))) {
      return res.status(400).json({ ok: false, error: "path does not match eventId" });
    }
    const clientRef = parseClientRef(req.body?.clientRef);
    const actedAt = parseActedAt(req.body?.actedAt);

    // Reintento de un envío que ya se guardó: devolver el mismo y NO mandar otro mail.
    if (clientRef) {
      const { data: existing, error: exErr } = await supabase
        .from("central_submissions")
        .select(COLS)
        .eq("client_ref", clientRef)
        .maybeSingle();
      if (exErr) throw exErr;
      if (existing) return res.json({ ok: true, duplicate: true, submission: toDto(existing) });
    }

    const { blocked, ev } = await loadEventForWrite(eventId, actedAt);
    if (blocked) return res.status(blocked.status).json({ ok: false, code: blocked.code, error: blocked.error });

    const [employee, client] = await Promise.all([
      resolveEmployeeByEmail(req.cleaner?.email),
      resolveClientForEvent(eventId),
    ]);
    const photoUrls = paths.map((p) => supabase.storage.from(BUCKET).getPublicUrl(p).data.publicUrl);
    const start = ev.startIso ? DateTime.fromISO(ev.startIso) : null;

    const { data, error } = await supabase
      .from("central_submissions")
      .insert({
        event_id: eventId,
        series_key: ev.seriesId || ev.id,
        client_id: client.clientId,
        client_name: client.clientName,
        event_summary: ev.summary ?? null,
        event_start: start ? start.toUTC().toISO() : null,
        location: ev.location ?? null,
        employee_id: employee?.id ?? null,
        employee_name: employee?.name ?? req.cleaner?.username ?? null,
        comment: comment || null,
        photo_urls: photoUrls,
        client_ref: clientRef,
        ...(actedAt ? { created_at: actedAt.toUTC().toISO() } : {}),
      })
      .select(COLS)
      .single();
    if (error) {
      // Dos reintentos en paralelo: gana uno, el otro recibe el mismo envío.
      if (error.code === "23505" && clientRef) {
        const { data: existing } = await supabase.from("central_submissions").select(COLS).eq("client_ref", clientRef).maybeSingle();
        if (existing) return res.json({ ok: true, duplicate: true, submission: toDto(existing) });
      }
      throw error;
    }

    // Aviso a central: no bloquea ni hace fallar el envío (ya quedó guardado).
    sendCentralSubmissionAlert(toDto(data)).catch((e) =>
      console.warn("⚠️  sendCentralSubmissionAlert failed:", e.message),
    );

    return res.json({ ok: true, submission: toDto(data) });
  } catch (e) {
    console.error("❌ createCentralSubmission:", e.message);
    return res.status(500).json({ ok: false, error: e.message });
  }
}

// GET /api/staff/calendar/events/central?eventId=...
// Lo que ya se mandó desde esta visita (para que el cleaner vea que llegó).
export async function listCentralSubmissionsForEvent(req, res) {
  try {
    const eventId = String(req.query.eventId || "").trim();
    if (!eventId) return res.status(400).json({ ok: false, error: "eventId is required" });
    const { data, error } = await supabase
      .from("central_submissions")
      .select(COLS)
      .eq("event_id", eventId)
      .order("created_at", { ascending: true });
    if (error) throw error;
    return res.json({ ok: true, submissions: (data ?? []).map(toDto) });
  } catch (e) {
    console.error("❌ listCentralSubmissionsForEvent:", e.message);
    return res.status(500).json({ ok: false, error: e.message });
  }
}

// GET /api/calendar/central-submissions?from=YYYY-MM-DD&to=YYYY-MM-DD&status=unreviewed|all
// (o ?eventId=... para los de una visita)
// Por fecha de envío (createdAt). Más nuevo primero.
export async function listCentralSubmissions(req, res) {
  try {
    const to = req.query.to
      ? DateTime.fromISO(String(req.query.to), { zone: TZ }).endOf("day")
      : DateTime.now().setZone(TZ).endOf("day");
    const from = req.query.from
      ? DateTime.fromISO(String(req.query.from), { zone: TZ }).startOf("day")
      : to.minus({ days: DEFAULT_RANGE_DAYS - 1 }).startOf("day");
    if (!from.isValid || !to.isValid) {
      return res.status(400).json({ ok: false, error: "from/to must be YYYY-MM-DD" });
    }
    const eventId = String(req.query.eventId || "").trim();
    if (eventId) {
      // Envíos de una visita puntual (popover del calendario admin): sin rango.
      const { data, error } = await supabase
        .from("central_submissions")
        .select(COLS)
        .eq("event_id", eventId)
        .order("created_at", { ascending: true });
      if (error) throw error;
      return res.json({ ok: true, submissions: (data ?? []).map(toDto) });
    }
    let q = supabase
      .from("central_submissions")
      .select(COLS)
      .gte("created_at", from.toUTC().toISO())
      .lte("created_at", to.toUTC().toISO())
      .order("created_at", { ascending: false })
      .limit(MAX_ROWS);
    if (req.query.status === "unreviewed") q = q.is("reviewed_at", null);
    const { data, error } = await q;
    if (error) throw error;
    return res.json({ ok: true, submissions: (data ?? []).map(toDto) });
  } catch (e) {
    console.error("❌ listCentralSubmissions:", e.message);
    return res.status(500).json({ ok: false, error: e.message });
  }
}

// GET /api/calendar/central-submissions/unreviewed-count
export async function countUnreviewedCentralSubmissions(_req, res) {
  try {
    const { count, error } = await supabase
      .from("central_submissions")
      .select("id", { count: "exact", head: true })
      .is("reviewed_at", null);
    if (error) throw error;
    return res.json({ ok: true, count: count ?? 0 });
  } catch (e) {
    console.error("❌ countUnreviewedCentralSubmissions:", e.message);
    return res.status(500).json({ ok: false, error: e.message });
  }
}

// PATCH /api/calendar/central-submissions/:id  { reviewed: boolean }
export async function setCentralSubmissionReviewed(req, res) {
  try {
    const reviewed = !!req.body?.reviewed;
    const { data, error } = await supabase
      .from("central_submissions")
      .update({ reviewed_at: reviewed ? new Date().toISOString() : null })
      .eq("id", req.params.id)
      .select(COLS)
      .single();
    if (error) throw error;
    return res.json({ ok: true, submission: toDto(data) });
  } catch (e) {
    console.error("❌ setCentralSubmissionReviewed:", e.message);
    return res.status(500).json({ ok: false, error: e.message });
  }
}

// Usado por el panel de checklists: envíos agrupados por eventId.
export async function loadCentralSubmissionsByEvent(eventIds) {
  const out = new Map();
  for (let i = 0; i < eventIds.length; i += 100) {
    const { data, error } = await supabase
      .from("central_submissions")
      .select(COLS)
      .in("event_id", eventIds.slice(i, i + 100))
      .order("created_at", { ascending: true });
    if (error) throw error;
    for (const r of data ?? []) {
      if (!out.has(r.event_id)) out.set(r.event_id, []);
      out.get(r.event_id).push(toDto(r));
    }
  }
  return out;
}
