// services/payrollClosingService.js
// Payroll — las tablas del cierre de quincena de la planilla manual:
//   * Checklist "Chequeo Nomina" (items con vigencia + estado por quincena,
//     con un comentario opcional por item).
//   * "Servicio nuevo | Tipo" (clientes/servicios nuevos de la quincena y con
//     qué frecuencia los piden).
// Admin-only en toda la cadena (controller/rutas).
import { supabase } from "../supabaseClient.js";
import { periodIndex } from "./payrollExpensesService.js";

const isMissingTable = (error) => error?.code === "PGRST205";

function warnMissing(table) {
  console.warn(
    `⚠️ [payrollClosingService] ${table} no existe todavía ` +
      "(falta correr la migración 20260923_payroll_closing.sql) — sigo sin datos.",
  );
}

// ── Checklist ────────────────────────────────────────────────────────────

// Función pura — junta los items vigentes con el estado guardado de la
// quincena (sin fila de estado = pendiente).
export function mergeChecklist(items, statuses) {
  const byItem = new Map(statuses.map((s) => [s.item_id, s]));
  const merged = items.map((item) => {
    const s = byItem.get(item.id);
    return {
      id: item.id,
      label: item.label,
      position: item.position,
      done: Boolean(s?.done),
      comment: s?.comment ?? null,
      doneBy: s?.done_by ?? null,
      doneAt: s?.done_at ?? null,
    };
  });
  return {
    items: merged,
    total: merged.length,
    doneCount: merged.filter((i) => i.done).length,
  };
}

export async function listChecklist({ year, month, half }) {
  const idx = periodIndex({ year, month, half });

  const { data: items, error } = await supabase
    .from("payroll_checklist_items")
    .select("id, label, position, from_period, until_period")
    .lte("from_period", idx)
    .or(`until_period.is.null,until_period.gt.${idx}`)
    .order("position", { ascending: true })
    .order("created_at", { ascending: true });
  if (error) {
    if (isMissingTable(error)) {
      warnMissing("payroll_checklist_items");
      return { items: [], total: 0, doneCount: 0 };
    }
    throw new Error(`payroll checklist: ${error.message}`);
  }

  const { data: statuses, error: statusErr } = await supabase
    .from("payroll_checklist_status")
    .select("item_id, done, comment, done_by, done_at")
    .eq("year", year)
    .eq("month", month)
    .eq("half", half);
  if (statusErr) throw new Error(`payroll checklist status: ${statusErr.message}`);

  return mergeChecklist(items ?? [], statuses ?? []);
}

// Un item nuevo aplica desde la quincena en que se crea en adelante (las
// anteriores, ya cerradas, no cambian) y va al final de la lista.
export async function createChecklistItem({ label, year, month, half, createdBy }) {
  const { data: last, error: lastErr } = await supabase
    .from("payroll_checklist_items")
    .select("position")
    .order("position", { ascending: false })
    .limit(1);
  if (lastErr) throw new Error(`payroll checklist position: ${lastErr.message}`);

  const { data, error } = await supabase
    .from("payroll_checklist_items")
    .insert({
      label,
      position: (last?.[0]?.position ?? -1) + 1,
      from_period: periodIndex({ year, month, half }),
      created_by: createdBy ?? null,
    })
    .select("id, label, position")
    .single();
  if (error) throw new Error(`payroll checklist create: ${error.message}`);
  return { id: data.id, label: data.label, position: data.position, done: false, comment: null, doneBy: null, doneAt: null };
}

export async function renameChecklistItem({ id, label }) {
  const { error } = await supabase.from("payroll_checklist_items").update({ label }).eq("id", id);
  if (error) throw new Error(`payroll checklist rename: ${error.message}`);
}

// Baja desde esta quincena en adelante. Si el item se creó en esta misma
// quincena (o después) no hay historia que conservar: se borra de verdad, con
// su estado (on delete cascade). Si no, se cierra su vigencia y las
// quincenas anteriores lo siguen mostrando.
export async function deleteChecklistItem({ id, year, month, half }) {
  const idx = periodIndex({ year, month, half });
  const { data: item, error } = await supabase
    .from("payroll_checklist_items")
    .select("id, from_period")
    .eq("id", id)
    .single();
  if (error) throw new Error(`payroll checklist item: ${error.message}`);

  if (item.from_period >= idx) {
    const { error: delErr } = await supabase.from("payroll_checklist_items").delete().eq("id", id);
    if (delErr) throw new Error(`payroll checklist delete: ${delErr.message}`);
    return;
  }
  const { error: closeErr } = await supabase
    .from("payroll_checklist_items")
    .update({ until_period: idx })
    .eq("id", id);
  if (closeErr) throw new Error(`payroll checklist close: ${closeErr.message}`);
}

// Marca/desmarca un item en una quincena y guarda su comentario. El
// comentario se conserva al desmarcar (no se pierde info), lo que se limpia
// es quién/cuándo lo marcó.
export async function setChecklistStatus({ year, month, half, itemId, done, comment, updatedBy }) {
  const { error } = await supabase.from("payroll_checklist_status").upsert(
    {
      year,
      month,
      half,
      item_id: itemId,
      done,
      comment: comment ? comment : null,
      done_by: done ? (updatedBy ?? null) : null,
      done_at: done ? new Date().toISOString() : null,
    },
    { onConflict: "year,month,half,item_id" },
  );
  if (error) throw new Error(`payroll checklist status upsert: ${error.message}`);
}

// ── Servicios nuevos ─────────────────────────────────────────────────────
// Mismas opciones que clients.expected_frequency (ClientFormModal.tsx).
export const NEW_SERVICE_FREQUENCIES = ["Weekly", "Bi-weekly", "Monthly", "One-time", "As needed"];

function mapNewService(row) {
  return {
    id: row.id,
    serviceName: row.service_name,
    clientId: row.client_id ?? null,
    frequency: row.frequency,
    note: row.note ?? null,
    createdBy: row.created_by,
    createdAt: row.created_at,
  };
}

const NEW_SERVICE_COLS = "id, service_name, client_id, frequency, note, created_by, created_at";

export async function listNewServices({ year, month, half }) {
  const { data, error } = await supabase
    .from("payroll_new_services")
    .select(NEW_SERVICE_COLS)
    .eq("year", year)
    .eq("month", month)
    .eq("half", half)
    .order("created_at", { ascending: true });
  if (error) {
    if (isMissingTable(error)) {
      warnMissing("payroll_new_services");
      return { newServices: [] };
    }
    throw new Error(`payroll new services: ${error.message}`);
  }
  return { newServices: (data ?? []).map(mapNewService) };
}

export async function createNewService({
  year,
  month,
  half,
  serviceName,
  clientId,
  frequency,
  note,
  createdBy,
}) {
  const { data, error } = await supabase
    .from("payroll_new_services")
    .insert({
      year,
      month,
      half,
      service_name: serviceName,
      client_id: clientId ?? null,
      frequency,
      note: note ?? null,
      created_by: createdBy ?? null,
    })
    .select(NEW_SERVICE_COLS)
    .single();
  if (error) throw new Error(`payroll new services create: ${error.message}`);
  return mapNewService(data);
}

export async function updateNewService({ id, serviceName, clientId, frequency, note }) {
  const patch = {};
  if (serviceName !== undefined) patch.service_name = serviceName;
  if (clientId !== undefined) patch.client_id = clientId;
  if (frequency !== undefined) patch.frequency = frequency;
  if (note !== undefined) patch.note = note;
  const { data, error } = await supabase
    .from("payroll_new_services")
    .update(patch)
    .eq("id", id)
    .select(NEW_SERVICE_COLS)
    .single();
  if (error) throw new Error(`payroll new services update: ${error.message}`);
  return mapNewService(data);
}

// ── Clientes nuevos detectados ───────────────────────────────────────────
// Un cliente es "nuevo" en una quincena si su PRIMER servicio (no cancelado,
// según el espejo `appointments`) cae dentro de ella: hay servicios en el
// período y ninguno antes. `clients.created_at` no sirve (muchos vinieron
// importados de Zoho) y el job de client_status solo deriva active/at_risk/
// inactive, no guarda desde cuándo.
const PLACEHOLDER_CLIENT_ID = "00000000-0000-0000-0000-000000000001";

// Función pura. inPeriod: [{client_id, scheduled_date}] de la quincena;
// priorClientIds: Set de clientes con algún servicio ANTERIOR; excluded: Set
// de clientes a omitir (ya cargados en la quincena). Devuelve
// [{clientId, firstServiceDate}] ordenado por fecha.
export function pickNewClients({ inPeriod, priorClientIds, excluded = new Set() }) {
  const first = new Map();
  for (const a of inPeriod) {
    if (!a.client_id || a.client_id === PLACEHOLDER_CLIENT_ID) continue;
    if (priorClientIds.has(a.client_id) || excluded.has(a.client_id)) continue;
    const seen = first.get(a.client_id);
    if (!seen || a.scheduled_date < seen) first.set(a.client_id, a.scheduled_date);
  }
  return [...first.entries()]
    .map(([clientId, firstServiceDate]) => ({ clientId, firstServiceDate }))
    .sort((a, b) => a.firstServiceDate.localeCompare(b.firstServiceDate));
}

// expected_frequency es texto libre en `clients`; se normaliza a una de las
// opciones de la tarjeta (null si no coincide).
export function normalizeFrequency(value) {
  const v = String(value ?? "").trim().toLowerCase();
  return NEW_SERVICE_FREQUENCIES.find((f) => f.toLowerCase() === v) ?? null;
}

function periodDates({ year, month, half }) {
  const mm = String(month).padStart(2, "0");
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return {
    from: `${year}-${mm}-${half === 1 ? "01" : "16"}`,
    to: `${year}-${mm}-${half === 1 ? "15" : String(lastDay).padStart(2, "0")}`,
  };
}

async function fetchAll(build) {
  const rows = [];
  for (let offset = 0; ; offset += 1000) {
    const { data, error } = await build().range(offset, offset + 999);
    if (error) throw new Error(error.message);
    rows.push(...data);
    if (data.length < 1000) break;
  }
  return rows;
}

export async function detectNewClients({ year, month, half }) {
  const { from, to } = periodDates({ year, month, half });

  const inPeriod = await fetchAll(() =>
    supabase
      .from("appointments")
      .select("client_id, scheduled_date")
      .neq("status", "cancelled")
      .gte("scheduled_date", from)
      .lte("scheduled_date", to)
      .order("id", { ascending: true }),
  );
  const candidateIds = [...new Set(inPeriod.map((a) => a.client_id).filter(Boolean))];
  if (!candidateIds.length) return { detected: [] };

  // Solo importa si el cliente tiene ALGÚN servicio anterior a la quincena.
  const priorClientIds = new Set();
  for (let i = 0; i < candidateIds.length; i += 150) {
    const chunk = candidateIds.slice(i, i + 150);
    const prior = await fetchAll(() =>
      supabase
        .from("appointments")
        .select("client_id")
        .in("client_id", chunk)
        .neq("status", "cancelled")
        .lt("scheduled_date", from)
        .order("id", { ascending: true }),
    );
    prior.forEach((a) => priorClientIds.add(a.client_id));
  }

  // Ya cargados en esta quincena (por client_id) no se vuelven a sugerir.
  const { newServices } = await listNewServices({ year, month, half });
  const excluded = new Set(newServices.map((s) => s.clientId).filter(Boolean));

  const picked = pickNewClients({ inPeriod, priorClientIds, excluded });
  if (!picked.length) return { detected: [] };

  const { data: clients, error } = await supabase
    .from("clients")
    .select("id, first_name, last_name, expected_frequency, service_type")
    .in("id", picked.map((p) => p.clientId));
  if (error) throw new Error(`payroll detected clients: ${error.message}`);
  const byId = new Map((clients ?? []).map((c) => [c.id, c]));

  return {
    detected: picked.map((p) => {
      const c = byId.get(p.clientId);
      const name = [c?.first_name, c?.last_name].filter(Boolean).join(" ").replace(/\s+/g, " ").trim();
      return {
        clientId: p.clientId,
        name: name || "Unknown client",
        firstServiceDate: p.firstServiceDate,
        frequency: normalizeFrequency(c?.expected_frequency),
        serviceType: c?.service_type || null,
      };
    }),
  };
}

export async function deleteNewService(id) {
  const { error } = await supabase.from("payroll_new_services").delete().eq("id", id);
  if (error) throw new Error(`payroll new services delete: ${error.message}`);
}
