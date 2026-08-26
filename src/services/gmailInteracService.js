// Lee mails de Interac e-Transfer desde Gmail via IMAP y los parsea.
// Requiere: imapflow (npm install imapflow)
// Credenciales: SMTP_USER (email) + SMTP_PASS (App Password de Google)

import { ImapFlow } from "imapflow";

const INTERAC_SENDER = "notify@payments.interac.ca";

// Subject: "Interac e-Transfer: You've received $283.50 from AMORITA MARIA ADAIR and it has been automatically deposited."
const SUBJECT_RE = /received\s+\$([0-9,]+(?:\.[0-9]{2})?)\s+from\s+([A-Z][A-Z\s]+?)(?:\s+and\s+it\s+has|\s*$)/i;

function createImapClient() {
  return new ImapFlow({
    host: "imap.gmail.com",
    port: 993,
    secure: true,
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS,
    },
    logger: false, // silenciar logs internos de imapflow
  });
}

/**
 * Parsea el subject de un mail de Interac.
 * Devuelve { senderName, amount } o null si no matchea.
 */
function parseInteracSubject(subject) {
  const match = subject?.match(SUBJECT_RE);
  if (!match) return null;
  return {
    amount: parseFloat(match[1].replace(",", "")),
    senderName: match[2].trim().toUpperCase(),
  };
}

/**
 * Trae todos los mails de Interac e-Transfer desde `fromDate` (Date object).
 * Devuelve array de { messageId, date, senderName, amount, subject }
 */
export async function fetchInteracTransfers(fromDate) {
  const client = createImapClient();
  const results = [];

  try {
    await client.connect();
    await client.mailboxOpen("INBOX");

    // Buscar mails del remitente de Interac desde la fecha indicada
    const since = new Date(fromDate);
    since.setHours(0, 0, 0, 0);

    const messages = client.fetch(
      { from: INTERAC_SENDER, since },
      { envelope: true }
    );

    for await (const msg of messages) {
      const subject = msg.envelope?.subject ?? "";
      const date    = msg.envelope?.date ?? null;
      const parsed  = parseInteracSubject(subject);

      if (!parsed) continue; // ignorar mails de Interac que no sean notificaciones de pago

      results.push({
        messageId:  msg.envelope?.messageId ?? null,
        date:       date ? new Date(date).toISOString() : null,
        senderName: parsed.senderName,   // "AMORITA MARIA ADAIR"
        amount:     parsed.amount,        // 283.50
        subject,
      });
    }
  } finally {
    await client.logout();
  }

  return results;
}