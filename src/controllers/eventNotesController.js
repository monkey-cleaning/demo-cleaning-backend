// controllers/eventNotesController.js
// Portado de Monkey Cleaning (Daily 2026-09-11) — notas de cleaners sobre un
// evento/serie (ver db/migrations/20260911_event_notes.sql para el porqué de
// series_key). Compartido por admin (solo lectura, ver calendarRoutes.js) y
// staff (lectura + escritura, ver staffCalendarRoutes.js) — mismo shape de
// nota para ambos, así el admin ve exactamente lo que dejó el cleaner.
import { supabase } from "../supabaseClient.js";

const MAX_NOTE_LEN = 2000;

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

// GET /api/{admin,staff}/calendar/events/notes?seriesKey=...
export async function listEventNotes(req, res) {
  try {
    const seriesKey = req.query.seriesKey;
    if (!seriesKey) {
      return res.status(400).json({ ok: false, error: "seriesKey is required" });
    }
    const { data, error } = await supabase
      .from("event_notes")
      .select("id, body, author_name, created_at")
      .eq("series_key", seriesKey)
      .order("created_at", { ascending: true });
    if (error) throw error;
    return res.json({ ok: true, notes: data ?? [] });
  } catch (e) {
    console.error("❌ listEventNotes:", e.message);
    return res.status(500).json({ ok: false, error: e.message });
  }
}

// POST /api/staff/calendar/events/notes  { seriesKey, eventId, body }
// Requiere requireCleaner — el autor se resuelve del propio JWT (employees
// vía req.cleaner.email), nunca del body, para que un cleaner no pueda
// firmar una nota con otro nombre.
export async function addEventNote(req, res) {
  try {
    const seriesKey = String(req.body?.seriesKey || "").trim();
    const eventId = String(req.body?.eventId || "").trim();
    const body = String(req.body?.body || "").trim();
    if (!seriesKey || !eventId || !body) {
      return res.status(400).json({ ok: false, error: "seriesKey, eventId and body are required" });
    }
    if (body.length > MAX_NOTE_LEN) {
      return res.status(400).json({ ok: false, error: `Note is too long (max ${MAX_NOTE_LEN} characters)` });
    }

    const employee = await resolveEmployeeByEmail(req.cleaner?.email);
    const authorName = employee?.name || req.cleaner?.username || "Cleaner";

    const { data, error } = await supabase
      .from("event_notes")
      .insert({
        series_key: seriesKey,
        event_id: eventId,
        employee_id: employee?.id ?? null,
        author_name: authorName,
        body,
      })
      .select("id, body, author_name, created_at")
      .single();
    if (error) throw error;

    return res.json({ ok: true, note: data });
  } catch (e) {
    console.error("❌ addEventNote:", e.message);
    return res.status(500).json({ ok: false, error: e.message });
  }
}
