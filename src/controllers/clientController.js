// controllers/clientController.js
import { supabase } from "../supabaseClient.js";
import { syncAndPersistZohoId } from "../services/zohoService.js";
import {
  getPendingReview,
  getClientOpenInvoices,
} from "../services/paymentReconciliationService.js";
import {
  getClientExportData,
  buildClientExportXlsx,
  buildClientExportPdf,
} from "../services/clientExportService.js";

const PAGE_LIMIT = 25;

// ── Helpers ───────────────────────────────────────────────────────────────────

function parseIntSafe(v, fallback) {
  const n = parseInt(v, 10);
  return isNaN(n) ? fallback : n;
}

// ── Helper: normalize and deduplicate aliases ─────────────────────────
function normalizeAliases(aliases) {
  if (!aliases) return null;
  if (!Array.isArray(aliases)) return null;

  const normalized = [
    ...new Set(aliases.map((a) => (a ?? "").trim()).filter(Boolean)),
  ];
  return normalized.length > 0 ? normalized : null;
}

// Fields safe to write from the request body (whitelist)
const WRITABLE_FIELDS = [
  "first_name",
  "last_name",
  "email",
  "phone",
  "mobile",
  "default_address",
  "street",
  "city",
  "state",
  "zip_code",
  "country",
  "status",
  "source",
  "service_type",
  "rate",
  "is_recurring",
  "expected_frequency",
  "preferred_days",
  "preferred_time",
  "availability_windows",
  "notes",
  "tags",
  "postponed_until",
  "postponed_until",
  "transfer_sender_aliases",
];

function pickWritable(body) {
  return Object.fromEntries(
    Object.entries(body).filter(
      ([k, v]) => WRITABLE_FIELDS.includes(k) && v !== undefined,
    ),
  );
}

function sanitizeUpdate(data) {
  // Normalizar aliases si existen
  if (data.transfer_sender_aliases) {
    data.transfer_sender_aliases = normalizeAliases(
      data.transfer_sender_aliases,
    );
  }
  return data;
}

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/admin/clients
// Query: search, status, page, limit
// ─────────────────────────────────────────────────────────────────────────────
export async function listClients(req, res) {
  try {
    const page = parseIntSafe(req.query.page, 1);
    const limit = parseIntSafe(req.query.limit, PAGE_LIMIT);
    const offset = (page - 1) * limit;
    const search = req.query.search?.trim() ?? "";
    const status = req.query.status?.trim() ?? "";
    const serviceType = req.query.service_type?.trim() ?? "";
    const billingStatus = req.query.billing_status?.trim() ?? "";

    // ── Helper to apply shared search/service_type filters to any query ──────
    function applyFilters(q) {
      if (status) q = q.ilike("status", status);
      if (serviceType) q = q.ilike("service_type", serviceType);
      if (search) {
        q = q.or(
          `name.ilike.%${search}%,email.ilike.%${search}%,phone.ilike.%${search}%,mobile.ilike.%${search}%,city.ilike.%${search}%,transfer_sender_aliases.cs.{${search.toUpperCase()}}`,
        );
      }
      return q;
    }

    // ── Run main list query + counts + service_types in parallel ─────────────
    const [listResult, countsResult, typesResult, billingCountsResult] =
      await Promise.all([
        // 1. Paginated client list — pre-filtered by billing status when requested
        (async () => {
          // If billing filter active, resolve matching client IDs first
          let allowedIds = null;
          if (billingStatus) {
            const { data: billingRows, error: billingErr } = await supabase
              .from("clients_billing_status")
              .select("client_id")
              .eq("billing_status", billingStatus);
            if (billingErr) throw billingErr;
            allowedIds = (billingRows ?? []).map((r) => r.client_id);
            // No matches — short-circuit, return empty
            if (allowedIds.length === 0) {
              return { data: [], count: 0, error: null };
            }
          }

          let q = applyFilters(
            supabase
              .from("clients_with_name")
              .select("*", { count: "exact" })
              .order("created_at", { ascending: false })
              .range(offset, offset + limit - 1),
          );
          if (allowedIds) q = q.in("id", allowedIds);
          return q;
        })(),

        // 2. Status counts — applied to the same search/service_type filters,
        //    but WITHOUT the status filter so we always get all three buckets.
        (async () => {
          const buckets = ["active", "at_risk", "inactive"];
          const results = await Promise.all(
            buckets.map((s) => {
              let q = supabase
                .from("clients_with_name")
                .select("id", { count: "exact", head: true })
                .ilike("status", s);
              if (serviceType) q = q.ilike("service_type", serviceType);
              if (search) {
                q = q.or(
                  `name.ilike.%${search}%,email.ilike.%${search}%,phone.ilike.%${search}%,mobile.ilike.%${search}%,city.ilike.%${search}%`,
                );
              }
              return q;
            }),
          );
          return Object.fromEntries(
            buckets.map((s, i) => [s, results[i].count ?? 0]),
          );
        })(),

        // 3. Distinct non-null service_types (for filter chips) — no filters applied
        supabase
          .from("clients")
          .select("service_type")
          .not("service_type", "is", null)
          .neq("service_type", ""),

        // 4. Billing status counts — global, no filters applied
        (async () => {
          const buckets = ["up_to_date", "balance_due", "credit", "no_billing"];
          const results = await Promise.all(
            buckets.map((b) =>
              supabase
                .from("clients_billing_status")
                .select("client_id", { count: "exact", head: true })
                .eq("billing_status", b),
            ),
          );
          return Object.fromEntries(
            buckets.map((b, i) => [b, results[i].count ?? 0]),
          );
        })(),
      ]);
    if (listResult.error) throw listResult.error;

    // ── Total services (appointment count) per client — current page only ────
    const clientIds = (listResult.data ?? []).map((c) => c.id);
    let servicesByClient = {};
    if (clientIds.length > 0) {
      const { data: apptRows, error: apptCountErr } = await supabase
        .from("appointments")
        .select("client_id")
        .in("client_id", clientIds);
      if (apptCountErr) throw apptCountErr;
      servicesByClient = (apptRows ?? []).reduce((acc, a) => {
        acc[a.client_id] = (acc[a.client_id] ?? 0) + 1;
        return acc;
      }, {});
    }
    const clientsWithServices = (listResult.data ?? []).map((c) => ({
      ...c,
      total_services: servicesByClient[c.id] ?? 0,
    }));

    // Deduplicate and sort service_types
    const serviceTypes = [
      ...new Set(
        (typesResult.data ?? [])
          .map((r) => r.service_type?.trim())
          .filter(Boolean),
      ),
    ].sort();

    const total = listResult.count ?? 0;
    return res.json({
      ok: true,
      clients: clientsWithServices,
      status_counts: countsResult,
      billing_counts: billingCountsResult,
      service_types: serviceTypes,
      pagination: {
        page,
        limit,
        total,
        pages: Math.ceil(total / limit),
      },
    });
  } catch (e) {
    console.error("❌ listClients:", e.message);
    return res.status(500).json({ ok: false, error: e.message });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/admin/clients/:id
// ─────────────────────────────────────────────────────────────────────────────
export async function getClient(req, res) {
  try {
    const { id } = req.params;

    const { data, error } = await supabase
      .from("clients_with_name")
      .select("*")
      .eq("id", id)
      .single();

    if (error) throw error;
    if (!data)
      return res.status(404).json({ ok: false, error: "Client not found" });

    return res.json({ ok: true, client: data });
  } catch (e) {
    console.error("❌ getClient:", e.message);
    const status = e.code === "PGRST116" ? 404 : 500;
    return res.status(status).json({ ok: false, error: e.message });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/admin/clients/:id/appointments
// Returns last 10 appointments + aggregate stats for the client profile drawer.
// Each appointment includes the assigned team members (from appointment_teams).
// ─────────────────────────────────────────────────────────────────────────────
export async function getClientAppointments(req, res) {
  try {
    const { id } = req.params;

    // Last 10 appointments (most recent first), with team members joined
    const { data: appointments, error: apptErr } = await supabase
      .from("appointments")
      .select(
        `id,
         scheduled_date,
         scheduled_start_time,
         scheduled_end_time,
         status,
         service_type,
         value,
         property_address,
         actual_hours,
         estimated_hours,
         google_calendar_event_id,
         teams:appointment_teams (
           role,
           employee:employee_id (
             id,
             name,
             is_team_leader
           )
         )`,
      )
      .eq("client_id", id)
      .order("scheduled_date", { ascending: false })
      .limit(10);

    if (apptErr) throw apptErr;

    // Aggregate stats: total count + total value across ALL appointments
    const { data: allAppts, error: statsErr } = await supabase
      .from("appointments")
      .select("value, status")
      .eq("client_id", id);

    if (statsErr) throw statsErr;

    const totalServices = allAppts?.length ?? 0;
    const estimatedSpend = (allAppts ?? []).reduce(
      (sum, a) => sum + (a.value ?? 0),
      0,
    );
    const completedCount = (allAppts ?? []).filter(
      (a) => a.status === "completed",
    ).length;

    return res.json({
      ok: true,
      appointments: appointments ?? [],
      stats: { totalServices, estimatedSpend, completedCount },
    });
  } catch (e) {
    console.error("❌ getClientAppointments:", e.message);
    return res.status(500).json({ ok: false, error: e.message });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/admin/clients
// Body: first_name, last_name, email, phone, mobile, default_address,
//       street, city, state, zip_code, country, status, source,
//       service_type, rate, is_recurring, notes, tags
// ─────────────────────────────────────────────────────────────────────────────
export async function createClient(req, res) {
  try {
    const fields = pickWritable(req.body);

    if (fields.transfer_sender_aliases) {
      fields.transfer_sender_aliases = normalizeAliases(fields.transfer_sender_aliases);
    }

    if (!fields.first_name && !fields.last_name) {
      return res
        .status(400)
        .json({ ok: false, error: "first_name or last_name is required" });
    }

    // Default status to active on creation
    if (!fields.status) fields.status = "active";

    const { data, error } = await supabase
      .from("clients")
      .insert(fields)
      .select()
      .single();

    if (error) throw error;

    console.log(
      `✅ Created client: ${data.id} — ${fields.first_name ?? ""} ${fields.last_name ?? ""}`.trim(),
    );

    // Convert matching lead by email — non-blocking
    if (fields.email) {
      supabase
        .from("leads")
        .update({ is_converted: true, converted_at: new Date().toISOString() })
        .eq("email", fields.email.toLowerCase().trim())
        .eq("is_converted", false)
        .then(({ error }) => {
          if (error) console.warn("⚠️  Lead conversion failed:", error.message);
          else console.log(`🔄 Lead converted for email: ${fields.email}`);
        });
    }

    // Async Zoho sync — non-blocking; errors caught inside the service
    syncAndPersistZohoId(supabase, data).catch(() => {});

    return res.status(201).json({ ok: true, client: data });
  } catch (e) {
    console.error("❌ createClient:", e.message);
    return res.status(500).json({ ok: false, error: e.message });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// PATCH /api/admin/clients/:id
// Body: any subset of writable fields
// ─────────────────────────────────────────────────────────────────────────────
export async function updateClient(req, res) {
  try {
    const { id } = req.params;
    const fields = pickWritable(req.body);

    if (fields.transfer_sender_aliases) {
      fields.transfer_sender_aliases = normalizeAliases(
        fields.transfer_sender_aliases,
      );
    }

    if (Object.keys(fields).length === 0) {
      return res
        .status(400)
        .json({ ok: false, error: "No valid fields to update" });
    }

    fields.updated_at = new Date().toISOString();

    const { data, error } = await supabase
      .from("clients")
      .update(fields)
      .eq("id", id)
      .select()
      .single();

    if (error) throw error;
    if (!data)
      return res.status(404).json({ ok: false, error: "Client not found" });

    console.log(`✅ Updated client: ${id}`);
    // Async Zoho sync — non-blocking
    syncAndPersistZohoId(supabase, data).catch(() => {});
    return res.json({ ok: true, client: data });
  } catch (e) {
    console.error("❌ updateClient:", e.message);
    const status = e.code === "PGRST116" ? 404 : 500;
    return res.status(status).json({ ok: false, error: e.message });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// DELETE /api/admin/clients/:id
// Hard delete — use with care. Appointments cascade via FK.
// ─────────────────────────────────────────────────────────────────────────────
export async function deleteClient(req, res) {
  try {
    const { id } = req.params;

    const { error } = await supabase
      .from("clients")
      .update({ status: "deleted", updated_at: new Date().toISOString() })
      .eq("id", id)
      .select()
      .single();

    if (error) throw error;

    console.log(`🗑️  Deleted client: ${id}`);
    return res.json({ ok: true });
  } catch (e) {
    console.error("❌ deleteClient:", e.message);
    return res.status(500).json({ ok: false, error: e.message });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/admin/clients/search
// Lightweight endpoint for typeahead selectors (e.g. calendar event creation)
// Query: q (min 2 chars), limit (default 8)
// Returns: [{ id, name, email, default_address, service_type }]
// ─────────────────────────────────────────────────────────────────────────────
export async function searchClients(req, res) {
  const q = req.query.q?.trim() ?? "";
  if (q.length < 2) return res.json({ ok: true, clients: [] });

  // Paso 1: búsqueda normal por nombre/email
  const { data: byName, error: byNameError } = await supabase
    .from("clients_with_name")
    .select(
      "id, name, first_name, last_name, email, status, transfer_sender_aliases, default_address, service_type, mobile, phone",
    )
    .or(`name.ilike.%${q}%,email.ilike.%${q}%`)
    .limit(8);

  if (byNameError)
    console.error("❌ searchClients byName:", byNameError.message);

  // Paso 2: buscar en aliases (exact match uppercase, como llegan de Interac)
  const { data: byAlias } = await supabase
    .from("clients")
    .select("id, first_name, last_name, email, status, transfer_sender_aliases")
    .contains("transfer_sender_aliases", [q.toUpperCase()])
    .limit(8);

  // Deduplicar por id
  const seen = new Set();
  const results = [...(byName ?? []), ...(byAlias ?? [])].filter((c) => {
    if (seen.has(c.id)) return false;
    seen.add(c.id);
    return true;
  });

  return res.json({ ok: true, clients: results.slice(0, 8) });
}

// ─────────────────────────────────────────────────────────────────────────────
// Inactivity status job
// Runs nightly via cron, or on-demand via POST /api/admin/clients/refresh-status
//
// Thresholds are read from the settings table at runtime.
//   active   : 0–(riskDays-1) days since last_activity_at
//   at_risk  : riskDays–(inactiveDays-1) days
//   inactive : inactiveDays+ days
//
// Clients with service_type in the adhoc list are skipped if
//      the exclude_adhoc_clients setting is enabled.
// ─────────────────────────────────────────────────────────────────────────────

// Load thresholds and exclusion config from the settings table.
// Falls back to safe defaults if the table is missing or empty.
async function loadSettings() {
  const { data, error } = await supabase
    .from("settings")
    .select("key, value")
    .in("key", [
      "inactivity_risk_days",
      "inactivity_inactive_days",
      "exclude_adhoc_clients",
      "adhoc_service_types",
    ]);

  if (error) {
    console.warn(
      "[Cron] Could not read settings table, using defaults:",
      error.message,
    );
  }

  const map = Object.fromEntries((data ?? []).map((r) => [r.key, r.value]));

  return {
    riskDays: parseInt(map.inactivity_risk_days ?? "21", 10),
    inactiveDays: parseInt(map.inactivity_inactive_days ?? "30", 10),
    excludeAdhoc: (map.exclude_adhoc_clients ?? "false") === "true",
    adhocTypes: (() => {
      try {
        return JSON.parse(map.adhoc_service_types ?? "null") || [];
      } catch {
        return [
          "Post-construction",
          "Event",
          "Move-in/Move-out",
          "Move Out Cleaning",
        ];
      }
    })(),
  };
}

function deriveStatus(lastActivityAt, riskDays, inactiveDays) {
  // No date → treat as inactive (client has never had a recorded service)
  if (!lastActivityAt) return "inactive";
  const days = Math.floor(
    (Date.now() - new Date(lastActivityAt).getTime()) / 86_400_000,
  );
  if (days < riskDays) return "active";
  if (days < inactiveDays) return "at_risk";
  return "inactive";
}

// ── Core logic shared by the HTTP handler and the standalone cron runner ──────
async function computeStatusUpdates(settings) {
  const { riskDays, inactiveDays, excludeAdhoc, adhocTypes } = settings;

  let query = supabase
    .from("clients")
    .select("id, last_activity_at, service_type, status, postponed_until")
    .neq("status", "deleted")
    .neq("status", "unsubscribed")
    .neq("id", "00000000-0000-0000-0000-000000000001");

  if (excludeAdhoc && adhocTypes.length > 0) {
    query = query.not("service_type", "in", `(${adhocTypes.join(",")})`);
  }

  const { data: clients, error: fetchErr } = await query;
  if (fetchErr) throw fetchErr;

  // ── NEW: fetch the last completed appointment date per client ──────────────
  // We pull all completed appointments and build a lookup map so we only need
  // one extra query instead of N queries inside the loop.
  const clientIds = clients.map((c) => c.id);
  const { data: completedAppts, error: apptErr } = await supabase
    .from("appointments")
    .select("client_id, scheduled_date")
    .in("client_id", clientIds)
    .eq("status", "completed")
    .order("scheduled_date", { ascending: false });

  if (apptErr) throw apptErr;

  // Build map: clientId → most recent completed scheduled_date
  const lastCalendarActivity = {};
  for (const appt of completedAppts ?? []) {
    if (!lastCalendarActivity[appt.client_id]) {
      // First occurrence is already the latest (results are ordered DESC)
      lastCalendarActivity[appt.client_id] = appt.scheduled_date;
    }
  }
  // ── END NEW ────────────────────────────────────────────────────────────────

  const updates = [];
  let skipped = 0;

  for (const c of clients) {
    // Use the calendar-based date; fall back to last_activity_at only if there
    // are no completed appointments on record (e.g. brand-new client).
    const effectiveLastActivity =
      lastCalendarActivity[c.id] ?? c.last_activity_at;

    const newStatus = deriveStatus(
      effectiveLastActivity,
      riskDays,
      inactiveDays,
    );
    // Skip clients snoozed until a future date
    if (c.postponed_until && new Date(c.postponed_until) > new Date()) {
      console.log(`[Cron] SKIP (snoozed) ${c.id} until ${c.postponed_until}`);
      skipped++;
      continue;
    }
    // Normalise existing status to lowercase for comparison (handles "Inactive" etc.)
    const currentNorm = (c.status ?? "").toLowerCase().replace(/\s+/g, "_");
    if (currentNorm === newStatus) {
      console.log(
        `[Cron] SKIP (no change) ${c.id}: "${currentNorm}" | last activity: ${effectiveLastActivity ?? "none"}`,
      );
      skipped++;
      continue;
    }

    // log every individual status change
    const days = effectiveLastActivity
      ? Math.floor(
          (Date.now() - new Date(effectiveLastActivity).getTime()) / 86_400_000,
        )
      : null;
    console.log(
      `[Cron] Client ${c.id}: "${currentNorm || "unknown"}" → "${newStatus}"${days !== null ? ` (${days}d since last calendar activity)` : " (no completed appointments)"}`,
    );

    updates.push({
      id: c.id,
      status: newStatus,
      updated_at: new Date().toISOString(),
      ...(lastCalendarActivity[c.id]
        ? { last_activity_at: lastCalendarActivity[c.id] }
        : {}),
    });
  }

  // Sync last_activity_at from Calendar for all clients that have completed appointments,
  // regardless of whether their status changed.
  const activityUpdates = Object.entries(lastCalendarActivity).map(
    ([id, date]) => ({
      id,
      last_activity_at: date,
      updated_at: new Date().toISOString(),
    }),
  );

  if (activityUpdates.length > 0) {
    const CHUNK = 100;
    for (let i = 0; i < activityUpdates.length; i += CHUNK) {
      const { error } = await supabase
        .from("clients")
        .upsert(activityUpdates.slice(i, i + CHUNK), { onConflict: "id" });
      if (error)
        console.warn("[Cron] Error syncing last_activity_at:", error.message);
    }
    console.log(
      `[Cron] Synced last_activity_at for ${activityUpdates.length} clients from Calendar`,
    );
  }

  return { updates, skipped, total: clients.length };
}
async function applyUpdates(updates) {
  const CHUNK = 100;
  let updated = 0;
  for (let i = 0; i < updates.length; i += CHUNK) {
    const { error } = await supabase
      .from("clients")
      .upsert(updates.slice(i, i + CHUNK), { onConflict: "id" });
    if (error) throw error;
    updated += Math.min(CHUNK, updates.length - i);
  }
  return updated;
}

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/admin/clients/refresh-status  (HTTP handler — on-demand trigger)
// ─────────────────────────────────────────────────────────────────────────────
export async function refreshClientStatuses(req, res) {
  try {
    const settings = await loadSettings();
    const { updates, skipped, total } = await computeStatusUpdates(settings);
    const updated = await applyUpdates(updates);

    console.log(
      `[Cron] refreshClientStatuses: ${updated} updated, ${skipped} skipped (thresholds: risk=${settings.riskDays}d inactive=${settings.inactiveDays}d)`,
    );
    return res.json({ ok: true, updated, skipped, total });
  } catch (e) {
    console.error("❌ refreshClientStatuses:", e.message);
    return res.status(500).json({ ok: false, error: e.message });
  }
}

// ───────────────────────────────────────────────────────────────────
// Standalone runner — called by the nightly cron job (no req/res)
// ───────────────────────────────────────────────────────────────────
export async function runStatusRefreshJob() {
  try {
    const settings = await loadSettings();
    // FIX: desestructurar skipped para incluirlo en el log nocturno
    const { updates, skipped, total } = await computeStatusUpdates(settings);
    const updated = await applyUpdates(updates);

    console.log(
      `[Cron] Client status refresh complete: ${updated}/${total} updated, ${skipped} skipped (thresholds: risk=${settings.riskDays}d inactive=${settings.inactiveDays}d)`,
    );
  } catch (e) {
    console.error("❌ [Cron] runStatusRefreshJob:", e.message);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/admin/clients/:id/pending-review
// Allocations pendientes de revisión para el drawer del cliente.
// ─────────────────────────────────────────────────────────────────────────────
export async function getClientPendingReview(req, res) {
  try {
    const { id } = req.params;
    const items = await getPendingReview({ clientId: id });
    return res.json({ ok: true, count: items.length, items });
  } catch (e) {
    console.error("❌ getClientPendingReview:", e.message);
    return res.status(500).json({ ok: false, error: e.message });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/admin/clients/:id/preferences
// Lightweight endpoint — returns only scheduling preference fields.
// Used by the reschedule assistant (S-CAL-2) to validate client availability
// before confirming a drag-and-drop reschedule.
// ─────────────────────────────────────────────────────────────────────────────
export async function getClientPreferences(req, res) {
  try {
    const { id } = req.params;

    const { data, error } = await supabase
      .from("clients")
      .select(
        "id, preferred_days, preferred_time, availability_windows, expected_frequency",
      )
      .eq("id", id)
      .single();

    if (error) throw error;
    if (!data)
      return res.status(404).json({ ok: false, error: "Client not found" });

    return res.json({ ok: true, preferences: data });
  } catch (e) {
    console.error("❌ getClientPreferences:", e.message);
    const status = e.code === "PGRST116" ? 404 : 500;
    return res.status(status).json({ ok: false, error: e.message });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/admin/clients/:id/billing
// Returns invoices + payments linked to this client, plus billing stats.
// ─────────────────────────────────────────────────────────────────────────────
export async function getClientBilling(req, res) {
  try {
    const { id } = req.params;

    const [invoicesResult, paymentsResult] = await Promise.all([
      supabase
        .from("invoices")
        .select(
          "id, doc_number, total_amount, balance, status, issued_date, due_date, quickbooks_invoice_id",
        )
        .eq("client_id", id)
        .order("issued_date", { ascending: false })
        .limit(20),

      supabase
        .from("payments")
        .select(
          "id, amount, payment_date, payment_method, status, quickbooks_payment_id",
        )
        .eq("client_id", id)
        .order("payment_date", { ascending: false })
        .limit(20),
    ]);

    if (invoicesResult.error) throw invoicesResult.error;
    if (paymentsResult.error) throw paymentsResult.error;

    const invoices = invoicesResult.data ?? [];
    const payments = paymentsResult.data ?? [];

    // Pull totals from the view — always correct regardless of the display limit
    const { data: billingTotals, error: totalsErr } = await supabase
      .from("clients_billing_status")
      .select("total_billed, total_paid, billing_status")
      .eq("client_id", id)
      .maybeSingle();

    if (totalsErr) throw totalsErr;

    const totalBilled = Number(billingTotals?.total_billed ?? 0);
    const totalPaid = Number(billingTotals?.total_paid ?? 0);

    return res.json({
      ok: true,
      invoices,
      payments,
      stats: {
        totalBilled: Number(totalBilled.toFixed(2)),
        totalPaid: Number(totalPaid.toFixed(2)),
        balance: Number((totalBilled - totalPaid).toFixed(2)),
        billing_status: billingTotals?.billing_status ?? null,
      },
    });
  } catch (e) {
    console.error("❌ getClientBilling:", e.message);
    return res.status(500).json({ ok: false, error: e.message });
  }
}

export async function getClientOpenInvoicesHandler(req, res) {
  try {
    const items = await getClientOpenInvoices(req.params.id);
    return res.json({ ok: true, items });
  } catch (e) {
    console.error("❌ getClientOpenInvoicesHandler:", e.message);
    return res.status(500).json({ ok: false, error: e.message });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/admin/clients/:id/export?format=xlsx|pdf
// Reporte completo: todas las invoices, todos los payments, y el detalle de
// cómo se matcheó cada payment contra cada invoice (payment_allocations).
// ─────────────────────────────────────────────────────────────────────────────
export async function exportClientBilling(req, res) {
  try {
    const { id } = req.params;
    const format = (req.query.format ?? "xlsx").toLowerCase();
    if (!["xlsx", "pdf"].includes(format)) {
      return res
        .status(400)
        .json({ ok: false, error: "format must be xlsx or pdf" });
    }

    const data = await getClientExportData(id);
    const safeName =
      (
        data.client.name ??
        `${data.client.first_name ?? ""}_${data.client.last_name ?? ""}`
      )
        .trim()
        .replace(/[^a-z0-9]+/gi, "_")
        .toLowerCase() || "client";
    const filename = `${safeName}_billing_${new Date().toISOString().slice(0, 10)}.${format}`;

    if (format === "xlsx") {
      const buffer = await buildClientExportXlsx(data);
      res.setHeader(
        "Content-Type",
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      );
      res.setHeader(
        "Content-Disposition",
        `attachment; filename="${filename}"`,
      );
      return res.send(Buffer.from(buffer));
    }

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
    buildClientExportPdf(data).pipe(res);
  } catch (e) {
    console.error("❌ exportClientBilling:", e.message);
    if (e.message === "Client not found") {
      return res.status(404).json({ ok: false, error: e.message });
    }
    return res.status(500).json({ ok: false, error: e.message });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/admin/payments/test-alias-match
// Diagnostic endpoint: test if a sender name would match a client's aliases
// Body: { sender_name: string, client_id?: string }
// ─────────────────────────────────────────────────────────────────────────────
export async function testAliasMatch(req, res) {
  try {
    const { sender_name, client_id } = req.body;

    if (!sender_name || typeof sender_name !== "string") {
      return res.status(400).json({
        ok: false,
        error: "sender_name is required and must be a string",
      });
    }

    // ── Helper functions (copied from eTransferSyncService) ──
    function normalizeName(name) {
      if (!name) return "";
      return name
        .toLowerCase()
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "")
        .replace(/[^a-z0-9\s]/g, "")
        .replace(/\s+/g, " ")
        .trim();
    }

    const normalized_input = normalizeName(sender_name);

    // Fetch clients (or specific client if client_id provided)
    let query = supabase
      .from("clients")
      .select("id, first_name, last_name, transfer_sender_aliases");

    if (client_id) {
      query = query.eq("id", client_id);
    }

    const { data: clients, error } = await query;
    if (error) throw error;

    const results = [];
    for (const client of clients ?? []) {
      const aliases = client.transfer_sender_aliases ?? [];

      // Skip if not array
      if (!Array.isArray(aliases)) continue;

      const normalized_aliases = aliases.map(normalizeName);
      const matched = normalized_aliases.includes(normalized_input);

      results.push({
        client_id: client.id,
        client_name:
          `${client.first_name ?? ""} ${client.last_name ?? ""}`.trim(),
        matched,
        input_normalized: normalized_input,
        raw_aliases: aliases,
        normalized_aliases,
      });
    }

    return res.json({ ok: true, sender_name, results });
  } catch (e) {
    console.error("❌ testAliasMatch:", e.message);
    return res.status(500).json({ ok: false, error: e.message });
  }
}
