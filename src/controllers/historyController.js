// controllers/historyController.js
//
// LAB418 (portado de Monkey Cleaning) — endpoint de lectura sobre
// `record_history`, para dos casos del frontend:
//   - con entity_type + entity_id: historial de UN registro (HistoryDrawer).
//   - sin entity_id: feed global filtrable (página de Actividad).
//
// Solo lectura — la escritura vive en services/recordHistory.js.
//
// NOTA vs Monkey: se quitó el param gcal_event_id (allá el calendario solo
// conocía el id de Google Calendar; acá el frontend ya usa appointments.id).

import { DateTime } from "luxon";
import { supabase } from "../supabaseClient.js";
import { GLOBAL_ENTITY_ID } from "../services/recordHistory.js";

const TZ = process.env.BOOKING_TIMEZONE || "America/Vancouver";

function parseIntSafe(v, fallback) {
  const n = parseInt(v, 10);
  return isNaN(n) ? fallback : n;
}

const PAGE_LIMIT = 50;
const MAX_LIMIT = 200;

const VALID_ENTITY_TYPES = new Set([
  "appointment",
  "client",
  "invoice",
  "employee",
  "payment",
  "setting",
]);

const VALID_SOURCES = new Set(["platform", "cron", "public"]);

// "YYYY-MM-DD" se ancla al día completo en BOOKING_TIMEZONE (no UTC); un ISO
// completo se usa tal cual.
function toRangeIso(raw, edge) {
  if (!raw) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    const dt = DateTime.fromISO(raw, { zone: TZ });
    return (edge === "start" ? dt.startOf("day") : dt.endOf("day"))
      .toUTC()
      .toISO();
  }
  return raw;
}

function fullName(row) {
  if (!row) return "";
  return `${row.first_name ?? ""} ${row.last_name ?? ""}`.trim();
}

const LABEL_RESOLVERS = {
  appointment: async (ids) => {
    const { data } = await supabase
      .from("appointments")
      .select(
        "id, gcal_summary, scheduled_date, client:client_id ( first_name, last_name )",
      )
      .in("id", ids);
    const map = {};
    for (const r of data ?? []) {
      map[r.id] =
        r.gcal_summary || fullName(r.client) || r.scheduled_date || null;
    }
    return map;
  },
  client: async (ids) => {
    const { data } = await supabase
      .from("clients")
      .select("id, first_name, last_name")
      .in("id", ids);
    const map = {};
    for (const r of data ?? []) map[r.id] = fullName(r) || null;
    return map;
  },
  invoice: async (ids) => {
    const { data } = await supabase
      .from("invoices")
      .select("id, doc_number, clients ( first_name, last_name )")
      .in("id", ids);
    const map = {};
    for (const r of data ?? []) {
      const who = fullName(r.clients) || "Invoice";
      map[r.id] = r.doc_number ? `${who} — #${r.doc_number}` : who;
    }
    return map;
  },
  employee: async (ids) => {
    const { data } = await supabase
      .from("employees")
      .select("id, name")
      .in("id", ids);
    const map = {};
    for (const r of data ?? []) map[r.id] = r.name ?? null;
    return map;
  },
  setting: (ids) =>
    Object.fromEntries(
      ids.map((id) => [id, id === GLOBAL_ENTITY_ID ? "Global settings" : null]),
    ),
};

async function attachEntityLabels(rows) {
  const idsByType = {};
  for (const row of rows) {
    (idsByType[row.entity_type] ??= new Set()).add(row.entity_id);
  }

  const mapsByType = {};
  await Promise.all(
    Object.entries(idsByType).map(async ([type, idSet]) => {
      const resolve = LABEL_RESOLVERS[type];
      if (!resolve) return;
      try {
        mapsByType[type] = await resolve([...idSet]);
      } catch (e) {
        console.error(`⚠️  attachEntityLabels(${type}):`, e.message);
      }
    }),
  );

  for (const row of rows) {
    row.entity_label = mapsByType[row.entity_type]?.[row.entity_id] ?? null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/admin/history
// Query: entity_type, entity_id, changed_by, source, from, to, page, limit
// ─────────────────────────────────────────────────────────────────────────────
export async function listHistory(req, res) {
  try {
    const page = parseIntSafe(req.query.page, 1);
    const limit = Math.min(parseIntSafe(req.query.limit, PAGE_LIMIT), MAX_LIMIT);
    const offset = (page - 1) * limit;
    const { entity_type, entity_id, changed_by, source, from, to } = req.query;

    if (entity_type && !VALID_ENTITY_TYPES.has(entity_type)) {
      return res
        .status(400)
        .json({ ok: false, error: `Invalid entity_type: ${entity_type}` });
    }
    if (source && !VALID_SOURCES.has(source)) {
      return res
        .status(400)
        .json({ ok: false, error: `Invalid source: ${source}` });
    }
    if (entity_id && !entity_type) {
      return res
        .status(400)
        .json({ ok: false, error: "entity_id requires entity_type" });
    }

    let query = supabase
      .from("record_history")
      .select("*", { count: "exact" })
      .order("changed_at", { ascending: false })
      .range(offset, offset + limit - 1);

    if (entity_type) query = query.eq("entity_type", entity_type);
    if (entity_id) query = query.eq("entity_id", entity_id);
    if (changed_by) query = query.eq("changed_by", changed_by);
    if (source) query = query.eq("source", source);

    const fromIso = toRangeIso(from, "start");
    const toIso = toRangeIso(to, "end");
    if (fromIso) query = query.gte("changed_at", fromIso);
    if (toIso) query = query.lte("changed_at", toIso);

    const { data, error, count } = await query;
    if (error) throw error;

    const rows = data ?? [];
    await attachEntityLabels(rows);

    const total = count ?? 0;
    return res.json({
      ok: true,
      history: rows,
      pagination: { page, limit, total, pages: Math.ceil(total / limit) },
    });
  } catch (e) {
    console.error("❌ listHistory:", e.message);
    return res.status(500).json({ ok: false, error: e.message });
  }
}
