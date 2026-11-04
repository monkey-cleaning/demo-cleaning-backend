-- Payroll — tablas del cierre de quincena que faltaban de la planilla manual
-- (SEP_Q1.xlsx): NET PAY editable, bonos, propinas, servicios nuevos,
-- checklist "Chequeo Nomina" y la tabla "Pagos Experimental" (cleaners que
-- cobran a traves de Javi y Jhony).
--
-- Decisiones (2026-09-23):
--   * Periodo = (year, month, half), igual que el resto de payroll.
--   * Bonos y propinas se asignan a UNO o VARIOS cleaners (tabla de
--     destinatarios), y los bonos ademas pueden ser "para todos"
--     (applies_to_all — se resuelve al leer, no se copia a cada cleaner).
--     El monto de un bono es POR cleaner; el de una propina se REPARTE en
--     partes iguales entre sus destinatarios.
--   * El checklist es una PLANTILLA con vigencia (from_period/until_period,
--     mismo indice year*24+(month-1)*2+(half-1) que los gastos fijos) + un
--     estado por quincena. Asi agregar un item nuevo no "ensucia" las
--     quincenas ya cerradas.
--   * NET PAY: el monto calculado (ganado + bonos + propinas - deducciones)
--     es solo el valor por defecto; el admin puede pisarlo por cleaner y
--     quincena (`payroll_net_pay_overrides`).
--   * Pagos Experimental: parametros por quincena y cleaner
--     (`payroll_payment_plans`) — ver payrollPaymentPlanService.js.
--
-- Aplicar en Supabase MANUALMENTE (no hay runner de migraciones en este
-- repo). Orden sugerido: dev primero, verificar, luego prod.

begin;

-- ── Bonos ────────────────────────────────────────────────────────────────
create table if not exists public.payroll_bonuses (
  id              uuid primary key default gen_random_uuid(),
  year            integer     not null,
  month           integer     not null,
  half            smallint    not null check (half in (1, 2)),
  concept         text        not null,
  amount          numeric     not null check (amount >= 0),
  applies_to_all  boolean     not null default false,
  created_by      text,
  created_at      timestamptz not null default now()
);

comment on table public.payroll_bonuses is
  'Payroll — bono de una quincena. amount es POR cleaner. applies_to_all=true => lo cobran todos los cleaners de la quincena; si no, solo los de payroll_bonus_recipients.';

create index if not exists payroll_bonuses_period_idx
  on public.payroll_bonuses (year, month, half);

create table if not exists public.payroll_bonus_recipients (
  bonus_id     uuid not null references public.payroll_bonuses(id) on delete cascade,
  employee_id  uuid not null references public.employees(id),
  primary key (bonus_id, employee_id)
);

-- ── Propinas ─────────────────────────────────────────────────────────────
create table if not exists public.payroll_tips (
  id           uuid primary key default gen_random_uuid(),
  year         integer     not null,
  month        integer     not null,
  half         smallint    not null check (half in (1, 2)),
  client_name  text        not null,
  client_id    uuid        references public.clients(id),
  amount       numeric     not null check (amount >= 0),
  note         text,
  created_by   text,
  created_at   timestamptz not null default now()
);

comment on table public.payroll_tips is
  'Payroll — propina que dejo un cliente. Es plata de paso: NO es ingreso ni costo del P&L, se suma al pago de los cleaners destinatarios (repartida en partes iguales).';

create index if not exists payroll_tips_period_idx
  on public.payroll_tips (year, month, half);

create table if not exists public.payroll_tip_recipients (
  tip_id       uuid not null references public.payroll_tips(id) on delete cascade,
  employee_id  uuid not null references public.employees(id),
  primary key (tip_id, employee_id)
);

-- ── Servicios nuevos ─────────────────────────────────────────────────────
create table if not exists public.payroll_new_services (
  id            uuid primary key default gen_random_uuid(),
  year          integer     not null,
  month         integer     not null,
  half          smallint    not null check (half in (1, 2)),
  service_name  text        not null,
  client_id     uuid        references public.clients(id),
  frequency     text        not null check (frequency in ('Weekly', 'Bi-weekly', 'Monthly', 'One-time', 'As needed')),
  note          text,
  created_by    text,
  created_at    timestamptz not null default now()
);

comment on table public.payroll_new_services is
  'Payroll — servicios/clientes nuevos de la quincena ("Servicio nuevo | Tipo" de la planilla). frequency usa las mismas opciones que clients.expected_frequency.';

create index if not exists payroll_new_services_period_idx
  on public.payroll_new_services (year, month, half);

-- ── Checklist "Chequeo Nomina" ───────────────────────────────────────────
create table if not exists public.payroll_checklist_items (
  id            uuid primary key default gen_random_uuid(),
  label         text        not null,
  position      integer     not null default 0,
  from_period   integer     not null default 0,
  until_period  integer,
  created_by    text,
  created_at    timestamptz not null default now(),
  check (until_period is null or until_period > from_period)
);

comment on table public.payroll_checklist_items is
  'Payroll — items del chequeo previo a cerrar la quincena. Aplica a las quincenas con from_period <= idx < until_period (until_period null = sin fin), mismo indice que payroll_recurring_expenses.';

create table if not exists public.payroll_checklist_status (
  year       integer     not null,
  month      integer     not null,
  half       smallint    not null check (half in (1, 2)),
  item_id    uuid        not null references public.payroll_checklist_items(id) on delete cascade,
  done       boolean     not null default false,
  comment    text,
  done_by    text,
  done_at    timestamptz,
  primary key (year, month, half, item_id)
);

comment on table public.payroll_checklist_status is
  'Payroll — estado de cada item del chequeo en una quincena. Sin fila = pendiente.';

-- Los 25 items de la planilla SEP_Q1 (columna "Chequeo Nomina"), en su orden.
insert into public.payroll_checklist_items (label, position)
select v.label, v.position
from (values
  ('Revisar fechas', 0),
  ('Actualizar Resumen_Anual', 1),
  ('Revisar Dias nomina en excel', 2),
  ('Dividendos + Marcar', 3),
  ('Efectivo Javi', 4),
  ('Telus', 5),
  ('Revisar Sin tarifa', 6),
  ('Hasta donde van Formulas', 7),
  ('Profit Monkey revisar con Minimo', 8),
  ('Revisar nuevos 3', 9),
  ('Invoice Status', 10),
  ('Nuevos Cleaners', 11),
  ('Propinas', 12),
  ('Trabajo Gael y Nohely?', 13),
  ('Total Jhony', 14),
  ('Total Javi', 15),
  ('Quickbooks payroll Fecha coincide', 16),
  ('Cargar horas QB + Comprobar Tabla', 17),
  ('Preview Review', 18),
  ('Generar Impto PD7A Segundo Q', 19),
  ('Pago Programado', 20),
  ('Pago GST', 21),
  ('Pagos Finales', 22),
  ('Pantallazo Pago Javi y Jhony', 23),
  ('Gael y Vanessa y Nohely', 24)
) as v(label, position)
where not exists (select 1 from public.payroll_checklist_items);

-- ── NET PAY editable ─────────────────────────────────────────────────────
create table if not exists public.payroll_net_pay_overrides (
  year         integer     not null,
  month        integer     not null,
  half         smallint    not null check (half in (1, 2)),
  employee_id  uuid        not null references public.employees(id),
  amount       numeric     not null check (amount >= 0),
  calculated   numeric,
  note         text,
  updated_by   text,
  updated_at   timestamptz not null default now(),
  primary key (year, month, half, employee_id)
);

comment on table public.payroll_net_pay_overrides is
  'Payroll — "A Pagar" fijado a mano por el admin para un cleaner en una quincena (pisa el calculado). calculated = lo que daba la cuenta al momento de editar, solo informativo.';

-- ── Pagos Experimental ───────────────────────────────────────────────────
-- Un plan por cleaner y quincena: parte de lo que gano se paga por la nomina
-- oficial (QuickBooks) y el resto, en efectivo, a traves de otros empleados
-- (Javi y Jhony) que se lo reparten en partes iguales.
create table if not exists public.payroll_payment_plans (
  year              integer     not null,
  month             integer     not null,
  half              smallint    not null check (half in (1, 2)),
  employee_id       uuid        not null references public.employees(id),
  official_net      numeric     check (official_net is null or official_net >= 0),
  official_gross    numeric     check (official_gross is null or official_gross >= 0),
  bonus_col         numeric     check (bonus_col is null or bonus_col >= 0),
  cash_rate_factor  numeric     not null default 1 check (cash_rate_factor >= 0),
  via_employee_ids  uuid[]      not null default '{}',
  note              text,
  updated_by        text,
  updated_at        timestamptz not null default now(),
  primary key (year, month, half, employee_id)
);

comment on table public.payroll_payment_plans is
  'Payroll — parametros de la tabla "Pagos Experimental". official_net = "Real" (neto de la nomina oficial, null = salario - deducciones); official_gross = tope bruto de la nomina oficial (null = sin excedente en efectivo); bonus_col = columna "Bono" (null = traslado + bonos); cash_rate_factor = ajuste de tarifa del excedente en efectivo (ej. 19/22); via_employee_ids = quienes lo cobran y reparten en partes iguales.';

-- Dividendos por accionista: a que empleado (Javi / Jhony) le corresponde.
alter table public.payroll_dividends
  add column if not exists employee_id uuid references public.employees(id);

commit;

-- ── Rollback manual (si hiciera falta) ────────────────────────────────────
--   alter table public.payroll_dividends drop column if exists employee_id;
--   drop table if exists public.payroll_payment_plans;
--   drop table if exists public.payroll_net_pay_overrides;
--   drop table if exists public.payroll_checklist_status;
--   drop table if exists public.payroll_checklist_items;
--   drop table if exists public.payroll_new_services;
--   drop table if exists public.payroll_tip_recipients;
--   drop table if exists public.payroll_tips;
--   drop table if exists public.payroll_bonus_recipients;
--   drop table if exists public.payroll_bonuses;
