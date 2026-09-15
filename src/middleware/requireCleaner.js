import jwt from "jsonwebtoken";

// Portado de Monkey Cleaning (LAB423). Reusa el mismo secreto que
// requireAdmin.js (un solo JWT_SECRET para todo el backend), pero exige
// role:'cleaner'. Un token de cleaner nunca pasa requireAdmin (role !==
// 'blog-admin') y un token admin nunca pasa acá — son roles separados aunque
// compartan el secreto de firma.
//
// Se lee process.env EN CADA REQUEST (no en el load del módulo): según el
// orden de imports, dotenv puede no haber corrido todavía cuando se evalúa
// este archivo.

export function requireCleaner(req, res, next) {
  const secret = process.env.ADMIN_JWT_SECRET;
  const auth = req.headers.authorization || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : null;

  if (!token) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  try {
    const payload = jwt.verify(token, secret);
    if (payload.role !== "cleaner") {
      return res.status(403).json({ error: "Forbidden" });
    }
    // req.cleaner.email — lo usa staffCalendarController/staffHoursController
    // para resolver el employees.id del cleaner logueado.
    req.cleaner = { username: payload.user, email: payload.email };
    next();
  } catch (err) {
    console.error("Cleaner auth error:", err.message);
    return res.status(401).json({ error: "Invalid token" });
  }
}
