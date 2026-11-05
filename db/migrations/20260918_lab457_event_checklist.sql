-- LAB457 — checklist de indicaciones por evento/serie, con fotos de staff.
--
-- El admin carga la lista de indicaciones (ej. "sacar telarañas del sótano",
-- "aspirar el sillón") al crear/editar un evento en el calendario. El staff
-- las ve en el detalle del evento, las marca como hechas y puede subir una
-- foto de respaldo. Mismo criterio de series_key que event_notes (ver
-- 20260911_event_notes.sql): la lista de items se guarda por
-- series_id del maestro (o el propio appointments.id si es un evento suelto), así un
-- evento recurrente arrastra la misma lista semana a semana. El check-off en
-- cambio es por ocurrencia puntual (event_checklist_completions.event_id),
-- para que cada visita tenga su propio estado — y es compartido entre todo
-- el equipo asignado a esa visita (cualquiera del team lo marca, no hay
-- estado por-persona).
--
-- Aplicar en Supabase MANUALMENTE (no hay runner de migraciones en este
-- repo, y dev/prod comparten la misma base — una sola corrida alcanza).

begin;

create table if not exists public.event_checklist_items (
  id           uuid        primary key default gen_random_uuid(),
  series_key   text        not null,
  label        text        not null,
  sort_order   int         not null default 0,
  created_by   uuid        references public.employees(id),
  created_at   timestamptz not null default now(),
  archived_at  timestamptz
);

comment on table public.event_checklist_items is
  'LAB457 — indicaciones que el admin carga para un evento/serie (series_key = series_id del maestro, o appointments.id si es suelto). Escritura: admin. Lectura: admin + staff.';

create index if not exists event_checklist_items_series_idx
  on public.event_checklist_items (series_key)
  where archived_at is null;

create table if not exists public.event_checklist_completions (
  id            uuid        primary key default gen_random_uuid(),
  item_id       uuid        not null references public.event_checklist_items(id) on delete cascade,
  event_id      text        not null,
  employee_id   uuid        references public.employees(id),
  completed_at  timestamptz,
  photo_url     text,
  updated_at    timestamptz not null default now(),
  unique (item_id, event_id)
);

comment on table public.event_checklist_completions is
  'LAB457 — estado de un item de checklist para una ocurrencia puntual del evento (event_id). Compartido por todo el equipo asignado a esa visita. Escritura + lectura: staff. Lectura: admin.';

create index if not exists event_checklist_completions_event_idx
  on public.event_checklist_completions (event_id);

commit;

-- ── Storage bucket (crear a mano en el dashboard de Supabase, no vía SQL) ──
--   Nombre: checklist-photos
--   Público para lectura (mismo criterio que blog-images, así photo_url sirve
--   directo como <img src>); escritura solo vía signed upload URL emitida por
--   el backend con la service role key (ver eventChecklistController.js) —
--   el staff nunca tiene una key con permiso de escritura directa al bucket.

-- ── Rollback manual (si hiciera falta) ────────────────────────────────────
--   drop table if exists public.event_checklist_completions;
--   drop table if exists public.event_checklist_items;
