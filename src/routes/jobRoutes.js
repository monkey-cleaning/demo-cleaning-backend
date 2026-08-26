import { Router } from 'express';
import { sendDueCustomerEmails } from '../controllers/jobController.js';

const r = Router();
r.post('/send-due-customer-emails', sendDueCustomerEmails);
export default r;
