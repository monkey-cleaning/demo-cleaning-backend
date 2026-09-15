-- LAB413 — Encuesta de satisfacción post-servicio (portado de Monkey Cleaning)
--
-- Columnas nuevas en `clients` para el flujo de encuesta 1–5 + funnel de
-- Google Review. `survey_sent` impone "una encuesta por cliente, para siempre".
--
-- Aplicar en Supabase MANUALMENTE (no hay runner de migraciones en este repo).
-- Orden sugerido: dev primero, verificar, luego prod.

begin;

alter table public.clients
  add column if not exists survey_sent           boolean     not null default false,
  add column if not exists survey_sent_at         timestamptz,
  add column if not exists survey_token           text,
  add column if not exists survey_appointment_id  uuid references public.appointments(id) on delete set null,
  add column if not exists survey_rating          smallint    check (survey_rating between 1 and 5),
  add column if not exists survey_feedback        text,
  add column if not exists survey_responded_at    timestamptz;

comment on column public.clients.survey_sent is
  'LAB413 — true una vez que se le mandó la encuesta a este cliente. Guard de "una encuesta por cliente".';

-- El controller público busca al cliente por survey_token — índice único
-- (parcial: solo filas con token, así los null no chocan).
create unique index if not exists clients_survey_token_key
  on public.clients (survey_token)
  where survey_token is not null;

commit;

-- ── Rollback manual ───────────────────────────────────────────────────────
--   drop index if exists public.clients_survey_token_key;
--   alter table public.clients
--     drop column if exists survey_sent,
--     drop column if exists survey_sent_at,
--     drop column if exists survey_token,
--     drop column if exists survey_appointment_id,
--     drop column if exists survey_rating,
--     drop column if exists survey_feedback,
--     drop column if exists survey_responded_at;
