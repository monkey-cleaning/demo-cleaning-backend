import { supabase } from "./supabaseService.js";
import {
  findOrCreateCustomer,
  createInvoice,
  getRequestConfig,
} from "./quickbooksService.js";

// ─── CREATE DRAFT ────────────────────────────────────────────────────────────

export async function createDraftInvoice({
  client_id,
  line_items,
  due_date,
  notes,
}) {
  const total_amount = line_items.reduce((sum, item) => sum + item.amount, 0);

  const { data: invoice, error } = await supabase
    .from("invoices")
    .insert([
      {
        client_id,
        line_items, // jsonb — array de { description, amount }
        total_amount,
        due_date: due_date || null,
        notes: notes || null,
        status: "draft",
        is_sandbox: process.env.QB_ENVIRONMENT !== "production",
        synced_at: null,
        quickbooks_invoice_id: null,
      },
    ])
    .select("*, clients(first_name, last_name, email)")
    .single();

  if (error) throw new Error(`Error creando draft invoice: ${error.message}`);

  console.log(
    `[Invoice] ✅ Draft creado. id: ${invoice.id} | client: ${client_id} | total: ${total_amount}`,
  );
  return invoice;
}

// ─── LIST ────────────────────────────────────────────────────────────────────

export async function getDraftInvoices({
  status,
  client_id,
  search,
  from,
  to,
  page = 1,
  limit = 20,
}) {
  const offset = (page - 1) * limit;

  // Helper: apply all filters to any query builder.
  // Keeps count and data queries in sync — same filters, different selects.
  function applyFilters(q) {
    if (status) q = q.eq("status", status);
    if (client_id) q = q.eq("client_id", client_id);
    // Filter by issued_date (the date shown in the UI), not created_at.
    // issued_date is a `date` column (no time component) so gte/lte on YYYY-MM-DD
    // strings works correctly without any timezone adjustment.
    // Drafts without an issued_date are excluded from date-filtered results --
    // that matches user expectation (a draft has no issue date yet).
    if (from) q = q.gte("issued_date", from);
    if (to) q = q.lte("issued_date", to);
    if (search) {
      const term = `%${search}%`;
      q = q.or(
        `quickbooks_customer_name.ilike.${term},doc_number.ilike.${term}`,
      );
    }
    return q;
  }

  // Step 1: count-only — no .range() so it never throws on out-of-bounds pages.
  const { count, error: countError } = await applyFilters(
    supabase.from("invoices").select("id", { count: "exact", head: true }),
  );
  if (countError)
    throw new Error(
      `Error listando invoices: ${countError.message ?? JSON.stringify(countError)}`,
    );

  const total = count ?? 0;
  const pages = Math.ceil(total / limit) || 0;

  // Step 2: page beyond total — return empty without a second DB hit.
  if (total === 0 || offset >= total) {
    return { data: [], pagination: { total, page, limit, pages } };
  }

  // Step 3: data query with guaranteed safe .range().
  const { data, error } = await applyFilters(
    supabase
      .from("invoices")
      .select("*, clients(first_name, last_name, email)")
      .order("created_at", { ascending: false })
      .range(offset, offset + limit - 1),
  );
  if (error)
    throw new Error(
      `Error listando invoices: ${error.message ?? JSON.stringify(error)}`,
    );

  return { data, pagination: { total, page, limit, pages } };
}

// ─── GET BY ID ───────────────────────────────────────────────────────────────

export async function getDraftInvoiceById(id) {
  const { data, error } = await supabase
    .from("invoices")
    .select("*, clients(first_name, last_name, email, phone, default_address, street, city, state, zip_code, country)")
    .eq("id", id)
    .maybeSingle();

  if (error) throw new Error(`Error obteniendo invoice: ${error.message}`);
  return data;
}

// ─── UPDATE DRAFT ────────────────────────────────────────────────────────────

export async function updateDraftInvoice(id, { line_items, due_date, notes }) {
  // Solo se pueden editar drafts
  const existing = await getDraftInvoiceById(id);
  if (!existing) throw new Error("Invoice no encontrada");
  if (existing.status !== "draft") {
    throw new Error(
      `Las invoices solo se pueden editar en estado draft (actual: ${existing.status})`,
    );
  }

  const updates = { updated_at: new Date().toISOString() };

  if (line_items !== undefined) {
    updates.line_items = line_items;
    updates.total_amount = line_items.reduce(
      (sum, item) => sum + item.amount,
      0,
    );
  }
  if (due_date !== undefined) updates.due_date = due_date;
  if (notes !== undefined) updates.notes = notes;

  const { data, error } = await supabase
    .from("invoices")
    .update(updates)
    .eq("id", id)
    .select("*, leads(full_name, email)")
    .single();

  if (error) throw new Error(`Error actualizando invoice: ${error.message}`);

  console.log(`[Invoice] ✏️  Draft actualizado. id: ${id}`);
  return data;
}

// ─── DELETE DRAFT ────────────────────────────────────────────────────────────

export async function deleteDraftInvoice(id) {
  const existing = await getDraftInvoiceById(id);
  if (!existing) throw new Error("Invoice no encontrada");
  if (existing.status !== "draft") {
    throw new Error(
      `Las invoices solo se pueden eliminar en estado draft (actual: ${existing.status})`,
    );
  }

  const { error } = await supabase.from("invoices").delete().eq("id", id);
  if (error) throw new Error(`Error eliminando invoice: ${error.message}`);

  console.log(`[Invoice] 🗑️  Draft eliminado. id: ${id}`);
}

// ─── PUBLISH TO QB ───────────────────────────────────────────────────────────

export async function publishInvoiceToQB(id) {
  const invoice = await getDraftInvoiceById(id);
  if (!invoice) throw new Error("Invoice no encontrada");
  if (invoice.status !== "draft") {
    throw new Error(
      `Esta invoice ya fue publicada (status: ${invoice.status})`,
    );
  }

  const client = invoice.clients;
  if (!client?.email) throw new Error("El cliente vinculado no tiene email");
  const fullName = [client.first_name, client.last_name]
    .filter(Boolean)
    .join(" ");

  // 1. Buscar o crear el customer en QB
  console.log(
    `[Invoice] 🔍 Buscando/creando customer en QB para: ${client.email}`,
  );
  const qbCustomer = await findOrCreateCustomer({
    email: client.email,
    fullName,
    phone: client.phone,
    address: client.default_address,
    street: client.street,
    city: client.city,
    state: client.state,
    zip: client.zip_code,
    country: client.country,
  });

  // 2. Crear la invoice en QB
  console.log(
    `[Invoice] 📤 Enviando invoice a QB. Customer QB id: ${qbCustomer.Id}`,
  );
  const qbInvoice = await createInvoice(
    qbCustomer,
    invoice.line_items,
    invoice.due_date || null,
  );

  // 3. Actualizar Supabase con el QB id y cambiar status
  const { data: updated, error } = await supabase
    .from("invoices")
    .update({
      quickbooks_invoice_id: qbInvoice.Id,
      quickbooks_customer_id: qbCustomer.Id,
      quickbooks_customer_name: qbCustomer.DisplayName || fullName,
      doc_number: qbInvoice.DocNumber,
      status: "published",
      issued_date: qbInvoice.TxnDate,
      synced_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq("id", id)
    .select("*, clients(first_name, last_name, email)")
    .single();

  if (error)
    throw new Error(
      `Error actualizando invoice tras publicar: ${error.message}`,
    );

  console.log(
    `[Invoice] ✅ Publicada en QB. QB id: ${qbInvoice.Id} | Supabase id: ${id}`,
  );
  return updated;
}

// ─── SEND EMAIL VIA QB ───────────────────────────────────────────────────────

export async function sendInvoiceEmail(id) {
  const invoice = await getDraftInvoiceById(id);
  if (!invoice) throw new Error("Invoice no encontrada");
  if (!["published", "sent"].includes(invoice.status)) {
    throw new Error(
      "La invoice debe estar publicada en QB antes de poder enviarse",
    );
  }
  if (!invoice.quickbooks_invoice_id) {
    throw new Error("La invoice no tiene un QB id asignado");
  }

  const client = invoice.clients;
  if (!client?.email) throw new Error("El cliente no tiene email");

  // Llamar al endpoint de envío de QB
  const { baseUrl, headers } = await getRequestConfig();
  const response = await fetch(
    `${baseUrl}/invoice/${invoice.quickbooks_invoice_id}/send?sendTo=${encodeURIComponent(client.email)}`,
    { method: "POST", headers },
  );

  if (!response.ok) {
    const errData = await response.json().catch(() => ({}));
    throw new Error(`QB send error: ${JSON.stringify(errData)}`);
  }

  // Actualizar status a "sent"
  const { data: updated, error } = await supabase
    .from("invoices")
    .update({
      status: "sent",
      updated_at: new Date().toISOString(),
    })
    .eq("id", id)
    .select()
    .single();

  if (error)
    throw new Error(`Error actualizando status a sent: ${error.message}`);

  console.log(
    `[Invoice] 📧 Email enviado al cliente ${client.email}. QB id: ${invoice.quickbooks_invoice_id}`,
  );
  return { success: true, sent_to: client.email, invoice: updated };
}
