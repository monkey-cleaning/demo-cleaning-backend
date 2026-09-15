// routes/staffAuthRoutes.js
// LAB423 — login de cleaners para el portal de solo lectura. LAB429 (portado
// de Monkey Cleaning): la cuenta entera (username, password hasheada, email
// de recuperación, y el link a `employees`) vive en app_credentials — ver
// services/appCredentials.js. Reemplaza al mapa CLEANER_USERS del round
// anterior.
//
// OJO con los dos emails de un cleaner:
//   - app_credentials.email  → recuperación de contraseña + lo que edita en
//     su perfil. NO se usa para matchear appointments.
//   - employees.email        → con lo que se resuelve el employee_id de
//     appointment_teams. Es lo que va en el claim `email` del JWT y lo que
//     usan staffCalendarController / staffHoursController / staffRequestsController
//     para filtrar "mis eventos"/horas/pedidos. Lo maneja ops, no el cleaner.
import express from "express";
import jwt from "jsonwebtoken";
import { requireCleaner } from "../middleware/requireCleaner.js";
import { supabase } from "../supabaseClient.js";
import {
  verifyPassword,
  updateProfile,
  usernameTaken,
  isValidPassword,
  isValidEmail,
  isValidUsername,
} from "../services/appCredentials.js";

const router = express.Router();

// process.env se lee en cada handler, no en el load del módulo (dotenv puede
// no haber corrido todavía según el orden de imports de index.js).

// employee_id (app_credentials) → employees.email para el claim del JWT.
async function employeeEmailFor(employeeId) {
  if (!employeeId) return null;
  const { data, error } = await supabase
    .from("employees")
    .select("email")
    .eq("id", employeeId)
    .maybeSingle();
  if (error) {
    console.error("❌ employeeEmailFor:", error.message);
    return null;
  }
  return data?.email ?? null;
}

// POST /api/staff/auth/login
// Body: { username, password }
router.post("/login", async (req, res) => {
  const { username, password } = req.body;

  if (!username || !password) {
    return res.status(400).json({ error: "username and password required" });
  }

  const credential = await verifyPassword(username.toLowerCase(), password, "cleaner");
  if (!credential) {
    return res.status(401).json({ error: "Invalid credentials" });
  }

  const gcalEmail = await employeeEmailFor(credential.employee_id);
  if (!gcalEmail) {
    // Sin link a employees no se puede filtrar "mis eventos" — mejor negar
    // que dejar entrar a una sesión que no va a mostrar nada.
    console.error(
      `[staffAuth] login: credential ${credential.username} has no linked employee email`,
    );
    return res.status(403).json({ error: "This account is not fully set up. Contact ops." });
  }

  const token = jwt.sign(
    { role: "cleaner", user: credential.username, email: gcalEmail },
    process.env.ADMIN_JWT_SECRET,
    { expiresIn: "30d" }, // sesión larga a propósito: celular personal, no un puesto compartido
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

// GET /api/staff/auth/profile — para precargar el modal de "My account".
router.get("/profile", requireCleaner, async (req, res) => {
  try {
    const { data, error } = await supabase
      .from("app_credentials")
      .select("username, email")
      .ilike("username", req.cleaner.username)
      .maybeSingle();
    if (error) throw error;
    if (!data) return res.status(404).json({ ok: false, error: "Account not found" });
    return res.json({ ok: true, username: data.username, email: data.email });
  } catch (e) {
    console.error("❌ [staffAuth] get profile:", e.message);
    return res.status(500).json({ ok: false, error: e.message });
  }
});

// PATCH /api/staff/auth/profile
// Body: { currentPassword, username?, email?, newPassword? }
router.patch("/profile", requireCleaner, async (req, res) => {
  try {
    const { currentPassword, username, email, newPassword } = req.body || {};
    if (!currentPassword) {
      return res.status(400).json({ ok: false, error: "currentPassword is required" });
    }

    const credential = await verifyPassword(req.cleaner.username, currentPassword, "cleaner");
    if (!credential) {
      return res.status(401).json({ ok: false, error: "Current password is incorrect" });
    }

    const patch = {};
    if (username != null && username.trim().toLowerCase() !== credential.username) {
      if (!isValidUsername(username)) {
        return res.status(400).json({ ok: false, error: "Username must be 3-30 letters, numbers, . _ or -" });
      }
      if (await usernameTaken(username, credential.id)) {
        return res.status(409).json({ ok: false, error: "That username is already taken" });
      }
      patch.username = username;
    }
    if (email != null && email.trim() !== credential.email) {
      if (!isValidEmail(email)) {
        return res.status(400).json({ ok: false, error: "Please enter a valid email" });
      }
      patch.email = email;
    }
    if (newPassword != null && newPassword !== "") {
      if (!isValidPassword(newPassword)) {
        return res.status(400).json({ ok: false, error: "Password must be at least 6 characters" });
      }
      patch.newPassword = newPassword;
    }

    if (Object.keys(patch).length === 0) {
      return res.json({ ok: true, usernameChanged: false });
    }

    await updateProfile(credential.id, patch);
    return res.json({ ok: true, usernameChanged: Boolean(patch.username) });
  } catch (e) {
    console.error("❌ [staffAuth] update profile:", e.message);
    return res.status(500).json({ ok: false, error: e.message });
  }
});

export default router;
