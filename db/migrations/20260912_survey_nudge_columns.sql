-- LAB413 (segunda ronda) — Encuesta de satisfacción: migración de las páginas
-- HTML server-rendered a la página React del frontend + emails "nudge" al día
-- siguiente (en vez de "gracias" inmediato).
--
-- Columnas nuevas en `clients`:
--   survey_review_clicked_at  — se graba cuando el cliente (nota 5) hace click
--                                en el link trackeado de Google Review
--                                (GET /api/public/survey/:token/go-review).
--   survey_review_nudge_at    — se graba una sola vez si jobs/surveyNudgeJob.js
--                                le mandó el recordatorio de review (nota 5,
--                                nunca clickeó).
--   survey_feedback_nudge_at  — se graba una sola vez si jobs/surveyNudgeJob.js
--                                le mandó el recordatorio de feedback (nota
--                                1-4, nunca dejó comentario).
--
-- Monkey Cleaning aplicó esto a mano (no quedó versionado allá); acá sí lo
-- dejamos como migración, mismo criterio que con 20260901_lab413_survey.sql.
--
-- Aplicar en Supabase MANUALMENTE (no hay runner de migraciones en este repo).
-- Orden sugerido: dev primero, verificar, luego prod. Sin dependencias de
-- otras migraciones de esta ronda — puede aplicarse en cualquier momento
-- después de 20260901_lab413_survey.sql.

begin;

alter table public.clients
  add column if not exists survey_review_clicked_at  timestamptz,
  add column if not exists survey_review_nudge_at     timestamptz,
  add column if not exists survey_feedback_nudge_at   timestamptz;

comment on column public.clients.survey_review_clicked_at is
  'LAB413 — se graba cuando el cliente (nota 5) abre el link trackeado de Google Review.';
comment on column public.clients.survey_review_nudge_at is
  'LAB413 — se graba una sola vez si se le mandó el nudge de review (nota 5, nunca clickeó). Guard contra reenvío.';
comment on column public.clients.survey_feedback_nudge_at is
  'LAB413 — se graba una sola vez si se le mandó el nudge de feedback (nota 1-4, nunca comentó). Guard contra reenvío.';

commit;

-- ── Rollback manual ───────────────────────────────────────────────────────
--   alter table public.clients
--     drop column if exists survey_review_clicked_at,
--     drop column if exists survey_review_nudge_at,
--     drop column if exists survey_feedback_nudge_at;
