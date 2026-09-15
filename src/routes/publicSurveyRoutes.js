// Encuesta de satisfacción post-servicio (API JSON pública).
// Portado de Monkey Cleaning (LAB413).
//
// Sin requireAdmin: la consume la página React pública `SurveyPage` del
// frontend. Montar en index.js FUERA del grupo /api/admin:
//
//   import publicSurveyRoutes from "./routes/publicSurveyRoutes.js";
//   app.use("/api/public", publicSurveyRoutes);

import { Router } from "express";
import {
  getSurveyState,
  submitRating,
  submitFeedback,
  goReview,
} from "../controllers/publicSurveyController.js";

const r = Router();

// Rutas literales antes de /:rating para que no las capture el param.
r.get("/survey/:token", getSurveyState);
r.post("/survey/:token/feedback", submitFeedback);
r.get("/survey/:token/go-review", goReview);
r.post("/survey/:token/:rating", submitRating);

export default r;
