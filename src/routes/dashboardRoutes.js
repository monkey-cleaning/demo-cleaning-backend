import express from 'express';
import { getOperationalKPIs, getTeamsToday } from '../controllers/dashboardController.js'; // ajustar path
import { requireAdmin }  from '../middleware/requireAdmin.js';                  // mismo middleware que calendarRoutes

const router = express.Router();

router.use(requireAdmin);

router.get('/operational', requireAdmin, getOperationalKPIs);
router.get('/teams-today',  getTeamsToday); 

export default router;