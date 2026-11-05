// jobs/seriesRenewalJob.js
//
// Renueva las series "Never" (recurrence_rule.endless = true).
//
// Sin Google Calendar no hay nadie que expanda la serie a demanda: las
// ocurrencias son filas reales de `appointments`, creadas de una vez al armar
// la serie (hasta 18 meses). Una serie "Never" necesita que alguien siga
// agregando filas hacia adelante, o se queda sin eventos en silencio. Este job
// corre a diario y completa cada serie hasta SERIES_RENEWAL_HORIZON_MONTHS
// (default 18) desde hoy.
//
// Reglas:
//   - Solo INSERTA fechas posteriores a la última fila de la serie (cancelada o
//     no): una fecha que el admin borró o canceló en el medio no se resucita.
//   - Las filas nuevas no traen equipo asignado (igual que al crear la serie).
//   - Series con fin explícito (count / until) y series canceladas se ignoran.
//
// Uso manual:  node src/jobs/seriesRenewalJob.js [--dry-run]

import cron from "node-cron";
import { pathToFileURL } from "node:url";
import { supabase } from "../supabaseClient.js";
import { TZ } from "../config/timezone.js";
import {
  deserializeRecurrence,
  datesToRenew,
  buildInstanceRows,
} from "../services/recurrenceService.js";

const RENEWAL_HOUR = Number(process.env.SERIES_RENEWAL_HOUR ?? 4);
const HORIZON_MONTHS = Number(process.env.SERIES_RENEWAL_HORIZON_MONTHS ?? 18);
const INSERT_CHUNK = 200;

// Campos del evento que heredan las instancias (los mismos que arma
// createCalendarEvent en baseFields, salvo los de fecha/hora).
function baseFieldsFrom(master) {
  const base = {
    client_id: master.client_id ?? null,
    timezone: master.timezone,
    special_instructions: master.special_instructions ?? null,
    property_address: master.property_address ?? "",
    gcal_summary: master.gcal_summary,
    color_id: master.color_id ?? null,
    team_id: master.team_id ?? null,
  };
  if (master.service_type) base.service_type = master.service_type;
  if (master.value) base.value = master.value;
  return base;
}

export async function runSeriesRenewalJob({ dryRun = false } = {}) {
  const { data: masters, error } = await supabase
    .from("appointments")
    .select("*")
    .eq("is_series_master", true)
    .not("recurrence_rule", "is", null)
    .neq("status", "cancelled");
  if (error) {
    console.error("❌ [SeriesRenewal] query de series:", error.message);
    return { error: error.message };
  }

  let seriesRenewed = 0;
  let rowsAdded = 0;

  for (const master of masters ?? []) {
    const rec = deserializeRecurrence(master.recurrence_rule);
    if (!rec?.endless) continue;

    try {
      const { data: last, error: lastErr } = await supabase
        .from("appointments")
        .select("scheduled_date")
        .eq("series_id", master.id)
        .order("scheduled_date", { ascending: false })
        .limit(1);
      if (lastErr) throw lastErr;
      const lastDate = last?.[0]?.scheduled_date ?? master.scheduled_date;

      const dtstartIso = master.starts_at || `${master.scheduled_date}T00:00:00`;
      const dates = datesToRenew(rec, dtstartIso, lastDate, { horizonMonths: HORIZON_MONTHS });
      if (!dates.length) continue;

      const rows = buildInstanceRows(master, dates, baseFieldsFrom(master));
      if (dryRun) {
        console.log(
          `[SeriesRenewal] (dry-run) "${master.gcal_summary}": +${rows.length} desde ${rows[0].scheduled_date} hasta ${rows.at(-1).scheduled_date}`,
        );
      } else {
        for (let i = 0; i < rows.length; i += INSERT_CHUNK) {
          const { error: insErr } = await supabase
            .from("appointments")
            .insert(rows.slice(i, i + INSERT_CHUNK));
          if (insErr) throw insErr;
        }
      }
      seriesRenewed++;
      rowsAdded += rows.length;
    } catch (e) {
      // Una serie que falla no frena a las demás.
      console.error(`❌ [SeriesRenewal] serie ${master.id}:`, e.message);
    }
  }

  console.log(
    `✅ [SeriesRenewal] ${dryRun ? "(dry-run) " : ""}${seriesRenewed} series renovadas, ${rowsAdded} filas nuevas`,
  );
  return { seriesRenewed, rowsAdded };
}

export function startSeriesRenewalJob() {
  cron.schedule(`0 ${RENEWAL_HOUR} * * *`, () => runSeriesRenewalJob(), {
    timezone: TZ,
  });
  console.log(
    `🕒 [SeriesRenewal] Cron registrado: diario ${RENEWAL_HOUR}:00 (${TZ}), horizonte ${HORIZON_MONTHS} meses`,
  );
}

// ── CLI ────────────────────────────────────────────────────────────────────
const isDirectRun =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isDirectRun) {
  const dryRun = process.argv.includes("--dry-run");
  runSeriesRenewalJob({ dryRun })
    .then((r) => process.exit(r?.error ? 2 : 0))
    .catch((err) => {
      console.error(err);
      process.exit(2);
    });
}
