-- Payroll — extras de accionista FIJOS (p. ej. el parking de Javi, confirmado
-- recurrente por Jhony el 2026-09-29). Mismo patrón que los gastos fijos
-- (20260918_payroll_finance_v2.sql, `payroll_recurring_expenses`): una
-- plantilla con VIGENCIA, no una fila copiada a cada quincena. Cada versión
-- cubre [from_period, until_period). Cambiar el monto cierra la versión
-- vigente y abre otra desde esa quincena; las quincenas pasadas no cambian.
-- period index = year*24 + (month-1)*2 + (half-1) (payrollExpensesService.periodIndex).
--
-- Aplicar en Supabase MANUALMENTE (no hay runner de migraciones en este
-- repo). Orden sugerido: dev primero, verificar, luego prod.

begin;

create table if not exists public.payroll_recurring_partner_extras (
  id            uuid primary key default gen_random_uuid(),
  series_id     uuid        not null default gen_random_uuid(),
  partner_id    uuid        not null references public.payroll_partners(id),
  concept       text        not null,
  amount        numeric     not null check (amount >= 0),
  from_period   integer     not null,
  until_period  integer,
  created_by    text,
  created_at    timestamptz not null default now(),
  check (until_period is null or until_period > from_period)
);

comment on table public.payroll_recurring_partner_extras is
  'Payroll 2026-09-29 — extras de accionista FIJOS (p. ej. parking de Javi). Una fila = una VERSION (mismo series_id = mismo extra con distintos montos). Aplica a las quincenas con from_period <= idx < until_period (until_period null = sin fin).';

create index if not exists payroll_recurring_partner_extras_series_idx
  on public.payroll_recurring_partner_extras (series_id, from_period);

create index if not exists payroll_recurring_partner_extras_partner_idx
  on public.payroll_recurring_partner_extras (partner_id);

commit;
