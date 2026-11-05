-- Payroll (2026-09-30) — tarifa por servicio puntual: hasta ahora, corregir el
-- $/h de un trabajo desde Payroll SIEMPRE actualizaba `clients.rate` (la
-- tarifa habitual, vale para los próximos trabajos también). Para casos como
-- una limpieza de alfombras a otro precio, hace falta poder fijar un $/h
-- distinto SOLO para ESE trabajo, sin tocar la tarifa habitual del cliente.
--
-- `billed_rate` es informativo/de despliegue: el monto real sigue siendo
-- `applied_amount` (ya existía). Cuando se carga "solo este trabajo", acá
-- queda el $/h que se usó para calcularlo, así la UI lo puede mostrar en la
-- columna Rate en vez del de `clients.rate`.
--
-- Aplicar en Supabase MANUALMENTE (no hay runner de migraciones en este
-- repo). Orden sugerido: dev primero, verificar, luego prod.

begin;

alter table public.payroll_client_billing_overrides
  add column if not exists billed_rate numeric check (billed_rate is null or billed_rate >= 0);

comment on column public.payroll_client_billing_overrides.billed_rate is
  'Tarifa $/h usada para este trabajo puntual — cuando difiere de clients.rate (p. ej. "solo este trabajo", sin tocar la tarifa habitual).';

commit;
