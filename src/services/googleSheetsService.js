import { google } from "googleapis";

function getServiceAccountCredsFromB64() {
  const b64 = process.env.GOOGLE_SERVICE_ACCOUNT_JSON_B64;
  if (!b64) {
    throw new Error("Missing GOOGLE_SERVICE_ACCOUNT_JSON_B64");
  }

  const jsonStr = Buffer.from(b64, "base64").toString("utf8");
  const creds = JSON.parse(jsonStr);

  // clave privada con saltos de línea correctos
  if (creds.private_key) {
    creds.private_key = creds.private_key.replace(/\\n/g, "\n");
  }

  return creds;
}

export async function getProgramacionesData() {
  const creds = getServiceAccountCredsFromB64();

  const auth = new google.auth.GoogleAuth({
    credentials: creds,
    scopes: ["https://www.googleapis.com/auth/spreadsheets.readonly"],
  });

  const sheets = google.sheets({ version: "v4", auth });

  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: "1AvH9Wqnn43Hxq3wQ3wZUiCLcrwly1ueau3PM7QYacL8",
    range: "Programaciones!A:H",
  });

  return res.data.values || [];
}
