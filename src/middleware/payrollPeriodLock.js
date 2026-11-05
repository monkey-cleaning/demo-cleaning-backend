// middleware/payrollPeriodLock.js
// Payroll — una quincena cerrada es un archivo inmutable:
//   * lock(getPeriod): rechaza (423) cualquier escritura sobre un período
//     cerrado. `getPeriod(req)` devuelve el { year, month, half } afectado
//     (del body, del query o de la fila por id).
//   * serveFrozen(path): en las lecturas, si el período está cerrado responde
//     con lo guardado en el snapshot en vez de recalcular.
import {
  getClosing,
  getClosingPart,
  periodFrom,
  periodOfRow,
} from "../services/payrollClosingsService.js";

export const CLOSED_MESSAGE =
  "This fortnight is closed and can't be modified.";

export const fromBody = (req) => periodFrom(req.body);
export const fromQuery = (req) => periodFrom(req.query);
export const fromRow = (table) => (req) => periodOfRow(table, req.params.id);

export function lock(getPeriod) {
  return async (req, res, next) => {
    try {
      const period = await getPeriod(req);
      if (!period) return next(); // sin período identificable: lo valida el handler
      if (await getClosing(period)) {
        return res.status(423).json({ ok: false, closed: true, error: CLOSED_MESSAGE });
      }
      return next();
    } catch (e) {
      // Un fallo al consultar el cierre no debe tumbar la escritura ni dejar
      // pasar en silencio: se rechaza para no arriesgar un archivo cerrado.
      console.error("❌ payrollPeriodLock:", e.message);
      return res.status(500).json({ ok: false, error: "Could not verify the fortnight is open" });
    }
  };
}

// Respuestas que se sirven congeladas. `path` es una ruta dentro del snapshot
// (lista fija del código): "summary" o "sections->dividends".
export function serveFrozen(path, { emptyBody } = {}) {
  return async (req, res, next) => {
    try {
      const period = fromQuery(req);
      if (!period) return next();
      const frozen = await getClosingPart(period, path);
      if (!frozen) return next();
      if (emptyBody !== undefined) return res.json(emptyBody);
      if (frozen.part == null) return next(); // sección no capturada
      const closing = { closedAt: frozen.closedAt, closedBy: frozen.closedBy };
      return res.json(path === "summary" ? { ...frozen.part, closing } : frozen.part);
    } catch (e) {
      console.error("❌ payrollPeriodLock.serveFrozen:", e.message);
      return next();
    }
  };
}
