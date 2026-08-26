import { supabase } from "../supabaseClient.js";
import { invalidateSettingsCache } from "../services/settingsService.js";
import { loadClassificationConfig } from "../services/eventClassification.js";
import {
  validateColorOverrides,
  isValidGcalColorId,
  SPECIAL_COLOR_SETTING_KEYS,
} from "../services/colorAssignmentService.js";

// Keys exposed through this API (whitelist — never expose internal-only keys)
const PUBLIC_KEYS = [
  "inactivity_risk_days",
  "inactivity_inactive_days",
  "exclude_adhoc_clients",
  "team_default_size",
  "service_buffer_minutes",
  "max_simultaneous_teams",
  "keep_stable_pair",
  "work_start_hour",
  "work_end_hour",
  "travel_time_buffer_minutes",
  "distance_validation_enabled",
  "confirmation_release_hours_before",
  "ops_alert_email",
  "confirmation_reminder_days_before",
  "confirmation_pairing_grace_minutes",
  ...SPECIAL_COLOR_SETTING_KEYS,
];

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/admin/settings
// Returns all whitelisted settings as a flat key→value object.
// ─────────────────────────────────────────────────────────────────────────────
export async function getSettings(req, res) {
  try {
    const { data, error } = await supabase
      .from("settings")
      .select("key, value")
      .in("key", PUBLIC_KEYS);

    if (error) throw error;

    const settings = Object.fromEntries(
      (data ?? []).map((r) => [r.key, r.value]),
    );

    // Backfill defaults for any keys not yet in the table
    const defaults = {
      inactivity_risk_days: "21",
      inactivity_inactive_days: "30",
      exclude_adhoc_clients: "false",
      team_default_size: "2",
      service_buffer_minutes: "30",
      max_simultaneous_teams: "2",
      keep_stable_pair: "false",
      work_start_hour: "7",
      work_end_hour: "19",
      travel_time_buffer_minutes: "10",
      distance_validation_enabled: "true",
      confirmation_release_hours_before: "24",
      ops_alert_email: "",
      confirmation_reminder_days_before: "2",
      confirmation_pairing_grace_minutes: "60",
      // Defaults en línea con los fallbacks de eventClassification.js —
      // si nunca se guardaron en `settings`, ambos módulos coinciden igual.
      confirmar_color_id: "5",
      non_service_color_id: "4",
      individual_color_id: "9",
    };
    for (const [k, v] of Object.entries(defaults)) {
      if (!(k in settings)) settings[k] = v;
    }

    return res.json({ ok: true, settings });
  } catch (e) {
    console.error("❌ getSettings:", e.message);
    return res.status(500).json({ ok: false, error: e.message });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// PATCH /api/admin/settings
// Body: { key: value, … }  — only whitelisted keys are processed.
// Uses upsert so missing rows are created automatically.
// ─────────────────────────────────────────────────────────────────────────────
export async function updateSettings(req, res) {
  try {
    const body = req.body ?? {};

    // Filter to whitelisted keys only
    const entries = Object.entries(body).filter(([k]) =>
      PUBLIC_KEYS.includes(k),
    );

    if (entries.length === 0) {
      return res
        .status(400)
        .json({ ok: false, error: "No valid settings keys provided." });
    }

    // Validate numeric fields
    const numericKeys = [
      "inactivity_risk_days",
      "inactivity_inactive_days",
      "team_default_size",
      "service_buffer_minutes",
      "max_simultaneous_teams",
      "travel_time_buffer_minutes",
      "confirmation_reminder_days_before",
      "confirmation_pairing_grace_minutes",
    ];

    // LAB290: separado de numericKeys porque confirmationReleaseJob.js ya usa
    // parseFloat — permitimos decimales (ej. 1.5 hs) sin romper ese parseo
    const positiveDecimalKeys = ["confirmation_release_hours_before"];

    const booleanKeys = [
      "exclude_adhoc_clients",
      "keep_stable_pair",
      "distance_validation_enabled",
    ];
    const hourKeys = ["work_start_hour", "work_end_hour"];

    for (const [k, v] of entries) {
      if (numericKeys.includes(k)) {
        const n = parseInt(v, 10);
        if (isNaN(n) || n < 1) {
          return res.status(400).json({
            ok: false,
            error: `"${k}" must be a positive integer, got: ${v}`,
          });
        }
      }
      if (hourKeys.includes(k)) {
        const n = parseInt(v, 10);
        if (isNaN(n) || n < 0 || n > 23) {
          return res.status(400).json({
            ok: false,
            error: `"${k}" must be an integer between 0 and 23, got: ${v}`,
          });
        }
      }
      if (booleanKeys.includes(k) && v !== "true" && v !== "false") {
        return res.status(400).json({
          ok: false,
          error: `"${k}" must be "true" or "false", got: ${v}`,
        });
      }

      if (SPECIAL_COLOR_SETTING_KEYS.includes(k) && !isValidGcalColorId(v)) {
        return res.status(400).json({
          ok: false,
          error: `"${k}" must be a valid Google Calendar colorId (1-11), got: ${v}`,
        });
      }

      // LAB290: obligatorio — sin destino, la alerta de liberación automática
      // no tiene a dónde llegar (ver opsNotificationService.js)
      if (k === "ops_alert_email") {
        if (!v || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v)) {
          return res.status(400).json({
            ok: false,
            error: `"ops_alert_email" must be a valid email address, got: ${v || "(empty)"}`,
          });
        }
      }
    }

    // Cross-field validation: risk_days must be < inactive_days
    const patchMap = Object.fromEntries(entries);
    if (
      "inactivity_risk_days" in patchMap ||
      "inactivity_inactive_days" in patchMap
    ) {
      const { data: current } = await supabase
        .from("settings")
        .select("key, value")
        .in("key", ["inactivity_risk_days", "inactivity_inactive_days"]);

      const currentMap = Object.fromEntries(
        (current ?? []).map((r) => [r.key, r.value]),
      );
      const riskDays = parseInt(
        patchMap.inactivity_risk_days ??
          currentMap.inactivity_risk_days ??
          "21",
        10,
      );
      const inactiveDays = parseInt(
        patchMap.inactivity_inactive_days ??
          currentMap.inactivity_inactive_days ??
          "30",
        10,
      );
      if (riskDays >= inactiveDays) {
        return res.status(400).json({
          ok: false,
          error: `"inactivity_risk_days" (${riskDays}) must be less than "inactivity_inactive_days" (${inactiveDays}).`,
        });
      }
    }

    // Cross-field validation: work_start_hour must be < work_end_hour
    if ("work_start_hour" in patchMap || "work_end_hour" in patchMap) {
      const { data: current } = await supabase
        .from("settings")
        .select("key, value")
        .in("key", ["work_start_hour", "work_end_hour"]);

      const currentMap = Object.fromEntries(
        (current ?? []).map((r) => [r.key, r.value]),
      );
      const startHour = parseInt(
        patchMap.work_start_hour ?? currentMap.work_start_hour ?? "7",
        10,
      );
      const endHour = parseInt(
        patchMap.work_end_hour ?? currentMap.work_end_hour ?? "19",
        10,
      );
      if (startHour >= endHour) {
        return res.status(400).json({
          ok: false,
          error: `"work_start_hour" (${startHour}) must be less than "work_end_hour" (${endHour}).`,
        });
      }
    }

    // Cross-field validation: ningún colorId especial (CONFIRMAR /
    // no-servicio / individual) puede quedar pisando el color de otro rol
    // especial ni el de un equipo activo. validateColorOverrides simula el
    // patch completo (soporta swaps entre los 3 roles en el mismo request)
    // contra teams.color_ids en vivo, así que esto también agarra una
    // colisión con un equipo creado recién (ver teamAssignmentController.js).
    const touchedColorKeys = entries.filter(([k]) =>
      SPECIAL_COLOR_SETTING_KEYS.includes(k),
    );
    if (touchedColorKeys.length > 0) {
      const colorCheck = await validateColorOverrides({
        settings: Object.fromEntries(touchedColorKeys),
      });
      if (!colorCheck.ok) {
        return res.status(409).json({ ok: false, error: colorCheck.error });
      }
    }

    // Cross-field validation + side effect: max_simultaneous_teams no puede
    // quedar por encima de los equipos activos (subirla implica crear el
    // equipo faltante primero, vía POST /api/admin/teams). Si en cambio se
    // BAJA por debajo de los equipos activos, el equipo "de más" se
    // desactiva automáticamente acá — no puede quedar un team is_active=true
    // que ya no entra en la capacidad configurada (ver LAB — reporte de
    // Team 4 quedando activo tras bajar la capacidad de 4 a 3).
    let deactivatedTeamIds = [];
    if ("max_simultaneous_teams" in patchMap) {
      const requested = parseInt(patchMap.max_simultaneous_teams, 10);
      const { data: activeTeamRows, error: teamsErr } = await supabase
        .from("teams")
        .select("id")
        .eq("is_active", true);

      if (teamsErr) throw teamsErr;

      const activeTeamsCount = activeTeamRows?.length ?? 0;

      if (requested > activeTeamsCount) {
        // LAB: antes de rechazar, buscamos si ya existe(n) equipo(s)
        // inactivo(s) (team_N) que puedan cubrir el gap — típicamente
        // porque una baja de capacidad anterior los desactivó. Si existen,
        // los ofrecemos para REACTIVAR (PATCH /api/admin/teams/:id con
        // is_active:true) en vez de forzar la creación de uno nuevo, que
        // generaría un team_N+1 y dejaría el equipo inactivo huérfano.
        const gap = requested - activeTeamsCount;

        const { data: inactiveTeamRows, error: inactiveErr } = await supabase
          .from("teams")
          .select("id, label, color, color_ids, emojis")
          .eq("is_active", false);

        if (inactiveErr) throw inactiveErr;

        const reactivatableTeams = (inactiveTeamRows ?? [])
          .map((t) => ({ ...t, n: Number(/^team_(\d+)$/.exec(t.id)?.[1] ?? -1) }))
          .filter((t) => t.n > 0)
          .sort((a, b) => a.n - b.n)
          .slice(0, gap)
          .map(({ n, ...t }) => t);

        return res.status(409).json({
          ok: false,
          error:
            reactivatableTeams.length > 0
              ? `"max_simultaneous_teams" (${requested}) excede la cantidad de equipos activos (${activeTeamsCount}). Hay ${reactivatableTeams.length} equipo(s) inactivo(s) que podés reactivar en vez de crear uno nuevo.`
              : `"max_simultaneous_teams" (${requested}) excede la cantidad de equipos activos (${activeTeamsCount}). Creá el equipo faltante (con su color) antes de subir la capacidad.`,
          reactivatableTeams,
        });
      }

      if (requested < activeTeamsCount) {
        // "Último asignado" = mayor sufijo numérico de team_N — mismo
        // criterio que createTeam usa para generar el próximo id, así el
        // orden de desactivación es el inverso exacto del de creación.
        const excess = activeTeamsCount - requested;
        deactivatedTeamIds = activeTeamRows
          .map((t) => ({ id: t.id, n: Number(/^team_(\d+)$/.exec(t.id)?.[1] ?? -1) }))
          .sort((a, b) => b.n - a.n)
          .slice(0, excess)
          .map((t) => t.id);

        const { error: deactivateErr } = await supabase
          .from("teams")
          .update({ is_active: false })
          .in("id", deactivatedTeamIds);

        if (deactivateErr) throw deactivateErr;

        console.log(
          `[Settings] max_simultaneous_teams → ${requested}: se desactivaron ${deactivatedTeamIds.join(", ")}`,
        );
        // El colorId de estos equipos queda libre de inmediato — getCurrentColorOwnerMap
        // (colorAssignmentService.js) solo cuenta teams is_active=true.
      }
    }

    const rows = entries.map(([key, value]) => ({
      key,
      value: String(value),
      updated_at: new Date().toISOString(),
    }));

    const { error } = await supabase
      .from("settings")
      .upsert(rows, { onConflict: "key" });

    if (error) throw error;

    // ✅ Invalidar la cache en memoria del settingsService compartido para que
    // el próximo booking, sync o assignment modal vea el valor nuevo de
    // inmediato, sin esperar el TTL de la cache.
    invalidateSettingsCache();

    // ✅ eventClassification.js mantiene su propio estado en memoria (no
    // pasa por settingsService), cargado una vez al boot — sin este
    // refresh explícito, un cambio de confirmar_color_id/non_service_color_id/
    // individual_color_id quedaría guardado en DB pero el clasificador de
    // eventos seguiría usando el valor viejo hasta el próximo restart.
    if (touchedColorKeys.length > 0) {
      await loadClassificationConfig();
    }

    console.log(
      `[Settings] Updated: ${entries.map(([k, v]) => `${k}=${v}`).join(", ")}`,
    );

    return res.json({
      ok: true,
      updated: entries.map(([k]) => k),
      deactivatedTeamIds,
    });
  } catch (e) {
    console.error("❌ updateSettings:", e.message);
    return res.status(500).json({ ok: false, error: e.message });
  }
}