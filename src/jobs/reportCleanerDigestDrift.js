// jobs/reportCleanerDigestDrift.js
//
// Informe de SOLO LECTURA que prueba que a cada cleaner le llegan los trabajos
// correctos. Adaptado de Monkey Cleaning (LAB403 reportCleanerDigestDrift.js):
// allá reconciliaba los attendees de Google Calendar contra appointment_teams
// contra lo que manda el digest. En este fork no hay Google Calendar —
// appointment_teams ES la única fuente — así que el informe reconstruye lo que
// runDailyDigestJob mandaría para un día y marca:
//
//   NO_EMAIL       — cleaner asignado sin employees.email → NO recibe el route
//                    sheet (el hallazgo importante en este fork)
//   UNASSIGNED     — appointment de servicio sin ninguna fila en appointment_teams
//   EXCLUDED       — cleaner cuyo email cae en NOTIFICATION_EXCLUDED_EMAILS
//
// Cero writes, cero mails. `exit 1` si hay hallazgos (sirve de pre-flight).
//
// CLI:
//   node src/jobs/reportCleanerDigestDrift.js                 (mañana)
//   node src/jobs/reportCleanerDigestDrift.js --date=2026-09-10
//   node src/jobs/reportCleanerDigestDrift.js --routes        (imprime cada route sheet)

import "dotenv/config";
import { pathToFileURL } from "node:url";
import { DateTime } from "luxon";
import { supabase } from "../supabaseClient.js";
import {
  isNotificationExcluded,
  sanitizeNotes,
} from "../services/employeeNotificationService.js";
import { isNonServiceEventRow } from "../services/eventClassification.js";

const TZ = process.env.BOOKING_TIMEZONE || "America/Vancouver";

export async function runReportCleanerDigestDrift({
  date,
  routes = false,
} = {}) {
  const targetDate =
    date || DateTime.now().setZone(TZ).plus({ days: 1 }).toISODate();
  console.log(`[CleanerDigestReport] ${targetDate}\n`);

  const { data: rows, error } = await supabase
    .from("appointments")
    .select(
      "id, gcal_summary, color_id, scheduled_start_time, scheduled_end_time, property_address, service_type, special_instructions, status, " +
        "clients(first_name, last_name), " +
        "appointment_teams(employees(id, name, email))",
    )
    .eq("scheduled_date", targetDate)
    .neq("status", "cancelled")
    .order("scheduled_start_time", { ascending: true });
  if (error) throw new Error(error.message);

  const findings = [];
  const byEmployee = new Map(); // id -> { name, email, tasks:[] }

  for (const appt of rows ?? []) {
    if (isNonServiceEventRow(appt)) continue;
    const clientName =
      [appt.clients?.first_name, appt.clients?.last_name]
        .filter(Boolean)
        .join(" ") || "Client";
    const task = {
      time: `${(appt.scheduled_start_time || "").slice(0, 5)}–${(appt.scheduled_end_time || "").slice(0, 5)}`,
      clientName,
      address: appt.property_address || "",
      serviceType: appt.service_type || "",
      notes: sanitizeNotes(appt.special_instructions),
    };

    const team = appt.appointment_teams ?? [];
    if (!team.length) {
      findings.push({
        kind: "UNASSIGNED",
        appt: appt.id,
        detail: `${task.time} ${task.clientName} — no cleaner in appointment_teams`,
      });
      continue;
    }

    for (const member of team) {
      const emp = member.employees;
      if (!emp) continue;
      if (!emp.email) {
        findings.push({
          kind: "NO_EMAIL",
          appt: appt.id,
          detail: `${emp.name || emp.id} is on ${task.time} ${task.clientName} but has no email — no route sheet`,
        });
        continue;
      }
      if (isNotificationExcluded(emp.email)) {
        findings.push({
          kind: "EXCLUDED",
          appt: appt.id,
          detail: `${emp.name} <${emp.email}> excluded via NOTIFICATION_EXCLUDED_EMAILS`,
        });
      }
      if (!byEmployee.has(emp.id))
        byEmployee.set(emp.id, { name: emp.name, email: emp.email, tasks: [] });
      byEmployee.get(emp.id).tasks.push(task);
    }
  }

  if (routes) {
    for (const { name, email, tasks } of byEmployee.values()) {
      console.log(`── ${name} <${email}> — ${tasks.length} job(s)`);
      for (const t of tasks) {
        console.log(
          `   ${t.time}  ${t.clientName}  ${t.address}${t.serviceType ? ` · ${t.serviceType}` : ""}${t.notes ? ` · note: ${t.notes}` : ""}`,
        );
      }
      console.log("");
    }
  }

  console.log(
    `Route sheets that would go out: ${byEmployee.size} cleaner(s)`,
  );
  if (!findings.length) {
    console.log("✅ No findings — every assigned cleaner has an email.");
    return { date: targetDate, findings: [] };
  }
  console.log(`\n⚠️  ${findings.length} finding(s):`);
  for (const f of findings) console.log(`   [${f.kind}] ${f.detail}`);
  return { date: targetDate, findings };
}

const isDirectRun =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isDirectRun) {
  const args = { routes: false };
  for (const raw of process.argv.slice(2)) {
    const [k, v] = raw.replace(/^--/, "").split("=");
    if (k === "date") args.date = v;
    else if (k === "routes") args.routes = true;
  }
  runReportCleanerDigestDrift(args)
    .then((r) => process.exit(r.findings.length ? 1 : 0))
    .catch((e) => {
      console.error("[CleanerDigestReport] ERROR:", e.message);
      process.exit(2);
    });
}
