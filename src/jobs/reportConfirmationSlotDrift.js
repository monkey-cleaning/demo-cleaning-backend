// scripts/reportConfirmationSlotDrift.js
//
// Ticket: "Confirmación automática de servicios pendientes (CONFIRMAR)" —
// investigación del bug de starts_at desactualizado (ago 2026).
//
// SOLO LECTURA. No escribe en Supabase ni en GCal. Es el "Paso 1" de la
// investigación: da el panorama completo y confiable de qué slots 'offered'
// tienen starts_at desincronizado contra el horario real en GCal, para
// decidir con datos reales qué hacer con cada caso (dejar que el fix de
// confirmationReminderJob.js lo corrija solo en su próxima corrida, o
// intervenir a mano si el slot está muy próximo / ya se mandó un email).
//
// Por qué no alcanza con SQL: para instancias de eventos recurrentes, el
// sufijo `_YYYYMMDDTHHMMSSZ` del google_calendar_event_id queda anclado al
// horario ORIGINAL de esa ocurrencia dentro del patrón de recurrencia — no
// se actualiza si esa instancia puntual se reagenda a mano después. Solo
// `event.start.dateTime` (vía API) refleja el horario real vigente. Se
// comprobó en vivo: slot b5f86d44-9ec2-4b1b-a395-a9b605383428 tenía sufijo
// `_20260901T150000Z` pero su horario real en GCal era 2026-09-03 15:30 —
// un reagendado legítimo, no un bug — mientras que su starts_at guardado
// (2026-09-03 16:00) sí tenía un drift real de 30 min. La comparación por
// sufijo habría marcado esto como "2 días de drift", un falso positivo que
// no sirve para decidir nada. Por eso este script llama a la API real.
//
// Uso:
//   node scripts/reportConfirmationSlotDrift.js
//   node scripts/reportConfirmationSlotDrift.js --csv=/tmp/drift-report.csv
//   node scripts/reportConfirmationSlotDrift.js --limit=20        (para probar rápido)
//   node scripts/reportConfirmationSlotDrift.js --status=offered,confirmed (default: offered)
//
// Nota de carga sobre la API de GCal: corre secuencial con un delay chico
// entre llamadas (DELAY_MS) en vez de Promise.all — mismo criterio que
// checkEventConflictsBatch en distanceService.js (evitar ráfagas), acá
// aplicado a la Calendar API en vez de ORS. Con ~50-100 slots 'offered'
// esperables en un momento dado, el tiempo total es de segundos, no minutos.

import { DateTime } from "luxon";
import { supabase } from "../supabaseClient.js";
import { getCalendarClient } from "../services/googleCalendarClient.js";
import { CALENDAR_ID } from "../controllers/calendarController.js";

const TZ = process.env.BOOKING_TIMEZONE || "America/Vancouver";
const DELAY_MS = 150; // pausa entre llamadas a la Calendar API

function parseArgs(argv) {
  const args = { statuses: ["offered"], csvPath: null, limit: null };
  for (const raw of argv.slice(2)) {
    if (raw.startsWith("--csv=")) args.csvPath = raw.slice("--csv=".length);
    else if (raw.startsWith("--limit=")) args.limit = parseInt(raw.slice("--limit=".length), 10);
    else if (raw.startsWith("--status=")) {
      args.statuses = raw
        .slice("--status=".length)
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
    }
  }
  return args;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function fmtDuration(ms) {
  const sign = ms < 0 ? "-" : "+";
  const abs = Math.abs(ms);
  const totalMinutes = Math.round(abs / 60000);
  const days = Math.floor(totalMinutes / 1440);
  const hours = Math.floor((totalMinutes % 1440) / 60);
  const minutes = totalMinutes % 60;
  const parts = [];
  if (days) parts.push(`${days}d`);
  if (hours) parts.push(`${hours}h`);
  if (minutes || parts.length === 0) parts.push(`${minutes}m`);
  return `${sign}${parts.join(" ")}`;
}

function toCsvRow(fields) {
  return fields
    .map((f) => {
      const s = String(f ?? "");
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    })
    .join(",");
}

async function fetchSlots(statuses, limit) {
  let query = supabase
    .from("confirmation_slots")
    .select(
      "id, group_id, google_calendar_event_id, appointment_id, client_id, starts_at, status, reminder_sent_at",
    )
    .in("status", statuses)
    .order("starts_at", { ascending: true });

  if (limit) query = query.limit(limit);

  const { data, error } = await query;
  if (error) {
    console.error("❌ Error leyendo confirmation_slots:", error.message);
    process.exit(1);
  }
  return data ?? [];
}

async function main() {
  const { statuses, csvPath, limit } = parseArgs(process.argv);

  console.log(
    `🔍 Reporte de drift confirmation_slots — status=[${statuses.join(", ")}]${
      limit ? `, limit=${limit}` : ""
    }\n`,
  );

  const slots = await fetchSlots(statuses, limit);
  if (!slots.length) {
    console.log("No hay slots para revisar con esos filtros.");
    return;
  }

  console.log(`Revisando ${slots.length} slot(s) contra GCal (1 por vez, ${DELAY_MS}ms entre llamadas)...\n`);

  const calendar = getCalendarClient();
  const rows = [];
  let checked = 0;
  let drifted = 0;
  let goneFromGcal = 0;
  let fetchErrors = 0;

  for (const slot of slots) {
    checked++;
    process.stdout.write(`\r  [${checked}/${slots.length}]`);

    try {
      const { data: event } = await calendar.events.get({
        calendarId: CALENDAR_ID,
        eventId: slot.google_calendar_event_id,
        timeZone: TZ,
      });

      const realStartIso = event.start?.dateTime || event.start?.date;
      if (!realStartIso) {
        rows.push({ slot, real: null, note: "evento sin start.dateTime/date" });
        continue;
      }

      const real = DateTime.fromISO(realStartIso, { zone: TZ });
      const stored = DateTime.fromISO(slot.starts_at, { zone: TZ });
      const eventCancelled = event.status === "cancelled";

      if (eventCancelled) {
        rows.push({ slot, real, note: "evento cancelado en GCal (status=cancelled)" });
        continue;
      }

      if (!real.isValid || real.toMillis() === stored.toMillis()) {
        continue; // sin drift, no entra al reporte
      }

      drifted++;
      rows.push({
        slot,
        real,
        driftMs: real.toMillis() - stored.toMillis(),
        note: null,
      });
    } catch (e) {
      const gone = e.code === 404 || e.code === 410;
      if (gone) {
        goneFromGcal++;
        rows.push({ slot, real: null, note: "evento no existe en GCal (404/410)" });
      } else {
        fetchErrors++;
        rows.push({ slot, real: null, note: `error al consultar GCal: ${e.message}` });
      }
    }

    await sleep(DELAY_MS);
  }

  process.stdout.write("\r" + " ".repeat(20) + "\r"); // limpia la línea de progreso

  // ── Reporte en consola ──────────────────────────────────────────────────
  console.log("═".repeat(100));
  console.log(
    `Chequeados: ${checked}  |  Con drift real: ${drifted}  |  Ya no existen en GCal: ${goneFromGcal}  |  Errores: ${fetchErrors}`,
  );
  console.log("═".repeat(100));

  const withDrift = rows.filter((r) => r.driftMs != null).sort((a, b) => Math.abs(b.driftMs) - Math.abs(a.driftMs));
  const withNote = rows.filter((r) => r.driftMs == null);

  if (withDrift.length) {
    console.log("\n📌 Slots con drift real (starts_at guardado ≠ horario real en GCal):\n");
    for (const r of withDrift) {
      console.log(
        `  [${fmtDuration(r.driftMs).padStart(10)}] slot=${r.slot.id}  status=${r.slot.status}  client=${r.slot.client_id}\n` +
          `             guardado=${r.slot.starts_at}  real=${r.real.toISO()}  event=${r.slot.google_calendar_event_id}` +
          (r.slot.reminder_sent_at ? `  ⚠️ YA SE MANDÓ RECORDATORIO (${r.slot.reminder_sent_at})` : ""),
      );
    }
  } else {
    console.log("\n✅ Ningún slot con drift real contra GCal.");
  }

  if (withNote.length) {
    console.log("\n📎 Slots con nota (no son drift de horario, pero requieren revisión):\n");
    for (const r of withNote) {
      console.log(`  slot=${r.slot.id}  status=${r.slot.status}  → ${r.note}`);
    }
  }

  // ── CSV opcional ─────────────────────────────────────────────────────────
  if (csvPath) {
    const fs = await import("fs");
    const header = toCsvRow([
      "slot_id",
      "group_id",
      "google_calendar_event_id",
      "client_id",
      "status",
      "starts_at_guardado",
      "starts_at_real_gcal",
      "drift",
      "reminder_sent_at",
      "nota",
    ]);
    const lines = [header];
    for (const r of rows) {
      lines.push(
        toCsvRow([
          r.slot.id,
          r.slot.group_id,
          r.slot.google_calendar_event_id,
          r.slot.client_id,
          r.slot.status,
          r.slot.starts_at,
          r.real ? r.real.toISO() : "",
          r.driftMs != null ? fmtDuration(r.driftMs) : "",
          r.slot.reminder_sent_at || "",
          r.note || "",
        ]),
      );
    }
    fs.writeFileSync(csvPath, lines.join("\n"), "utf8");
    console.log(`\n💾 CSV guardado en ${csvPath}`);
  }

  console.log("\nListo. Este script no modificó nada — es solo lectura.");
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error("❌ Script failed:", e);
    process.exit(1);
  });