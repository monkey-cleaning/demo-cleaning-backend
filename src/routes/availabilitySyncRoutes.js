import { Router } from "express";
import { syncAvailability } from "../controllers/availabilitySyncController.js";

const r = Router();
r.post("/sync", syncAvailability);
export default r;