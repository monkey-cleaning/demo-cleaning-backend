import nodemailer from "nodemailer";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const RECIPIENTS =
  process.env.LEAD_NOTIFICATION_RECIPIENTS ||
  [
    "contact@monkeycleaning.com",
    "Jhony.blanco.Higuera@gmail.com",
    "nico_204@hotmail.com",
  ].join(",");

/**
 * Sends an email notification whenever a lead is created/updated.
 * Includes: Lead data, Zoho result, Database (Supabase) result
 */
export async function sendLeadNotificationEmail(leadData, options = {}) {
  const {
    operation = "created",
    zohoResult = null,
    zohoError = null,
    dbLead = null,
    dbError = null,
    source = null,
  } = options;

  if (!process.env.GMAIL_USER || !process.env.GMAIL_PASS) {
    console.error(
      "Missing GMAIL_USER or GMAIL_PASS in .env, cannot send notification",
    );
    return;
  }

  const transporter = nodemailer.createTransport({
    service: "gmail",
    auth: {
      user: process.env.GMAIL_USER,
      pass: process.env.GMAIL_PASS,
    },
  });

  const subject = `🐵 [Monkey Cleaning] ${operation === "created" ? "New" : "Updated"} Lead - ${leadData.fullName || leadData.email || "No name"}`;
  const logoPath = path.join(__dirname, "../assets/logo-desktop.png");

  // Combinar datos del lead con datos de DB (que puede tener campos adicionales)
  const completeLeadData = { ...leadData, ...(dbLead || {}) };

  const html = `
    <!DOCTYPE html>
    <html>
    <head>
      <style>
        body {
          font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
          line-height: 1.6;
          color: #333;
          max-width: 800px;
          margin: 0 auto;
          padding: 20px;
          background-color: #f5f5f5;
        }
        .container {
          background: white;
          border-radius: 12px;
          box-shadow: 0 2px 8px rgba(0,0,0,0.1);
          overflow: hidden;
        }
        .header {
          background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
          color: white;
          padding: 30px;
          text-align: center;
        }
        .header img {
          max-width: 200px;
          height: auto;
          margin-bottom: 20px;
        }
        .header h1 {
          margin: 10px 0;
          font-size: 28px;
        }
        .metadata {
          background: #f8f9fa;
          padding: 15px 30px;
          border-bottom: 2px solid #e9ecef;
        }
        .metadata p {
          margin: 5px 0;
          font-size: 14px;
          color: #666;
        }
        .section {
          padding: 30px;
          border-bottom: 1px solid #e9ecef;
        }
        .section:last-child {
          border-bottom: none;
        }
        .section h2 {
          margin-top: 0;
          color: #667eea;
          font-size: 20px;
          display: flex;
          align-items: center;
          gap: 8px;
        }
        .data-table {
          width: 100%;
          border-collapse: collapse;
          margin-top: 15px;
        }
        .data-table tr {
          border-bottom: 1px solid #e9ecef;
        }
        .data-table tr:last-child {
          border-bottom: none;
        }
        .data-table td {
          padding: 12px 8px;
          vertical-align: top;
        }
        .data-table td:first-child {
          font-weight: 600;
          color: #495057;
          width: 35%;
          white-space: nowrap;
        }
        .data-table td:last-child {
          color: #212529;
          word-break: break-word;
        }
        .empty-value {
          color: #adb5bd;
          font-style: italic;
        }
        .status-badge {
          display: inline-block;
          padding: 4px 12px;
          border-radius: 12px;
          font-size: 12px;
          font-weight: 600;
          text-transform: uppercase;
        }
        .status-success {
          background: #d4edda;
          color: #155724;
        }
        .status-error {
          background: #f8d7da;
          color: #721c24;
        }
        .code-block {
          background: #f8f9fa;
          border: 1px solid #dee2e6;
          border-radius: 4px;
          padding: 12px;
          font-family: 'Courier New', monospace;
          font-size: 12px;
          overflow-x: auto;
          margin-top: 8px;
          color: #495057;
        }
        .footer {
          text-align: center;
          padding: 20px;
          background: #f8f9fa;
          color: #6c757d;
          font-size: 12px;
        }
        .message-box {
          background: #f8f9fa;
          border-left: 4px solid #667eea;
          padding: 15px;
          margin-top: 8px;
          border-radius: 4px;
        }
        .integration-status {
          display: flex;
          align-items: center;
          gap: 10px;
          margin-bottom: 15px;
        }
        .error-box {
          background: #fff5f5;
          border: 1px solid #feb2b2;
          border-radius: 4px;
          padding: 12px;
          margin-top: 10px;
          color: #c53030;
        }
        .header-title {
          color: #000000;
        }
      </style>
    </head>
    <body>
      <div class="container">
        <div class="header">
          <img src="cid:logo" alt="Monkey Cleaning Logo">
          <h1 class="header-title">${operation === "created" ? "🎉 New Lead" : "🔄 Lead Updated"}</h1>
        </div>

        <div class="metadata">
          <p><strong>📅 Date:</strong> ${new Date().toLocaleString("en-CA", { dateStyle: "full", timeStyle: "short", timeZone: "America/Vancouver" })}</p>
          ${source ? `<p><strong>📍 Source:</strong> ${source}</p>` : ""}
        </div>

        <div class="section">
          <h2>👤 Complete Lead Information</h2>
          <table class="data-table">
            ${generateCompleteLeadRows(completeLeadData)}
          </table>
        </div>

        <div class="section">
          <h2>🔗 Integration Status</h2>
          
          <div class="integration-status">
            <strong>Zoho CRM:</strong>
            <span class="status-badge ${zohoResult ? "status-success" : "status-error"}">
              ${zohoResult ? "✅ Success" : "❌ Failed"}
            </span>
            ${zohoResult ? `<span style="color: #666; font-size: 13px;">ID: ${zohoResult.id}</span>` : ""}
          </div>
          ${
            zohoError
              ? `
            <div class="error-box">
              <strong>⚠️ Zoho Error:</strong><br>
              ${zohoError.message || zohoError.toString()}
            </div>
          `
              : ""
          }

          <div class="integration-status" style="margin-top: 20px;">
            <strong>Database:</strong>
            <span class="status-badge ${dbLead ? "status-success" : "status-error"}">
              ${dbLead ? "✅ Success" : "❌ Failed"}
            </span>
            ${dbLead ? `<span style="color: #666; font-size: 13px;">ID: ${dbLead.id}</span>` : ""}
          </div>
          ${
            dbError
              ? `
            <div class="error-box">
              <strong>⚠️ Database Error:</strong><br>
              ${dbError.message || dbError.toString()}
            </div>
          `
              : ""
          }
        </div>

        <div class="footer">
          <p>This email was sent automatically by the Monkey Cleaning system</p>
          <p>© ${new Date().getFullYear()} Monkey Cleaning. All rights reserved.</p>
        </div>
      </div>
    </body>
    </html>
  `;

  try {
    await transporter.sendMail({
      from: `"🐵 Monkey Cleaning Leads" <${process.env.GMAIL_USER}>`,
      to: RECIPIENTS,
      subject,
      html,
      attachments: [
        {
          filename: "logo.png",
          path: logoPath,
          cid: "logo",
        },
      ],
    });
    console.log(`✅ Lead notification email sent successfully (${operation})`);
  } catch (error) {
    console.error("❌ Error sending lead notification email:", error);
    throw error;
  }
}

/**
 * Genera TODAS las filas del lead sin duplicados
 */
function generateCompleteLeadRows(leadData) {
  // Mapeo de campos equivalentes (snake_case -> camelCase)
  const fieldAliases = {
    service_option: "serviceOption",
    cleaning_frequency: "frequency",
    cleaning_date: "cleaningDate",
    service_type: "serviceType",
    property_size: "propertySize",
    full_bathrooms: "fullBathrooms",
    half_bathrooms: "halfBathrooms",
    inside_fridge: "insideFridge",
    inside_freezer: "insideFreezer",
    inside_oven: "insideOven",
    inside_windows: "insideWindows",
    deep_cleaned: "deepCleaned",
    close_to_hiring: "closeToHiring",
    additional_message: "additionalMessage",
    how_did_you_hear: "howDidYouHear",
    full_name: "fullName",
    zip_code: "zipCode",
    has_pets: "hasPets",
  };

  const fieldDefinitions = [
    // Información de contacto
    {
      label: "Full Name",
      keys: ["fullName", "full_name"],
      icon: "👤",
      group: "contact",
    },
    { label: "Email", keys: ["email"], icon: "📧", group: "contact" },
    { label: "Phone", keys: ["phone"], icon: "📱", group: "contact" },
    { label: "Address", keys: ["address"], icon: "🏠", group: "contact" },
    {
      label: "Zip Code",
      keys: ["zipCode", "zip_code"],
      icon: "📍",
      group: "contact",
    },

    // Información del servicio
    { label: "Service", keys: ["service"], icon: "🧹", group: "service" },
    {
      label: "Service Option",
      keys: ["serviceOption", "service_option"],
      icon: "🏠",
      group: "service",
    },
    {
      label: "Cleaning Frequency",
      keys: ["frequency", "cleaning_frequency"],
      icon: "📅",
      group: "service",
    },
    {
      label: "Cleaning Date",
      keys: ["cleaningDate", "cleaning_date"],
      icon: "📅",
      group: "service",
    },
    {
      label: "Preferred Days",
      keys: ["preferredDays", "preferred_days"],
      icon: "📆",
      group: "service",
    },
    {
      label: "Preferred Time",
      keys: ["preferredTime", "preferred_time"],
      icon: "🕐",
      group: "service",
    },
    {
      label: "Service Type",
      keys: ["serviceType", "service_type"],
      icon: "🔧",
      group: "service",
    },

    // Propiedad
    {
      label: "Property Size",
      keys: ["propertySize", "property_size"],
      icon: "📐",
      group: "property",
    },
    { label: "Bedrooms", keys: ["bedrooms"], icon: "🛏️", group: "property" },
    {
      label: "Full Bathrooms",
      keys: ["fullBathrooms", "full_bathrooms"],
      icon: "🚿",
      group: "property",
    },
    {
      label: "Half Bathrooms",
      keys: ["halfBathrooms", "half_bathrooms"],
      icon: "🚽",
      group: "property",
    },
    { label: "Bathrooms", keys: ["bathrooms"], icon: "🚿", group: "property" },
    {
      label: "Pets",
      keys: ["hasPets", "pets", "has_pets"],
      icon: "🐾",
      group: "property",
    },

    // Opciones adicionales
    {
      label: "Inside Fridge",
      keys: ["insideFridge", "inside_fridge"],
      icon: "❄️",
      group: "extras",
    },
    {
      label: "Inside Freezer",
      keys: ["insideFreezer", "inside_freezer"],
      icon: "🧊",
      group: "extras",
    },
    {
      label: "Inside Oven",
      keys: ["insideOven", "inside_oven"],
      icon: "🔥",
      group: "extras",
    },
    {
      label: "Inside Windows",
      keys: ["insideWindows", "inside_windows"],
      icon: "🪟",
      group: "extras",
    },
    {
      label: "Deep Cleaned",
      keys: ["deepCleaned", "deep_cleaned"],
      icon: "✨",
      group: "extras",
    },
    {
      label: "Close to Hiring",
      keys: ["closeToHiring", "close_to_hiring"],
      icon: "🤝",
      group: "extras",
    },

    // Mensajes
    {
      label: "How Did You Hear",
      keys: ["howDidYouHear", "how_did_you_hear"],
      icon: "📢",
      group: "info",
    },
    { label: "Message", keys: ["message"], icon: "💬", group: "info" },
    {
      label: "Additional Message",
      keys: ["additionalMessage", "additional_message"],
      icon: "💬",
      group: "info",
    },

    // Sistema
    { label: "Status", keys: ["status"], icon: "📊", group: "system" },
    { label: "Zoho ID", keys: ["zoho_id"], icon: "🔗", group: "system" },
    { label: "Source", keys: ["source"], icon: "🔍", group: "system" },
    { label: "ID", keys: ["id"], icon: "🆔", group: "system" },
    { label: "Created At", keys: ["created_at"], icon: "📅", group: "system" },
    { label: "Updated At", keys: ["updated_at"], icon: "📅", group: "system" },
  ];

  const allDefinedKeys = new Set(fieldDefinitions.flatMap((f) => f.keys));
  const rows = [];
  const processedLabels = new Set();

  // Procesar campos definidos
  for (const field of fieldDefinitions) {
    // Buscar el primer key que tenga valor
    let value = null;
    for (const key of field.keys) {
      if (
        leadData[key] !== undefined &&
        leadData[key] !== null &&
        leadData[key] !== ""
      ) {
        value = leadData[key];
        break;
      }
    }

    // Si no hay valor, saltar
    if (value === null) continue;

    // Evitar duplicar labels
    if (processedLabels.has(field.label)) continue;
    processedLabels.add(field.label);

    let formattedValue;

    // Formatear arrays (ej: preferred_days, preferred_time) como lista legible
    if (Array.isArray(value)) {
      formattedValue = value.length
        ? value.join(", ")
        : '<span class="empty-value">—</span>';
    }
    // Formatear booleanos
    if (typeof value === "boolean") {
      formattedValue = value ? "✅ Yes" : "❌ No";
    }
    // Formatear fechas
    else if (
      field.keys.some((k) => k.includes("_at")) &&
      typeof value === "string"
    ) {
      try {
        const date = new Date(value);
        formattedValue = date.toLocaleString("en-CA", {
          dateStyle: "medium",
          timeStyle: "short",
          timeZone: "America/Vancouver",
        });
      } catch {
        formattedValue = value;
      }
    }
    // Formatear objetos y arrays
    else if (typeof value === "object") {
      formattedValue = `<div class="code-block">${JSON.stringify(value, null, 2)}</div>`;
    }
    // Formatear mensajes largos
    else if (
      field.label.includes("Message") &&
      typeof value === "string" &&
      value.length > 50
    ) {
      formattedValue = `<div class="message-box">${value}</div>`;
    }
    // Valor normal
    else {
      formattedValue = value;
    }

    rows.push(`
      <tr>
        <td>${field.icon} ${field.label}</td>
        <td>${formattedValue}</td>
      </tr>
    `);
  }

  return rows.join("");
}

// =============================================================================
// Booking Web Notification
// Destinatario: BOOKING_NOTIFICATION_EMAIL (por defecto contact@monkeycleaning.com)
// Se dispara SOLO desde bookAvailability() — no desde createLead() ni /contact
// =============================================================================

const BOOKING_NOTIFICATION_EMAIL =
  process.env.BOOKING_NOTIFICATION_EMAIL || "contact@monkeycleaning.com";

const BOOKING_TZ = process.env.BOOKING_TIMEZONE || "America/Vancouver";

/**
 * Envía notificación interna cuando se confirma un booking desde la web.
 * Reintenta una vez (con 2 s de delay) si el primer envío falla.
 *
 * @param {object} opts
 * @param {string} opts.name
 * @param {string} opts.phone
 * @param {string} opts.address
 * @param {string|null} opts.email
 * @param {string} opts.team          - "team_1" | "team_2"
 * @param {string} opts.startIso      - ISO UTC string
 * @param {string} opts.endIso        - ISO UTC string
 * @param {number} opts.requiredHours
 * @param {string|null} opts.leadId
 * @param {string|null} opts.googleEventId
 */

export async function sendBookingWebNotification({
  name,
  phone,
  address,
  email,
  team,
  startIso,
  endIso,
  requiredHours,
  leadId,
  googleEventId,
}) {
  if (!process.env.GMAIL_USER || !process.env.GMAIL_PASS) {
    console.error(
      "[BookingNotif] Missing GMAIL_USER or GMAIL_PASS, skipping notification",
    );
    return;
  }

  const dateFmt = new Intl.DateTimeFormat("en-US", {
    timeZone: BOOKING_TZ,
    weekday: "long",
    month: "long",
    day: "numeric",
    year: "numeric",
  });
  const timeFmt = new Intl.DateTimeFormat("en-US", {
    timeZone: BOOKING_TZ,
    hour: "numeric",
    minute: "2-digit",
  });

  const startDate = new Date(startIso);
  const endDate = new Date(endIso);
  const dateStr = dateFmt.format(startDate);
  const timeStr = `${timeFmt.format(startDate)} – ${timeFmt.format(endDate)}`;
  const teamLabel = team === "team_1" ? "Team 1 🟢" : "Team 2 🟣";

  const subject = `🐵 New Web Booking — ${name} — ${dateStr}`;

  const teamColor = team === "team_1" ? "#22c55e" : "#a855f7";
  const teamBg = team === "team_1" ? "#f0fdf4" : "#faf5ff";
  const teamBorder = team === "team_1" ? "#bbf7d0" : "#e9d5ff";
  const bookedOn = new Date().toLocaleString("en-US", {
    weekday: "long",
    month: "long",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZone: BOOKING_TZ,
  });

  const html = `<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f4f6f9;font-family:'Helvetica Neue',Helvetica,Arial,sans-serif;">

  <table width="100%" cellpadding="0" cellspacing="0" style="background:#f4f6f9;padding:32px 16px;">
    <tr><td align="center">
      <table width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;">

        <!-- ── HEADER ── -->
        <tr>
          <td style="background:#0d1b3e;border-radius:12px 12px 0 0;padding:32px 36px 28px;">
            <table width="100%" cellpadding="0" cellspacing="0">
              <tr>
                <td>
                  <!-- Logo wordmark -->
                  <div style="display:inline-flex;align-items:center;gap:10px;">
                    <div style="width:36px;height:36px;background:#fff;border-radius:8px;display:flex;align-items:center;justify-content:center;font-size:20px;line-height:36px;text-align:center;">🐒</div>
                    <span style="color:#fff;font-size:18px;font-weight:700;letter-spacing:-0.3px;">Monkey Cleaning</span>
                  </div>
                  <div style="margin-top:20px;">
                    <div style="display:inline-block;background:rgba(255,255,255,0.12);border:1px solid rgba(255,255,255,0.2);border-radius:20px;padding:4px 14px;font-size:12px;color:rgba(255,255,255,0.8);letter-spacing:0.5px;text-transform:uppercase;font-weight:600;">New Booking</div>
                  </div>
                  <h1 style="margin:10px 0 4px;color:#fff;font-size:26px;font-weight:700;letter-spacing:-0.5px;line-height:1.2;">Web Booking Confirmed</h1>
                  <p style="margin:0;color:rgba(255,255,255,0.6);font-size:13px;">${bookedOn}</p>
                </td>
              </tr>
            </table>
          </td>
        </tr>

        <!-- ── TEAM BADGE ── -->
        <tr>
          <td style="background:#0d1b3e;padding:0 36px 28px;">
            <table cellpadding="0" cellspacing="0" style="background:${teamBg};border:1px solid ${teamBorder};border-radius:8px;padding:12px 16px;width:auto;">
              <tr>
                <td style="padding:0;">
                  <span style="color:#0d1b3e;font-weight:700;font-size:14px;vertical-align:middle;">${teamLabel}  assigned</span>
                  <span style="color:#64748b;font-size:13px;margin-left:8px;vertical-align:middle;">· ${requiredHours}h estimated</span>
                </td>
              </tr>
            </table>
          </td>
        </tr>

        <!-- ── BODY ── -->
        <tr>
          <td style="background:#fff;border-left:1px solid #e2e8f0;border-right:1px solid #e2e8f0;padding:0 36px;">

            <!-- Client info group -->
            <div style="padding:24px 0 0;">
              <p style="margin:0 0 14px;font-size:11px;font-weight:700;color:#94a3b8;letter-spacing:1px;text-transform:uppercase;">Client</p>
              <table width="100%" cellpadding="0" cellspacing="0">
                <tr>
                  <td style="padding:10px 0;border-bottom:1px solid #f1f5f9;width:36%;">
                    <span style="font-size:13px;color:#64748b;font-weight:500;">Full name</span>
                  </td>
                  <td style="padding:10px 0;border-bottom:1px solid #f1f5f9;">
                    <span style="font-size:14px;color:#0d1b3e;font-weight:600;">${name}</span>
                  </td>
                </tr>
                <tr>
                  <td style="padding:10px 0;border-bottom:1px solid #f1f5f9;">
                    <span style="font-size:13px;color:#64748b;font-weight:500;">Phone</span>
                  </td>
                  <td style="padding:10px 0;border-bottom:1px solid #f1f5f9;">
                    <span style="font-size:14px;color:#0d1b3e;">${phone}</span>
                  </td>
                </tr>
                <tr>
                  <td style="padding:10px 0;border-bottom:1px solid #f1f5f9;">
                    <span style="font-size:13px;color:#64748b;font-weight:500;">Email</span>
                  </td>
                  <td style="padding:10px 0;border-bottom:1px solid #f1f5f9;">
                    <span style="font-size:14px;color:#0d1b3e;">${email ? `<a href="mailto:${email}" style="color:#1d4ed8;text-decoration:none;">${email}</a>` : '<span style="color:#94a3b8;">—</span>'}</span>
                  </td>
                </tr>
                <tr>
                  <td style="padding:10px 0;">
                    <span style="font-size:13px;color:#64748b;font-weight:500;">Address</span>
                  </td>
                  <td style="padding:10px 0;">
                    <span style="font-size:14px;color:#0d1b3e;">${address}</span>
                  </td>
                </tr>
              </table>
            </div>

            <!-- Divider -->
            <div style="height:1px;background:#f1f5f9;margin:8px 0;"></div>

            <!-- Appointment group -->
            <div style="padding:16px 0 0;">
              <p style="margin:0 0 14px;font-size:11px;font-weight:700;color:#94a3b8;letter-spacing:1px;text-transform:uppercase;">Appointment</p>

              <!-- Date highlight card -->
              <table width="100%" cellpadding="0" cellspacing="0" style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:8px;margin-bottom:16px;">
                <tr>
                  <td style="padding:16px 20px;">
                    <p style="margin:0 0 2px;font-size:12px;color:#94a3b8;font-weight:500;">Date &amp; Time</p>
                    <p style="margin:0;font-size:18px;font-weight:700;color:#0d1b3e;letter-spacing:-0.3px;">${dateStr}</p>
                    <p style="margin:4px 0 0;font-size:15px;color:#334155;font-weight:500;">${timeStr}</p>
                  </td>
                </tr>
              </table>
            </div>

            <!-- System refs group -->
            <div style="padding:0 0 24px;">
              <p style="margin:0 0 14px;font-size:11px;font-weight:700;color:#94a3b8;letter-spacing:1px;text-transform:uppercase;">Reference</p>
              <table width="100%" cellpadding="0" cellspacing="0">
                ${
                  leadId
                    ? `
                <tr>
                  <td style="padding:8px 0;border-bottom:1px solid #f1f5f9;width:36%;">
                    <span style="font-size:13px;color:#64748b;font-weight:500;">Lead ID</span>
                  </td>
                  <td style="padding:8px 0;border-bottom:1px solid #f1f5f9;">
                    <code style="font-size:12px;color:#475569;background:#f1f5f9;padding:2px 7px;border-radius:4px;">${leadId}</code>
                  </td>
                </tr>`
                    : ""
                }
                ${
                  googleEventId
                    ? `
                <tr>
                  <td style="padding:8px 0;">
                    <span style="font-size:13px;color:#64748b;font-weight:500;">Calendar Event</span>
                  </td>
                  <td style="padding:8px 0;">
                    <code style="font-size:12px;color:#475569;background:#f1f5f9;padding:2px 7px;border-radius:4px;">${googleEventId}</code>
                  </td>
                </tr>`
                    : ""
                }
              </table>
            </div>

          </td>
        </tr>

        <!-- ── FOOTER ── -->
        <tr>
          <td style="background:#f8fafc;border:1px solid #e2e8f0;border-top:none;border-radius:0 0 12px 12px;padding:20px 36px;">
            <table width="100%" cellpadding="0" cellspacing="0">
              <tr>
                <td>
                  <p style="margin:0;font-size:12px;color:#94a3b8;">
                    Sent automatically by the Monkey Cleaning booking system
                    · © ${new Date().getFullYear()} Monkey Cleaning
                  </p>
                </td>
              </tr>
            </table>
          </td>
        </tr>

      </table>
    </td></tr>
  </table>

</body>
</html>`;

  const transporter = nodemailer.createTransport({
    service: "gmail",
    auth: {
      user: process.env.GMAIL_USER,
      pass: process.env.GMAIL_PASS,
    },
  });

  async function attemptSend() {
    await transporter.sendMail({
      from: `"Monkey Cleaning Bookings" <${process.env.GMAIL_USER}>`,
      to: BOOKING_NOTIFICATION_EMAIL,
      subject,
      html,
    });
  }

  try {
    await attemptSend();
    console.log(
      `✅ [BookingNotif] Notification sent to ${BOOKING_NOTIFICATION_EMAIL}`,
    );
  } catch (err) {
    console.warn(
      `⚠️ [BookingNotif] First attempt failed: ${err.message}. Retrying in 2 s...`,
    );
    await new Promise((r) => setTimeout(r, 2000));
    try {
      await attemptSend();
      console.log(
        `✅ [BookingNotif] Notification sent on retry to ${BOOKING_NOTIFICATION_EMAIL}`,
      );
    } catch (retryErr) {
      // Ambos intentos fallaron — logueamos pero NO lanzamos para no romper el booking
      console.error(`❌ [BookingNotif] Retry also failed: ${retryErr.message}`);
    }
  }
}
