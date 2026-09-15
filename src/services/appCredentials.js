// services/appCredentials.js
//
// Portado de Monkey Cleaning (LAB429). Único lugar que toca bcrypt + la tabla
// app_credentials (ver migración 20260909_login_password_reset.sql), que es
// el registro COMPLETO de cada cuenta de login (admin + cleaner): username,
// password hasheada, email de recuperación, y el link a `employees` (solo
// cleaners). Reemplaza a TEST_USERS (adminAuthRoutes.js) y a CLEANER_USERS
// (staffAuthRoutes.js, del round anterior — se retira).
import bcrypt from "bcryptjs";
import { supabase } from "../supabaseClient.js";

const SALT_ROUNDS = 10;
const MIN_PASSWORD_LENGTH = 6;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
// letras/números/._- , 3-30. Igual de laxo que los usernames actuales
// (jhony, jony1, tech, ana…) pero sin espacios ni cosas raras.
const USERNAME_RE = /^[a-z0-9._-]{3,30}$/i;

export function isValidPassword(pw) {
  return typeof pw === "string" && pw.trim().length >= MIN_PASSWORD_LENGTH;
}

export function isValidEmail(email) {
  return typeof email === "string" && EMAIL_RE.test(email.trim());
}

export function isValidUsername(username) {
  return typeof username === "string" && USERNAME_RE.test(username.trim());
}

const SELECT = "id, username, password_hash, role, email, employee_id";

export async function findCredentialByUsername(username) {
  const key = String(username || "").trim().toLowerCase();
  if (!key) return null;

  const { data, error } = await supabase
    .from("app_credentials")
    .select(SELECT)
    .ilike("username", key)
    .maybeSingle();

  if (error) {
    console.error("❌ findCredentialByUsername:", error.message);
    return null;
  }
  return data;
}

/**
 * Todas las credenciales con ese email (case-insensitive). Puede devolver
 * varias — el email NO es unique (p. ej. un buzón compartido de recuperación
 * para varios admins). Lo usa forgot-password.
 */
export async function findCredentialsByEmail(email) {
  const key = String(email || "").trim().toLowerCase();
  if (!key) return [];

  const { data, error } = await supabase
    .from("app_credentials")
    .select(SELECT)
    .ilike("email", key);

  if (error) {
    console.error("❌ findCredentialsByEmail:", error.message);
    return [];
  }
  return data ?? [];
}

/**
 * Verifica username+password contra app_credentials, exigiendo que el role
 * coincida con el esperado (adminAuthRoutes pide 'blog-admin',
 * staffAuthRoutes pide 'cleaner') — un cleaner nunca debe poder loguear
 * como admin ni viceversa.
 *
 * @returns la fila de la credencial si es válida, null si no.
 */
export async function verifyPassword(username, plainPassword, expectedRole) {
  if (!plainPassword) return null;
  const cred = await findCredentialByUsername(username);
  if (!cred || cred.role !== expectedRole) return null;

  const ok = await bcrypt.compare(String(plainPassword), cred.password_hash);
  return ok ? cred : null;
}

/**
 * Username de la cuenta de staff ligada a ese employee_id, o null si ese
 * cleaner todavía no tiene cuenta. Lo usa el pie del digest para mostrarle
 * a cada cleaner con qué usuario entra.
 */
export async function getStaffUsernameByEmployeeId(employeeId) {
  if (!employeeId) return null;
  const { data, error } = await supabase
    .from("app_credentials")
    .select("username")
    .eq("employee_id", employeeId)
    .eq("role", "cleaner")
    .maybeSingle();

  if (error) {
    console.warn("⚠️ getStaffUsernameByEmployeeId:", error.message);
    return null;
  }
  return data?.username ?? null;
}

/**
 * ¿Está ese username tomado por OTRA cuenta? (case-insensitive)
 */
export async function usernameTaken(username, exceptId) {
  const key = String(username || "").trim().toLowerCase();
  const { data, error } = await supabase
    .from("app_credentials")
    .select("id")
    .ilike("username", key);

  if (error) throw error;
  return (data ?? []).some((row) => row.id !== exceptId);
}

/**
 * Cambia la contraseña de una credencial ya existente (por id).
 */
export async function setPassword(credentialId, newPlainPassword) {
  const hash = await bcrypt.hash(String(newPlainPassword), SALT_ROUNDS);
  const { error } = await supabase
    .from("app_credentials")
    .update({ password_hash: hash, updated_at: new Date().toISOString() })
    .eq("id", credentialId);

  if (error) throw error;
}

/**
 * Actualiza cualquier subconjunto de { username, email, newPassword } de una
 * cuenta. El caller ya validó formato/unicidad y verificó currentPassword.
 */
export async function updateProfile(credentialId, { username, email, newPassword }) {
  const patch = { updated_at: new Date().toISOString() };
  if (username != null) patch.username = username.trim().toLowerCase();
  if (email != null) patch.email = email.trim();
  if (newPassword != null) patch.password_hash = await bcrypt.hash(String(newPassword), SALT_ROUNDS);

  const { error } = await supabase
    .from("app_credentials")
    .update(patch)
    .eq("id", credentialId);

  if (error) throw error;
}

/**
 * Crea o reemplaza una credencial por username — usado únicamente por
 * jobs/seedAppCredentials.js para poblar la tabla desde las env vars
 * PASS_* actuales. No lo llama ningún endpoint HTTP.
 */
export async function upsertCredential({ username, role, plainPassword, email, employeeId = null }) {
  const hash = await bcrypt.hash(String(plainPassword), SALT_ROUNDS);
  const { error } = await supabase.from("app_credentials").upsert(
    {
      username: username.toLowerCase(),
      role,
      password_hash: hash,
      email,
      employee_id: employeeId,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "username" },
  );

  if (error) throw error;
}
