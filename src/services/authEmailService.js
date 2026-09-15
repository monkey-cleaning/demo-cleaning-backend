// services/authEmailService.js
// Portado de Monkey Cleaning (LAB429) — "Forgot your password?" — el único
// mail de este servicio. Audiencia propia (quien está tratando de entrar a
// la plataforma, admin o cleaner), distinta de clientNotificationService
// (clientes), employeeNotificationService (cleaners sobre sus trabajos) y
// opsNotificationService (equipo interno) — mismo criterio de separación por
// audiencia que ya usa el resto del proyecto, así que archivo propio en vez
// de sumar esto a alguno de esos.
//
// Mismo transporter Gmail/nodemailer y mismo patrón de reintento que los
// otros servicios de email — cada uno con su propia copia, es la convención
// ya establecida acá (ver opsNotificationService.js).
import nodemailer from "nodemailer";

const BRAND_NAME = process.env.BRAND_NAME || "Demo Cleaning Co.";

function getTransporter() {
  if (!process.env.GMAIL_USER || !process.env.GMAIL_PASS) {
    console.error(
      "[AuthEmail] Missing GMAIL_USER or GMAIL_PASS in .env, skipping notification",
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

function emailWrapper(bodyHtml) {
  return `<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f4f6f9;font-family:'Helvetica Neue',Helvetica,Arial,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#f4f6f9;padding:32px 16px;">
    <tr><td align="center">
      <table width="560" cellpadding="0" cellspacing="0" style="max-width:560px;width:100%;">
        <tr><td style="background:#0d1b3e;border-radius:12px 12px 0 0;padding:20px 28px;">
          <span style="color:#fff;font-size:18px;font-weight:700;">${escapeHtml(BRAND_NAME)}</span>
        </td></tr>
        <tr><td style="background:#fff;border-left:1px solid #e2e8f0;border-right:1px solid #e2e8f0;padding:24px 28px;">
          ${bodyHtml}
        </td></tr>
        <tr><td style="background:#f8fafc;border:1px solid #e2e8f0;border-top:none;border-radius:0 0 12px 12px;padding:16px 28px;">
          <p style="margin:0;font-size:12px;color:#94a3b8;">If you didn't request this, you can ignore this email — your password won't change.</p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * @param {{ to: string, resetUrl: string, username?: string }} params
 *   `username` se muestra en el cuerpo cuando el email es compartido (p. ej.
 *   un buzón de recuperación común) para que quien lo reciba sepa de qué
 *   cuenta es.
 */
export async function sendPasswordResetEmail({ to, resetUrl, username }) {
  try {
    if (!to) return;

    const transporter = getTransporter();
    if (!transporter) return;

    const accountLine = username
      ? `<p style="margin:0 0 8px;font-size:14px;color:#0d1b3e;">Account: <b>${escapeHtml(username)}</b></p>`
      : "";

    const bodyHtml = `
    <h1 style="margin:0 0 4px;font-size:20px;color:#0d1b3e;">Reset your password</h1>
    ${accountLine}
    <p style="margin:0 0 20px;font-size:14px;color:#64748b;">
      Someone asked to reset the password for your ${escapeHtml(BRAND_NAME)} account. This link works once and expires in 1 hour.
    </p>
    <table cellpadding="0" cellspacing="0" role="presentation">
      <tr><td style="border-radius:8px;background:#0d1b3e;">
        <a href="${resetUrl}" style="display:inline-block;padding:12px 24px;font-size:14px;font-weight:600;color:#fff;text-decoration:none;">Set a new password</a>
      </td></tr>
    </table>
    <p style="margin:20px 0 0;font-size:12px;color:#94a3b8;word-break:break-all;">
      Or paste this link in your browser: ${resetUrl}
    </p>
  `;

    await sendWithRetry(
      transporter,
      {
        from: `"${BRAND_NAME}" <${process.env.GMAIL_USER}>`,
        to,
        subject: `Reset your ${BRAND_NAME} password`,
        html: emailWrapper(bodyHtml),
      },
      "PasswordResetEmail",
    );
  } catch (err) {
    console.error("❌ [PasswordResetEmail] failed:", err.message);
  }
}
