-- LAB418 — Historial genérico de cambios + atribución por usuario
-- Portado de Monkey Cleaning, adaptado a este fork.
--
-- Crea `record_history`: una sola tabla de auditoría para todas las entidades
-- (appointments, clients, invoices, employees, payments, settings). Reemplaza a
-- `appointment_history`, que en este fork está VACÍA (era escrita por el sync
-- horario de Google Calendar, ya eliminado) — se dropea directo, sin migrar
-- filas ni dejar view de compat.
--
-- Aplicar en Supabase MANUALMENTE. Orden sugerido: dev primero, verificar, prod.
--
-- Antes de correr, confirmá que appointment_history está vacía:
--   select count(*) from appointment_history;   -- debe dar 0

begin;

create table if not exists public.record_history (
  id            uuid        primary key default gen_random_uuid(),
  entity_type   text        not null,   -- 'appointment'|'client'|'invoice'|'employee'|'payment'|'setting'
  entity_id     uuid        not null,
  changed_field text        not null,
  old_value     text,
  new_value     text,
  changed_by    text        not null,   -- usuario del panel (JWT) | 'cron' | 'system'
  source        text        not null default 'platform', -- 'platform'|'cron'|'public'
  reason        text,
  changed_at    timestamptz not null default now()
);

comment on table public.record_history is
  'LAB418 — historial de cambios de todas las entidades. changed_by = usuario del panel (JWT) o nombre del job. Settings comparte entity_id 00000000-0000-0000-0000-000000000000 (changed_field ES la key).';

create index if not exists record_history_entity_idx
  on public.record_history (entity_type, entity_id, changed_at desc);
create index if not exists record_history_actor_idx
  on public.record_history (changed_by, changed_at desc);

-- appointment_history está vacía en este fork — se retira.
drop table if exists public.appointment_history;

commit;

-- ── Rollback manual ───────────────────────────────────────────────────────
--   drop table if exists public.record_history;
--   -- (recrear appointment_history si de verdad hiciera falta — ver
--   --  Docs/schema_monkey_cleaning.sql)
