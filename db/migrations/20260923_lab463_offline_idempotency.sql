-- LAB463 — modo offline: idempotencia de la cola de sincronización.
--
-- El cleaner puede marcar items, sacar fotos y mandar "Send to Central" sin
-- conexión; el celular las guarda y las reenvía cuando vuelve la red. Un
-- reintento (la respuesta se perdió pero el servidor sí escribió) no debe
-- duplicar fotos ni envíos: el cliente genera un client_ref (UUID) por foto /
-- por envío y el backend devuelve la fila existente si ya lo vio.
--
-- Partial unique indexes: las filas viejas (client_ref null) no se ven afectadas.
--
-- Aplicar en Supabase MANUALMENTE (dev/prod comparten la misma base).

begin;

alter table public.event_checklist_photos
  add column if not exists client_ref text;

create unique index if not exists event_checklist_photos_client_ref_uidx
  on public.event_checklist_photos (item_id, event_id, client_ref)
  where client_ref is not null;

alter table public.central_submissions
  add column if not exists client_ref text;

create unique index if not exists central_submissions_client_ref_uidx
  on public.central_submissions (client_ref)
  where client_ref is not null;

commit;

-- ── Rollback manual ───────────────────────────────────────────────────────
--   drop index if exists public.central_submissions_client_ref_uidx;
--   drop index if exists public.event_checklist_photos_client_ref_uidx;
--   alter table public.central_submissions drop column if exists client_ref;
--   alter table public.event_checklist_photos drop column if exists client_ref;
