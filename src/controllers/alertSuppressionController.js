// Silence / list / reinstate alerts from the coverage monitor.
// See services/coverageScan.js and db/migrations/20261103_alert_suppressions.sql.
//
// REST endpoints. The UI ("Coverage" page in the admin panel) consumes them for
// the per-row "Resolved for now" / "Silence" buttons.

import { supabase } from "../supabaseClient.js";
import { getActor } from "../lib/actorContext.js";
import { ALERT_TYPE, FINDING_KINDS, invalidateLastScan } from "../services/coverageScan.js";

const VALID_ENTITY = new Set(["recurring_series", "client"]);

// GET /api/admin/alert-suppressions
export async function listSuppressions(_req, res) {
  const { data, error } = await supabase
    .from("alert_suppressions")
    .select("id, alert_type, entity_type, entity_id, finding_kind, reason, suppressed_by, created_at, expires_at")
    .eq("alert_type", ALERT_TYPE)
    .order("created_at", { ascending: false });
  if (error) return res.status(500).json({ ok: false, error: error.message });

  const now = new Date();
  const rows = (data || []).map((r) => ({
    ...r,
    active: !r.expires_at || new Date(r.expires_at) > now,
  }));
  return res.json({ ok: true, suppressions: rows });
}

// POST /api/admin/alert-suppressions
// body: { entityType: 'recurring_series'|'client', entityId, findingKind?, reason?, expiresAt? }
//   findingKind null / absent → silences ALL alerts for that entity
//   findingKind = no_coverage|on_demand|ending_soon|gap|overlap → only that kind
//   expiresAt null → permanent; with a date → "resolved for now, revisit on X"
export async function createSuppression(req, res) {
  const { entityType, entityId, findingKind, reason, expiresAt } = req.body || {};
  if (!VALID_ENTITY.has(entityType))
    return res.status(400).json({ ok: false, error: "entityType must be 'recurring_series' or 'client'" });
  if (!entityId || typeof entityId !== "string")
    return res.status(400).json({ ok: false, error: "entityId is required" });
  if (findingKind != null && !FINDING_KINDS.includes(findingKind))
    return res.status(400).json({
      ok: false,
      error: `invalid findingKind — use one of: ${FINDING_KINDS.join(", ")} (or null for all)`,
    });
  if (expiresAt && Number.isNaN(Date.parse(expiresAt)))
    return res.status(400).json({ ok: false, error: "invalid expiresAt (use ISO 8601)" });

  const row = {
    alert_type: ALERT_TYPE,
    entity_type: entityType,
    entity_id: entityId.trim(),
    finding_kind: findingKind || null,
    reason: reason?.trim() || null,
    suppressed_by: getActor(),
    expires_at: expiresAt || null,
  };

  const { data, error } = await supabase
    .from("alert_suppressions")
    .insert(row)
    .select()
    .single();

  if (error) {
    // partial unique index clash: a permanent suppression already exists for
    // that (entity, kind). Return it so the UI can offer to replace it.
    if (error.code === "23505") {
      const { data: existing } = await supabase
        .from("alert_suppressions")
        .select("id, finding_kind, reason, suppressed_by, created_at")
        .eq("alert_type", ALERT_TYPE)
        .eq("entity_type", entityType)
        .eq("entity_id", entityId.trim())
        .is("expires_at", null)
        .filter("finding_kind", findingKind ? "eq" : "is", findingKind || null)
        .maybeSingle();
      return res.status(409).json({
        ok: false,
        error: "A permanent suppression already exists for that entity and kind.",
        existing: existing || null,
      });
    }
    return res.status(500).json({ ok: false, error: error.message });
  }
  invalidateLastScan();
  return res.status(201).json({ ok: true, suppression: data });
}

// DELETE /api/admin/alert-suppressions/:id  — reinstates the alert
export async function deleteSuppression(req, res) {
  const { id } = req.params;
  const { error } = await supabase
    .from("alert_suppressions")
    .delete()
    .eq("id", id)
    .eq("alert_type", ALERT_TYPE);
  if (error) return res.status(500).json({ ok: false, error: error.message });
  invalidateLastScan();
  return res.json({ ok: true });
}
