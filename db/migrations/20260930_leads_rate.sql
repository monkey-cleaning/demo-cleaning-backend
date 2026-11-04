-- Payroll/CRM (2026-09-30) — guarda en el lead la tarifa $/h cotizada (web o
-- voz), para poder copiarla al cliente cuando se convierte. Hoy esa plata se
-- calcula al vuelo para el email de cotización y se pierde — ni el lead ni el
-- cliente nuevo quedan con el dato, así que hay que cargarlo a mano después.
--
-- Aplicar en Supabase MANUALMENTE (no hay runner de migraciones en este
-- repo). Orden sugerido: dev primero, verificar, luego prod.

begin;

alter table public.leads
  add column if not exists rate numeric check (rate is null or rate >= 0);

comment on column public.leads.rate is
  'Tarifa $/h cotizada al lead (web o voz) — se copia a clients.rate al convertir si el cliente no tiene una propia cargada.';

commit;
