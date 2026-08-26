import {
    fetchAndLockDueCustomerEmails,
    markCustomerEmailSent,
    markCustomerEmailFailed,
    releaseStaleLocks,
  } from '../services/supabaseService.js';
  
  import { sendClientEmail } from '../services/clientQuoteEmailService.js';
  
  const JOB_TOKEN = process.env.JOBS_TOKEN;
  
  /**
   * POST /api/jobs/send-due-customer-emails
   * Requiere header: Authorization: Bearer <JOBS_TOKEN>
   */
  export async function sendDueCustomerEmails(req, res) {
    try {
      // ✅ Auth (case-insensitive header)
      const auth = req.get('authorization') || req.get('Authorization') || '';
      const ok = JOB_TOKEN && auth.trim() === `Bearer ${JOB_TOKEN}`;
      if (!ok) return res.status(401).json({ error: 'Unauthorized' });
  
      // ✅ libera locks viejos (por si un job murió)
      // (10 min es razonable; ajusta si quieres)
      await releaseStaleLocks(10);
  
      // 🔒 Trae y lockea N filas (queda status=processing)
      const rows = await fetchAndLockDueCustomerEmails(10);
  
      let sent = 0;
      let failed = 0;
      let skipped = 0;
  
      for (const row of rows) {
        try {
          // Si por alguna razón no quedó en processing, saltamos
          if (row.status !== 'processing') {
            skipped++;
            continue;
          }
  
          const { to, subject, html } = row.payload || {};
          if (!to || !subject || !html) {
            throw new Error('Missing payload fields (to/subject/html)');
          }
  
          await sendClientEmail({ to, subject, html });
          await markCustomerEmailSent(row.id);
          sent++;
  
          console.log(`✅ Customer email sent: ${to} (id=${row.id})`);
        } catch (err) {
          const msg = err?.message || String(err);
          console.error(`❌ Failed customer email id=${row.id}:`, msg);
  
          // 🔁 Si falló, lo marcamos failed (MVP).
          // (Si luego querés reintentos, cambiamos a pending si attempts < N)
          await markCustomerEmailFailed(row.id, msg);
          failed++;
        }
      }
  
      return res.json({
        ok: true,
        locked: rows.length,
        sent,
        failed,
        skipped,
        now: new Date().toISOString(),
      });
    } catch (err) {
      console.error('❌ Error in sendDueCustomerEmails:', err);
      return res.status(500).json({ error: err?.message || String(err) });
    }
  }
  
  /**
   * POST /api/jobs/release-stale-email-locks
   * Requiere header: Authorization: Bearer <JOBS_TOKEN>
   */
  export async function releaseStaleEmailLocks(req, res) {
    try {
      const auth = req.get('authorization') || req.get('Authorization') || '';
      const ok = JOB_TOKEN && auth.trim() === `Bearer ${JOB_TOKEN}`;
      if (!ok) return res.status(401).json({ error: 'Unauthorized' });
  
      const minutes = Number(req.query.minutes || 10);
      await releaseStaleLocks(Number.isFinite(minutes) ? minutes : 10);
  
      return res.json({
        ok: true,
        minutes: Number.isFinite(minutes) ? minutes : 10,
        now: new Date().toISOString(),
      });
    } catch (err) {
      console.error('❌ Error in releaseStaleEmailLocks:', err);
      return res.status(500).json({ error: err?.message || String(err) });
    }
  }
  