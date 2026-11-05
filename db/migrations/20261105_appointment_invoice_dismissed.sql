-- When an admin deletes the draft invoice that invoiceDraftJob auto-created for
-- an appointment, the appointment is unlinked (invoice_id = null) and flagged
-- here so the job does not draft it again.
--
-- Aplicar en Supabase MANUALMENTE (no hay runner de migraciones en este repo).

begin;

alter table public.appointments
  add column if not exists invoice_draft_dismissed boolean not null default false;

commit;

-- Rollback: alter table public.appointments drop column if exists invoice_draft_dismissed;
