/**
 * jobs/seedAppCredentials.js
 * Portado de Monkey Cleaning (LAB429), adaptado a las cuentas reales de Demo
 * Cleaning.
 *
 * One-shot: puebla app_credentials (ver migración
 * 20260909_login_password_reset.sql) — el registro completo de cada cuenta:
 * username, password ACTUAL (una sola, compartida por todas las cuentas —
 * ver SHARED_PASSWORD/PASS_SHARED más abajo — hasheada), email de
 * recuperación, y para cleaners el link a su fila de `employees`.
 *
 * Autocontenido a propósito: la lista de cuentas vive acá, no depende del
 * código de la app (TEST_USERS y el mapa CLEANER_USERS del round anterior
 * ya no existen).
 *
 * Correr UNA vez por ambiente, ANTES de deployar el código que lee de
 * app_credentials (si no, nadie puede loguearse):
 *   node src/jobs/seedAppCredentials.js            (dry run — solo lista)
 *   node src/jobs/seedAppCredentials.js --apply     (aplica)
 */
import "dotenv/config";
import { supabase } from "../supabaseClient.js";
import { upsertCredential } from "../services/appCredentials.js";

const ADMIN_RECOVERY_EMAIL = (
  process.env.ADMIN_RECOVERY_EMAIL || "ops@demo-cleaning.co"
).trim();

// 2026-09-15 — a pedido: todas las cuentas comparten UNA sola contraseña, ya
// no hay un env var PASS_* por persona. Overrideable con PASS_SHARED (útil
// para no tener el valor real en el código si esto se sube a un repo
// público); sin esa env cae al valor pedido.
const SHARED_PASSWORD = (process.env.PASS_SHARED || "Demo123!").trim();

// Admins: solo el username. email = bandeja compartida por ahora (cada uno
// lo cambia después desde su perfil). Sin employee_id.
const ADMINS = ["tech", "admin1", "admin2"];

// Cleaners: username → employees.email (ver seed de la demo) — sirve de
// email de recuperación Y para resolver el employee_id.
const CLEANERS = {
  ana: "ana.torres@demo-cleaning.co",
  bruno: "bruno.silva@demo-cleaning.co",
  carla: "carla.nunez@demo-cleaning.co",
  diego: "diego.ramos@demo-cleaning.co",
  elena: "elena.vega@demo-cleaning.co",
  franco: "franco.molina@demo-cleaning.co",
};

async function resolveEmployeeIdsByEmail(emails) {
  const { data, error } = await supabase
    .from("employees")
    .select("id, email")
    .in("email", emails);
  if (error) throw error;
  const byEmail = new Map();
  for (const row of data ?? []) {
    if (row.email) byEmail.set(row.email.toLowerCase(), row.id);
  }
  return byEmail;
}

async function run() {
  const apply = process.argv.includes("--apply");
  console.log(`[SeedCredentials] Modo: ${apply ? "APPLY (va a escribir)" : "DRY RUN (solo lista)"}`);

  const empIdByEmail = await resolveEmployeeIdsByEmail(Object.values(CLEANERS));

  const toSeed = [];

  for (const username of ADMINS) {
    toSeed.push({
      username,
      role: "blog-admin",
      plainPassword: SHARED_PASSWORD,
      email: ADMIN_RECOVERY_EMAIL,
      employeeId: null,
      note: "PASS_SHARED",
    });
  }

  for (const [username, email] of Object.entries(CLEANERS)) {
    const employeeId = empIdByEmail.get(email.toLowerCase()) ?? null;
    if (!employeeId) {
      console.warn(`  ⚠️  ${username} (cleaner): no hay employees.email == ${email} — se seedea SIN employee_id (login va a fallar hasta arreglarlo)`);
    }
    toSeed.push({
      username,
      role: "cleaner",
      plainPassword: SHARED_PASSWORD,
      email,
      employeeId,
      note: `PASS_SHARED · employee ${employeeId ?? "MISSING"}`,
    });
  }

  console.log(`[SeedCredentials] ${toSeed.length} cuentas a seedear:`);
  for (const { username, role, email, note } of toSeed) {
    console.log(`  - ${username} (${role}) · email ${email} · ${note}`);
  }

  if (!apply) {
    console.log("[SeedCredentials] Dry run — no se escribió nada. Correr con --apply para aplicar.");
    return;
  }

  let done = 0;
  for (const { username, role, plainPassword, email, employeeId } of toSeed) {
    try {
      await upsertCredential({ username, role, plainPassword, email, employeeId });
      done++;
      console.log(`  ✅ ${username} (${done}/${toSeed.length})`);
    } catch (err) {
      console.error(`  ❌ ${username} falló:`, err.message);
    }
  }

  console.log(`[SeedCredentials] Listo — ${done}/${toSeed.length} cuentas seedeadas.`);
}

run().catch((err) => {
  console.error("[SeedCredentials] ❌", err.message);
  process.exit(1);
});
