import express from "express";
import { calculateQuoteEndpoint, calculateQuoteVoiceEndpoint } from "../controllers/quoteController.js";

const router = express.Router();

router.post("/calculate", calculateQuoteEndpoint);
router.post("/voice", calculateQuoteVoiceEndpoint);

export default router;
