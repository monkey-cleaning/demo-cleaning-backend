// services/employeeNotificationService.js
//
// Cleaner-facing email notifications for the LAB "silent GCal invites" task.
// Google's own invite/update/cancel emails are silenced everywhere in
// calendarController.js (sendUpdates: "none") — cleaners now hear about
// their schedule through exactly three channels:
//
//   1. sendDailyDigestEmail()       — one consolidated route sheet per
//                                     cleaner, sent by jobs/dailyDigestJob.js
//                                     at 6 AM Vancouver time (DIGEST_CUTOFF_HOUR).
//   2. sendUrgentAssignmentEmail()  — instant heads-up, used when a same-day
//                                     assignment/reschedule happens AFTER the
//                                     digest already went out (see
//                                     notifyCleanersOfChange in
//                                     calendarController.js).
//   3. sendCancellationEmail()      — instant heads-up when a same-day job is
//                                     cancelled/deleted AFTER the digest
//                                     already went out (see
//                                     notifyCancellationIfNeeded in
//                                     calendarController.js).
//
// Reuses the same nodemailer/Gmail transport as
// services/leadNotificationService.js (GMAIL_USER / GMAIL_PASS env vars).

import nodemailer from "nodemailer";
import { DateTime } from "luxon";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import sanitizeHtml from "sanitize-html";

const TZ = process.env.BOOKING_TIMEZONE || "America/Vancouver";

// Hour (Vancouver-local, 24h) the daily digest cron fires. Exported so
// jobs/dailyDigestJob.js (schedule) and controllers/calendarController.js
// (same-day urgent-alert cutoff check) share one source of truth and can't
// drift out of sync.
export const DIGEST_CUTOFF_HOUR = 6;

// ── Notification exclusion list ──────────────────────────────────────────────
// Emails that should NEVER get a cleaner-facing email (digest, urgent, or
// cancellation), even if they're a legit `employees` row or a GCal attendee
// — e.g. shared inboxes like contact@monkeycleaning.com that sometimes end
// up as an attendee but aren't a person waiting on a route sheet.
//
// Separate on purpose from EXCLUDED_ATTENDEE_EMAILS in calendarController.js
// — that list decides who counts as a "cleaner" for team-sync purposes, this
// one only decides who gets emailed. Comma-separated, case-insensitive.
const NOTIFICATION_EXCLUDED_EMAILS = new Set(
  (process.env.NOTIFICATION_EXCLUDED_EMAILS || "")
    .split(",")
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean),
);

export function isNotificationExcluded(email) {
  return NOTIFICATION_EXCLUDED_EMAILS.has(String(email ?? "").toLowerCase());
}

// ── Logo (replaces the old 🐒 emoji header) ──────────────────────────────────
// Sent as a nodemailer `cid:` attachment rather than a public URL — that's
// the pattern that renders reliably across Gmail / Apple Mail / Outlook
// without needing a hosted asset. logo_mobile.png is OPTIONAL: if it exists
// we show/hide desktop vs. mobile via a media query; if it doesn't, the
// desktop logo is used everywhere.
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LOGO_DESKTOP_PATH = path.resolve(__dirname, "../assets/logo-desktop.png");
const LOGO_MOBILE_PATH = path.resolve(__dirname, "../assets/logo-mobile.png");
const LOGO_DESKTOP_CID = "monkeycleaning-logo-desktop";
const LOGO_MOBILE_CID = "monkeycleaning-logo-mobile";

const hasDesktopLogo = fs.existsSync(LOGO_DESKTOP_PATH);
const hasMobileLogo = fs.existsSync(LOGO_MOBILE_PATH);

if (!hasDesktopLogo) {
  console.warn(
    `[EmployeeNotif] logo_desktop.png not found at ${LOGO_DESKTOP_PATH} — falling back to text wordmark in emails`,
  );
}

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
  // Isotipo (logo_mobile.png, el ícono solo) puesto sobre un círculo blanco, más
  // el nombre escrito en texto blanco al lado. Mismo layout en desktop y
  // mobile.
  const iconCid = hasMobileLogo
    ? LOGO_MOBILE_CID
    : hasDesktopLogo
      ? LOGO_DESKTOP_CID
      : null;

  const iconHtml = iconCid
    ? `<img src="cid:${iconCid}" alt="" width="20" height="20" style="display:block;border:0;outline:none;">`
    : ""; // sin logo en disco → solo el texto, sin emoji

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

function getTransporter() {
  if (!process.env.GMAIL_USER || !process.env.GMAIL_PASS) {
    console.error(
      "[EmployeeNotif] Missing GMAIL_USER or GMAIL_PASS in .env, skipping notification",
    );
    return null;
  }
  return nodemailer.createTransport({
    service: "gmail",
    auth: {
      user: process.env.GMAIL_USER,
      pass: process.env.GMAIL_PASS,
    },
  });
}

// Same one-retry-after-2s pattern as sendBookingWebNotification in
// leadNotificationService.js — never throws, a notification failure must
// never break the calendar write that triggered it.
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

// ── Notes HTML sanitization ────────────────────────────────────────────────
// Notes are written by admins through a rich-text field (bold, lists, line
// breaks) and land in GCal's `description` as real HTML. We render that
// formatting instead of dumping raw/escaped tags, but only ever through an
// allowlist — nothing from this field is trusted (admin accounts can be
// phished/compromised, and this same field carries internal machine tags).
const NOTES_SANITIZE_OPTIONS = {
  allowedTags: ["strong", "b", "em", "i", "u", "br", "p", "ul", "ol", "li", "span"],
  allowedAttributes: {}, // no attributes at all — kills style=, onclick=, href=, etc.
  disallowedTagsMode: "discard", // drop unknown tags but keep their text content
};

function notesHtml(notes) {
  if (!notes) return "";
  const clean = sanitizeHtml(notes, NOTES_SANITIZE_OPTIONS).trim();
  if (!clean) return "";
  return `
    <details style="margin-top:8px;">
      <summary style="cursor:pointer;font-size:12px;font-weight:600;color:#2563eb;">Notes</summary>
      <div style="margin:6px 0 0;padding:8px 10px;background:#f8fafc;border-radius:6px;font-size:12px;line-height:1.5;color:#475569;">${clean}</div>
    </details>`;
}

// ── Notes sanitization ────────────────────────────────────────────────────────
// GCal's `description` field doubles as BOTH freeform notes AND internal
// machine tags (client_id:<uuid>, team_id:team_N — see calendarController.js
// resolveClientId / parseTeamIdFromDescription). Cleaners must never see the
// raw tags, only the human-written part.
const INTERNAL_TAG_RE = /\b(?:client_id|team_id):\s*\S+/gi;

export function sanitizeNotes(description) {
  if (!description) return null;
  const cleaned = description
    .replace(INTERNAL_TAG_RE, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{2,}/g, "\n")
    .trim();
  return cleaned || null;
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

function taskRowHtml(task) {
  const timeLabel = task.endTime
    ? `${task.startTime} – ${task.endTime}`
    : task.startTime;
  return `
    <tr>
      <td style="padding:12px 0;border-bottom:1px solid #f1f5f9;width:30%;vertical-align:top;">
        <span style="font-size:14px;font-weight:700;color:#0d1b3e;">${timeLabel}</span>
      </td>
      <td style="padding:12px 0;border-bottom:1px solid #f1f5f9;vertical-align:top;">
        <span style="font-size:14px;font-weight:600;color:#0d1b3e;">${task.clientName || "Client"}</span>
        ${task.serviceType ? `<span style="display:block;font-size:12px;color:#64748b;margin-top:2px;">${task.serviceType}</span>` : ""}
        ${task.address ? `<span style="display:block;font-size:12px;color:#64748b;margin-top:2px;">${task.address}</span>` : ""}
        ${notesHtml(task.notes)}
      </td>
    </tr>`;
}

/**
 * Sends ONE consolidated "route sheet" email to a cleaner for all of today's
 * tasks. No-ops (silently) if the cleaner has zero tasks — the caller
 * (jobs/dailyDigestJob.js) should already skip empty lists, this is a
 * defensive second check.
 *
 * @param {{ id: string, name: string, email: string }} employee
 * @param {Array<{ startTime: string, endTime?: string, clientName: string, address?: string, serviceType?: string, notes?: string }>} tasks
 */
export async function sendDailyDigestEmail(employee, tasks) {
  if (!employee?.email || !tasks?.length) return;

  if (isNotificationExcluded(employee.email)) {
    console.log(
      `[DailyDigest] Skipped — ${employee.email} is on NOTIFICATION_EXCLUDED_EMAILS`,
    );
    return;
  }

  const transporter = getTransporter();
  if (!transporter) return;

  const dateLabel = DateTime.now().setZone(TZ).toFormat("cccc, LLLL d");
  const sorted = [...tasks].sort((a, b) =>
    (a.startTime || "").localeCompare(b.startTime || ""),
  );

  const bodyHtml = `
    <p style="margin:0 0 4px;font-size:11px;font-weight:700;color:#94a3b8;letter-spacing:1px;text-transform:uppercase;">Today's schedule</p>
    <h1 style="margin:0 0 4px;font-size:22px;color:#0d1b3e;">Hi ${employee.name || "there"} 👋</h1>
    <p style="margin:0 0 20px;font-size:14px;color:#64748b;">${dateLabel} — ${sorted.length} ${sorted.length === 1 ? "job" : "jobs"} today.</p>
    <table width="100%" cellpadding="0" cellspacing="0">${sorted.map(taskRowHtml).join("")}</table>
  `;

  await sendWithRetry(
    transporter,
    {
      from: `"Monkey Cleaning" <${process.env.GMAIL_USER}>`,
      to: employee.email,
      subject: `Your schedule for today — ${sorted.length} ${sorted.length === 1 ? "job" : "jobs"}`,
      html: emailWrapper(bodyHtml),
      attachments: logoAttachments(),
    },
    "DailyDigest",
  );
}

// Builds the eyebrow/intro copy for the urgent-assignment email depending on
// what actually changed. `task.changeType` is set by the caller
// (notifyCleanersOfChange in calendarController.js):
//   "rescheduled" — the time moved (task.previousTimeLabel must be set)
//   "reassigned"  — the cleaner was added/removed from an unchanged time slot
//   "updated"     — anything else (fallback, keeps old generic copy)
function buildChangeCopy(task) {
  const timeLabel = task.endTime
    ? `${task.startTime} – ${task.endTime}`
    : task.startTime;

  if (task.changeType === "rescheduled" && task.previousTimeLabel) {
    return {
      eyebrow: "Schedule update — today",
      intro: `Your <strong>${task.previousTimeLabel}</strong> job moved to <strong>${timeLabel}</strong>.`,
    };
  }
  if (task.changeType === "reassigned") {
    return {
      eyebrow: "Schedule update — today",
      intro: `You've been added to today's <strong>${timeLabel}</strong> job.`,
    };
  }
  return {
    eyebrow: "Schedule update — today",
    intro:
      "Your schedule for today just changed after your morning digest went out.",
  };
}

/**
 * Instant alert for the DoD #3 exception: a same-day assignment/reschedule
 * that lands AFTER the digest already went out. Only ever called from
 * notifyCleanersOfChange() in calendarController.js, which already gates on
 * "is this today AND is it past DIGEST_CUTOFF_HOUR".
 *
 * @param {{ id: string, name: string, email: string }} employee
 * @param {{ startTime: string, endTime?: string, summary: string, address?: string, notes?: string, changeType?: "rescheduled"|"reassigned"|"updated", previousTimeLabel?: string }} task
 */
export async function sendUrgentAssignmentEmail(employee, task) {
  if (!employee?.email) return;

  if (isNotificationExcluded(employee.email)) {
    console.log(
      `[UrgentAssignment] Skipped — ${employee.email} is on NOTIFICATION_EXCLUDED_EMAILS`,
    );
    return;
  }

  const transporter = getTransporter();
  if (!transporter) return;

  const timeLabel = task.endTime
    ? `${task.startTime} – ${task.endTime}`
    : task.startTime;
  const { eyebrow, intro } = buildChangeCopy(task);

  const bodyHtml = `
    <p style="margin:0 0 4px;font-size:11px;font-weight:700;color:#e11d48;letter-spacing:1px;text-transform:uppercase;">${eyebrow}</p>
    <h1 style="margin:0 0 4px;font-size:22px;color:#0d1b3e;">Hi ${employee.name || "there"} 👋</h1>
    <p style="margin:0 0 20px;font-size:14px;color:#64748b;">${intro}</p>
    <table width="100%" cellpadding="0" cellspacing="0" style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:8px;">
      <tr>
        <td style="padding:16px 20px;">
          <p style="margin:0 0 2px;font-size:12px;color:#94a3b8;font-weight:500;">${timeLabel}</p>
          <p style="margin:0;font-size:16px;font-weight:700;color:#0d1b3e;">${task.summary || "Cleaning service"}</p>
          ${task.address ? `<p style="margin:4px 0 0;font-size:14px;color:#334155;">${task.address}</p>` : ""}
          ${notesHtml(task.notes)}
        </td>
      </tr>
    </table>
  `;

  await sendWithRetry(
    transporter,
    {
      from: `"Monkey Cleaning" <${process.env.GMAIL_USER}>`,
      to: employee.email,
      subject: `Schedule update for today — ${timeLabel}`,
      html: emailWrapper(bodyHtml),
      attachments: logoAttachments(),
    },
    "UrgentAssignment",
  );
}

/**
 * Instant alert when a same-day job is cancelled/deleted AFTER the digest
 * already went out. Only ever called from notifyCancellationIfNeeded() in
 * calendarController.js, which gates on "is this today AND is it past
 * DIGEST_CUTOFF_HOUR" the same way the urgent-assignment path does.
 *
 * @param {{ id: string, name: string, email: string }} employee
 * @param {{ startTime: string, endTime?: string, summary: string, address?: string }} task
 */
export async function sendCancellationEmail(employee, task) {
  if (!employee?.email) return;

  if (isNotificationExcluded(employee.email)) {
    console.log(
      `[Cancellation] Skipped — ${employee.email} is on NOTIFICATION_EXCLUDED_EMAILS`,
    );
    return;
  }

  const transporter = getTransporter();
  if (!transporter) return;

  const timeLabel = task.endTime
    ? `${task.startTime} – ${task.endTime}`
    : task.startTime;

  const bodyHtml = `
    <p style="margin:0 0 4px;font-size:11px;font-weight:700;color:#e11d48;letter-spacing:1px;text-transform:uppercase;">Job cancelled — today</p>
    <h1 style="margin:0 0 4px;font-size:22px;color:#0d1b3e;">Hi ${employee.name || "there"} 👋</h1>
    <p style="margin:0 0 20px;font-size:14px;color:#64748b;">One of today's jobs was cancelled after your morning digest went out — you don't need to go anymore.</p>
    <table width="100%" cellpadding="0" cellspacing="0" style="background:#fef2f2;border:1px solid #fecdd3;border-radius:8px;">
      <tr>
        <td style="padding:16px 20px;">
          <p style="margin:0 0 2px;font-size:12px;color:#94a3b8;font-weight:500;text-decoration:line-through;">${timeLabel}</p>
          <p style="margin:0;font-size:16px;font-weight:700;color:#0d1b3e;text-decoration:line-through;">${task.summary || "Cleaning service"}</p>
          ${task.address ? `<p style="margin:4px 0 0;font-size:14px;color:#334155;">${task.address}</p>` : ""}
        </td>
      </tr>
    </table>
  `;

  await sendWithRetry(
    transporter,
    {
      from: `"Monkey Cleaning" <${process.env.GMAIL_USER}>`,
      to: employee.email,
      subject: `Job cancelled for today — ${timeLabel}`,
      html: emailWrapper(bodyHtml),
      attachments: logoAttachments(),
    },
    "Cancellation",
  );
}