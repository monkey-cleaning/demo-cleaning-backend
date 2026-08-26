// Servicio de reconciliación de pagos + deteccion de propina
// Fuente de verdad en payment_allocations
import { supabase } from "./supabaseService.js";

const TIP_MAX_PCT = 0.3;

/**
 * Reconcilia un payment contra las invoices abiertas del cliente (FIFO) o
 * contra las invoices que QB ya vinculó explícitamente (LinkedTxn), y escribe
 * el resultado en payment_allocations.
 *
 * Idempotente: si el payment ya tiene cualquier allocation (aunque esté
 * superseded), no hace nada — evita que una corrección manual sea pisada por
 * una corrida posterior del sync.
 *
 * @param {object} params
 * @param {string} params.paymentId          - payments.id (uuid)
 * @param {string|null} params.clientId      - clients.id (uuid)
 * @param {number} params.amount             - payments.amount
 * @param {string[]} [params.linkedInvoiceQbIds] - quickbooks_invoice_id[] si QB ya linkeó el payment
 * @returns {Promise<{ status: string, allocations: object[] }>}
 */
export async function reconcilePayment({
  paymentId,
  clientId,
  amount,
  linkedInvoiceQbIds = [],
}) {
  if (!clientId) {
    return { status: "skipped_no_client", allocations: [] };
  }

  const { count: existingCount, error: existingErr } = await supabase
    .from("payment_allocations")
    .select("id", { count: "exact", head: true })
    .eq("payment_id", paymentId);
  if (existingErr) {
    throw new Error(
      `Error chequeando allocations existentes: ${existingErr.message}`,
    );
  }
  if (existingCount > 0) {
    return { status: "already_reconciled", allocations: [] };
  }

  const invoices = linkedInvoiceQbIds.length
    ? await getInvoicesByQbIds(linkedInvoiceQbIds)
    : await getOpenInvoicesFifo(clientId);

  if (!invoices.length) {
    const row = buildAllocation({
      paymentId,
      clientId,
      invoiceId: null,
      type: "pending_review",
      amount,
      source: "auto_fifo",
      note: "No open invoices for this payment",
    });
    await insertAllocations([row]);
    return { status: "pending_review", allocations: [row] };
  }

  const allocations = [];
  const coveredInvoices = [];
  let remaining = Number(amount);

  for (const inv of invoices) {
    if (remaining <= 0) break;
    const invoiceTotal = Number(inv.total_amount);
    const applied = Math.min(remaining, invoiceTotal);
    allocations.push(
      buildAllocation({
        paymentId,
        clientId,
        invoiceId: inv.id,
        type: "invoice_payment",
        amount: applied,
        source: "auto_fifo",
      }),
    );
    coveredInvoices.push(inv);
    remaining = Number((remaining - applied).toFixed(2));
  }

  if (remaining > 0.01) {
    if (coveredInvoices.length === 1) {
      const invoiceTotal = Number(coveredInvoices[0].total_amount);
      const maxTip = Number((invoiceTotal * TIP_MAX_PCT).toFixed(2));

      allocations.push(
        remaining <= maxTip
          ? buildAllocation({
              paymentId,
              clientId,
              invoiceId: coveredInvoices[0].id,
              type: "tip",
              amount: remaining,
              source: "auto_fifo",
            })
          : buildAllocation({
              paymentId,
              clientId,
              invoiceId: coveredInvoices[0].id,
              type: "pending_review",
              amount: remaining,
              source: "auto_fifo",
              note: `Surplus $${remaining} exceeds ${TIP_MAX_PCT * 100}% of the invoice ($${invoiceTotal})`,
            }),
      );
    } else {
      // Cubrió 0 o más de una invoice y sobró plata — nunca se auto-clasifica
      // como propina en ese caso (ver decisión de negocio).
      allocations.push(
        buildAllocation({
          paymentId,
          clientId,
          invoiceId: null,
          type: "pending_review",
          amount: remaining,
          source: "auto_fifo",
          note: coveredInvoices.length
            ? `Surplus after covering ${coveredInvoices.length} invoices by FIFO`
            : "Payment with no open invoices to cover",
        }),
      );
    }
  }

  await insertAllocations(allocations);

  const status = allocations.some((a) => a.allocation_type === "pending_review")
    ? "pending_review"
    : "resolved";
  return { status, allocations };
}

function buildAllocation({
  paymentId,
  clientId,
  invoiceId,
  type,
  amount,
  source,
  note = null,
  createdBy = null,
}) {
  return {
    payment_id: paymentId,
    client_id: clientId,
    invoice_id: invoiceId,
    allocation_type: type,
    amount: Number(Number(amount).toFixed(2)),
    source,
    created_by: createdBy,
    note,
  };
}

async function insertAllocations(rows) {
  if (!rows.length) return;
  const { error } = await supabase.from("payment_allocations").insert(rows);
  if (error) {
    throw new Error(`Error insertando payment_allocations: ${error.message}`);
  }
}

async function getInvoicesByQbIds(qbIds) {
  const { data, error } = await supabase
    .from("invoices")
    .select("id, total_amount, issued_date")
    .in("quickbooks_invoice_id", qbIds)
    .order("issued_date", { ascending: true });
  if (error)
    throw new Error(`Error trayendo invoices linkeadas: ${error.message}`);
  return data ?? [];
}

async function getOpenInvoicesFifo(clientId) {
  const { data, error } = await supabase
    .from("invoices")
    .select("id, total_amount, issued_date")
    .eq("client_id", clientId)
    .in("status", ["sent", "overdue"])
    .order("issued_date", { ascending: true });
  if (error)
    throw new Error(`Error trayendo invoices abiertas: ${error.message}`);
  return data ?? [];
}

// ── Revisión manual ───────────────────────────────────────────────────────

/**
 * Cola de allocations pendientes de revisión.
 * Sin clientId → global (payments page). Con clientId → drawer del cliente.
 */
export async function getPendingReview({ clientId } = {}) {
  let q = supabase
    .from("payment_allocations")
    .select(
      `id, payment_id, client_id, invoice_id, amount, note, created_at,
       payments(payment_date, amount, quickbooks_customer_name, payment_method)`,
    )
    .eq("allocation_type", "pending_review")
    .is("superseded_by", null)
    .order("created_at", { ascending: true });
  if (clientId) q = q.eq("client_id", clientId);

  const { data, error } = await q;
  if (error) throw new Error(`Error listando pending_review: ${error.message}`);
  return data ?? [];
}

/**
 * Un admin resuelve una allocation pendiente: crea la fila con la
 * clasificación correcta y marca la original como superseded (no se borra —
 * queda como historial de qué propuso el sistema vs. qué decidió el admin).
 */
export async function resolveAllocation(
  allocationId,
  { allocation_type, invoice_id = null, note = null, created_by },
) {
  if (!["invoice_payment", "tip", "credit_balance"].includes(allocation_type)) {
    throw new Error(
      `allocation_type inválido para resolución manual: ${allocation_type}`,
    );
  }
  if (allocation_type === "invoice_payment" && !invoice_id) {
    throw new Error(
      "invoice_id es requerido para allocation_type=invoice_payment",
    );
  }

  const { data: original, error: fetchErr } = await supabase
    .from("payment_allocations")
    .select("*")
    .eq("id", allocationId)
    .single();
  if (fetchErr)
    throw new Error(`Allocation no encontrada: ${fetchErr.message}`);
  if (original.allocation_type !== "pending_review") {
    throw new Error("Solo se pueden resolver allocations en pending_review");
  }

  const newRow = buildAllocation({
    paymentId: original.payment_id,
    clientId: original.client_id,
    invoiceId: invoice_id,
    type: allocation_type,
    amount: Number(original.amount),
    source: "manual",
    note,
    createdBy: created_by,
  });

  const { data: inserted, error: insertErr } = await supabase
    .from("payment_allocations")
    .insert(newRow)
    .select()
    .single();
  if (insertErr)
    throw new Error(`Error creando allocation manual: ${insertErr.message}`);

  const { error: supersedeErr } = await supabase
    .from("payment_allocations")
    .update({ superseded_by: inserted.id })
    .eq("id", allocationId);
  if (supersedeErr) {
    throw new Error(
      `Error marcando allocation original como superseded: ${supersedeErr.message}`,
    );
  }

  return inserted;
}

// ── Invoices abiertas de un cliente (para el picker de "aplicar a otra invoice") ──
export async function getClientOpenInvoices(clientId) {
  const { data, error } = await supabase
    .from("invoices")
    .select(
      "id, doc_number, quickbooks_invoice_id, total_amount, balance, issued_date, due_date",
    )
    .eq("client_id", clientId)
    .in("status", ["sent", "overdue"])
    .order("issued_date", { ascending: true });
  if (error)
    throw new Error(`Error trayendo invoices abiertas: ${error.message}`);
  return data ?? [];
}
