import { google } from "googleapis";

export function getCalendarClient() {
  const clientEmail = process.env.GCAL_CLIENT_EMAIL;
  let privateKey = process.env.GCAL_PRIVATE_KEY;
  const subject = process.env.GCAL_IMPERSONATE_USER; // admin@monkeycleaning.com

  if (!clientEmail || !privateKey || !subject) {
    throw new Error("Missing GCAL_CLIENT_EMAIL / GCAL_PRIVATE_KEY / GCAL_IMPERSONATE_USER env vars");
  }

  privateKey = privateKey.replace(/\\n/g, "\n");

  const auth = new google.auth.JWT({
    email: clientEmail,
    key: privateKey,
    scopes: [
      "https://www.googleapis.com/auth/calendar",
    ],
    subject,
  });

  return google.calendar({ version: "v3", auth });
}