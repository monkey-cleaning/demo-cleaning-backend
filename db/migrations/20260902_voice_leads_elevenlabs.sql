-- Bot de cotización en vivo (ElevenLabs Agents) — columnas nuevas en voice_leads
--
-- Contexto: `voice_leads` se creó a mano en Supabase para el Studio Flow "Quote
-- Bot" (una fila por llamada, key = call_sid). Ahora el bot de voz pasa a ser un
-- agente de ElevenLabs; el registro final de cada llamada llega por el post-call
-- webhook (POST /api/quote/elevenlabs/webhook) y trae más datos: intención de
-- reserva, escalado a humano, resumen del transcript, etc.
--
-- Esta migración deja `voice_leads` con el esquema canónico (create if not
-- exists, por si algún ambiente no la tiene) y agrega las columnas nuevas de
-- forma idempotente sobre la tabla que ya existe.
--
-- Aplicar en Supabase MANUALMENTE (no hay runner de migraciones en este repo).
-- Correr primero en dev, verificar, luego prod.

begin;

-- ── Esquema canónico (solo si no existe) ─────────────────────────────────
create table if not exists public.voice_leads (
  id                    uuid        primary key default gen_random_uuid(),
  call_sid              text,                       -- Twilio CallSid (Studio Flow / phone_call.call_sid)
  conversation_id       text,                       -- ElevenLabs conversation id (key del post-call webhook)
  from_phone            text,                       -- E.164 del que llama
  source                text,                       -- 'Voice IVR' | 'Voice AI (ElevenLabs)'
  status                text        default 'quoted', -- quoted | booking_requested | escalated
  cleaning_frequency    text,
  bedrooms              text,
  full_bathrooms        text,
  half_bathrooms        text,
  property_size         text,
  inside_fridge         text,
  inside_freezer        text,
  inside_oven           text,
  estimated_total_cad   numeric,
  estimated_total_hours numeric,
  hourly_rate_cad       numeric,
  calc_type             text,
  wants_to_book         boolean,
  escalated             boolean,
  escalation_reason     text,
  caller_name           text,
  callback_number       text,
  transcript_summary    text,
  caller_notes          text,
  raw                   jsonb,                      -- payload completo del webhook por si falta algo
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now()
);

-- ── Columnas nuevas sobre la tabla que ya existe ────────────────────────
alter table public.voice_leads
  add column if not exists conversation_id    text,
  add column if not exists source             text,
  add column if not exists half_bathrooms     text,
  add column if not exists property_size      text,
  add column if not exists wants_to_book      boolean,
  add column if not exists escalated          boolean,
  add column if not exists escalation_reason  text,
  add column if not exists caller_name        text,
  add column if not exists callback_number    text,
  add column if not exists transcript_summary text,
  add column if not exists caller_notes       text,
  add column if not exists raw                jsonb,
  add column if not exists created_at         timestamptz not null default now(),
  add column if not exists updated_at         timestamptz not null default now();

comment on column public.voice_leads.conversation_id is
  'ElevenLabs conversation id. Key de upsert del post-call webhook (una llamada del agente = una fila).';
comment on column public.voice_leads.status is
  'quoted (se dio precio) | booking_requested (pidió reservar) | escalated (pasó a humano).';

-- ── Índices únicos (targets de ON CONFLICT) ─────────────────────────────
-- Índices completos (no parciales): PostgREST/supabase-js genera ON CONFLICT
-- (col) y necesita un índice único no parcial. Postgres permite múltiples NULL
-- en un índice único, así que call_sid y conversation_id pueden convivir nulos.
create unique index if not exists voice_leads_call_sid_key
  on public.voice_leads (call_sid);
create unique index if not exists voice_leads_conversation_id_key
  on public.voice_leads (conversation_id);

commit;

-- ── Rollback manual ────────────────────────────────────────────────────
--   drop index if exists public.voice_leads_conversation_id_key;
--   alter table public.voice_leads
--     drop column if exists conversation_id,
--     drop column if exists source,
--     drop column if exists half_bathrooms,
--     drop column if exists property_size,
--     drop column if exists wants_to_book,
--     drop column if exists escalated,
--     drop column if exists escalation_reason,
--     drop column if exists caller_name,
--     drop column if exists callback_number,
--     drop column if exists transcript_summary,
--     drop column if exists caller_notes,
--     drop column if exists raw;
