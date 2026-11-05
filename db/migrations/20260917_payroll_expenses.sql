-- LAB428 (2026-09-17) — gastos de la quincena en la pestaña "Payroll".
--
-- Calcado de la sección "GASTOS" de la planilla manual (Concepto | Tipo |
-- Monto, con Tipo restringido a Financiero/Operativo/Administrativo y
-- totales por categoría + total general arriba de la lista). Categorías
-- guardadas en inglés (financial/operational/administrative) para
-- consistencia con el resto de la pestaña (Work hours/Travel hours, no
-- Horas/Trans-te) — mismo concepto, mismas 3 categorías, otro idioma.
--
-- A propósito FUERA de alcance: el resto del P&L de la planilla (Ing.
-- Bruto, Profit, GA/CIA NETA, Ahorro, NET PAY, Invoice Status) — el pedido
-- fue específicamente "agregar y categorizar los gastos", no reconstruir
-- todo el estado de resultados.
--
-- Aplicar en Supabase MANUALMENTE (no hay runner de migraciones en este
-- repo). Orden sugerido: dev primero, verificar, luego prod.

begin;

create table if not exists public.payroll_expenses (
  id           uuid primary key default gen_random_uuid(),
  year         integer     not null,
  month        integer     not null,
  half         smallint    not null check (half in (1, 2)),
  concept      text        not null,
  category     text        not null check (category in ('financial', 'operational', 'administrative')),
  amount       numeric     not null check (amount >= 0),
  created_by   text,
  created_at   timestamptz not null default now()
);

comment on table public.payroll_expenses is
  'LAB428 2026-09-17 — gastos operativos de una quincena, cargados a mano en la pestaña Payroll. category: financial/operational/administrative (= Financiero/Operativo/Administrativo en la planilla manual).';

create index if not exists payroll_expenses_period_idx
  on public.payroll_expenses (year, month, half);

commit;

-- ── Rollback manual (si hiciera falta) ────────────────────────────────────
--   drop table if exists public.payroll_expenses;
