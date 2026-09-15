import cron from 'node-cron';
import { processReminders } from '../services/smsReminderService.js';

// Cada 15 min (antes 30): así un turno que cruza la ventana de 24 h del
// recordatorio se toma antes. El dedupe por sms_reminders evita reenvíos.
cron.schedule('*/15 * * * *', async () => {
  try {
    await processReminders();
  } catch (err) {
    console.error('SMS reminder cron failed:', err);
  }
}, { timezone: 'America/Vancouver' });