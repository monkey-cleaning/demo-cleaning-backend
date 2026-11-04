// services/payrollEvents.js
//
// Eventos de servicio de un rango, con la forma que espera payrollSummaryService
// (la misma que devolvía getEventsForRange de Monkey sobre Google Calendar), pero
// leídos de `appointments` + `appointment_teams`. `attendees` son los emails de los
// cleaners asignados; `id` es appointments.id.
import { DateTime } from "luxon";
import { supabase } from "../supabaseClient.js";
import { isNonServiceEventRow } from "./eventClassification.js";
import { TZ } from "../config/timezone.js";

export async function getPayrollEvents(timeMin, timeMax) {
  const rows = [];
  const PAGE = 1000;
  for (let off = 0; ; off += PAGE) {
    const { data, error } = await supabase
      .from("appointments")
      .select(
        "id, gcal_summary, color_id, scheduled_date, starts_at, ends_at, property_address, series_id, " +
          "appointment_teams(employees(email))",
      )
      .gte("starts_at", timeMin)
      .lt("starts_at", timeMax)
      .neq("status", "cancelled")
      .order("starts_at")
      .range(off, off + PAGE - 1);
    if (error) throw new Error(`payroll events: ${error.message}`);
    rows.push(...(data ?? []));
    if (!data || data.length < PAGE) break;
  }

  return rows
    .filter((r) => r.starts_at && r.ends_at)
    .map((r) => {
      const start = DateTime.fromISO(r.starts_at, { zone: TZ });
      const end = DateTime.fromISO(r.ends_at, { zone: TZ });
      return {
        id: r.id,
        summary: r.gcal_summary || "(no title)",
        isAllDay: false,
        isNonService: isNonServiceEventRow(r),
        startIso: start.toISO(),
        endIso: end.toISO(),
        startDate: start.toISODate(),
        durationH: end.isValid && start.isValid ? end.diff(start, "hours").hours : 0,
        location: r.property_address || null,
        recurringEventId: r.series_id ?? null,
        attendees: (r.appointment_teams ?? [])
          .map((t) => t.employees?.email)
          .filter(Boolean),
      };
    });
}
