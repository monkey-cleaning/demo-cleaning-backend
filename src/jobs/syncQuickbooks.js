import cron from "node-cron";
import { supabase } from "../services/supabaseService.js";
import { runStatusRefreshJob } from "../controllers/clientController.js";
import {
  getInvoicesSince,
  getPaymentsSince,
  getCustomersWithEmail,
  getPaymentMethodsMap,
} from "../services/quickbooksService.js";
import { reconcilePayment } from "../services/paymentReconciliationService.js";

const IS_SANDBOX = process.env.QB_ENVIRONMENT !== "production";

function getSyncFromDate(override) {
  if (override) return override;
  const year = new Date().getFullYear();
  return `${year}-01-01`;
}

// ─── HELPERS (misma normalización que quickbooksRoutes.js) ───────────────────

// Cualquier invoice que llega acá viene de la API de QB — por definición ya
// existe/fue publicada. Nunca debe volver a "draft" (eso solo lo asigna
// createDraftInvoice() para invoices que todavía no se mandaron a QB y por
// eso ni aparecen en getInvoicesSince). El caso anterior devolvía "draft" para
// cualquier invoice no pagada y no vencida, pisando "published"/"sent" reales
// en cada sync (nightly + cada reinicio del server) — bug crítico, corregido
// LAB, ago 2026. "sent" se deriva de EmailStatus, que QB sí trackea.
function resolveInvoiceStatus(inv) {
  if (inv.Balance === 0) return "paid";
  const due = new Date(inv.DueDate);
  if (due < new Date()) return "overdue";
  if (inv.EmailStatus === "EmailSent") return "sent";
  return "published";
}

function normalizeInvoice(inv) {
  return {
    quickbooks_invoice_id: inv.Id,
    quickbooks_customer_id: inv.CustomerRef?.value || null, // ← nuevo
    doc_number: inv.DocNumber,
    quickbooks_customer_name: inv.CustomerRef?.name || "Unknown",
    total_amount: inv.TotalAmt,
    balance: inv.Balance,
    currency: inv.CurrencyRef?.value || "CAD",
    status: resolveInvoiceStatus(inv),
    issued_date: inv.TxnDate,
    due_date: inv.DueDate,
    paid_date: inv.Balance === 0 ? inv.TxnDate : null,
    is_sandbox: IS_SANDBOX,
    synced_at: new Date().toISOString(),
  };
}

// paymentMethodsMap se carga dinámicamente desde QB al inicio de cada sync.
// Se usa en normalizePayment para resolver el nombre del método de pago a partir
// del ID numérico que QB devuelve en PaymentMethodRef.value (sin .name).
let _paymentMethodsMap = {};

function resolvePaymentMethod(pay) {
  const ref = pay.PaymentMethodRef;
  if (!ref) return null;
  if (ref.name && ref.name !== "undefined") return ref.name;
  if (ref.value) return _paymentMethodsMap[ref.value] ?? null;
  return null;
}

function normalizePayment(pay) {
  return {
    row: {
      quickbooks_payment_id: pay.Id,
      quickbooks_customer_id: pay.CustomerRef?.value || null,
      quickbooks_customer_name: pay.CustomerRef?.name || "Unknown",
      amount: pay.TotalAmt,
      currency: pay.CurrencyRef?.value || "CAD",
      payment_date: pay.TxnDate,
      payment_method: resolvePaymentMethod(pay),
      status: "completed",
      is_sandbox: IS_SANDBOX,
      synced_at: new Date().toISOString(),
    },
    linkedInvoiceIds: (pay.Line || [])
      .flatMap((l) => l.LinkedTxn || [])
      .filter((t) => t.TxnType === "Invoice")
      .map((t) => t.TxnId),
  };
}

// ─── SYNC INVOICES ───────────────────────────────────────────────────────────

async function syncInvoices(rawInvoices) {
  console.log(`[DEBUG] syncInvoices START — ${rawInvoices.length} raw`);
  if (!rawInvoices.length) return;

  let rows;
  try {
    rows = rawInvoices.map(normalizeInvoice);
    console.log(
      `[DEBUG] normalizeInvoice OK — sample:`,
      JSON.stringify(rows[0]),
    );
  } catch (normErr) {
    console.error(`[DEBUG] normalizeInvoice CRASH:`, normErr);
    throw normErr;
  }

  // Upsert in batches of 200 to avoid payload limits
  const BATCH = 200;
  for (let i = 0; i < rows.length; i += BATCH) {
    const batch = rows.slice(i, i + BATCH);
    console.log(`[DEBUG] upsert invoices batch ${i}–${i + batch.length}...`);
    const { error } = await supabase.from("invoices").upsert(batch, {
      onConflict: "quickbooks_invoice_id",
      ignoreDuplicates: false,
    });
    if (error) {
      console.error(`[DEBUG] upsert invoices batch error:`, error);
      throw new Error(
        `Error sincronizando invoices (batch ${i}): ${error.message}`,
      );
    }
    console.log(`[DEBUG] upsert invoices batch ${i}–${i + batch.length} OK`);
  }

  console.log(`[QB Sync] ✅ ${rows.length} invoices sincronizadas`);
}

// ─── SYNC PAYMENTS ───────────────────────────────────────────────────────────

async function syncPayments(rawPayments) {
  console.log(`[DEBUG] syncPayments START — ${rawPayments.length} raw`);
  if (!rawPayments.length) return;

  for (const pay of rawPayments) {
    const { row } = normalizePayment(pay);

    const { error: pmtError } = await supabase.from("payments").upsert(row, {
      onConflict: "quickbooks_payment_id",
      ignoreDuplicates: false,
    });

    if (pmtError) {
      console.error(
        `[QB Sync] ❌ Error en payment QB#${pay.Id}:`,
        pmtError.message,
      );
    }
  }

  console.log(`[QB Sync] ✅ ${rawPayments.length} payments sincronizados`);
}

// ─── RECONCILIAR PAYMENTS (FIFO + propina) ───────────────────────────────────
// Corre DESPUÉS de syncCustomersToClients, porque necesita client_id ya
// backfilleado en payments para poder buscar las invoices abiertas del cliente.
async function reconcileQbPayments(rawPayments) {
  console.log(`[DEBUG] reconcileQbPayments START — ${rawPayments.length} raw`);
  let reconciled = 0;
  let pending = 0;
  let skipped = 0;

  for (const pay of rawPayments) {
    const { linkedInvoiceIds } = normalizePayment(pay);

    const { data: paymentRow, error } = await supabase
      .from("payments")
      .select("id, client_id, amount, status")
      .eq("quickbooks_payment_id", pay.Id)
      .maybeSingle();

    if (error || !paymentRow) {
      console.warn(
        `[QB Sync] ⚠️  No se encontró payment QB#${pay.Id} para reconciliar`,
      );
      skipped++;
      continue;
    }
    if (paymentRow.status !== "completed" || !(paymentRow.amount > 0)) {
      skipped++;
      continue;
    }

    try {
      const { status } = await reconcilePayment({
        paymentId: paymentRow.id,
        clientId: paymentRow.client_id,
        amount: paymentRow.amount,
        linkedInvoiceQbIds: linkedInvoiceIds,
      });

      if (status === "pending_review") pending++;
      else if (status === "resolved") reconciled++;
      else skipped++; // skipped_no_client | already_reconciled
    } catch (reconErr) {
      console.error(
        `[QB Sync] ❌ Error reconciliando payment QB#${pay.Id}:`,
        reconErr.message,
      );
      skipped++;
    }
  }

  console.log(
    `[QB Sync] ✅ Reconciliación: ${reconciled} resueltos, ${pending} en revisión, ${skipped} omitidos`,
  );
}
// ─── SYNC CUSTOMERS ─────────────────────────────────────────────────────────

async function syncCustomersToClients(customers) {
  console.log(
    `[DEBUG] syncCustomersToClients START — ${customers.length} customers`,
  );
  let clientsUpdated = 0;
  let clientsCreated = 0;
  let leadsMatched = 0;
  let invoicesLinked = 0;
  let paymentsLinked = 0;
  let notFound = 0;

  for (const customer of customers) {
    const qbCustomerId = customer.id;
    const email = customer.email;
    const normalizedEmail = email?.toLowerCase().trim() || null;
    const fullName = customer.displayName?.trim() || "";
    const nameParts = fullName.split(" ").filter(Boolean);
    const firstName = customer.givenName?.trim() || nameParts[0] || "";
    const lastName =
      customer.familyName?.trim() || nameParts.slice(1).join(" ") || "";

    const basePatch = Object.fromEntries(
      Object.entries({
        quickbooks_customer_id: qbCustomerId,
        phone: customer.phone,
        mobile: customer.mobile,
        street: customer.billAddrLine1,
        city: customer.billAddrCity,
        state: customer.billAddrState,
        zip_code: customer.billAddrZip,
        country: customer.billAddrCountry,
        default_address: customer.billAddrFull,
        updated_at: new Date().toISOString(),
      }).filter(([, v]) => v != null),
    );

    // ── 1. Intentar encontrar el cliente existente ─────────────────────────
    let existingClient = null;

    // Prioridad 0: por quickbooks_customer_id — evita re-INSERTs que violan
    // el unique constraint idx_clients_quickbooks_customer_id (afecta sobre
    // todo a entidades sin last_name, como "RONA+").
    {
      const { data } = await supabase
        .from("clients")
        .select("id")
        .eq("quickbooks_customer_id", qbCustomerId)
        .maybeSingle();
      if (data) existingClient = data;
    }

    if (!existingClient && normalizedEmail) {
      const { data } = await supabase
        .from("clients")
        .select("id")
        .ilike("email", normalizedEmail)
        .maybeSingle();
      if (data) existingClient = data;
    }

    // Fallback: match por nombre si no hay email o no matcheó
    if (!existingClient && firstName && lastName) {
      const { data } = await supabase
        .from("clients")
        .select("id")
        .ilike("first_name", firstName)
        .ilike("last_name", lastName)
        .limit(2);
      // Solo matchear si es unívoco
      if (data?.length === 1) existingClient = data[0];
      else if (data?.length > 1) {
        console.log(
          `[DEBUG] syncCustomers ambiguous name match: "${fullName}" — skipping name match`,
        );
      }
    }

    // ── 2. Update si existe, insert si no existe ───────────────────────────
    if (existingClient) {
      const { error } = await supabase
        .from("clients")
        .update(basePatch)
        .eq("id", existingClient.id);

      if (error) {
        console.error(
          `[QB Sync] ⚠️  Error actualizando client ${fullName}:`,
          error.message,
        );
      } else {
        console.log(
          `[DEBUG] updated client "${fullName}" (${existingClient.id})`,
        );
        clientsUpdated++;
      }
    } else {
      // No existe → crear solo si tenemos al menos nombre
      if (!firstName) {
        console.log(
          `[DEBUG] skipping customer with no name and no email: QB#${qbCustomerId}`,
        );
        notFound++;
        continue;
      }

      const newClient = {
        ...basePatch,
        first_name: firstName,
        last_name: lastName || null,
        email: normalizedEmail,
        status: "active",
        source: "quickbooks",
        created_at: new Date().toISOString(),
      };

      const { data: created, error: createError } = await supabase
        .from("clients")
        .insert(newClient)
        .select("id")
        .single();

      if (createError) {
        console.error(
          `[QB Sync] ⚠️  Error creando client "${fullName}":`,
          createError.message,
        );
        notFound++;
        continue;
      }

      console.log(
        `[DEBUG] created client "${fullName}" (${created.id}) from QB#${qbCustomerId}`,
      );
      clientsCreated++;
      existingClient = created;
    }

    // ── 2.5. Backfill client_id en invoices/payments via quickbooks_customer_id ──
    // Independiente de si existe un lead — vincula TODO lo que vino de QB
    // con el cliente, sin depender de que el email matchee un lead.
    const { data: invUpdated, error: invClientErr } = await supabase
      .from("invoices")
      .update({ client_id: existingClient.id })
      .eq("quickbooks_customer_id", qbCustomerId)
      .is("client_id", null)
      .select("id");

    if (invClientErr) {
      console.error(
        `[QB Sync] ⚠️  Error backfilling invoices.client_id para "${fullName}":`,
        invClientErr.message,
      );
    } else {
      invoicesLinked += invUpdated?.length ?? 0;
    }

    const { data: payUpdated, error: payClientErr } = await supabase
      .from("payments")
      .update({ client_id: existingClient.id })
      .eq("quickbooks_customer_id", qbCustomerId)
      .is("client_id", null)
      .select("id");

    if (payClientErr) {
      console.error(
        `[QB Sync] ⚠️  Error backfilling payments.client_id para "${fullName}":`,
        payClientErr.message,
      );
    } else {
      paymentsLinked += payUpdated?.length ?? 0;
    }

    // ── 3. Link invoices + payments via leads table ────────────────────────
    if (!normalizedEmail) {
      notFound++;
      continue;
    }

    const { data: lead } = await supabase
      .from("leads")
      .select("id")
      .eq("email", normalizedEmail)
      .maybeSingle();

    if (!lead) {
      console.log(`[DEBUG] no lead found for ${normalizedEmail}`);
      notFound++;
      continue;
    }

    await supabase
      .from("invoices")
      .update({ lead_id: lead.id })
      .eq("quickbooks_customer_id", qbCustomerId)
      .is("lead_id", null);
    await supabase
      .from("payments")
      .update({ lead_id: lead.id })
      .eq("quickbooks_customer_id", qbCustomerId)
      .is("lead_id", null);

    leadsMatched++;
  }

  console.log(
    `[QB Sync] 👥 Clients actualizados: ${clientsUpdated} | Creados: ${clientsCreated} | Leads matcheados: ${leadsMatched} | Sin match: ${notFound}`,
  );
  console.log(
    `[QB Sync] 🔗 client_id backfill — invoices: ${invoicesLinked} | payments: ${paymentsLinked}`,
  );
}
// ─── SYNC LAST ACTIVITY ──────────────────────────────────────────────────────

async function syncClientLastActivity(rawInvoices) {
  const paidInvoices = rawInvoices.filter(
    (inv) => inv.Balance === 0 && inv.TxnDate,
  );
  console.log(
    `[DEBUG] syncClientLastActivity — paid: ${paidInvoices.length}/${rawInvoices.length}`,
  );
  if (!paidInvoices.length) {
    console.log("[QB Sync] ℹ️  No paid invoices to sync for last_activity_at");
    return;
  }

  let updated = 0;
  let skipped = 0;
  let notFound = 0;

  for (const inv of paidInvoices) {
    const invoiceDate = new Date(inv.TxnDate).toISOString();
    const customerEmail = inv.BillEmail?.Address?.toLowerCase().trim() || null;
    const customerName = inv.CustomerRef?.name?.trim() || "";

    let client = null;

    // Priority 1: match by email
    if (customerEmail) {
      const { data } = await supabase
        .from("clients")
        .select("id, last_activity_at")
        .ilike("email", customerEmail)
        .maybeSingle();
      if (data) client = data;
    }

    // Priority 2: split "Firstname Lastname" → first_name + last_name columns
    if (!client && customerName) {
      const parts = customerName.split(" ").filter(Boolean);
      const firstName = parts[0] ?? "";
      const lastName = parts.slice(1).join(" ") || "";

      let query = supabase
        .from("clients")
        .select("id, last_activity_at")
        .ilike("first_name", firstName);
      if (lastName) query = query.ilike("last_name", lastName);

      const { data } = await query.limit(2);
      if (data?.length === 1) client = data[0];
      else if (data?.length > 1)
        console.log(`[DEBUG] last_activity ambiguous name: "${customerName}"`);
    }

    if (!client) {
      console.log(
        `[DEBUG] last_activity no match — email:${customerEmail} name:"${customerName}"`,
      );
      notFound++;
      continue;
    }

    const current = client.last_activity_at
      ? new Date(client.last_activity_at)
      : null;
    const candidate = new Date(invoiceDate);

    if (current && candidate <= current) {
      skipped++;
      continue;
    }

    const { error } = await supabase
      .from("clients")
      .update({
        last_activity_at: invoiceDate,
        updated_at: new Date().toISOString(),
      })
      .eq("id", client.id);

    if (error) {
      console.error(
        `[QB Sync] ⚠️  last_activity_at update error for client ${client.id}:`,
        error.message,
      );
    } else {
      updated++;
    }
  }

  console.log(
    `[QB Sync] 📅 last_activity_at: ${updated} updated | ${skipped} already current | ${notFound} unmatched`,
  );
}

// ─── MAIN ────────────────────────────────────────────────────────────────────

export async function syncQuickbooksData({ fromDateOverride } = {}) {
  console.log(
    `[QB Sync] 🔄 Iniciando — ${new Date().toISOString()} — sandbox: ${IS_SANDBOX}`,
  );

  try {
    // Cargar mapa de métodos de pago antes de procesar payments
    _paymentMethodsMap = await getPaymentMethodsMap();

    const from = getSyncFromDate(fromDateOverride);
    console.log(`[QB Sync] Trayendo datos desde: ${from}`);

    const rawInvoices = await getInvoicesSince(from);
    console.log(`[QB Sync] Invoices recibidas de QB: ${rawInvoices.length}`);

    const rawPayments = await getPaymentsSince(from);
    console.log(`[QB Sync] Payments recibidos de QB: ${rawPayments.length}`);

    await syncInvoices(rawInvoices);
    await syncPayments(rawPayments);
    await syncClientLastActivity(rawInvoices);

    console.log(`[QB Sync] 🔍 Buscando customers en QB...`);
    const customers = await getCustomersWithEmail();
    console.log(`[QB Sync] Customers encontrados en QB: ${customers.length}`);
    await syncCustomersToClients(customers);

    await reconcileQbPayments(rawPayments);

    // Recalculate client statuses now that last_activity_at is fresh
    await runStatusRefreshJob();

    console.log(`[QB Sync] ✅ Completado — ${new Date().toISOString()}`);
  } catch (err) {
    console.error("[QB Sync] ❌ Error:", err.message);
    console.error(err);
  }
}

// Cada hora - ajustá según necesites
cron.schedule("0 3 * * *", syncQuickbooksData);

// Correr una vez al arrancar el servidor
syncQuickbooksData();
