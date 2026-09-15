import crypto from "node:crypto";

// ElevenLabs firma sus webhooks con HMAC-SHA256. Header:
//   ElevenLabs-Signature: t=<unix_seconds>,v0=<hex_hmac>[,v0=<hex_hmac>...]
// El mensaje firmado es `${t}.${rawBody}` (rawBody = bytes crudos, sin re-serializar).
// El secreto es el string completo tal cual (incluye el prefijo "wsec_").
// Ventana de tolerancia de timestamp: 30 minutos (anti-replay).
const TOLERANCE_SECONDS = 30 * 60;

/**
 * @param {object} p
 * @param {Buffer|string|undefined} p.rawBody   cuerpo crudo del request
 * @param {string|undefined}        p.signatureHeader  valor de ElevenLabs-Signature
 * @param {string|undefined}        p.secret    ELEVENLABS_WEBHOOK_SECRET (wsec_...)
 * @returns {{ ok: boolean, reason?: string }}
 */
export function verifyElevenLabsSignature({ rawBody, signatureHeader, secret }) {
  if (!secret) return { ok: false, reason: "no secret configured" };
  if (!signatureHeader) return { ok: false, reason: "missing signature header" };
  if (rawBody == null) return { ok: false, reason: "missing raw body" };

  const parts = String(signatureHeader)
    .split(",")
    .map((s) => s.trim());
  const timestamp = parts.find((p) => p.startsWith("t="))?.slice(2);
  const provided = parts
    .filter((p) => p.startsWith("v0="))
    .map((p) => p.slice(3));

  if (!timestamp || provided.length === 0) {
    return { ok: false, reason: "malformed signature header" };
  }

  const ageSeconds = Math.abs(Date.now() / 1000 - Number(timestamp));
  if (!Number.isFinite(ageSeconds) || ageSeconds > TOLERANCE_SECONDS) {
    return { ok: false, reason: "timestamp outside tolerance" };
  }

  const body = Buffer.isBuffer(rawBody)
    ? rawBody.toString("utf8")
    : String(rawBody);

  const expected = crypto
    .createHmac("sha256", secret)
    .update(`${timestamp}.${body}`)
    .digest("hex");
  const expectedBuf = Buffer.from(expected, "hex");

  const match = provided.some((sig) => {
    let sigBuf;
    try {
      sigBuf = Buffer.from(sig, "hex");
    } catch {
      return false;
    }
    return (
      sigBuf.length === expectedBuf.length &&
      crypto.timingSafeEqual(sigBuf, expectedBuf)
    );
  });

  return match ? { ok: true } : { ok: false, reason: "signature mismatch" };
}
