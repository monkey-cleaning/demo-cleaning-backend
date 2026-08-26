//
// Core logic for the e-Transfer sync pipeline:
//   1. Fetch raw Interac notifications from Gmail via IMAP.
//   2. For each mail, attempt to match it against invoices/payments/clients/leads.
//   3. Upsert into the `etransfers` table (idempotent via message_id).
//
// Matching cascade (in order):
//   1. Open invoices (sent/overdue)     → name similarity → lead_id + resolve client_id
//   2. QB payments (e-transfer method)  → name similarity → lead_id + resolve client_id
//   3. Recently paid invoices (≤30d)    → name similarity → lead_id + resolve client_id
//   4. clients table directly           → name similarity → client_id + resolve lead_id
//   5. leads table directly             → name similarity → lead_id + resolve client_id
//   6. transfer_sender_aliases (exact)  → client_id (future-proof, data sparse now)

import { supabase } from "./supabaseService.js";
import { fetchInteracTransfers } from "./gmailInteracService.js";

// ── Matching thresholds ───────────────────────────────────────────────────────
const EXACT_THRESHOLD = 0.95;
const FUZZY_THRESHOLD = 0.75;
const INVOICE_LOOKBACK_DAYS = 180;
const PAID_INVOICE_LOOKBACK_DAYS = 30; // shorter window for paid invoices

// ── Name normalization ────────────────────────────────────────────────────────

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

function nameSimilarity(a, b) {
  const ta = new Set(normalizeName(a).split(" ").filter(Boolean));
  const tb = new Set(normalizeName(b).split(" ").filter(Boolean));
  if (!ta.size || !tb.size) return 0;
  let shared = 0;
  for (const token of ta) {
    if (tb.has(token)) shared++;
  }
  return shared / Math.max(ta.size, tb.size);
}

// ── Candidate loaders ─────────────────────────────────────────────────────────

async function loadCandidateInvoices() {
  const cutoff = new Date(Date.now() - INVOICE_LOOKBACK_DAYS * 86_400_000)
    .toISOString()
    .slice(0, 10);
  const cutoffPaid = new Date(
    Date.now() - PAID_INVOICE_LOOKBACK_DAYS * 86_400_000,
  )
    .toISOString()
    .slice(0, 10);

  // Open invoices (full lookback window)
  const { data: open, error: openErr } = await supabase
    .from("invoices")
    .select(
      "id, doc_number, total_amount, balance, quickbooks_customer_name, lead_id, status, due_date",
    )
    .gte("issued_date", cutoff)
    .in("status", ["sent", "overdue"]);
  if (openErr)
    throw new Error(`loadCandidateInvoices (open): ${openErr.message}`);

  // Recently paid invoices (shorter window — just to catch same-cycle payments)
  const { data: paid, error: paidErr } = await supabase
    .from("invoices")
    .select(
      "id, doc_number, total_amount, balance, quickbooks_customer_name, lead_id, status, due_date",
    )
    .gte("paid_date", cutoffPaid)
    .eq("status", "paid");
  if (paidErr)
    throw new Error(`loadCandidateInvoices (paid): ${paidErr.message}`);

  return { open: open ?? [], paid: paid ?? [] };
}

async function loadCandidatePayments() {
  const cutoff = new Date(Date.now() - INVOICE_LOOKBACK_DAYS * 86_400_000)
    .toISOString()
    .slice(0, 10);

  const { data, error } = await supabase
    .from("payments")
    .select(
      "id, amount, payment_date, quickbooks_customer_name, lead_id, client_id",
    )
    .gte("payment_date", cutoff)
    .or("payment_method.ilike.%e-transfer%,payment_method.ilike.%interac%");

  if (error) throw new Error(`loadCandidatePayments: ${error.message}`);
  return data ?? [];
}

async function loadCandidateClients() {
  const { data, error } = await supabase
    .from("clients")
    .select("id, first_name, last_name, email, transfer_sender_aliases");
  if (error) throw new Error(`loadCandidateClients: ${error.message}`);
  return data ?? [];
}

async function loadCandidateLeads() {
  const { data, error } = await supabase
    .from("leads")
    .select("id, full_name, email");
  if (error) throw new Error(`loadCandidateLeads: ${error.message}`);
  return data ?? [];
}

// ── Cross-table ID resolver ───────────────────────────────────────────────────
// Given a lead_id or client_id, attempts to resolve the missing one via email.

async function resolveIds({ lead_id, client_id }) {
  // Both already known — nothing to do
  if (lead_id && client_id) return { lead_id, client_id };

  if (lead_id && !client_id) {
    const { data } = await supabase
      .from("leads")
      .select("email")
      .eq("id", lead_id)
      .maybeSingle();
    if (data?.email) {
      const { data: client } = await supabase
        .from("clients")
        .select("id")
        .ilike("email", data.email)
        .maybeSingle();
      return { lead_id, client_id: client?.id ?? null };
    }
  }

  if (client_id && !lead_id) {
    const { data } = await supabase
      .from("clients")
      .select("email, first_name, last_name")
      .eq("id", client_id)
      .maybeSingle();

    if (data?.email) {
      const { data: lead } = await supabase
        .from("leads")
        .select("id")
        .ilike("email", data.email)
        .maybeSingle();
      return { lead_id: lead?.id ?? null, client_id };
    }
    // Sin email — igual retornar el client_id que tenemos
    return { lead_id: null, client_id };
  }

  return { lead_id: null, client_id: null };
}

// ── Matchers ──────────────────────────────────────────────────────────────────

function matchByNameAndAmount(transfer, candidates, nameField) {
  const byAmount = candidates.filter(
    (c) =>
      Math.abs(Number(c.total_amount ?? c.amount) - transfer.amount) < 0.01,
  );
  if (!byAmount.length) return null;

  let best = null,
    bestScore = 0;
  for (const c of byAmount) {
    const score = nameSimilarity(transfer.senderName, c[nameField]);
    if (score > bestScore) {
      bestScore = score;
      best = c;
    }
  }

  if (bestScore >= EXACT_THRESHOLD) return { match: best, confidence: "exact" };
  if (bestScore >= FUZZY_THRESHOLD) return { match: best, confidence: "fuzzy" };
  return null;
}

function matchClientByAlias(senderName, clients) {
  const normalized = normalizeName(senderName);
  for (const client of clients) {
    const aliases = client.transfer_sender_aliases ?? [];

    // Validación: asegurar que aliases es array
    if (!Array.isArray(aliases)) {
      console.warn(
        `[EtransferSync] Client ${client.id} has non-array aliases:`,
        typeof aliases,
        aliases,
      );
      continue;
    }

    if (aliases.some((a) => normalizeName(a) === normalized)) return client;

    // DEBUG: si no matchea, loguea por qué
    if (aliases.length > 0) {
      const normalized_aliases = aliases.map(normalizeName);
      if (
        aliases.some((a) => a.toLowerCase().includes(senderName.toLowerCase()))
      ) {
        console.log(
          `[EtransferSync] CLOSE BUT NO MATCH for ${senderName}`,
          `Expected one of: ${normalized_aliases.join(" | ")}`,
          `Got normalized: "${normalized}"`,
          `Client: ${client.id}`,
        );
      }
    }
  }
  return null;
}

function matchClientByName(transfer, clients) {
  let best = null,
    bestScore = 0;
  for (const client of clients) {
    const fullName =
      `${client.first_name ?? ""} ${client.last_name ?? ""}`.trim();
    const score = nameSimilarity(transfer.senderName, fullName);
    if (score > bestScore) {
      bestScore = score;
      best = client;
    }
  }
  if (bestScore >= FUZZY_THRESHOLD)
    return {
      match: best,
      confidence: bestScore >= EXACT_THRESHOLD ? "exact" : "fuzzy",
    };
  return null;
}

function matchLeadByName(transfer, leads) {
  let best = null,
    bestScore = 0;
  for (const lead of leads) {
    const score = nameSimilarity(transfer.senderName, lead.full_name);
    if (score > bestScore) {
      bestScore = score;
      best = lead;
    }
  }
  if (bestScore >= FUZZY_THRESHOLD)
    return {
      match: best,
      confidence: bestScore >= EXACT_THRESHOLD ? "exact" : "fuzzy",
    };
  return null;
}

// ── Status derivation ─────────────────────────────────────────────────────────

function deriveStatus(transfer, invoice) {
  if (!invoice) return "pending";
  const diff = Math.abs(Number(invoice.total_amount) - transfer.amount);
  return diff < 0.01 ? "received" : "discrepancy";
}

// ── Upsert ────────────────────────────────────────────────────────────────────

async function upsertEtransfers(rows) {
  if (!rows.length) return;
  const { error } = await supabase
    .from("etransfers")
    .upsert(rows, { onConflict: "message_id", ignoreDuplicates: false });
  if (error) throw new Error(`upsertEtransfers: ${error.message}`);
}

// ── Public API ────────────────────────────────────────────────────────────────

export async function syncEtransfers({ fromDate, dryRun = false } = {}) {
  const since = fromDate
    ? new Date(fromDate)
    : new Date(Date.now() - 30 * 86_400_000);

  console.log(
    `[EtransferSync] Fetching Gmail since ${since.toISOString().slice(0, 10)}…`,
  );

  let rawTransfers;
  try {
    rawTransfers = await fetchInteracTransfers(since);
  } catch (err) {
    throw new Error(`[EtransferSync] Gmail fetch failed: ${err.message}`);
  }

  console.log(
    `[EtransferSync] ${rawTransfers.length} Interac notifications found.`,
  );
  if (!rawTransfers.length) {
    return { fetched: 0, inserted: 0, updated: 0, unmatched: 0, errors: [] };
  }

  // Load all candidate sets once — shared across all transfers in this run.
  const [
    { open: openInvoices, paid: paidInvoices },
    qbPayments,
    clients,
    leads,
  ] = await Promise.all([
    loadCandidateInvoices(),
    loadCandidatePayments(),
    loadCandidateClients(),
    loadCandidateLeads(),
  ]);

  console.log(
    `[EtransferSync] Candidates — open invoices: ${openInvoices.length}, ` +
      `paid invoices: ${paidInvoices.length}, payments: ${qbPayments.length}, ` +
      `clients: ${clients.length}, leads: ${leads.length}`,
  );

  const now = new Date().toISOString();
  const rows = [];
  const errors = [];
  let unmatched = 0;

  // Tracks payment_ids already linked to a transfer earlier in THIS run, so
  // two different e-transfers (e.g. same amount, same client, within the
  // 3-day tolerance) don't both get matched to the same payment record.
  const claimedPaymentIds = new Set();

  for (const transfer of rawTransfers) {
    try {
      if (!transfer.messageId) {
        errors.push(
          `Skipped transfer from ${transfer.senderName} (no messageId)`,
        );
        continue;
      }

      let lead_id = null;
      let client_id = null;
      let invoice_id = null;
      let doc_number = null;
      let match_confidence = null;
      let matchedInvoice = null;

      // ── Step 0: alias exact match ────────────────────────────────────────
      // Runs FIRST: transfer_sender_aliases is curated/authoritative data
      // (loaded by hand precisely to catch cases where the bank sender name
      // doesn't resemble the client's real/QB name). It must win over the
      // fuzzy heuristics below, otherwise a coincidental weak match on an
      // unrelated invoice/payment can consume the transfer before the
      // alias is ever checked.

      console.log(
        `[EtransferSync] Processing: ${transfer.senderName} ($${transfer.amount})`,
      );
      console.log(
        `[EtransferSync]   Normalized to: "${normalizeName(transfer.senderName)}"`,
      );

      const aliasMatch0 = matchClientByAlias(transfer.senderName, clients);
      if (aliasMatch0) {
        match_confidence = "exact";
        ({ lead_id, client_id } = await resolveIds({
          lead_id: null,
          client_id: aliasMatch0.id,
        }));
        console.log(
          `[EtransferSync] ✓ Step0 (alias MATCH) → ${transfer.senderName} matched to client ${aliasMatch0.id}`,
        );
      } else if (
        clients.some((c) => (c.transfer_sender_aliases ?? []).length > 0)
      ) {
        console.log(
          `[EtransferSync] ✗ Step0 (alias NO MATCH) → ${transfer.senderName} | will try fuzzy fallback`,
        );
      }

      // ── Step 1: open invoices ───────────────────────────────────────────
      const openMatch =
        !lead_id &&
        !client_id &&
        matchByNameAndAmount(
          transfer,
          openInvoices,
          "quickbooks_customer_name",
        );
      if (openMatch) {
        matchedInvoice = openMatch.match;
        match_confidence = openMatch.confidence;
        invoice_id = matchedInvoice.id;
        doc_number = matchedInvoice.doc_number;
        ({ lead_id, client_id } = await resolveIds({
          lead_id: matchedInvoice.lead_id,
          client_id: null,
        }));
        console.log(
          `[EtransferSync] Step1 (open invoice) → ${transfer.senderName} | conf: ${match_confidence}`,
        );
      }

      // ── Step 2: QB payments ─────────────────────────────────────────────
      if (!lead_id && !client_id) {
        const payMatch = matchByNameAndAmount(
          transfer,
          qbPayments,
          "quickbooks_customer_name",
        );
        if (payMatch) {
          match_confidence = payMatch.confidence;
          ({ lead_id, client_id } = await resolveIds({
            lead_id: payMatch.match.lead_id,
            client_id: payMatch.match.client_id,
          }));
          console.log(
            `[EtransferSync] Step2 (QB payment) → ${transfer.senderName} | conf: ${match_confidence}`,
          );
        }
      }

      // ── Step 3: recently paid invoices ──────────────────────────────────
      if (!lead_id && !client_id) {
        const paidMatch = matchByNameAndAmount(
          transfer,
          paidInvoices,
          "quickbooks_customer_name",
        );
        if (paidMatch) {
          matchedInvoice = paidMatch.match;
          match_confidence = paidMatch.confidence;
          // Don't overwrite invoice_id — this invoice is already paid, linking it
          // would imply it's still open. Just grab the identity.
          ({ lead_id, client_id } = await resolveIds({
            lead_id: matchedInvoice.lead_id,
            client_id: null,
          }));
          console.log(
            `[EtransferSync] Step3 (paid invoice) → ${transfer.senderName} | conf: ${match_confidence}`,
          );
        }
      }

      // ── Step 4: clients table by name similarity ────────────────────────
      // (Exact alias match already attempted in Step 0.)
      if (!lead_id && !client_id) {
        const clientMatch = matchClientByName(transfer, clients);
        if (clientMatch) {
          match_confidence = clientMatch.confidence;
          ({ lead_id, client_id } = await resolveIds({
            lead_id: null,
            client_id: clientMatch.match.id,
          }));
          console.log(
            `[EtransferSync] Step4 (client name) → ${transfer.senderName} | conf: ${match_confidence}`,
          );
        }
      }

      // ── Step 5: leads table directly ────────────────────────────────────
      if (!lead_id && !client_id) {
        const leadMatch = matchLeadByName(transfer, leads);
        if (leadMatch) {
          match_confidence = leadMatch.confidence;
          ({ lead_id, client_id } = await resolveIds({
            lead_id: leadMatch.match.id,
            client_id: null,
          }));
          console.log(
            `[EtransferSync] Step5 (lead name) → ${transfer.senderName} | conf: ${match_confidence}`,
          );
        }
      }

      if (!lead_id && !client_id) unmatched++;

      const status = deriveStatus(transfer, matchedInvoice);

      // ── Step 7 helper: resolve payment_id by matching against payments table ───
      const PAYMENT_DATE_TOLERANCE_MS = 3 * 86_400_000; // 3 days

      async function matchPaymentRecord(transfer, { lead_id, client_id }) {
        if (!lead_id && !client_id) return null;

        let q = supabase
          .from("payments")
          .select("id, payment_date, amount")
          .eq("amount", transfer.amount);

        q = lead_id ? q.eq("lead_id", lead_id) : q.eq("client_id", client_id);

        const { data, error } = await q;
        if (error || !data?.length) return null;

        // Exclude payments already claimed by another transfer earlier in
        // this same run — otherwise two same-amount, same-client transfers
        // within the tolerance window would both match the one payment.
        const available = data.filter((p) => !claimedPaymentIds.has(p.id));
        if (!available.length) return null;

        const transferTime = new Date(transfer.date ?? Date.now()).getTime();

        let best = null,
          bestDiff = Infinity;
        for (const p of available) {
          const diff = Math.abs(
            new Date(p.payment_date).getTime() - transferTime,
          );
          if (diff <= PAYMENT_DATE_TOLERANCE_MS && diff < bestDiff) {
            bestDiff = diff;
            best = p;
          }
        }

        if (best?.id) claimedPaymentIds.add(best.id);
        return best?.id ?? null;
      }

      let payment_id = null;
      if (lead_id || client_id) {
        payment_id = await matchPaymentRecord(transfer, { lead_id, client_id });
        if (payment_id) {
          console.log(
            `[EtransferSync] Step7 (payment match) → ${transfer.senderName} | payment_id: ${payment_id}`,
          );
          // Actualizar payment_method solo si aún no tiene uno seteado.
          // La condición principal aquí es el match confirmado contra etransfers,
          // no la ausencia de método (que podría darse por otras razones).
          const { error: updateErr } = await supabase
            .from("payments")
            .update({ payment_method: "e-Transfer" })
            .eq("id", payment_id)
            .is("payment_method", null);
          if (updateErr) {
            console.warn(
              `[EtransferSync] Could not update payment_method for ${payment_id}: ${updateErr.message}`,
            );
          } else {
            console.log(
              `[EtransferSync] Step7 (payment_method) → set e-Transfer on payment ${payment_id}`,
            );
          }
        }
      }

      rows.push({
        message_id: transfer.messageId,
        received_at: transfer.date ?? now,
        sender_name: transfer.senderName,
        amount: transfer.amount,
        subject: transfer.subject ?? null,
        lead_id,
        client_id,
        payment_id,
        invoice_id,
        doc_number,
        match_confidence,
        status,
        synced_at: now,
      });
    } catch (err) {
      errors.push(`Error processing ${transfer.messageId}: ${err.message}`);
    }
  }

  if (dryRun) {
    console.log("[EtransferSync] DRY RUN — rows that would be upserted:", rows);
    return {
      fetched: rawTransfers.length,
      inserted: 0,
      updated: 0,
      unmatched,
      errors,
      dryRun: true,
    };
  }

  const BATCH = 100;
  for (let i = 0; i < rows.length; i += BATCH) {
    await upsertEtransfers(rows.slice(i, i + BATCH));
  }

  const upsertedIds = rows.map((r) => r.message_id);
  const { count: existingCount } = await supabase
    .from("etransfers")
    .select("id", { count: "exact", head: true })
    .in("message_id", upsertedIds);

  const updated = Math.min(existingCount ?? 0, rows.length);
  const inserted = rows.length - updated;

  const stats = {
    fetched: rawTransfers.length,
    inserted,
    updated,
    unmatched,
    errors,
  };
  console.log("[EtransferSync] Done:", stats);
  return stats;
}
