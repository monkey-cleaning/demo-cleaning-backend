import { Router } from "express";
import { getAvailability, bookAvailability } from "../controllers/availabilityController.js";

const r = Router();

r.get("/", getAvailability);
r.post("/book", bookAvailability);

export default r;