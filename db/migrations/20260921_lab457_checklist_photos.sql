-- LAB457 (parte 2) — varias fotos por item de checklist, y subir una foto
-- deja de marcar el item como hecho (el check-off es siempre manual).
--
-- Antes: event_checklist_completions.photo_url guardaba UNA sola foto por
-- (item, ocurrencia). Ahora cada foto es una fila en event_checklist_photos.
-- La columna vieja photo_url NO se borra (queda sin uso, nullable) para no
-- hacer una migración destructiva; las fotos ya subidas se copian a la
-- tabla nueva acá abajo.
--
-- Aplicar en Supabase MANUALMENTE (no hay runner de migraciones; dev/prod
-- comparten la misma base — una sola corrida alcanza).

begin;

create table if not exists public.event_checklist_photos (
  id           uuid        primary key default gen_random_uuid(),
  item_id      uuid        not null references public.event_checklist_items(id) on delete cascade,
  event_id     text        not null,
  employee_id  uuid        references public.employees(id),
  photo_url    text        not null,
  created_at   timestamptz not null default now()
);

comment on table public.event_checklist_photos is
  'LAB457 — fotos de respaldo que sube el staff para un item de checklist en una ocurrencia puntual (event_id). Varias por item. Escritura + lectura: staff. Lectura: admin.';

create index if not exists event_checklist_photos_event_idx
  on public.event_checklist_photos (event_id);

create index if not exists event_checklist_photos_item_event_idx
  on public.event_checklist_photos (item_id, event_id, created_at);

-- Backfill: la foto única que ya existía pasa a ser una fila de la tabla nueva.
insert into public.event_checklist_photos (item_id, event_id, employee_id, photo_url, created_at)
select c.item_id, c.event_id, c.employee_id, c.photo_url, c.updated_at
from public.event_checklist_completions c
where c.photo_url is not null
  and not exists (
    select 1 from public.event_checklist_photos p
    where p.item_id = c.item_id and p.event_id = c.event_id and p.photo_url = c.photo_url
  );

commit;

-- ── Rollback manual (si hiciera falta) ────────────────────────────────────
--   drop table if exists public.event_checklist_photos;
--   (event_checklist_completions.photo_url sigue intacta, no se tocó)
