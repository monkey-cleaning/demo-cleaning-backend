import express from "express";
import {
  calculateQuoteEndpoint,
  calculateQuoteVoiceEndpoint,
  elevenLabsPostCallWebhook,
} from "../controllers/quoteController.js";

const router = express.Router();

// Tool webhook del agente de ElevenLabs (cotización en vivo).
router.post("/calculate", calculateQuoteEndpoint);

// Studio Flow "Quote Bot" — fallback determinístico por DTMF.
router.post("/voice", calculateQuoteVoiceEndpoint);

// Post-call webhook (transcription) del agente de ElevenLabs. Inerte sin
// ELEVENLABS_WEBHOOK_SECRET (la verificación de firma devuelve 401).
router.post("/elevenlabs/webhook", elevenLabsPostCallWebhook);

export default router;
