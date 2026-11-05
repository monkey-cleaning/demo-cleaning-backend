-- Payroll estilo Excel (2026-09-18): gastos fijos, dividendos, deducciones a
-- cleaners y lista fija de gastos "relevantes".
--
-- Decisiones (acordadas con el usuario 2026-09-18):
--   * Dividendos y deducciones NO son gastos del P&L. Dividendos = plata que
--     sale hacia los accionistas DESPUES de la ganancia neta. Deducciones =
--     adelantos de sueldo a cleaners, se descuentan de su pago (Earned -
--     Deducciones = Net pay); el costo ya esta en la nomina.
--   * Gastos fijos = plantilla con VIGENCIA, no filas copiadas a cada
--     quincena. Cada version cubre [from_period, until_period). Cambiar el
--     precio cierra la version vigente y abre otra desde esa quincena, asi
--     las quincenas pasadas no cambian.
--   * period index = year*24 + (month-1)*2 + (half-1) — monotonico, permite
--     comparar quincenas con un simple <=.
--
-- Aplicar en Supabase MANUALMENTE (no hay runner de migraciones en este
-- repo). Orden sugerido: dev primero, verificar, luego prod.

begin;

create table if not exists public.payroll_recurring_expenses (
  id            uuid primary key default gen_random_uuid(),
  series_id     uuid        not null default gen_random_uuid(),
  concept       text        not null,
  category      text        not null check (category in ('financial', 'operational', 'administrative')),
  amount        numeric     not null check (amount >= 0),
  from_period   integer     not null,
  until_period  integer,
  created_by    text,
  created_at    timestamptz not null default now(),
  check (until_period is null or until_period > from_period)
);

comment on table public.payroll_recurring_expenses is
  'Payroll 2026-09-18 — gastos fijos. Una fila = una VERSION (mismo series_id = mismo gasto con distintos precios). Aplica a las quincenas con from_period <= idx < until_period (until_period null = sin fin).';

create index if not exists payroll_recurring_expenses_series_idx
  on public.payroll_recurring_expenses (series_id, from_period);

create table if not exists public.payroll_dividends (
  id          uuid primary key default gen_random_uuid(),
  year        integer     not null,
  month       integer     not null,
  half        smallint    not null check (half in (1, 2)),
  concept     text        not null,
  amount      numeric     not null check (amount >= 0),
  created_by  text,
  created_at  timestamptz not null default now()
);

comment on table public.payroll_dividends is
  'Payroll 2026-09-18 — dinero que sale hacia los accionistas en una quincena. NO es un gasto: no entra en Ganancia neta.';

create index if not exists payroll_dividends_period_idx
  on public.payroll_dividends (year, month, half);

create table if not exists public.payroll_deductions (
  id           uuid primary key default gen_random_uuid(),
  year         integer     not null,
  month        integer     not null,
  half         smallint    not null check (half in (1, 2)),
  employee_id  uuid        not null references public.employees(id),
  concept      text        not null,
  amount       numeric     not null check (amount >= 0),
  created_by   text,
  created_at   timestamptz not null default now()
);

comment on table public.payroll_deductions is
  'Payroll 2026-09-18 — adelantos de sueldo a un cleaner, se descuentan de su pago en esta quincena. NO son un gasto del P&L.';

create index if not exists payroll_deductions_period_idx
  on public.payroll_deductions (year, month, half);

create table if not exists public.payroll_pinned_expense_concepts (
  concept_key  text primary key,
  label        text    not null,
  position     integer not null default 0
);

comment on table public.payroll_pinned_expense_concepts is
  'Payroll 2026-09-18 — conceptos de gasto que la tabla de "gastos relevantes" muestra SIEMPRE (aunque el monto sea 0). concept_key = concepto en minusculas y sin espacios en los bordes.';

insert into public.payroll_pinned_expense_concepts (concept_key, label, position)
values
  ('transporte', 'Transporte', 0),
  ('gasolina',   'Gasolina',   1)
on conflict (concept_key) do nothing;

commit;

-- ── Rollback manual (si hiciera falta) ────────────────────────────────────
--   drop table if exists public.payroll_pinned_expense_concepts;
--   drop table if exists public.payroll_deductions;
--   drop table if exists public.payroll_dividends;
--   drop table if exists public.payroll_recurring_expenses;
