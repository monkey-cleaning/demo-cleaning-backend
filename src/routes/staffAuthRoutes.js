// routes/staffAuthRoutes.js
// Portado de Monkey Cleaning (LAB423) — login de cleaners para el portal de
// solo lectura.
//
// Mismo patrón que adminAuthRoutes.js (mapa usuario→password leído de .env,
// sin tabla ni hashing — decisión explícita para no sumar "gestión de cuentas"
// en esta primera versión), pero en un archivo separado y con su propio rol
// ('cleaner' en vez de 'blog-admin'): un token de acá nunca debe pasar
// requireAdmin, y uno de admin nunca debe pasar requireCleaner.
//
// El `email` de cada entrada es el dato que usan staffCalendarController /
// staffHoursController para resolver el employees.id del cleaner — tiene que
// ser EXACTAMENTE el mismo email que su fila en `employees`.

import express from "express";
import jwt from "jsonwebtoken";

const router = express.Router();

// process.env se lee en cada handler, no en el load del módulo (dotenv puede
// no haber corrido todavía según el orden de imports de index.js).

// ── Cuentas de cleaners ────────────────────────────────────────────────────
// Una entrada por cleaner activo (tabla `employees`). El `email` DEBE coincidir
// con employees.email — es lo que usa el backend para resolver el employee.
//
// Password: PASS_CLEANER_<NOMBRE> en .env. El fallback "demo2026" es solo para
// la demo local (mismo criterio que TEST_USERS en adminAuthRoutes.js) — en un
// deploy real, setear las env vars y borrar el fallback.
const CLEANER_DEMO_PASSWORD = "demo2026";

const CLEANER_USERS = {
  ana: {
    password: process.env.PASS_CLEANER_ANA || CLEANER_DEMO_PASSWORD,
    email: "ana.torres@demo-cleaning.co",
  },
  bruno: {
    password: process.env.PASS_CLEANER_BRUNO || CLEANER_DEMO_PASSWORD,
    email: "bruno.silva@demo-cleaning.co",
  },
  carla: {
    password: process.env.PASS_CLEANER_CARLA || CLEANER_DEMO_PASSWORD,
    email: "carla.nunez@demo-cleaning.co",
  },
  diego: {
    password: process.env.PASS_CLEANER_DIEGO || CLEANER_DEMO_PASSWORD,
    email: "diego.ramos@demo-cleaning.co",
  },
  elena: {
    password: process.env.PASS_CLEANER_ELENA || CLEANER_DEMO_PASSWORD,
    email: "elena.vega@demo-cleaning.co",
  },
  franco: {
    password: process.env.PASS_CLEANER_FRANCO || CLEANER_DEMO_PASSWORD,
    email: "franco.molina@demo-cleaning.co",
  },
};

// POST /api/staff/auth/login   Body: { username, password }
router.post("/login", (req, res) => {
  const { username, password } = req.body;

  if (!username || !password) {
    return res.status(400).json({ error: "username and password required" });
  }

  const key = username.toLowerCase();
  const account = CLEANER_USERS[key];

  if (!account || !account.password || password !== account.password) {
    return res.status(401).json({ error: "Invalid credentials" });
  }

  const token = jwt.sign(
    { role: "cleaner", user: key, email: account.email },
    process.env.ADMIN_JWT_SECRET,
    { expiresIn: "30d" }, // sesión larga: celular personal, no un puesto compartido
  );

  res.json({ token });
});

// GET /api/staff/auth/me
router.get("/me", (req, res) => {
  const auth = req.headers.authorization || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : null;
  if (!token) return res.status(401).json({ error: "No token" });
  try {
    const payload = jwt.verify(token, process.env.ADMIN_JWT_SECRET);
    if (payload.role !== "cleaner")
      return res.status(403).json({ error: "Forbidden" });
    res.json({ ok: true, user: payload.user });
  } catch {
    return res.status(401).json({ error: "Invalid token" });
  }
});

export default router;
