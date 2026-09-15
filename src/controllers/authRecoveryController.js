// controllers/authRecoveryController.js
// Portado de Monkey Cleaning (LAB429) — "Forgot your password?" — compartido
// por admin y cleaner (mismo username global-unique en app_credentials, así
// que ninguno de los dos endpoints necesita saber de antemano a qué rol
// pertenece el username).
import {
  findCredentialByUsername,
  findCredentialsByEmail,
  isValidPassword,
  setPassword,
} from "../services/appCredentials.js";
import { createResetToken, consumeResetToken } from "../services/passwordResetTokens.js";
import { sendPasswordResetEmail } from "../services/authEmailService.js";

const FRONTEND_URL = (
  process.env.FRONTEND_URL || "https://demo-cleaning-frontend.onrender.com"
).replace(/\/+$/, "");

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/auth/forgot-password
// Body: { email }  (también acepta { username } por tolerancia)
// Responde SIEMPRE el mismo mensaje genérico, exista o no la cuenta — no
// revela si ese correo está en el sistema.
// ─────────────────────────────────────────────────────────────────────────────
export async function forgotPassword(req, res) {
  const GENERIC_OK = {
    ok: true,
    message: "If an account exists for that email, a reset link was sent.",
  };

  try {
    const raw = (req.body?.email || req.body?.username || "").trim();
    if (!raw) return res.status(400).json({ ok: false, error: "email is required" });

    // Busca por email; si lo que mandaron no parece un email, prueba username
    // (una cuenta puede acordarse del user y no del correo).
    const credentials = raw.includes("@")
      ? await findCredentialsByEmail(raw)
      : [await findCredentialByUsername(raw)].filter(Boolean);

    if (!credentials.length) {
      console.warn(`[AuthRecovery] forgot-password: no account for "${raw}"`);
      return res.json(GENERIC_OK);
    }

    // Un email compartido matchea varias cuentas — se manda un link por cada
    // una, nombrando el username en el mail para que quien lo reciba sepa cuál es.
    for (const cred of credentials) {
      const to = (cred.email || "").trim();
      if (!to) {
        console.warn(`[AuthRecovery] forgot-password: "${cred.username}" has no email on file`);
        continue;
      }
      const rawToken = await createResetToken(cred.id);
      const resetUrl = `${FRONTEND_URL}/reset-password?token=${rawToken}`;
      await sendPasswordResetEmail({ to, resetUrl, username: cred.username });
    }

    return res.json(GENERIC_OK);
  } catch (e) {
    console.error("❌ forgotPassword:", e.message);
    // Nunca delatar un error interno como "esa cuenta no existe" ni al revés —
    // misma respuesta genérica también en el camino de error.
    return res.json(GENERIC_OK);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/auth/reset-password
// Body: { token, newPassword }
// ─────────────────────────────────────────────────────────────────────────────
export async function resetPassword(req, res) {
  try {
    const { token, newPassword } = req.body || {};
    if (!token || !newPassword) {
      return res.status(400).json({ ok: false, error: "token and newPassword are required" });
    }
    if (!isValidPassword(newPassword)) {
      return res.status(400).json({ ok: false, error: "Password must be at least 6 characters" });
    }

    const credentialId = await consumeResetToken(token);
    if (!credentialId) {
      return res.status(400).json({ ok: false, error: "This reset link is invalid or has expired" });
    }

    await setPassword(credentialId, newPassword);
    return res.json({ ok: true });
  } catch (e) {
    console.error("❌ resetPassword:", e.message);
    return res.status(500).json({ ok: false, error: e.message });
  }
}
