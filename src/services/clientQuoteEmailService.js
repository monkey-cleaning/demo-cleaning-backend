import nodemailer from "nodemailer";
import { DateTime } from "luxon";

const BOOKING_TZ = process.env.BOOKING_TIMEZONE || "America/Vancouver";

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function formatSlot(slot) {
  const start = DateTime.fromISO(slot.start_at).setZone(BOOKING_TZ);
  const end   = DateTime.fromISO(slot.end_at).setZone(BOOKING_TZ);

  const dateFmt = new Intl.DateTimeFormat("en-US", {
    timeZone: BOOKING_TZ,
    weekday: "short",
    month:   "short",
    day:     "numeric",
  });

  const timeFmt = new Intl.DateTimeFormat("en-US", {
    timeZone: BOOKING_TZ,
    hour:   "numeric",
    minute: "2-digit",
  });

  return `${dateFmt.format(start.toJSDate())} — ${timeFmt.format(start.toJSDate())} to ${timeFmt.format(end.toJSDate())}`;
}

function formatMoney(n) {
  const num = Number(n);
  if (!Number.isFinite(num)) return `$${n}`;
  return `$${num.toFixed(2)}`;
}

function formatHours(n) {
  const whole = Math.floor(n);
  const mins  = Math.round((n % 1) * 60);
  if (mins === 0) return `${whole} hour${whole === 1 ? "" : "s"}`;
  return `${whole}h ${mins}min`;
}

function escapeHtml(s) {
  return String(s)
    .replaceAll("&",  "&amp;")
    .replaceAll("<",  "&lt;")
    .replaceAll(">",  "&gt;")
    .replaceAll('"',  "&quot;")
    .replaceAll("'",  "&#039;");
}

// ---------------------------------------------------------------------------
// Nodemailer transport factory
// ---------------------------------------------------------------------------

export function createClientMailer() {
  const host = process.env.SMTP_HOST || "smtp.gmail.com";
  const port = Number(process.env.SMTP_PORT || 587);

  return nodemailer.createTransport({
    host,
    port,
    secure: false,
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS,
    },
  });
}

// ---------------------------------------------------------------------------
// buildResidentialQuoteEmail
// ---------------------------------------------------------------------------

/**
 * @param {object} opts
 * @param {object} opts.lead      - lead data
 * @param {object} opts.calc      - result of calculateQuote()
 * @param {Array}  [opts.slots]   - suggested availability windows (trimmed to hrsPerPerson)
 * @param {string} [opts.leadId]  - DB uuid of the lead; appended to the booking URL
 */
export function buildResidentialQuoteEmail({ lead, calc, slots = [], leadId = null }) {
  const name        = lead.fullName || "there";
  const isMoveInOut = calc.calcType === "Move In/Out";
  const totalHrs    = calc.totalHrs;
  const totalAmount = formatMoney(calc.totalAmount);

  const subject = "Here: Your Quote with Monkey Cleaning 🐵✨";

  // Build the booking URL — include leadId so the frontend (and GET
  // /api/availability?leadId=X) can filter windows to the right duration.
  const baseBookingUrl = "https://monkeycleaning.com/available";
  const bookingUrl     = leadId
    ? `${baseBookingUrl}?leadId=${encodeURIComponent(leadId)}`
    : baseBookingUrl;

  const slotsHtml = slots.length
    ? `
      <p><b>Suggested available times (first come, first served):</b></p>
      <ul>
        ${slots.map(s => `<li>${formatSlot(s)}</li>`).join("")}
      </ul>
      <p>
        Prefer another time? View all availability and book directly here:<br/>
        <a href="${bookingUrl}">${bookingUrl}</a>
      </p>
    `
    : `
      <p>
        Feel free to view our current availability and book directly here:<br/>
        <a href="${bookingUrl}">${bookingUrl}</a>
      </p>
      <p>If you don't find a time that fits your schedule, simply reply to this email and we'll be happy to help find a suitable option for you.</p>
    `;

  // ── MOVE IN/OUT template ────────────────────────────────────────────────
  if (isMoveInOut) {
    const html = `
    <div style="font-family: Arial, sans-serif; line-height:1.6; color:#111;">
      <p>Hello ${escapeHtml(name)},</p>

      <p>Thank you so much for reaching out to Monkey Cleaning 🐒✨ We'd be happy to assist you during your move and help ensure your home is left in excellent condition.</p>

      <p>For your situation, we recommend a move-out cleaning service, which is more detailed than a standard or deep cleaning, as it is designed to prepare the home for the next occupant or final inspection.</p>

      <p><b>✅ What Does This Service Include?</b><br/>
      Our move-out cleaning typically includes:</p>
      <ul>
        <li>Detailed cleaning of bathrooms and kitchen</li>
        <li>Interior and exterior cleaning of cabinets, drawers, and closets</li>
        <li>Interior cleaning of appliances such as fridge, freezer and oven</li>
        <li>Floor cleaning throughout the entire property</li>
        <li>Thorough dusting of all surfaces, including baseboards, doors, and frames</li>
        <li>Spot cleaning of walls and reachable interior windows</li>
      </ul>
      <p>If there are any specific areas you would like us to focus on, we're always happy to customize the service.</p>

      <p><b>✅ Estimated Time</b><br/>
      Based on the information provided, we estimate this service will require approximately <b>${formatHours(totalHrs)}</b> labor hours. Our team may consist of two professionals working simultaneously to complete the job efficiently.</p>

      <p><b>💲 Pricing</b><br/>
      Our service rate is $45 per labor hour + applicable taxes.<br/>
      Based on this estimate, the total cost would be approximately <b>${totalAmount} + tax</b>.</p>

      <p>As a note of transparency and honesty, we only charge for the actual time our team spends at the property. If the service takes less time than estimated, only the time worked will be charged.</p>

      <p>For your convenience, we accept payment by e-transfer, cheque, or cash.</p>

      <p><b>📅 Scheduling Your Service</b></p>
      ${slotsHtml}

      <p>We understand how important it is to leave your home in top condition, and we'd be delighted to help make your move smooth and stress-free ✨</p>

      <p>If you have any questions or would like to proceed, please don't hesitate to reach out.</p>

      <p>Warm regards,<br/>
      Claire<br/>
      Monkey Cleaning Team 🐒</p>
    </div>`;

    return { subject, html };
  }

  // ── REGULAR CLEANING template ───────────────────────────────────────────
  const html = `
  <div style="font-family: Arial, sans-serif; line-height:1.6; color:#111;">
    <p>Hello ${escapeHtml(name)},</p>

    <p>Thank you so much for reaching out to Monkey Cleaning 🐒✨ We'd be delighted to assist you and help create a cleaning plan that feels just right for your home.</p>

    <p>For your first visit, we recommend starting with an initial deep cleaning service. This allows us to bring your home to an excellent baseline, making future maintenance cleanings more efficient and consistent.</p>

    <p><b>✅ What Does This Service Include?</b><br/>
    Our initial deep cleaning typically includes:</p>
    <ul>
      <li>Detailed bathroom cleaning</li>
      <li>Exterior cleaning of kitchen cabinets and appliances</li>
      <li>Floor cleaning throughout the home</li>
      <li>Thorough dusting in all main areas</li>
    </ul>
    <p>If you would like to include additional tasks (such as interior appliances), please let us know and we will gladly customize the service.</p>

    <p><b>✅ Estimated Time</b><br/>
    We estimate the first cleaning will require approximately <b>${formatHours(totalHrs)}</b> labor hours.<br/>
    This may be completed by a team of two professionals working simultaneously, meaning less time spent in your home.</p>

    <p><b>💲 Pricing</b><br/>
    Our service rate is $45 per labor hour + applicable taxes.<br/>
    Based on this estimate, the total cost for your initial deep cleaning would be approximately <b>${totalAmount} + tax</b>.</p>

    <p>As a note of transparency and honesty, we only charge for the actual time our team spends at the property. If the service takes less time than estimated, only the time worked will be charged.</p>

    <p>For your convenience, we accept payment by e-transfer, cheque, or cash.</p>

    <p><b>📅 Scheduling Your Service</b></p>
    ${slotsHtml}

    <p>We'd love the opportunity to make your home feel fresh, clean, and comfortable ✨</p>

    <p>If you have any questions or would like to move forward, please don't hesitate to reach out.</p>

    <p>Warm regards,<br/>
    Claire<br/>
    Monkey Cleaning Team 🐒</p>
  </div>`;
  return { subject, html };
}

export function buildCustomerConfirmationEmail({ fullName }) {
  const name = fullName || "there";
  const subject = "Thank you for reaching out to Monkey Cleaning!";
  const html = [
    '<div style="font-family: Arial, sans-serif; line-height:1.5; color:#111;">',
    `<p>Hello ${name},</p>`,
    "<p>Thank you for reaching out to Monkey Cleaning!</p>",
    "<p>We have received your request and a member of our team will be in touch with you shortly with all the details.</p>",
    "<p>We look forward to helping you!</p>",
    "<p>Warm regards,<br/>Claire<br/>Monkey Cleaning Team</p>",
    "</div>",
  ].join("\n");

  return { subject, html };
}

// ---------------------------------------------------------------------------
// buildCommercialInquiryEmail — unchanged, no slots link
// ---------------------------------------------------------------------------

export function buildCommercialInquiryEmail({ lead }) {
  const name    = lead.fullName || "there";
  const subject = `Received: Monkey Cleaning Inquiry for ${lead.fullName || lead.email || "Client"}`;

  const html = `
  <div style="font-family: Arial, sans-serif; line-height:1.6; color:#111;">
    <p>Dear ${escapeHtml(name)},</p>

    <p>Thank you for contacting Monkey Cleaning!</p>

    <p>We have received your inquiry regarding cleaning services for your space.</p>

    <p>One of our team members will review your details and contact you shortly.</p>

    <p>Warm regards,<br/>
    Claire<br/>
    Monkey Cleaning Team</p>
  </div>`;

  return { subject, html };
}

// ---------------------------------------------------------------------------
// sendClientEmail
// ---------------------------------------------------------------------------

export async function sendClientEmail({ to, subject, html }) {
  const transporter = createClientMailer();

  const fromName  = process.env.CLIENT_FROM_NAME || "Claire";
  const fromEmail = process.env.SMTP_USER;

  await transporter.sendMail({
    from:    `"${fromName} - Monkey Cleaning" <${fromEmail}>`,
    to,
    subject,
    html,
  });
}

export function buildFollowUpEmail({ lead, leadId = null }) {
  const name = lead.full_name || lead.fullName || "there";

  const subject = "Just checking in! 🐒✨";

  const baseBookingUrl = "https://monkeycleaning.com/available";
  const bookingUrl     = leadId
    ? `${baseBookingUrl}?leadId=${encodeURIComponent(leadId)}`
    : baseBookingUrl;

  const html = `
  <div style="font-family: Arial, sans-serif; line-height:1.6; color:#111; max-width:600px;">
    <p>Hi ${escapeHtml(name)}! 👋</p>

    <p>Hope your week is off to a great start! 🌿</p>

    <p>We've been thinking about your home — and honestly, we can't wait to make it
    shine ✨ Picture this: you walk through the door, everything is fresh, spotless,
    and gleaming… and you didn't lift a finger 😌</p>

    <p>That's exactly what we do best at Monkey Cleaning 🐒💚 — the kind of clean
    you can see, smell, and relax into.</p>

    <p>Whenever you're ready, we've made it super easy:</p>

    <p>💬 Got a question about your quote? Just hit reply — we'd love to help! 😊<br/>
    📅 Ready to book? Spots are filling up fast this week, so let's grab yours
    before it's gone!</p>

    <p style="margin-top:24px;">
      <a href="${bookingUrl}"
         style="display:inline-block;padding:12px 24px;background:#667eea;color:#fff;
                border-radius:6px;text-decoration:none;font-weight:600;font-size:15px;">
        Book My Cleaning 🐒
      </a>
    </p>

    <p>It only takes 30 seconds — and then it's off your to-do list for good ✅</p>

    <p style="margin-top:28px;">
      Kind regards,<br/>
      Claire
    </p>
  </div>`;

  return { subject, html };
}