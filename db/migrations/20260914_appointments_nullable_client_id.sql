-- Permite crear eventos sin cliente (Lunch, y en general cualquier evento
-- "no-servicio") en `appointments`.
--
-- Contexto: en Monkey Cleaning, los eventos non-service (Lunch, bloqueos,
-- etc.) vivían SOLO en Google Calendar — nunca se sincronizaban a
-- `appointments` (ver eventClassification / appointmentSyncService: se
-- saltean el upsert cuando isNonServiceEvent() da true). Por eso el schema
-- original heredado (Docs/schema_monkey_cleaning.sql) tiene
-- `appointments.client_id uuid NOT NULL`.
--
-- Este fork (Demo) es standalone: no hay Google Calendar, `appointments` es
-- la única fuente de verdad y TODOS los eventos del calendario —incluido
-- Lunch— se insertan ahí (ver createCalendarEvent en
-- src/controllers/calendarController.js, que ya hace `client_id: clientId ??
-- null`). La constraint NOT NULL heredada nunca se relajó, por eso "Add
-- Lunch" tira "null value in column client_id ... violates not-null
-- constraint".
--
-- Aplicar en Supabase MANUALMENTE. Orden sugerido: dev primero, verificar, prod.

begin;

alter table public.appointments
  alter column client_id drop not null;

comment on column public.appointments.client_id is
  'Nullable: eventos non-service (Lunch, bloqueos, etc.) no tienen cliente asociado.';

commit;

-- ── Rollback manual ───────────────────────────────────────────────────────
-- Antes de volver a poner NOT NULL hay que resolver (borrar o asignar un
-- client_id) cualquier fila que haya quedado en null, o el ALTER falla:
--   select id, gcal_summary from public.appointments where client_id is null;
--
--   alter table public.appointments alter column client_id set not null;
