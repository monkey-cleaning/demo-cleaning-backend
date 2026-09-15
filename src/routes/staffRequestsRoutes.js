import { Router } from "express";
import { requireCleaner } from "../middleware/requireCleaner.js";
import {
  createTimeOffRequest,
  listTimeOffRequests,
  createComplaint,
  listComplaints,
} from "../controllers/staffRequestsController.js";

// LAB425 — solicitudes de licencia y reclamos, protegido por requireCleaner.
const r = Router();
r.post("/time-off", requireCleaner, createTimeOffRequest);
r.get("/time-off", requireCleaner, listTimeOffRequests);
r.post("/complaint", requireCleaner, createComplaint);
r.get("/complaint", requireCleaner, listComplaints);
export default r;
