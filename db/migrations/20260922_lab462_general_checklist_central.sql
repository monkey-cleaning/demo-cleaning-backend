-- LAB462 — checklist general + por limpieza, foto obligatoria por item,
-- snapshot al ejecutar, y "Send to Central" (fotos + comentario a la oficina).
--
-- Se apoya en LAB457 (event_checklist_items / completions / photos):
--   * Los items "específicos" siguen siendo los de siempre (series_key =
--     series_id del maestro, o appointments.id si es suelto).
--   * Los items "generales" son filas de la misma tabla con is_general = true y
--     series_key = '__general__'. Así completions y photos (que apuntan a
--     item_id) funcionan igual para ambos tipos, sin tocar sus FKs.
--   * require_photo aplica a ambos tipos.
--   * event_checklist_snapshots congela la lista (general + específicos, con
--     sus labels y flags) de una ocurrencia la primera vez que el staff
--     escribe algo en ella; de ahí en más editar el general ya no la altera.
--
-- Aplicar en Supabase MANUALMENTE (no hay runner de migraciones; dev/prod
-- comparten la misma base — una sola corrida alcanza). Reiniciar el backend
-- después.

begin;

alter table public.event_checklist_items
  add column if not exists is_general    boolean not null default false,
  add column if not exists require_photo boolean not null default false;

create index if not exists event_checklist_items_general_idx
  on public.event_checklist_items (sort_order)
  where is_general and archived_at is null;

create table if not exists public.event_checklist_snapshots (
  event_id    text        primary key,
  series_key  text        not null,
  items       jsonb       not null,
  created_at  timestamptz not null default now()
);

comment on table public.event_checklist_snapshots is
  'LAB462 — lista de items (id, label, sortOrder, isGeneral, requirePhoto) tal como estaba la primera vez que el staff escribió en esta ocurrencia. Después de eso la visita usa esta copia, no la lista viva.';

create table if not exists public.central_submissions (
  id            uuid        primary key default gen_random_uuid(),
  event_id      text        not null,
  series_key    text,
  client_id     uuid,
  client_name   text,
  event_summary text,
  event_start   timestamptz,
  location      text,
  employee_id   uuid        references public.employees(id),
  employee_name text,
  comment       text,
  photo_urls    text[]      not null default '{}',
  created_at    timestamptz not null default now(),
  reviewed_at   timestamptz
);

comment on table public.central_submissions is
  'LAB462 — fotos + comentario que un cleaner manda a central desde un evento, fuera del checklist. Los datos del evento/cliente se copian acá para que el envío sobreviva si el evento se borra del calendario.';

create index if not exists central_submissions_event_idx
  on public.central_submissions (event_id);
create index if not exists central_submissions_created_idx
  on public.central_submissions (created_at desc);
create index if not exists central_submissions_unreviewed_idx
  on public.central_submissions (created_at desc)
  where reviewed_at is null;

-- Items por defecto del checklist general (editables desde el admin). Solo se
-- siembran si todavía no hay ninguno, así re-correr la migración no duplica.
insert into public.event_checklist_items (series_key, label, sort_order, is_general)
select '__general__', v.label, v.ord, true
from (values
  (0, 'Dust all reachable surfaces, shelves and window sills'),
  (1, 'Wipe and sanitize kitchen counters, sink and stovetop'),
  (2, 'Wipe the outside of kitchen appliances'),
  (3, 'Clean and disinfect bathrooms (toilet, shower/tub, sink, mirror)'),
  (4, 'Vacuum all carpets and rugs'),
  (5, 'Sweep and mop all hard floors'),
  (6, 'Empty trash bins and replace liners'),
  (7, 'Wipe door handles, light switches and other high-touch areas'),
  (8, 'Final walk-through: lights off, doors locked, everything left as found')
) as v(ord, label)
where not exists (select 1 from public.event_checklist_items where is_general);

commit;

-- ── Rollback manual (si hiciera falta) ────────────────────────────────────
--   drop table if exists public.central_submissions;
--   drop table if exists public.event_checklist_snapshots;
--   delete from public.event_checklist_items where is_general;
--   alter table public.event_checklist_items drop column if exists is_general, drop column if exists require_photo;
--
-- Las fotos de "Send to Central" van al mismo bucket checklist-photos, bajo el
-- prefijo central/<eventId>/ (no hace falta crear otro bucket).
