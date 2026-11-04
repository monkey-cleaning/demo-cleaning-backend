-- LAB428 — corrección manual del monto facturado al cliente por un evento
-- (servicio) puntual. El monto calculado (durationH x cleaners asignados x
-- tarifa vigente a la fecha del evento) es solo una referencia — no hay
-- forma de reconstruir el monto COTIZADO real de un evento ya trabajado
-- (bedrooms/baths/extras de esa casa puntual no quedan linkeados al
-- appointment), así que el admin puede corregirlo a mano contra su propio
-- registro de facturación real.
--
-- Clave única por event_id (no por empleado): el monto facturado es del
-- SERVICIO, no de quién lo hizo — un evento con 2 cleaners de attendees
-- tiene un solo monto, no uno por persona.
--
-- Aplicar en Supabase MANUALMENTE (no hay runner de migraciones en este
-- repo). Orden sugerido: dev primero, verificar, luego prod.

create table if not exists public.payroll_client_billing_overrides (
  id                 uuid        primary key default gen_random_uuid(),
  event_id           text        not null unique,
  calculated_amount  numeric,
  applied_amount     numeric     not null,
  reviewed_by        text,
  reviewed_at        timestamptz not null default now(),
  created_at         timestamptz not null default now()
);

create index if not exists payroll_client_billing_overrides_event_idx
  on public.payroll_client_billing_overrides (event_id);

-- ── Rollback manual (si hiciera falta) ────────────────────────────────────
--   drop table if exists public.payroll_client_billing_overrides;
