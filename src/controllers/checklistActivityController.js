// controllers/checklistActivityController.js
// LAB458 — panel admin: qué subieron y marcaron los cleaners, agrupado por
// evento. Cruza los appointments del rango (para tener fecha/hora, título y
// dirección) con los items de checklist de su serie y las completions/fotos de
// esa ocurrencia puntual (ver eventChecklistController.js y la migración
// 20260918/20260921_lab457_*.sql).
//
// Vive en su propio archivo (y no en eventChecklistController) porque necesita
// getEventsForRange de calendarController, que a su vez ya importa
// eventChecklistController — importarlo desde ahí sería un ciclo.
import { DateTime } from "luxon";
import { supabase } from "../supabaseClient.js";
import { getEventsForRange } from "./calendarController.js";
import { loadSnapshots } from "./eventChecklistController.js";
import { loadCentralSubmissionsByEvent } from "./centralSubmissionsController.js";
import { TZ } from "../config/timezone.js";
import { isLunchEvent } from "../services/eventClassification.js";

// Nombre del cliente (clients.name) por id, para poder buscar visitas por
// cliente aunque el título del evento no lo diga. Best-effort: si falla, las
// visitas simplemente salen sin clientName.
async function loadClientNames(clientIds) {
  const byId = new Map();
  for (const ids of chunk(clientIds, 100)) {
    const { data, error } = await supabase.from("clients").select("id, first_name, last_name").in("id", ids);
    if (error) {
      console.warn("⚠️  checklistActivity clients lookup failed:", error.message);
      continue;
    }
    for (const c of data ?? []) {
      const name = [c.first_name, c.last_name].filter(Boolean).join(" ").replace(/\s+/g, " ").trim();
      // Cliente placeholder de los appointments sin cliente real: no aporta nada
      // para buscar ni mostrar.
      if (name && name.toLowerCase() !== "unassigned unassigned") byId.set(c.id, name);
    }
  }
  return byId;
}

const MAX_RANGE_DAYS = 31;
const DEFAULT_RANGE_DAYS = 7;
const ID_CHUNK = 100;

function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

// GET /api/calendar/events/checklist-activity?from=YYYY-MM-DD&to=YYYY-MM-DD
// Eventos con checklist (general o propio, con o sin actividad todavía).
// Devuelve ascendente por inicio; el orden de visualización lo decide el front.
export async function listChecklistActivity(req, res) {
  try {
    const today = DateTime.now().setZone(TZ).startOf("day");
    const to = req.query.to
      ? DateTime.fromISO(String(req.query.to), { zone: TZ }).startOf("day")
      : today;
    const from = req.query.from
      ? DateTime.fromISO(String(req.query.from), { zone: TZ }).startOf("day")
      : to.minus({ days: DEFAULT_RANGE_DAYS - 1 });

    if (!from.isValid || !to.isValid) {
      return res.status(400).json({ ok: false, error: "from/to must be YYYY-MM-DD" });
    }
    if (to < from) {
      return res.status(400).json({ ok: false, error: "'to' must not be before 'from'" });
    }
    const spanDays = Math.round(to.diff(from, "days").days) + 1;
    if (spanDays > MAX_RANGE_DAYS) {
      return res.status(400).json({ ok: false, error: `Range too large (max ${MAX_RANGE_DAYS} days)` });
    }

    // Tramos semanales en paralelo: getEventsForRange cachea por mes y un rango
    // largo que cruza varios meses ya devolvió vacío en pruebas (ver el mismo
    // criterio en getStaffMonthEvents del frontend).
    const rangeEnd = to.plus({ days: 1 });
    const windows = [];
    for (let s = from; s < rangeEnd; s = s.plus({ days: 7 })) {
      const e = s.plus({ days: 7 }) < rangeEnd ? s.plus({ days: 7 }) : rangeEnd;
      windows.push([s.toISO(), e.toISO()]);
    }
    const weeks = await Promise.all(windows.map(([a, b]) => getEventsForRange(a, b)));
    const seen = new Set();
    const events = [];
    for (const w of weeks) {
      for (const ev of w) {
        if (!seen.has(ev.id)) {
          seen.add(ev.id);
          events.push(ev);
        }
      }
    }

    // La tabla de items es chica: se trae completa y se cruza en memoria (evita
    // un .in() con cientos de ids de appointments que reventaría el largo de la URL).
    const { data: allItems, error: itemsErr } = await supabase
      .from("event_checklist_items")
      .select("id, series_key, label, sort_order, is_general, require_photo")
      .is("archived_at", null)
      .order("sort_order", { ascending: true });
    if (itemsErr) throw itemsErr;

    const toItem = (it) => ({
      id: it.id,
      label: it.label,
      isGeneral: !!it.is_general,
      requirePhoto: !!it.require_photo,
    });
    const generalItems = (allItems ?? []).filter((it) => it.is_general).map(toItem);
    const itemsBySeries = new Map();
    for (const it of allItems ?? []) {
      if (it.is_general) continue;
      if (!itemsBySeries.has(it.series_key)) itemsBySeries.set(it.series_key, []);
      itemsBySeries.get(it.series_key).push(toItem(it));
    }

    // Con checklist general, toda visita con cleaners asignados tiene checklist;
    // sin él, solo las que tienen items propios.
    const candidates = events
      .map((ev) => ({ ev, seriesKey: ev.seriesId || ev.id, cleaners: ev.assignedCleaners ?? [] }))
      .filter(
        ({ ev, seriesKey, cleaners }) =>
          itemsBySeries.has(seriesKey) ||
          (generalItems.length > 0 && cleaners.length > 0 && !ev.isNonService && !isLunchEvent(ev.summary)),
      );
    const clientNames = await loadClientNames([...new Set(candidates.map((c) => c.ev.clientId).filter(Boolean))]);

    const eventIds = candidates.map(({ ev }) => ev.id);
    const snapshots = await loadSnapshots(eventIds);
    const centralByEvent = await loadCentralSubmissionsByEvent(eventIds);
    const completions = [];
    const photos = [];
    for (const ids of chunk(eventIds, ID_CHUNK)) {
      const [c, p] = await Promise.all([
        supabase
          .from("event_checklist_completions")
          .select("item_id, event_id, completed_at, employee:employees(name)")
          .in("event_id", ids),
        supabase
          .from("event_checklist_photos")
          .select("id, item_id, event_id, photo_url, created_at, employee:employees(name)")
          .in("event_id", ids)
          .order("created_at", { ascending: true }),
      ]);
      if (c.error) throw c.error;
      if (p.error) throw p.error;
      completions.push(...(c.data ?? []));
      photos.push(...(p.data ?? []));
    }

    const completionByKey = new Map(completions.map((c) => [`${c.event_id}|${c.item_id}`, c]));
    const photosByKey = new Map();
    for (const p of photos) {
      const k = `${p.event_id}|${p.item_id}`;
      if (!photosByKey.has(k)) photosByKey.set(k, []);
      photosByKey.get(k).push({
        id: p.id,
        url: p.photo_url,
        createdAt: p.created_at,
        uploadedBy: p.employee?.name ?? null,
      });
    }

    const result = candidates
      .map(({ ev, seriesKey, cleaners }) => {
        // La visita ya empezó a ejecutarse -> su snapshot; si no, la lista viva.
        const list = snapshots.get(ev.id) ?? [...generalItems, ...(itemsBySeries.get(seriesKey) ?? [])];
        const items = list.map((it) => {
          const k = `${ev.id}|${it.id}`;
          const c = completionByKey.get(k);
          return {
            id: it.id,
            label: it.label,
            isGeneral: it.isGeneral,
            requirePhoto: it.requirePhoto,
            completed: !!c?.completed_at,
            completedAt: c?.completed_at ?? null,
            completedBy: c?.completed_at ? c?.employee?.name ?? null : null,
            photos: photosByKey.get(k) ?? [],
          };
        });
        return {
          eventId: ev.id,
          seriesKey,
          summary: ev.summary,
          startIso: ev.startIso,
          endIso: ev.endIso,
          isAllDay: ev.isAllDay,
          location: ev.location,
          clientName: (ev.clientId && clientNames.get(ev.clientId)) || null,
          cleaners,
          items,
          centralSubmissions: centralByEvent.get(ev.id) ?? [],
          totals: {
            done: items.filter((i) => i.completed).length,
            total: items.length,
            photos: items.reduce((n, i) => n + i.photos.length, 0),
          },
        };
      })
      .filter((e) => e.totals.total > 0 || e.centralSubmissions.length > 0)
      .sort((a, b) => a.startIso.localeCompare(b.startIso));

    return res.json({
      ok: true,
      from: from.toISODate(),
      to: to.toISODate(),
      tz: TZ,
      events: result,
    });
  } catch (e) {
    console.error("❌ listChecklistActivity:", e.message);
    return res.status(500).json({ ok: false, error: e.message });
  }
}
