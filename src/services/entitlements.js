// ─────────────────────────────────────────────────────────────────────────────
// entitlements.js
//
// Único lugar que decide si la instancia puede usar features de pago / addon.
// Hoy el "auto blog" se activa a mano (PUT /api/internal/content/addon con
// service token). Cuando se enchufe cobro (Stripe / Mercado Pago), el webhook
// de pago exitoso debería llamar a setAutoAddonStatus('active') (o al endpoint
// interno) y el de fallido/cancelado a 'past_due' / 'inactive'.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * @param {{ auto_addon_status?: string }} siteSettings
 * @returns {boolean}
 */
export function hasAutoBlogEntitlement(siteSettings) {
  // Cobro: reemplazar / complementar con chequeo de suscripción activa
  // (Stripe subscription status === 'active', etc.).
  return siteSettings?.auto_addon_status === "active";
}
