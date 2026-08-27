// ─────────────────────────────────────────────────────────────────────────────
// recaptchaService.js
//
// Verificación de reCAPTCHA v3 compartida por leadController (formulario de
// cotización) y availabilityController (reserva desde /available).
//
// Antes había una copia en cada controlador. La de availabilityController era
// una versión reducida que devolvía `data.success && score >= 0.5` sin loguear
// nada, así que cuando una reserva fallaba no quedaba ni rastro del motivo. Esa
// diferencia costó cara: el diagnóstico de un fallo de dominio en el formulario
// salió directo del log de la otra copia, y en el flujo de reserva no habría
// existido.
//
// El umbral sale de RECAPTCHA_MIN_SCORE (default 0.5, el valor que ya usaban
// ambas copias) para poder aflojarlo sin redeploy si Google empieza a puntuar
// bajo a usuarios legítimos.
// ─────────────────────────────────────────────────────────────────────────────

const RECAPTCHA_SECRET = process.env.RECAPTCHA_SECRET_KEY;

const DEFAULT_MIN_SCORE = 0.5;

function resolveMinScore() {
  const raw = Number(process.env.RECAPTCHA_MIN_SCORE);
  if (Number.isFinite(raw) && raw >= 0 && raw <= 1) return raw;
  if (process.env.RECAPTCHA_MIN_SCORE) {
    console.warn(
      `[reCAPTCHA] RECAPTCHA_MIN_SCORE inválido ("${process.env.RECAPTCHA_MIN_SCORE}"), usando ${DEFAULT_MIN_SCORE}`,
    );
  }
  return DEFAULT_MIN_SCORE;
}

/**
 * Valida un token de reCAPTCHA v3 contra Google.
 *
 * Loguea siempre la respuesta cruda de siteverify: los error-codes de Google
 * son el único dato que distingue "secret mal configurado" de "dominio no
 * autorizado" de "score bajo", y sin ellos un fallo es indistinguible.
 *
 * @param {string} token           - el token que mandó el frontend
 * @param {string} [remoteIp]      - req.ip, opcional; mejora el scoring
 * @param {object} [opts]
 * @param {string} [opts.context]  - etiqueta para el log ("lead", "booking")
 * @returns {Promise<boolean>}
 */
export async function verifyRecaptcha(token, remoteIp, { context = "" } = {}) {
  const tag = context ? `[reCAPTCHA:${context}]` : "[reCAPTCHA]";

  if (!RECAPTCHA_SECRET) {
    console.warn(`${tag} RECAPTCHA_SECRET_KEY is not set`);
    return false;
  }

  if (!token) {
    console.warn(`${tag} token vacío`);
    return false;
  }

  const params = new URLSearchParams({
    secret: RECAPTCHA_SECRET,
    response: token,
  });
  if (remoteIp) params.append("remoteip", remoteIp);

  let data;
  try {
    const r = await fetch("https://www.google.com/recaptcha/api/siteverify", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: params,
    });
    data = await r.json();
  } catch (err) {
    // Un fallo de red contra Google no es un usuario sospechoso, pero tampoco
    // podemos dar por buena la verificación: rechazamos y lo dejamos claro en
    // el log para no confundirlo con un token inválido.
    console.error(`${tag} no se pudo contactar a siteverify:`, err.message);
    return false;
  }

  console.log(`${tag} siteverify response:`, JSON.stringify(data));

  if (!data.success) {
    console.warn(`${tag} Verification failed. error-codes:`, data["error-codes"]);
    return false;
  }

  const score = data.score ?? 0;
  const minScore = resolveMinScore();

  console.log(
    `${tag} success=true | score=${score} | action=${data.action} | hostname=${data.hostname}`,
  );

  if (score < minScore) {
    console.warn(`${tag} Score too low: ${score} < ${minScore}`);
    return false;
  }

  return true;
}
