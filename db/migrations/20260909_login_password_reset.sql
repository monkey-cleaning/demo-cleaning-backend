-- Login: perfil de usuario editable (username / email / contraseña) +
-- "forgot your password" — admin y cleaners.
-- Portado de Monkey Cleaning (LAB429).
--
-- Hasta ahora TODAS las contraseñas (admin en TEST_USERS, cleaners en
-- CLEANER_USERS) vivían como texto plano en variables de entorno de Render
-- — la app no puede reescribir una env var en caliente, así que nadie podía
-- cambiar su propia contraseña ni recuperarla si la olvidaba.
--
-- `app_credentials` es el REGISTRO COMPLETO de cada cuenta (admin + cleaner):
-- username, password hasheada, email de recuperación, y (solo cleaners) el
-- link a su fila de `employees`. Reemplaza tanto a TEST_USERS (adminAuthRoutes.js)
-- como al mapa estático CLEANER_USERS (staffAuthRoutes.js) — con el username
-- editable, un mapa en código se desincroniza.
--
-- OJO: `email` acá es el email de RECUPERACIÓN / identidad de la cuenta —
-- NO es necesariamente el mismo que `employees.email` (el que usa el motor
-- de asignación/calendario). El login de cleaner resuelve `employees.email`
-- vía `employee_id` para el claim del JWT.
--
-- `password_reset_tokens` guarda el HASH del token de reset, nunca el
-- token crudo — igual que una contraseña, si se filtra la tabla no debe
-- alcanzar para resetear nada.
--
-- Aplicar en Supabase MANUALMENTE (no hay runner de migraciones en este
-- repo). Orden: dev primero, correr jobs/seedAppCredentials.js --apply
-- ahí, verificar, recién después prod. El código que lee de esta tabla NO
-- debe deployarse antes de correr el seed en ese ambiente — si se deploya
-- antes, nadie puede loguearse.

begin;

create table if not exists public.app_credentials (
  id            uuid        primary key default gen_random_uuid(),
  username      text        not null unique,
  password_hash text        not null,
  role          text        not null check (role in ('blog-admin', 'cleaner')),
  email         text        not null,   -- recuperación + identidad, editable por el usuario
  employee_id   uuid        references public.employees(id),  -- solo cleaners; null para admin/tech
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

comment on table public.app_credentials is
  'Registro completo de cada cuenta de login (admin + cleaner): username, password hasheada, email de recuperación, y el link a employees (solo cleaners). email NO es necesariamente employees.email.';

create unique index if not exists app_credentials_username_lower_idx
  on public.app_credentials (lower(username));

create table if not exists public.password_reset_tokens (
  id            uuid        primary key default gen_random_uuid(),
  credential_id uuid        not null references public.app_credentials(id),
  token_hash    text        not null unique,
  expires_at    timestamptz not null,
  used_at       timestamptz,
  created_at    timestamptz not null default now()
);

comment on table public.password_reset_tokens is
  'Tokens de "forgot your password" — se guarda sha256(token), nunca el token crudo. TTL corto (ver passwordResetTokens.js), used_at marca consumido para que no se pueda reusar.';

create index if not exists password_reset_tokens_credential_idx
  on public.password_reset_tokens (credential_id, created_at desc);

commit;

-- ── Rollback manual (si hiciera falta) ────────────────────────────────────
--   drop table if exists public.password_reset_tokens;
--   drop table if exists public.app_credentials;
