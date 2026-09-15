// Webhooks entrantes de Twilio para el número de recordatorios SMS.
//
// Montar en index.js FUERA del grupo /api/admin y sin requireAdmin:
//
//   import smsWebhookRoutes from "./routes/smsWebhookRoutes.js";
//   app.use("/api/sms", smsWebhookRoutes);
//
// La auth la hace la firma X-Twilio-Signature dentro del controller.

import { Router } from "express";
import {
  handleInboundSms,
  handleStatusCallback,
} from "../controllers/smsWebhookController.js";

const r = Router();

// Twilio: "A MESSAGE COMES IN" (Messaging Service → Integration, o el número)
r.post("/incoming", handleInboundSms);
// Twilio: statusCallback de messages.create / "Delivery Status Callback"
r.post("/status", handleStatusCallback);

export default r;
