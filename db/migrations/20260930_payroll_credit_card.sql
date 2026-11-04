-- Payroll (2026-09-30) — balance de la tarjeta de crédito de la empresa, de
-- carga manual por ahora (punto 13 del pedido grande). Un registro por
-- quincena: saldo al cierre + lo que se abonó esa quincena. Mismo patrón que
-- `payroll_net_pay_overrides` (upsert por período, sin tabla de historial
-- propia — record_history no aplica a payroll, ver memoria del proyecto).
--
-- Aplicar en Supabase MANUALMENTE (no hay runner de migraciones en este
-- repo). Orden sugerido: dev primero, verificar, luego prod.

begin;

create table if not exists public.payroll_credit_card_balance (
  year            integer     not null,
  month           integer     not null,
  half            smallint    not null check (half in (1, 2)),
  balance         numeric     not null check (balance >= 0),
  payment_amount  numeric     not null default 0 check (payment_amount >= 0),
  note            text,
  updated_by      text,
  updated_at      timestamptz not null default now(),
  created_at      timestamptz not null default now(),
  primary key (year, month, half)
);

comment on table public.payroll_credit_card_balance is
  'Payroll — saldo de la tarjeta de crédito de la empresa al cierre de la quincena y el abono hecho esa quincena. Carga manual.';

commit;
