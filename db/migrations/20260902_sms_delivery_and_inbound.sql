-- SMS recordatorios: estado de entrega real + registro de respuestas entrantes
--
-- Contexto: hoy `sms_reminders.status = 'sent'` solo significa "Twilio aceptó el
-- mensaje en cola", no que llegó al teléfono. Y si un cliente responde al número
-- de Twilio, ese mensaje no se guarda en ningún lado ni avisa a nadie.
--
-- Esta migración:
--   1. agrega columnas de entrega real a sms_reminders (las llena el webhook
--      POST /api/sms/status con los status callbacks de Twilio)
--   2. crea sms_inbound: una fila por cada SMS entrante al número
--      (lo escribe el webhook POST /api/sms/incoming)
--
-- Aplicar en Supabase MANUALMENTE (no hay runner de migraciones en este repo).
-- Correr primero en dev, verificar, luego prod.

begin;

-- ── 1. Estado de entrega real en sms_reminders ─────────────────────────────
-- delivery_status: valor crudo de Twilio (queued|sending|sent|delivered|
--   undelivered|failed). `status` (pending|sent|failed) se mantiene como está,
--   salvo que pase a 'failed' cuando Twilio reporta undelivered/failed.
alter table public.sms_reminders
  add column if not exists delivery_status text,
  add column if not exists delivered_at    timestamptz,
  add column if not exists error_code      text,
  add column if not exists updated_at      timestamptz not null default now();

comment on column public.sms_reminders.delivery_status is
  'Estado final reportado por Twilio via status callback (delivered/undelivered/failed/...). Distinto de status: sent = aceptado en cola, no entregado.';

-- ── 2. Respuestas entrantes ───────────────────────────────────────────────
create table if not exists public.sms_inbound (
  id             uuid        primary key default gen_random_uuid(),
  twilio_sid     text        unique,          -- MessageSid del mensaje entrante
  from_number    text        not null,        -- E.164, ej. +17789772870
  to_number      text,                        -- nuestro número de Twilio
  body           text,
  num_media      integer     not null default 0,
  client_id      uuid        references public.clients(id) on delete set null,
  appointment_id uuid        references public.appointments(id) on delete set null,
  received_at    timestamptz not null default now(),
  raw            jsonb                          -- payload completo de Twilio por si falta algo
);

comment on table public.sms_inbound is
  'Un registro por SMS entrante al número de Twilio. Lo escribe POST /api/sms/incoming. client_id/appointment_id se resuelven por matching de teléfono cuando se puede.';

create index if not exists sms_inbound_from_idx
  on public.sms_inbound (from_number, received_at desc);
create index if not exists sms_inbound_client_idx
  on public.sms_inbound (client_id, received_at desc);

commit;

-- ── Rollback manual ───────────────────────────────────────────────────────
--   drop table if exists public.sms_inbound;
--   alter table public.sms_reminders
--     drop column if exists delivery_status,
--     drop column if exists delivered_at,
--     drop column if exists error_code,
--     drop column if exists updated_at;
