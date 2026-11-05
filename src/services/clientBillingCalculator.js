// services/clientBillingCalculator.js
//
// "Cuánto vale un evento ya trabajado para el cliente" — usado por payroll (P&L,
// Forecast, facturación por evento). Es una REFERENCIA: no hay forma de
// reconstruir el monto cotizado real de un evento ya trabajado, así que el admin
// puede corregir el monto por evento (payroll_client_billing_overrides).
//
//   durationH × cleaners asignados al evento × tarifa efectiva × (1 + GST)
//
// Tarifa efectiva: `clients.rate` cuando está cargada; si no, la base del quote
// (HOURLY_RATE) o la de Move-in/Move-out. A diferencia de Monkey, Demo NO tiene
// tarifa diferencial para clientes nuevos ni recargo de feriado en la facturación
// (decisión de producto: depende de cada negocio).
import {
  HOURLY_RATE,
  HOURLY_RATE_MOVE_IN_OUT,
} from "./cleaningQuoteCalculator.js";

export const MOVE_IN_OUT_SERVICE_TYPE = "Move-in/Move-out";

// GST — se cobra aparte del labor rate. BC/Canadá: 5%.
export const GST_RATE = 0.05;

function round2(n) {
  return Math.round(n * 100) / 100;
}

export function resolveClientHourlyRate({ serviceType, clientRate }) {
  if (clientRate != null) return Number(clientRate);
  if (serviceType === MOVE_IN_OUT_SERVICE_TYPE) return HOURLY_RATE_MOVE_IN_OUT;
  return HOURLY_RATE;
}

// Función pura — recibe ya resuelto el contexto (nada de DB acá).
// `clientCreatedAt` y `eventStartIso` se aceptan por compatibilidad y no se usan.
export function computeEventClientMoney({
  durationH,
  attendeeCount = 1,
  serviceType,
  clientRate,
}) {
  const baseRate = resolveClientHourlyRate({ serviceType, clientRate });
  const crew = Math.max(1, attendeeCount || 1);
  const preTax = (durationH || 0) * crew * baseRate;
  return {
    calculatedAmount: round2(preTax * (1 + GST_RATE)),
    // Sin el 5% de GST — lo que usa el P&L para "Gross revenue".
    preTaxAmount: round2(preTax),
    billedRate: baseRate,
    baseRate,
    holidayName: null,
  };
}
