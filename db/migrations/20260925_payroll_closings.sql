-- Payroll — cierre manual de quincena: la quincena queda congelada como un
-- archivo inmutable.
--
-- Decisiones (2026-09-25):
--   * Una fila por quincena cerrada (year, month, half). `snapshot` guarda el
--     resumen admin COMPLETO (pnl, net pay, tabla de pagos, cleaners con sus
--     eventos y traslados, facturación por cliente) y las tarjetas de la
--     página (gastos, dividendos, extras, deducciones, bonos, propinas,
--     servicios nuevos, checklist, planes). Una quincena cerrada se sirve
--     desde acá, no se recalcula: sus números no cambian aunque después se
--     edite el calendario, una tarifa o un cliente.
--   * INMUTABLE a nivel base de datos: un trigger rechaza UPDATE y DELETE
--     (también al service role). Reabrir una quincena es una decisión
--     deliberada que se hace a mano en la base (borrar la fila desactivando el
--     trigger), nunca desde la app.
--
-- Aplicar en Supabase MANUALMENTE (no hay runner de migraciones en este
-- repo). Orden sugerido: dev primero, verificar, luego prod.

begin;

create table if not exists public.payroll_closings (
  year       integer     not null,
  month      integer     not null,
  half       smallint    not null check (half in (1, 2)),
  closed_at  timestamptz not null default now(),
  closed_by  text,
  snapshot   jsonb       not null,
  primary key (year, month, half)
);

comment on table public.payroll_closings is
  'Quincenas de payroll cerradas: snapshot inmutable del resumen y de las tarjetas.';

create or replace function public.payroll_closings_immutable()
returns trigger
language plpgsql
as $$
begin
  raise exception 'payroll_closings is immutable: a closed fortnight cannot be % (reopen it manually in the database if truly needed)', lower(tg_op);
end;
$$;

drop trigger if exists payroll_closings_no_update on public.payroll_closings;
create trigger payroll_closings_no_update
  before update on public.payroll_closings
  for each row execute function public.payroll_closings_immutable();

drop trigger if exists payroll_closings_no_delete on public.payroll_closings;
create trigger payroll_closings_no_delete
  before delete on public.payroll_closings
  for each row execute function public.payroll_closings_immutable();

-- Mismo criterio que el resto de las tablas de payroll: solo el backend
-- (service role) la toca.
alter table public.payroll_closings enable row level security;

commit;
