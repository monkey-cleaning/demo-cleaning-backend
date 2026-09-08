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

// ─────────────────────────────────────────────────────────────────────────────
// Encuesta de satisfacción post-servicio (portado de Monkey Cleaning LAB413).
//
// Tres emails al cliente:
//   1. sendSurveyRequestEmail        — "puntuá tu limpieza 1–5" (lo manda el job)
//   2. sendSurveyReviewThankYouEmail — puntuó 5 → pedir review público en Google
//   3. sendSurveyFeedbackThankYouEmail — puntuó 1–4 → preguntar qué mejorar
//
// SEGURIDAD: todo acá está detrás de SURVEY_EMAILS_ENABLED (default off) — el
// interruptor pedido. Sin "true" no se envía nada. SURVEY_TEST_EMAIL redirige
// todos los mails de encuesta a esa casilla para revisar los copys sin tocar
// clientes reales.
// ─────────────────────────────────────────────────────────────────────────────

const SURVEY_BRAND = process.env.BRAND_NAME || "Demo Cleaning Co.";

function surveyEmailsEnabled(label) {
  if (process.env.SURVEY_EMAILS_ENABLED === "true") return true;
  console.warn(
    `[ClientNotif] ${label} SKIPPED — SURVEY_EMAILS_ENABLED is not "true". No survey email sent.`,
  );
  return false;
}

function surveyRecipient(clientEmail) {
  const testTo = (process.env.SURVEY_TEST_EMAIL || "").trim();
  return testTo || clientEmail;
}

function surveyLink(token, suffix) {
  const base = (process.env.PUBLIC_BACKEND_URL || "").replace(/\/$/, "");
  if (!base) {
    console.warn(
      "[ClientNotif] PUBLIC_BACKEND_URL no está seteada en .env — el link de la encuesta va a quedar roto.",
    );
  }
  return `${base}/api/public/survey/${token}${suffix}`;
}

function ratingButtonsHtml(token) {
  const cells = [1, 2, 3, 4, 5]
    .map(
      (n) => `
        <td style="padding:0 4px;">
          <a href="${surveyLink(token, `/${n}`)}"
             style="display:block;width:44px;line-height:44px;text-align:center;background:#f1f5f9;border:1px solid #cbd5e1;border-radius:8px;color:#0d1b3e;font-size:17px;font-weight:700;text-decoration:none;">
            ${n}
          </a>
        </td>`,
    )
    .join("");
  return `
    <table cellpadding="0" cellspacing="0" role="presentation" style="margin:8px 0 4px;">
      <tr>${cells}</tr>
    </table>
    <p style="margin:4px 0 0;font-size:12px;color:#94a3b8;">1 = not happy · 5 = loved it</p>`;
}

/**
 * @param {{ name?: string, email: string }} client
 * @param {string} token  clients.survey_token
 * @returns {Promise<boolean>} true solo si el email se entregó de verdad
 */
export async function sendSurveyRequestEmail(client, token) {
  if (!surveyEmailsEnabled("sendSurveyRequestEmail")) return false;
  if (!client?.email) {
    console.warn(
      "[ClientNotif] sendSurveyRequestEmail: cliente sin email, se salta.",
    );
    return false;
  }
  const transporter = getTransporter();
  if (!transporter) return false;

  const bodyHtml = `
    <p style="margin:0 0 4px;font-size:11px;font-weight:700;color:#0b8043;letter-spacing:1px;text-transform:uppercase;">Your feedback</p>
    <h1 style="margin:0 0 4px;font-size:22px;color:#0d1b3e;">How did we do, ${escapeHtml(client.name || "there")}? ✨</h1>
    <p style="margin:0 0 12px;font-size:14px;color:#64748b;">
      Thanks for choosing ${escapeHtml(SURVEY_BRAND)}. On a scale of 1 to 5, how would you rate your recent cleaning? Just tap a number:
    </p>
    ${ratingButtonsHtml(token)}
    <p style="margin:18px 0 0;font-size:12px;color:#94a3b8;">It takes one tap and helps us keep improving.</p>
  `;

  return await sendWithRetry(
    transporter,
    {
      from: `"${SURVEY_BRAND}" <${process.env.GMAIL_USER}>`,
      to: surveyRecipient(client.email),
      subject: "How did we do? ✨",
      html: emailWrapper(bodyHtml),
      attachments: logoAttachments(),
    },
    "SurveyRequest",
  );
}

/**
 * Puntuó 5 → agradecer y pedir un review público en Google. Fire-and-forget
 * desde el endpoint público de rating.
 * @param {{ name?: string, email: string }} client
 * @param {string} reviewUrl  link de Google Reviews (settingsService.getGoogleReviewUrl)
 */
export async function sendSurveyReviewThankYouEmail(client, reviewUrl) {
  if (!surveyEmailsEnabled("sendSurveyReviewThankYouEmail")) return false;
  if (!client?.email) return false;
  if (!reviewUrl) {
    console.warn(
      "[ClientNotif] sendSurveyReviewThankYouEmail: sin google_review_url configurado — se salta.",
    );
    return false;
  }
  const transporter = getTransporter();
  if (!transporter) return false;

  const bodyHtml = `
    <p style="margin:0 0 4px;font-size:11px;font-weight:700;color:#0b8043;letter-spacing:1px;text-transform:uppercase;">Thank you</p>
    <h1 style="margin:0 0 4px;font-size:22px;color:#0d1b3e;">You made our day, ${escapeHtml(client.name || "there")}! 🎉</h1>
    <p style="margin:0 0 16px;font-size:14px;color:#64748b;">
      We're so glad you loved your cleaning. If you have a moment, a quick Google review means the world to a small local team like ours:
    </p>
    <table cellpadding="0" cellspacing="0" role="presentation">
      <tr><td style="background:#0b8043;border-radius:8px;">
        <a href="${escapeHtml(reviewUrl)}"
           style="display:inline-block;padding:12px 22px;color:#ffffff;font-size:14px;font-weight:700;text-decoration:none;">
          Leave a Google review
        </a>
      </td></tr>
    </table>
    <p style="margin:18px 0 0;font-size:12px;color:#94a3b8;">Thank you for supporting ${escapeHtml(SURVEY_BRAND)} 💚</p>
  `;

  return await sendWithRetry(
    transporter,
    {
      from: `"${SURVEY_BRAND}" <${process.env.GMAIL_USER}>`,
      to: surveyRecipient(client.email),
      subject: "Thank you! Would you share it on Google?",
      html: emailWrapper(bodyHtml),
      attachments: logoAttachments(),
    },
    "SurveyReviewThankYou",
  );
}

/**
 * Puntuó 1–4 → agradecer y pedir detalle de qué mejorar. Linkea al mismo form
 * de feedback que muestra la landing. SIN link de Google Reviews.
 * @param {{ name?: string, email: string }} client
 * @param {string} token  clients.survey_token
 */
export async function sendSurveyFeedbackThankYouEmail(client, token) {
  if (!surveyEmailsEnabled("sendSurveyFeedbackThankYouEmail")) return false;
  if (!client?.email) return false;
  const transporter = getTransporter();
  if (!transporter) return false;

  const bodyHtml = `
    <p style="margin:0 0 4px;font-size:11px;font-weight:700;color:#0b8043;letter-spacing:1px;text-transform:uppercase;">Thank you</p>
    <h1 style="margin:0 0 4px;font-size:22px;color:#0d1b3e;">Thanks for the honest feedback, ${escapeHtml(client.name || "there")}</h1>
    <p style="margin:0 0 16px;font-size:14px;color:#64748b;">
      We'd really like to get it right for you. Could you tell us a bit more about what we could have done better?
    </p>
    <table cellpadding="0" cellspacing="0" role="presentation">
      <tr><td style="background:#0d1b3e;border-radius:8px;">
        <a href="${surveyLink(token, "/feedback")}"
           style="display:inline-block;padding:12px 22px;color:#ffffff;font-size:14px;font-weight:700;text-decoration:none;">
          Tell us what to improve
        </a>
      </td></tr>
    </table>
    <p style="margin:18px 0 0;font-size:12px;color:#94a3b8;">You can also just reply to this email — a real person reads it.</p>
  `;

  return await sendWithRetry(
    transporter,
    {
      from: `"${SURVEY_BRAND}" <${process.env.GMAIL_USER}>`,
      to: surveyRecipient(client.email),
      subject: "Thank you — how can we do better?",
      html: emailWrapper(bodyHtml),
      attachments: logoAttachments(),
    },
    "SurveyFeedbackThankYou",
  );
}
