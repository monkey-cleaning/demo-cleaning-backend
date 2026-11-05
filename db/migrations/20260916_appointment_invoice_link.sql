-- Link an appointment to the draft invoice auto-created when it's marked
-- "completed" (appointmentSyncService.js), so the sync job doesn't create a
-- duplicate invoice every time it re-processes the same completed row.
--
-- Amount is NOT computed automatically (no reliable per-appointment quote
-- data yet — see cleaningQuoteCalculator.js, which only has inputs from
-- `leads`, not `appointments`). The draft is created with a $0 line item for
-- staff to fill in via the Invoices admin page.
--
-- Aplicar en Supabase MANUALMENTE (no hay runner de migraciones en este
-- repo). Orden sugerido: dev primero, verificar, luego prod.

begin;

alter table public.appointments
  add column if not exists invoice_id uuid references public.invoices(id);

create index if not exists appointments_invoice_id_idx
  on public.appointments (invoice_id);

commit;

-- ── Rollback manual (si hiciera falta) ────────────────────────────────────
--   alter table public.appointments drop column if exists invoice_id;
