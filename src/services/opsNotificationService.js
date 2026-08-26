// Ticket: "Confirmación automática de servicios pendientes (CONFIRMAR)" — Paso 7
//
// Alerta interna a operaciones cuando un espacio se libera automáticamente
// por falta de confirmación del cliente (Criterio de aceptación #6).
//
// Por qué es un archivo propio y no una función más en
// clientNotificationService.js: ese archivo es, por su propio diseño,
// "el primer servicio de emails al CLIENTE" — separado de
// employeeNotificationService.js justamente para no mezclar audiencias.
// Este alert es interno (operaciones), no client-facing, así que mezclarlo
// ahí reabriría el mismo problema que esa separación evitó. Mismo
// transporter Gmail/nodemailer y mismo patrón de reintento que los otros
// dos servicios de email del proyecto.
//
// Funciones:
//   sendOpsReleaseAlert({ client, releasedSlots }) — usado por
//     jobs/confirmationReleaseJob.js, UNA vez por grupo liberado (no una vez
//     por slot) para no mandar 2 emails casi idénticos cuando eran 2
//     horarios ofrecidos al mismo cliente.

import nodemailer from "nodemailer";
import { DateTime } from "luxon";
import { getRawSettings } from "./settingsService.js";

const TZ = process.env.BOOKING_TIMEZONE || "America/Vancouver";

// Destinatarios fijos para fallos de envío de email a un lead — vía env var
// (LEAD_FAILURE_ALERT_EMAILS, separado por comas) en lugar de hardcodeado,
// para poder cambiarlos sin tocar código ni exponerlos si el repo se hace
// público. No usa el setting ops_alert_email a propósito — este alert es de
// más alta prioridad y va directo al equipo, no depende de que alguien haya
// configurado el setting en el admin.
function getLeadEmailFailureRecipients() {
  return (process.env.LEAD_FAILURE_ALERT_EMAILS || "")
    .split(",")
    .map((e) => e.trim())
    .filter(Boolean);
}

function getTransporter() {
  if (!process.env.GMAIL_USER || !process.env.GMAIL_PASS) {
    console.error(
      "[OpsNotif] Missing GMAIL_USER or GMAIL_PASS in .env, skipping notification",
    );
    return null;
  }
  return nodemailer.createTransport({
    service: "gmail",
    auth: { user: process.env.GMAIL_USER, pass: process.env.GMAIL_PASS },
  });
}

async function sendWithRetry(transporter, mailOptions, label) {
  try {
    await transporter.sendMail(mailOptions);
    console.log(`✅ [${label}] sent to ${mailOptions.to}`);
  } catch (err) {
    console.warn(
      `⚠️ [${label}] first attempt failed: ${err.message}. Retrying in 2s...`,
    );
    await new Promise((r) => setTimeout(r, 2000));
    try {
      await transporter.sendMail(mailOptions);
      console.log(`✅ [${label}] sent on retry to ${mailOptions.to}`);
    } catch (retryErr) {
      console.error(`❌ [${label}] retry also failed: ${retryErr.message}`);
    }
  }
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function emailWrapper(bodyHtml) {
  return `<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f4f6f9;font-family:'Helvetica Neue',Helvetica,Arial,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#f4f6f9;padding:32px 16px;">
    <tr><td align="center">
      <table width="560" cellpadding="0" cellspacing="0" style="max-width:560px;width:100%;">
        <tr><td style="background:#0d1b3e;border-radius:12px 12px 0 0;padding:20px 28px;">
          <span style="color:#fff;font-size:18px;font-weight:700;">Monkey Cleaning — Ops Alert</span>
        </td></tr>
        <tr><td style="background:#fff;border-left:1px solid #e2e8f0;border-right:1px solid #e2e8f0;padding:24px 28px;">
          ${bodyHtml}
        </td></tr>
        <tr><td style="background:#f8fafc;border:1px solid #e2e8f0;border-top:none;border-radius:0 0 12px 12px;padding:16px 28px;">
          <p style="margin:0;font-size:12px;color:#94a3b8;">Sent automatically by the Monkey Cleaning scheduling system.</p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;
}

function slotRowHtml(slot) {
  return `
    <tr>
      <td style="padding:10px 0;border-bottom:1px solid #f1f5f9;">
        <span style="font-size:14px;font-weight:700;color:#0d1b3e;">${slot.dateLabel}, ${slot.timeLabel}</span>
        ${slot.address ? `<span style="display:block;font-size:12px;color:#64748b;margin-top:2px;">${escapeHtml(slot.address)}</span>` : ""}
      </td>
    </tr>`;
}

function driftRowHtml(row) {
  const previo = DateTime.fromISO(row.starts_at_previo, { zone: TZ }).toFormat(
    "cccc, LLLL d 'at' h:mm a",
  );
  const nuevo = DateTime.fromISO(row.starts_at_nuevo, { zone: TZ }).toFormat(
    "cccc, LLLL d 'at' h:mm a",
  );
  const detected = DateTime.fromISO(row.detected_at, { zone: TZ }).toFormat(
    "LLLL d, h:mm a",
  );
  return `
    <tr>
      <td style="padding:14px 0;border-bottom:1px solid #f1f5f9;">
        <p style="margin:0 0 4px;font-size:14px;font-weight:700;color:#0d1b3e;">
          ${escapeHtml(row.clientName || "Unknown client")}${
    row.slotStatus
      ? ` <span style="font-weight:400;color:#94a3b8;">(slot ${escapeHtml(row.slotStatus)})</span>`
      : ""
  }
        </p>
        <p style="margin:0;font-size:13px;color:#334155;">Client confirmed for: ${previo}</p>
        <p style="margin:2px 0 0;font-size:13px;color:#e11d48;font-weight:600;">Real time now: ${nuevo}</p>
        <p style="margin:6px 0 0;font-size:11px;color:#94a3b8;">
          detected ${detected} · confirmation_slot_id ${escapeHtml(row.confirmation_slot_id)}
        </p>
      </td>
    </tr>`;
}

/**
 * Alerta a operaciones: confirmation_slot_drift_log tiene filas sin revisar.
 * El trigger trg_sync_confirmation_slot_starts_at loguea ahí cualquier slot
 * 'confirmed' cuyo horario se movió en GCal DESPUÉS de que el cliente ya
 * confirmó — a propósito no lo autocorrige (el cliente ya vio el valor
 * viejo, corregirlo en silencio esconde el problema en vez de resolverlo,
 * ver análisis 2026-08-16_confirmation-slot-drift, sección 7.1.1). Esta
 * alerta es lo que avisa que apareció una fila nueva para que alguien la
 * revise y, si hace falta, contacte al cliente — sin este job la tabla se
 * llena pero nadie se entera (exactamente lo que pasó con el caso cba40caf,
 * detectado por un script manual, no porque el sistema avisara).
 *
 * No hace queries — recibe las filas ya enriquecidas por el caller
 * (jobs/confirmationSlotDriftAlertJob.js), mismo patrón que
 * sendOpsReleaseAlert. Reusa el mismo setting `ops_alert_email` — mismo
 * destinatario que las alertas de liberación automática.
 *
 * @param {{ rows: Array<{ confirmation_slot_id: string, appointment_id: string, starts_at_previo: string, starts_at_nuevo: string, detected_at: string, slotStatus?: string, clientName?: string }> }} params
 */
export async function sendDriftLogAlert({ rows }) {
  if (!rows?.length) return;

  const settings = await getRawSettings();
  const opsEmail = (settings.ops_alert_email || "").trim();
  if (!opsEmail) {
    console.warn(
      `[OpsNotif] ops_alert_email no está configurado en settings — se salta la alerta de drift (${rows.length} fila(s) sin revisar).`,
    );
    return;
  }

  const transporter = getTransporter();
  if (!transporter) return;

  const plural = rows.length > 1;
  const bodyHtml = `
    <p style="margin:0 0 4px;font-size:11px;font-weight:700;color:#e11d48;letter-spacing:1px;text-transform:uppercase;">Needs manual review</p>
    <h1 style="margin:0 0 4px;font-size:20px;color:#0d1b3e;">${rows.length} confirmed slot${plural ? "s" : ""} moved after the client confirmed</h1>
    <p style="margin:0 0 16px;font-size:14px;color:#64748b;">
      These clients confirmed a time that later changed in the calendar. The system did not auto-correct it or notify them — please check each one and reach out if needed. Mark it reviewed in confirmation_slot_drift_log once handled (this alert keeps repeating daily until you do).
    </p>
    <table width="100%" cellpadding="0" cellspacing="0">${rows.map(driftRowHtml).join("")}</table>
  `;

  await sendWithRetry(
    transporter,
    {
      from: `"Monkey Cleaning" <${process.env.GMAIL_USER}>`,
      to: opsEmail,
      subject: `Action needed: ${rows.length} confirmed slot${plural ? "s" : ""} drifted after confirmation`,
      html: emailWrapper(bodyHtml),
    },
    "ConfirmationSlotDriftAlert",
  );
}

/**
 * Alerta a operaciones: un grupo de confirmation_slots se liberó porque el
 * cliente no respondió a tiempo (confirmation_release_hours_before venció).
 * No hace queries — recibe todo ya armado por el caller
 * (jobs/confirmationReleaseJob.js), mismo patrón que el resto de los
 * servicios de email del proyecto.
 *
 * Si el setting `ops_alert_email` está vacío, loguea y se salta — nunca
 * lanza (misma regla del proyecto: una notificación nunca puede romper el
 * flujo que la disparó).
 *
 * @param {{ client: { name?: string }, releasedSlots: Array<{ dateLabel: string, timeLabel: string, address?: string }> }} params
 */
export async function sendOpsReleaseAlert({ client, releasedSlots }) {
  if (!releasedSlots?.length) return;

  const settings = await getRawSettings();
  const opsEmail = (settings.ops_alert_email || "").trim();
  if (!opsEmail) {
    console.warn(
      "[OpsNotif] ops_alert_email no está configurado en settings — se salta la alerta de liberación automática. " +
        `(cliente: ${client?.name || "unknown"}, ${releasedSlots.length} slot(s) liberado(s))`,
    );
    return;
  }

  const transporter = getTransporter();
  if (!transporter) return;

  const clientName = client?.name?.trim() || "Unknown client";
  const plural = releasedSlots.length > 1;

  const bodyHtml = `
    <p style="margin:0 0 4px;font-size:11px;font-weight:700;color:#e11d48;letter-spacing:1px;text-transform:uppercase;">Auto-released — no client response</p>
    <h1 style="margin:0 0 4px;font-size:20px;color:#0d1b3e;">${escapeHtml(clientName)}</h1>
    <p style="margin:0 0 16px;font-size:14px;color:#64748b;">
      ${plural ? "These time slots were" : "This time slot was"} released automatically —
      the client didn't confirm within the deadline. Feel free to reassign ${plural ? "them" : "it"}.
    </p>
    <table width="100%" cellpadding="0" cellspacing="0">${releasedSlots.map(slotRowHtml).join("")}</table>
  `;

  await sendWithRetry(
    transporter,
    {
      from: `"Monkey Cleaning" <${process.env.GMAIL_USER}>`,
      to: opsEmail,
      subject: `Auto-released: ${clientName} — ${releasedSlots.length} slot${plural ? "s" : ""}`,
      html: emailWrapper(bodyHtml),
    },
    "OpsReleaseAlert",
  );
}

/**
 * Alerta al equipo cuando falla el encolado del email al cliente
 * (cotización residencial o inquiry comercial) tras guardar un lead.
 *
 * Origen: incidente 2026-08-19/25 — un merge rompió esta línea del
 * controller y el error quedó absorbido en silencio durante 6 días porque
 * nada avisaba. Este alert existe para que eso no vuelva a pasar
 * desapercibido, sin depender de que alguien mire los logs del servidor.
 *
 * Va a una lista fija de destinatarios (no al setting ops_alert_email) y,
 * como el resto de los servicios de email del proyecto, nunca lanza — un
 * fallo acá no debe romper el flujo de creación del lead.
 *
 * @param {{ lead: { fullName?: string, full_name?: string, email?: string, id?: string }, error: Error|string }} params
 */
export async function sendLeadEmailFailureAlert({ lead, error }) {
  const recipients = getLeadEmailFailureRecipients();
  if (!recipients.length) {
    console.warn(
      "[OpsNotif] LEAD_FAILURE_ALERT_EMAILS no está configurado en .env — se salta la alerta de fallo de email al lead.",
    );
    return;
  }

  const transporter = getTransporter();
  if (!transporter) return;

  const leadName = lead?.fullName || lead?.full_name || "Unknown lead";
  const leadEmail = lead?.email || "unknown";
  const leadId = lead?.id || lead?.dbId || "unknown";
  const errorMessage = error?.message || String(error);

  const bodyHtml = `
    <p style="margin:0 0 4px;font-size:11px;font-weight:700;color:#e11d48;letter-spacing:1px;text-transform:uppercase;">Needs manual review</p>
    <h1 style="margin:0 0 4px;font-size:20px;color:#0d1b3e;">Failed to enqueue customer email</h1>
    <p style="margin:0 0 16px;font-size:14px;color:#64748b;">
      The quote/inquiry email for this lead could not be queued. The lead was
      already saved to the database and synced to Zoho as usual — only the
      customer-facing email failed. Please review and, if needed, reach out
      to the client manually.
    </p>
    <table width="100%" cellpadding="0" cellspacing="0">
      <tr><td style="padding:6px 0;font-size:13px;color:#334155;"><b>Lead:</b> ${escapeHtml(leadName)} (${escapeHtml(leadEmail)})</td></tr>
      <tr><td style="padding:6px 0;font-size:13px;color:#334155;"><b>Lead ID:</b> ${escapeHtml(String(leadId))}</td></tr>
      <tr><td style="padding:6px 0;font-size:13px;color:#e11d48;"><b>Error:</b> ${escapeHtml(errorMessage)}</td></tr>
    </table>
  `;

  await sendWithRetry(
    transporter,
    {
      from: `"Monkey Cleaning" <${process.env.GMAIL_USER}>`,
      to: recipients.join(", "),
      subject: `⚠️ Lead email failed to send — ${escapeHtml(leadName)}`,
      html: emailWrapper(bodyHtml),
    },
    "LeadEmailFailureAlert",
  );
}