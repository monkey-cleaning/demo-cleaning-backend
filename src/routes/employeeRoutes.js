import express from "express";
import { requireAdmin } from "../middleware/requireAdmin.js";
import {
  listEmployees,
  getEmployee,
  createEmployee,
  updateEmployee,
  deactivateEmployee,
  searchEmployees,
  getAvailableStaffForEvents,
} from "../controllers/employeeController.js";
import {
  getAssignments,
  createAssignment,
  deleteAssignment,
  getTeams,
  getAutoAssignSuggestions,
  applyAutoAssign,
} from "../controllers/teamAssignmentController.js";

const router = express.Router();

// All routes require admin auth
router.use(requireAdmin);

// ── Team assignments ──────────────────────────────────────────────────────────
// Must be before /:id to avoid route conflicts.

// GET /api/admin/staff/available?date=YYYY-MM-DD&eventIds=id1,id2,...
// Devuelve empleados disponibles para eventos específicos en una fecha
router.get("/available", getAvailableStaffForEvents);

// GET  /api/admin/teams
router.get("/teams", getTeams);

// GET  /api/admin/staff/team-assignments/auto-suggestions?weekStart=YYYY-MM-DD
router.get("/team-assignments/auto-suggestions", getAutoAssignSuggestions);

// POST /api/admin/staff/team-assignments/auto-apply
router.post("/team-assignments/auto-apply", applyAutoAssign);


// GET  /api/admin/staff/team-assignments?date=YYYY-MM-DD
router.get("/team-assignments", getAssignments);

// POST /api/admin/staff/team-assignments
// Body: { date, team_id, employee_id }
router.post("/team-assignments", createAssignment);

// DELETE /api/admin/staff/team-assignments/:id
router.delete("/team-assignments/:id", deleteAssignment);

// ── Typeahead search ──────────────────────────────────────────────────────────
// Must be before /:id to avoid route conflict.
router.get("/search", searchEmployees);

// ── Employee CRUD ─────────────────────────────────────────────────────────────
router.get("/", listEmployees);
router.post("/", createEmployee);
router.get("/:id", getEmployee);
router.patch("/:id", updateEmployee);
router.delete("/:id", deactivateEmployee);

export default router;
