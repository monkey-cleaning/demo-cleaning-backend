/**
 * jobs/seedAppCredentials.js
 * Portado de Monkey Cleaning (LAB429), adaptado a las cuentas reales de Demo
 * Cleaning.
 *
 * One-shot: puebla app_credentials (ver migración
 * 20260909_login_password_reset.sql) — el registro completo de cada cuenta:
 * username, password ACTUAL (de las env vars PASS_*, hasheada), email de
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

// Admins: solo username + env var del password. email = bandeja compartida
// por ahora (cada uno lo cambia después desde su perfil). Sin employee_id.
const ADMINS = {
  jhony: "PASS_JHONY",
  jony1: "PASS_JONY1",
  yudith1: "PASS_YUDITH1",
  javier1: "PASS_JAVIER1",
  clara: "PASS_CLARA",
  tech: "PASS_TECH",
};

// Cleaners: username → { envVar, email }. El `email` es el de employees.email
// (ver seed de la demo) — sirve de email de recuperación Y para resolver el
// employee_id.
const CLEANERS = {
  ana: { envVar: "PASS_CLEANER_ANA", email: "ana.torres@demo-cleaning.co" },
  bruno: { envVar: "PASS_CLEANER_BRUNO", email: "bruno.silva@demo-cleaning.co" },
  carla: { envVar: "PASS_CLEANER_CARLA", email: "carla.nunez@demo-cleaning.co" },
  diego: { envVar: "PASS_CLEANER_DIEGO", email: "diego.ramos@demo-cleaning.co" },
  elena: { envVar: "PASS_CLEANER_ELENA", email: "elena.vega@demo-cleaning.co" },
  franco: { envVar: "PASS_CLEANER_FRANCO", email: "franco.molina@demo-cleaning.co" },
};

// Fallback de demo — mismo criterio que TEST_USERS/CLEANER_USERS: sirve para
// probar el portal ya mismo sin cargar PASS_* en .env. En un deploy real,
// setear las env vars y borrar este fallback.
const DEMO_FALLBACK_PASSWORD = "demo2026";

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

  const empIdByEmail = await resolveEmployeeIdsByEmail(
    Object.values(CLEANERS).map((c) => c.email),
  );

  const toSeed = [];

  for (const [username, envVar] of Object.entries(ADMINS)) {
    const plainPassword = process.env[envVar] || DEMO_FALLBACK_PASSWORD;
    toSeed.push({
      username,
      role: "blog-admin",
      plainPassword,
      email: ADMIN_RECOVERY_EMAIL,
      employeeId: null,
      note: process.env[envVar] ? envVar : `${envVar} (fallback demo2026)`,
    });
  }

  for (const [username, { envVar, email }] of Object.entries(CLEANERS)) {
    const plainPassword = process.env[envVar] || DEMO_FALLBACK_PASSWORD;
    const employeeId = empIdByEmail.get(email.toLowerCase()) ?? null;
    if (!employeeId) {
      console.warn(`  ⚠️  ${username} (cleaner): no hay employees.email == ${email} — se seedea SIN employee_id (login va a fallar hasta arreglarlo)`);
    }
    toSeed.push({
      username,
      role: "cleaner",
      plainPassword,
      email,
      employeeId,
      note: `${process.env[envVar] ? envVar : envVar + " (fallback demo2026)"} · employee ${employeeId ?? "MISSING"}`,
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
