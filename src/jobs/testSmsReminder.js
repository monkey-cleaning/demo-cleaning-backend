import 'dotenv/config';
import { processReminders } from '../services/smsReminderService.js';

processReminders()
  .then(() => console.log('done'))
  .catch(console.error);