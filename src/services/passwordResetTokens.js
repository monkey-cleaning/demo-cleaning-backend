// services/passwordResetTokens.js
// Portado de Monkey Cleaning (LAB429) — tokens de "forgot your password". Se
// persiste sha256(token), nunca el token crudo — igual que una contraseña:
// si la tabla se filtra, no debe alcanzar para resetear nada. El token crudo
// solo existe en memoria el tiempo justo para mandarlo por mail.
import crypto from "node:crypto";
import { supabase } from "../supabaseClient.js";

const TOKEN_BYTES = 32;
const TTL_MINUTES = 60;

function hashToken(rawToken) {
  return crypto.createHash("sha256").update(rawToken).digest("hex");
}

/**
 * Genera un token de reset para esa credencial y lo guarda (hasheado).
 * @returns el token CRUDO — el caller lo manda por mail y lo descarta.
 */
export async function createResetToken(credentialId) {
  const rawToken = crypto.randomBytes(TOKEN_BYTES).toString("hex");
  const expiresAt = new Date(Date.now() + TTL_MINUTES * 60_000).toISOString();

  const { error } = await supabase.from("password_reset_tokens").insert({
    credential_id: credentialId,
    token_hash: hashToken(rawToken),
    expires_at: expiresAt,
  });

  if (error) throw error;
  return rawToken;
}

/**
 * Valida un token crudo (no vencido, no usado), lo marca usado, y devuelve
 * el credential_id al que pertenece — o null si no es válido/ya venció/ya
 * se usó. Nunca lanza por un token inválido (es el caso esperado de un
 * link viejo o reusado), solo por un error real de DB.
 */
export async function consumeResetToken(rawToken) {
  if (!rawToken) return null;
  const tokenHash = hashToken(String(rawToken));

  const { data, error } = await supabase
    .from("password_reset_tokens")
    .select("id, credential_id, expires_at, used_at")
    .eq("token_hash", tokenHash)
    .maybeSingle();

  if (error) {
    console.error("❌ consumeResetToken lookup:", error.message);
    return null;
  }
  if (!data || data.used_at || new Date(data.expires_at) < new Date()) {
    return null;
  }

  const { error: updateErr } = await supabase
    .from("password_reset_tokens")
    .update({ used_at: new Date().toISOString() })
    .eq("id", data.id);

  if (updateErr) {
    console.error("❌ consumeResetToken mark-used:", updateErr.message);
    return null; // más seguro negar el reset que dejar un token reusable
  }

  return data.credential_id;
}
