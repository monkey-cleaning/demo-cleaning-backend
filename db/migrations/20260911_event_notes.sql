-- Notas de cleaners sobre un evento/serie — pensadas sobre todo para el
-- PRÓXIMO cleaner que le toque un servicio en esa casa (ej. "la llave está
-- en la maceta", "el perro es bravo"). Visibles para admin y staff.
-- Portado de Monkey Cleaning (Daily 2026-09-11).
--
-- Se guardan por `series_key` (appointments.series_id si el appointment es
-- parte de una serie recurrente, o el propio appointments.id si es un
-- appointment suelto) en vez de por appointment_id puntual — así una nota
-- cargada en la instancia de esta semana la ve el cleaner que agarre la
-- instancia de la semana que viene, que es todo el sentido del pedido.
-- `event_id` se guarda solo a título informativo (en qué instancia puntual
-- se escribió) — en este fork es appointments.id, no un id de Google Calendar.
--
-- Aplicar en Supabase MANUALMENTE (no hay runner de migraciones en este
-- repo). Orden sugerido: dev primero, verificar, luego prod.

begin;

create table if not exists public.event_notes (
  id           uuid        primary key default gen_random_uuid(),
  series_key   text        not null,
  event_id     text        not null,
  employee_id  uuid        references public.employees(id),
  author_name  text        not null,
  body         text        not null,
  created_at   timestamptz not null default now()
);

comment on table public.event_notes is
  'Notas de cleaners sobre un evento/serie (series_key = appointments.series_id o el propio appointments.id), para el próximo cleaner que caiga en esa casa. Lectura: admin + staff. Escritura: staff.';

create index if not exists event_notes_series_idx
  on public.event_notes (series_key, created_at asc);

commit;

-- ── Rollback manual (si hiciera falta) ────────────────────────────────────
--   drop table if exists public.event_notes;
