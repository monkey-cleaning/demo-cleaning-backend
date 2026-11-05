-- Payroll — accionistas (Javi y Jhony) como entidad propia.
--
-- Por qué (aclarado por el usuario 2026-09-24): Javier y Jhony son los
-- ACCIONISTAS de la empresa. Javi es tambien un cleaner (Javier Martinez), pero
-- Jhony NO es un cleaner — en la planilla, las horas/traslado de las filas
-- "Jhony" son de Edilsa y solo los dividendos son de Jhony. Por eso los
-- dividendos y los "intermediarios" de Pagos Experimental (quienes cobran y
-- reparten el efectivo) apuntan a un ACCIONISTA, no a un empleado.
--
--   * payroll_partners.employee_id enlaza al accionista con su empleado cuando
--     es la misma persona (Javi); queda null para quien no es cleaner (Jhony).
--   * payroll_dividends: employee_id (20260923, nunca usado) se reemplaza por
--     partner_id. Los dividendos ya cargados se asignan por coincidencia del
--     concepto con el nombre del accionista ("Jhony", "Javi").
--   * payroll_partner_extras: montos extra que cobra un accionista en una
--     quincena y no son dividendos (ej. el parking fijo de 45 que suma Javi en
--     la planilla). No afectan el P&L: el gasto ya esta en Expenses.
--   * payroll_payment_plans: via_employee_ids -> via_partner_ids.
--
-- Aplicar en Supabase MANUALMENTE (no hay runner de migraciones en este
-- repo). Requiere haber corrido antes 20260923_payroll_closing.sql.

begin;

create table if not exists public.payroll_partners (
  id           uuid primary key default gen_random_uuid(),
  name         text        not null,
  employee_id  uuid        unique references public.employees(id),
  is_active    boolean     not null default true,
  created_at   timestamptz not null default now()
);

comment on table public.payroll_partners is
  'Payroll — accionistas. employee_id = su empleado si tambien es cleaner (Javi); null si no lo es (Jhony).';

-- Semilla: Javi (enlazado a su empleado por email) y Jhony (sin empleado).
insert into public.payroll_partners (name, employee_id)
select 'Javi', e.id
from public.employees e
where lower(e.email) = 'javiermartoch@gmail.com'
  and not exists (select 1 from public.payroll_partners where name = 'Javi');

insert into public.payroll_partners (name)
select 'Jhony'
where not exists (select 1 from public.payroll_partners where name = 'Jhony');

-- ── Dividendos por accionista ────────────────────────────────────────────
alter table public.payroll_dividends
  add column if not exists partner_id uuid references public.payroll_partners(id);

update public.payroll_dividends d
set partner_id = p.id
from public.payroll_partners p
where d.partner_id is null
  and lower(btrim(d.concept)) = lower(p.name);

alter table public.payroll_dividends
  drop column if exists employee_id;

-- ── Extras de un accionista en una quincena ──────────────────────────────
create table if not exists public.payroll_partner_extras (
  id          uuid primary key default gen_random_uuid(),
  year        integer     not null,
  month       integer     not null,
  half        smallint    not null check (half in (1, 2)),
  partner_id  uuid        not null references public.payroll_partners(id),
  concept     text        not null,
  amount      numeric     not null check (amount >= 0),
  created_by  text,
  created_at  timestamptz not null default now()
);

comment on table public.payroll_partner_extras is
  'Payroll — monto extra que cobra un accionista en la quincena (ej. reintegro de parking). Suma a "A <accionista>" en Pagos Experimental; no es dividendo ni toca el P&L.';

create index if not exists payroll_partner_extras_period_idx
  on public.payroll_partner_extras (year, month, half);

-- ── Planes de pago: intermediarios = accionistas ─────────────────────────
alter table public.payroll_payment_plans
  add column if not exists via_partner_ids uuid[] not null default '{}';

alter table public.payroll_payment_plans
  drop column if exists via_employee_ids;

commit;

-- ── Rollback manual (si hiciera falta) ────────────────────────────────────
--   alter table public.payroll_payment_plans add column if not exists via_employee_ids uuid[] not null default '{}';
--   alter table public.payroll_payment_plans drop column if exists via_partner_ids;
--   drop table if exists public.payroll_partner_extras;
--   alter table public.payroll_dividends add column if not exists employee_id uuid references public.employees(id);
--   alter table public.payroll_dividends drop column if exists partner_id;
--   drop table if exists public.payroll_partners;
