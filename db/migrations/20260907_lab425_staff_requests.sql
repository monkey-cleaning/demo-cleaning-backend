-- LAB425 — Solicitudes de licencia/vacaciones y reclamos desde el staff calendar
--
-- Dos tablas NUEVAS, deliberadamente separadas de `employee_time_off`:
-- esa tabla ya la usa el motor de disponibilidad/auto-assign
-- (controllers/scheduleController.js — getAvailableStaffForEvents) para
-- BLOQUEAR a un empleado en una fecha. Un pedido de licencia sin revisar no
-- puede caer ahí directo o bloquearía la agenda antes de que ops lo apruebe.
-- Ops sigue cargando el bloqueo real a mano en /admin/staff (endpoint ya
-- existente createTimeOff) una vez que decide aprobar el pedido.
--
-- Aplicar en Supabase MANUALMENTE (no hay runner de migraciones en este
-- repo). Orden sugerido: dev primero, verificar, luego prod.

begin;

create table if not exists public.time_off_requests (
  id           uuid        primary key default gen_random_uuid(),
  employee_id  uuid        not null references public.employees(id),
  start_date   date        not null,
  end_date     date        not null,
  reason       text,
  notes        text,
  status       text        not null default 'pending'
               check (status in ('pending', 'approved', 'denied')),
  created_at   timestamptz not null default now()
);

comment on table public.time_off_requests is
  'LAB425 — pedidos de licencia/vacaciones enviados por un cleaner desde el staff calendar. NO bloquea disponibilidad por sí sola (a diferencia de employee_time_off) — es solo el registro del pedido + dispara el mail a ops_alert_email.';

create index if not exists time_off_requests_employee_idx
  on public.time_off_requests (employee_id, created_at desc);

create table if not exists public.staff_complaints (
  id           uuid        primary key default gen_random_uuid(),
  employee_id  uuid        not null references public.employees(id),
  message      text        not null,
  status       text        not null default 'open'
               check (status in ('open', 'resolved')),
  created_at   timestamptz not null default now()
);

comment on table public.staff_complaints is
  'LAB425 — reclamos enviados por un cleaner desde el staff calendar. Dispara el mail a ops_alert_email; sin panel de resolución todavía (ops actúa desde el mail).';

create index if not exists staff_complaints_employee_idx
  on public.staff_complaints (employee_id, created_at desc);

commit;

-- ── Rollback manual (si hiciera falta) ────────────────────────────────────
--   drop table if exists public.staff_complaints;
--   drop table if exists public.time_off_requests;
