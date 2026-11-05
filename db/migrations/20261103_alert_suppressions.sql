-- Supresión de alertas de cobertura — silenciar un hallazgo puntual del monitor
-- de cobertura (services/coverageScan.js) sin depender del status del cliente.
--
-- Aplicar en Supabase MANUALMENTE (no hay runner de migraciones en este repo),
-- ANTES de desplegar el código que la usa.
--
-- El escaneo avisa cuando un cliente activo se queda sin cobertura futura, cuando
-- su serie recurrente está por terminar, cuando hay un hueco anómalo o cuando dos
-- series vivas del mismo cliente se pisan. Hay 3 formas de silenciarlo:
--
--   1. clients.status = 'lost' / 'inactive'  → silencia TODO para ese cliente
--   2. clients.postponed_until en el futuro  → silencia hasta esa fecha
--   3. esta tabla                            → silencia UNA serie o UN cliente,
--                                               de todo o de un solo tipo de
--                                               hallazgo, con o sin vencimiento
--
-- entity_id: id del maestro de la serie (appointments.id) o clients.id, como texto.
-- finding_kind: null = todas las alertas de la entidad; si no, uno de
--   no_coverage | on_demand | ending_soon | gap | overlap

begin;

create table if not exists public.alert_suppressions (
  id             uuid        primary key default gen_random_uuid(),
  alert_type     text        not null,   -- 'recurring_coverage' (único por ahora; extensible)
  entity_type    text        not null,   -- 'recurring_series' | 'client'
  entity_id      text        not null,
  finding_kind   text,
  reason         text,
  suppressed_by  text        not null,   -- usuario admin o script
  created_at     timestamptz not null default now(),
  expires_at     timestamptz             -- null = permanente
);

comment on table public.alert_suppressions is
  'Silencia alertas del monitor de cobertura para una serie o cliente. Ver services/coverageScan.js.';
comment on column public.alert_suppressions.finding_kind is
  'null = todas las alertas de la entidad; si no, uno de: no_coverage | on_demand | ending_soon | gap | overlap.';

-- Una supresión permanente activa por (tipo, entidad, hallazgo). Las que tienen
-- expires_at pueden coexistir (histórico): el escaneo filtra por vencimiento.
-- coalesce() porque NULL != NULL en índices únicos de Postgres.
create unique index if not exists alert_suppressions_active_uniq
  on public.alert_suppressions (alert_type, entity_type, entity_id, coalesce(finding_kind, ''))
  where expires_at is null;

create index if not exists alert_suppressions_lookup
  on public.alert_suppressions (alert_type, entity_type, entity_id, finding_kind);

-- Solo el backend (service role) la toca.
alter table public.alert_suppressions enable row level security;

commit;

-- ── Rollback ────────────────────────────────────────────────────────────────
-- drop table if exists public.alert_suppressions;
