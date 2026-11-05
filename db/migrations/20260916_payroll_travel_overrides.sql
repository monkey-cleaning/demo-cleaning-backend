-- LAB428 (2026-09-16) — slots de traslado editables en la pestaña "Payroll".
--
-- Cada hueco entre dos eventos consecutivos del mismo día para un mismo
-- empleado (payrollSummaryService.js) se calcula en vivo desde Google
-- Calendar, no se persiste — PERO cuando ese hueco da >= 1h queda "para
-- revisión manual": no se cuenta solo (aplica 0h) hasta que un admin carga
-- a mano cuántas horas de traslado corresponden de verdad. Esta tabla guarda
-- SOLO esas decisiones manuales, identificando el tramo por el par de ids de
-- Google Calendar de los dos eventos que lo rodean (estables entre corridas,
-- a diferencia de un índice de array).
--
-- Si el evento anterior o el siguiente cambian de horario después de
-- revisado, el par de ids sigue siendo el mismo → el override persiste
-- aunque el hueco calculado en vivo ahora sea otro (se muestra igual el
-- valor aplicado a mano; no hay job que lo re-invalide automáticamente,
-- es decisión de quien lo cargó volver a revisarlo si hace falta).
--
-- Aplicar en Supabase MANUALMENTE (no hay runner de migraciones en este
-- repo). Orden sugerido: dev primero, verificar, luego prod.

begin;

create table if not exists public.payroll_travel_overrides (
  id               uuid        primary key default gen_random_uuid(),
  employee_id      uuid        not null references public.employees(id),
  prev_event_id    text        not null,
  next_event_id    text        not null,
  calculated_hours numeric,
  applied_hours    numeric     not null,
  reviewed_by      text,
  reviewed_at      timestamptz not null default now(),
  created_at       timestamptz not null default now(),
  unique (employee_id, prev_event_id, next_event_id)
);

comment on table public.payroll_travel_overrides is
  'LAB428 2026-09-16 — horas de traslado cargadas a mano por un admin para un tramo puntual (hueco calculado >= 1h, "para revisión manual"). Identifica el tramo por employee_id + el par de ids de GCal de los dos eventos que lo rodean.';

create index if not exists payroll_travel_overrides_employee_idx
  on public.payroll_travel_overrides (employee_id);

commit;

-- ── Rollback manual (si hiciera falta) ────────────────────────────────────
--   drop table if exists public.payroll_travel_overrides;
