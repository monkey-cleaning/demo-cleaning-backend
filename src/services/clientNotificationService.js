// Ticket: "Confirmación automática de servicios pendientes (CONFIRMAR)"
//
// PRIMER servicio de emails dirigidos al CLIENTE (todo lo que existía en
// employeeNotificationService.js habla con limpiadores). Por eso es un
// archivo aparte en vez de extender ese — mismo estilo visual (logo, colores,
// tono de las cards), pero un archivo propio para no mezclar audiencias ni
// arriesgar el que ya funciona en producción.
//
// Reusa el mismo transporter Gmail/nodemailer y el mismo patrón de
// reintento que employeeNotificationService.js. El wrapper HTML es propio
// (no tenía acceso al emailWrapper() original para clonarlo 1:1) — mismo
// lenguaje visual (header #0d1b3e, acentos, cards con borde suave).
//
// Funciones:
//   sendConfirmationRequestEmail(client, slots) — el recordatorio a 2 días,
//     usado por jobs/confirmationReminderJob.js. `slots` es 1 fila (caso
//     sí/no) o 2 filas (caso "elegí entre A y B") ya formateadas por el
//     caller — este archivo no toca Supabase directamente, igual que
//     employeeNotificationService.js recibe `task` ya armado.

import nodemailer from "nodemailer";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LOGO_DESKTOP_PATH = path.resolve(__dirname, "../assets/logo-desktop.png");
const LOGO_MOBILE_PATH = path.resolve(__dirname, "../assets/logo-mobile.png");
const LOGO_DESKTOP_CID = "monkeycleaning-logo-desktop";
const LOGO_MOBILE_CID = "monkeycleaning-logo-mobile";

const hasDesktopLogo = fs.existsSync(LOGO_DESKTOP_PATH);
const hasMobileLogo = fs.existsSync(LOGO_MOBILE_PATH);

function logoAttachments() {
  if (hasMobileLogo) {
    return [
      {
        filename: "logo_mobile.png",
        path: LOGO_MOBILE_PATH,
        cid: LOGO_MOBILE_CID,
      },
    ];
  }
  if (hasDesktopLogo) {
    return [
      {
        filename: "logo_desktop.png",
        path: LOGO_DESKTOP_PATH,
        cid: LOGO_DESKTOP_CID,
      },
    ];
  }
  return [];
}

function logoBlockHtml() {
  const iconCid = hasMobileLogo
    ? LOGO_MOBILE_CID
    : hasDesktopLogo
      ? LOGO_DESKTOP_CID
      : null;
  const iconHtml = iconCid
    ? `<img src="cid:${iconCid}" alt="" width="20" height="20" style="display:block;border:0;outline:none;">`
    : "";
  return `
    <table cellpadding="0" cellspacing="0" role="presentation">
      <tr>
        <td style="width:36px;height:36px;background:#ffffff;border-radius:50%;text-align:center;vertical-align:middle;">
          <table cellpadding="0" cellspacing="0" role="presentation" style="width:100%;height:36px;">
            <tr><td align="center" valign="middle">${iconHtml}</td></tr>
          </table>
        </td>
        <td style="padding-left:10px;vertical-align:middle;">
          <span style="color:#fff;font-size:18px;font-weight:700;letter-spacing:-0.3px;">Monkey Cleaning</span>
        </td>
      </tr>
    </table>
  `;
}

function emailWrapper(bodyHtml) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
</head>
<body style="margin:0;padding:0;background:#f4f6f9;font-family:'Helvetica Neue',Helvetica,Arial,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#f4f6f9;padding:32px 16px;">
    <tr><td align="center">
      <table width="560" cellpadding="0" cellspacing="0" style="max-width:560px;width:100%;">
        <tr>
          <td style="background:#0d1b3e;border-radius:12px 12px 0 0;padding:20px 28px;">
            ${logoBlockHtml()}
          </td>
        </tr>
        <tr>
          <td style="background:#fff;border-left:1px solid #e2e8f0;border-right:1px solid #e2e8f0;padding:24px 28px;">
            ${bodyHtml}
          </td>
        </tr>
        <tr>
          <td style="background:#f8fafc;border:1px solid #e2e8f0;border-top:none;border-radius:0 0 12px 12px;padding:16px 28px;">
            <p style="margin:0;font-size:12px;color:#94a3b8;">Sent automatically by the Monkey Cleaning scheduling system.</p>
          </td>
        </tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;
}

function getTransporter() {
  if (!process.env.GMAIL_USER || !process.env.GMAIL_PASS) {
    console.error(
      "[ClientNotif] Missing GMAIL_USER or GMAIL_PASS in .env, skipping notification",
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
    return true;
  } catch (err) {
    console.warn(
      `⚠️ [${label}] first attempt failed: ${err.message}. Retrying in 2s...`,
    );
    await new Promise((r) => setTimeout(r, 2000));
    try {
      await transporter.sendMail(mailOptions);
      console.log(`✅ [${label}] sent on retry to ${mailOptions.to}`);
      return true
    } catch (retryErr) {
      console.error(`❌ [${label}] retry also failed: ${retryErr.message}`);
      return false;
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

// ── Link de confirmación ─────────────────────────────────────────────────────
function confirmUrl(token) {
  const base = (process.env.PUBLIC_BACKEND_URL || "").replace(/\/$/, "");
  if (!base) {
    console.warn(
      "[ClientNotif] PUBLIC_BACKEND_URL no está seteada en .env — el link de confirmación va a quedar roto.",
    );
  }
  return `${base}/api/public/confirm/${token}`;
}

function slotCardHtml(slot, label) {
  return `
    <table width="100%" cellpadding="0" cellspacing="0" style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:8px;margin-bottom:12px;">
      <tr>
        <td style="padding:16px 20px;">
          ${label ? `<p style="margin:0 0 4px;font-size:11px;font-weight:700;color:#94a3b8;letter-spacing:1px;text-transform:uppercase;">${label}</p>` : ""}
          <p style="margin:0;font-size:16px;font-weight:700;color:#0d1b3e;">${slot.dateLabel}</p>
          <p style="margin:2px 0 0;font-size:14px;color:#334155;">${slot.timeLabel}</p>
          ${slot.address ? `<p style="margin:6px 0 0;font-size:13px;color:#64748b;">${escapeHtml(slot.address)}</p>` : ""}
          <a href="${confirmUrl(slot.token)}"
             style="display:inline-block;margin-top:14px;padding:10px 18px;background:#0b8043;color:#ffffff;font-size:14px;font-weight:600;text-decoration:none;border-radius:6px;">
            ${label ? `Confirm Option ${label.slice(-1)}` : "Confirm this time"}
          </a>
        </td>
      </tr>
    </table>`;
}

/**
 * Email de recordatorio 2 días antes, pidiéndole al cliente que confirme
 * uno de los horarios ofrecidos (o que confirme sí/no si es uno solo).
 * No hace queries — recibe todo ya armado por el caller
 * (jobs/confirmationReminderJob.js), igual que sendUrgentAssignmentEmail()
 * recibe `task` ya armado en employeeNotificationService.js.
 *
 * @param {{ name: string, email: string }} client
 * @param {Array<{ token: string, dateLabel: string, timeLabel: string, address?: string }>} slots
 *        1 elemento → caso "confirmá sí/no". 2 elementos → caso "elegí A o B".
 */
export async function sendConfirmationRequestEmail(client, slots) {
  if (process.env.DISABLE_CLIENT_CONFIRMATION_EMAILS === "true") {
    console.warn(
      `[ClientNotif] sendConfirmationRequestEmail SKIPPED (DISABLE_CLIENT_CONFIRMATION_EMAILS=true) — client=${client?.id ?? "?"}`,
    );
    return false;
  }
  if (!client?.email) {
    console.warn(
      `[ClientNotif] sendConfirmationRequestEmail: cliente sin email (id=${client?.id ?? "?"}), se salta.`,
    );
    return false;
  }
  if (!slots?.length) return false;

  const transporter = getTransporter();
  if (!transporter) return false;

  const isChoice = slots.length >= 2;
  const intro = isChoice
    ? "We've got two possible times for your next cleaning — pick whichever works best for you:"
    : "We'd like to confirm your next cleaning:";

  const cardsHtml = isChoice
    ? slots
        .map((s, i) => slotCardHtml(s, `Option ${String.fromCharCode(65 + i)}`))
        .join("")
    : slotCardHtml(slots[0], null);

  const bodyHtml = `
    <p style="margin:0 0 4px;font-size:11px;font-weight:700;color:#0b8043;letter-spacing:1px;text-transform:uppercase;">Confirm your appointment</p>
    <h1 style="margin:0 0 4px;font-size:22px;color:#0d1b3e;">Hi ${escapeHtml(client.name || "")} 👋</h1>
    <p style="margin:0 0 20px;font-size:14px;color:#64748b;">${intro}</p>
    ${cardsHtml}
    <p style="margin:16px 0 0;font-size:12px;color:#94a3b8;">If we don't hear from you, this time slot will be released automatically 24 hours before the service.</p>
  `;

  return await sendWithRetry(
    transporter,
    {
      from: `"Monkey Cleaning" <${process.env.GMAIL_USER}>`,
      to: client.email,
      subject: isChoice
        ? "Please confirm your cleaning time"
        : "Please confirm your upcoming cleaning",
      html: emailWrapper(bodyHtml),
      attachments: logoAttachments(),
    },
    "ConfirmationRequest",
  );
}
