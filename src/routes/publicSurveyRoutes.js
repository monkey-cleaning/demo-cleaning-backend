// Encuesta de satisfacción post-servicio (LAB413, portado de Monkey Cleaning).
//
// Sin requireAdmin a propósito: son los links que el cliente clickea desde el
// email. Montar en index.js FUERA del grupo /api/admin:
//
//   import publicSurveyRoutes from "./routes/publicSurveyRoutes.js";
//   app.use("/api/public", publicSurveyRoutes);
//
// El POST de feedback usa un <form> sin JS → requiere express.urlencoded()
// montado en index.js.

import { Router } from "express";
import {
  ratingPreview,
  submitRating,
  feedbackForm,
  submitFeedback,
} from "../controllers/publicSurveyController.js";

const r = Router();

// /feedback antes que /:rating — si no, "feedback" entraría por el param :rating.
r.get("/survey/:token/feedback", feedbackForm);
r.post("/survey/:token/feedback", submitFeedback);
// GET = página de confirmación (no graba, a prueba de prefetch de escáneres de
// email). POST = graba la calificación.
r.get("/survey/:token/:rating", ratingPreview);
r.post("/survey/:token/:rating", submitRating);

export default r;
