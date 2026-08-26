/**
 * scripts/backfillEtransferPaymentMethod.js
 *
 * One-shot migration: marca payment_method = 'e-Transfer' en los pagos de QB
 * que tienen un match confirmado en la tabla `etransfers` (campo payment_id)
 * pero que aún no tienen método seteado.
 *
 * Criterio: el pago aparece en etransfers.payment_id  ← match confirmado
 *           AND payments.payment_method IS NULL        ← no pisar datos existentes
 *
 * Correr UNA sola vez:
 *   node scripts/backfillEtransferPaymentMethod.js
 */

import { supabase } from "../services/supabaseService.js";

async function run() {
  console.log("[Backfill] Buscando e-transfers con payment_id seteado…");

  // 1. Obtener todos los payment_id que la tabla etransfers identificó como match
  const { data: matched, error: fetchErr } = await supabase
    .from("etransfers")
    .select("payment_id")
    .not("payment_id", "is", null);

  if (fetchErr) throw new Error(`Error leyendo etransfers: ${fetchErr.message}`);

  const paymentIds = [...new Set(matched.map((r) => r.payment_id))];
  console.log(`[Backfill] ${paymentIds.length} pagos con match en etransfers`);

  if (!paymentIds.length) {
    console.log("[Backfill] Nada que actualizar.");
    return;
  }

  // 2. Preview: cuántos de esos pagos no tienen método aún
  const { count: toUpdate, error: countErr } = await supabase
    .from("payments")
    .select("id", { count: "exact", head: true })
    .in("id", paymentIds)
    .is("payment_method", null);

  if (countErr) throw new Error(`Error contando: ${countErr.message}`);
  console.log(`[Backfill] ${toUpdate} pagos sin payment_method → se marcarán como e-Transfer`);
  console.log(`[Backfill] ${paymentIds.length - (toUpdate ?? 0)} ya tenían método seteado → no se tocan`);

  if (!toUpdate) {
    console.log("[Backfill] Nada que actualizar.");
    return;
  }

  // 3. Actualizar en batches de 100 para no saturar la API
  const BATCH = 100;
  let updated = 0;

  for (let i = 0; i < paymentIds.length; i += BATCH) {
    const batch = paymentIds.slice(i, i + BATCH);
    const { error: updateErr } = await supabase
      .from("payments")
      .update({ payment_method: "e-Transfer" })
      .in("id", batch)
      .is("payment_method", null);

    if (updateErr) throw new Error(`Error actualizando batch ${i}: ${updateErr.message}`);
    updated += batch.length;
    console.log(`[Backfill] ${updated}/${paymentIds.length} procesados…`);
  }

  console.log("[Backfill] ✅ Listo.");
}

run().catch((err) => {
  console.error("[Backfill] ❌", err.message);
  process.exit(1);
});