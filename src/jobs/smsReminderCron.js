import cron from 'node-cron';
import { processReminders } from '../services/smsReminderService.js';

cron.schedule('*/30 * * * *', async () => {
  try {
    await processReminders();
  } catch (err) {
    console.error('SMS reminder cron failed:', err);
  }
}, { timezone: 'America/Vancouver' });