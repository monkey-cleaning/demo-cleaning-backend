process.env.TZ = "America/Vancouver";

import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import cron from "node-cron";
import leadRoutes from "./routes/leadRoutes.js";
import authRoutes from "./routes/auth.js";
import blogRoutes from "./routes/blogRoutes.js";
import adminRoutes from "./routes/adminRoutes.js";
import adminAuthRoutes from "./routes/adminAuthRoutes.js";
import jobRoutes from "./routes/jobRoutes.js";
import availabilityRoutes from "./routes/availabilityRoutes.js";
import availabilitySyncRoutes from "./routes/availabilitySyncRoutes.js";
import quickbooksAuthRoutes from "./routes/quickbooksAuthRoutes.js";
import quickbooksRoutes from "./routes/quickbooksRoutes.js";
import invoiceRoutes from "./routes/invoiceRoutes.js";
import paymentRoutes from "./routes/paymentRoutes.js";
// import "./jobs/syncQuickbooks.js";
import calendarRoutes from "./routes/calendarRoutes.js";
import publicConfirmationRoutes from "./routes/publicConfirmationRoutes.js";
import clientRoutes from "./routes/clientRoutes.js";
import { startClientStatusJob } from "./jobs/clientStatusJob.js";
import employeeRoutes from "./routes/employeeRoutes.js";
import dashboardRoutes from "./routes/dashboardRoutes.js";
import appointmentRoutes from "./routes/appointmentRoutes.js";
import scheduleRoutes from "./routes/scheduleRoutes.js";
import settingsRoutes from "./routes/settingsRoutes.js";
import { startEtransferSyncJob } from "./jobs/eTransferSyncJob.js";
import {
  getTeams,
  createTeam,
  updateTeam,
} from "./controllers/teamAssignmentController.js";
import { requireAdmin } from "./middleware/requireAdmin.js";
import { runFollowUpQuoteJob } from "./jobs/followUpQuoteJob.js";
import { generateAvailability } from "./services/availabilityGeneratorService.js";
import seoRoutes from "./routes/seoRoutes.js";
import { startDailyDigestJob } from "./jobs/dailyDigestJob.js";
import { startConfirmationPairingJob } from "./jobs/confirmationPairingJob.js";
import { startConfirmationReminderJob } from "./jobs/confirmationReminderJob.js";
import { startConfirmationReleaseJob } from "./jobs/confirmationReleaseJob.js";
import quoteRoutes from "./routes/quoteRoutes.js";
import "./jobs/smsReminderCron.js";

dotenv.config();

const app = express();
const PORT = process.env.PORT || 4000;
app.set("trust proxy", 1);

app.use(
  cors({
    origin: [
      "http://localhost:5173",
      "http://localhost:5174",
      "https://demo-cleaning-frontend.onrender.com",
    ],
    credentials: true,
  }),
);
app.use(express.json());

// ── No cachear respuestas de la API ──────────────────────────────────────────
// El panel admin trabaja siempre con datos vivos. Sin esto, el browser puede
// servir respuestas viejas desde el disk cache sin revalidar — pasó con un
// 410 stub viejo de /auto-suggestions que quedó cacheado tras el redeploy
// (los 410 son cacheables por defecto según RFC 7231).
app.use("/api", (_req, res, next) => {
  res.set("Cache-Control", "no-store");
  next();
});

// ── Leads & Blog ─────────────────────────────────────────────────────────────
app.use("/api/leads", leadRoutes);
app.use("/api/blogs", blogRoutes);

// ── Quote (Twilio integration) ────────────────────────────────────────────
app.use("/api/quote", quoteRoutes);

// ── Admin ────────────────────────────────────────────────────────────────────
app.use("/api/admin/auth", adminAuthRoutes);
app.use("/api/admin/blogs", adminRoutes);
app.use("/api/admin/clients", clientRoutes);
app.use("/api/admin/staff", employeeRoutes);
app.use("/api/admin/staff", scheduleRoutes);
app.use("/api/admin/appointments", appointmentRoutes);
app.use("/api/admin/settings", settingsRoutes);
app.get("/api/admin/teams", requireAdmin, getTeams);
app.post("/api/admin/teams", requireAdmin, createTeam);
app.patch("/api/admin/teams/:id", requireAdmin, updateTeam);
app.use("/api/dashboard", dashboardRoutes);

// ── Jobs & Availability ──────────────────────────────────────────────────────
app.use("/api/jobs", jobRoutes);
app.use("/api/availability", availabilityRoutes);
app.use("/api/jobs/availability", availabilitySyncRoutes);

// ── QuickBooks ───────────────────────────────────────────────────────────────
app.use("/auth", quickbooksAuthRoutes);
app.use("/api/quickbooks", quickbooksRoutes);

// ── Invoices & Payments ──────────────────────────────────────────────────────
app.use("/api/invoices", invoiceRoutes);
app.use("/api/payments", paymentRoutes);

// ── Calendar ──────────────────────────────────────────────────────────────────
app.use("/api/calendar", calendarRoutes);

// ── Public (no auth) ─────────────────────────────────────────────────────────
// Confirmation links clicked by clients from the "CONFIRMAR" reminder email —
// see controllers/publicConfirmationController.js.
app.use("/api/public", publicConfirmationRoutes);

// ── Healthcheck ──────────────────────────────────────────────────────────────
app.get("/health", (_req, res) => {
  res.json({ ok: true });
});

// ── SEO (robots.txt / sitemap.xml) ────────────────────────────────────────────
app.use("/", seoRoutes);

// ── Auth  ─────────────────────────────────────────────────────────────────────
app.use("/", authRoutes);

// ── 404 global ───────────────────────────────────────────────────────────────
app.use((_req, res) => {
  res.status(404).json({ error: "Not found" });
});

app.listen(PORT, () => {
  console.log(`🚀 Backend listening on http://localhost:${PORT}`);
  startClientStatusJob();
});

// startEtransferSyncJob();
startDailyDigestJob();
// startConfirmationPairingJob();
// startConfirmationReminderJob();
// startConfirmationReleaseJob();

// 07:50 AM Vancouver — da 10 min de margen antes de la ventana de las 8:00
// Expresión en UTC: Vancouver es UTC-7 (PDT) / UTC-8 (PST)
// Con TZ=America/Vancouver en el proceso, node-cron usa esa zona directamente
cron.schedule("50 7 * * *", runFollowUpQuoteJob, {
  timezone: "America/Vancouver",
});

// 03:00 AM Vancouver — regenera cleaning_availability para los proximos 30
// dias a partir de appointments. Cuando la disponibilidad venia de Google
// Calendar esto lo hacia un Cron Job externo contra /api/jobs/availability/sync;
// esa ruta sigue viva para dispararlo a mano, pero el fork no depende de ella.
// Sin este cron la tabla se vacia sola: el horizonte avanza y nadie lo repone.
cron.schedule(
  "0 3 * * *",
  () =>
    generateAvailability({ rangeDays: 30 }).catch((err) =>
      console.error("❌ [cron availability] Fallo la generacion:", err.message),
    ),
  { timezone: "America/Vancouver" },
);
