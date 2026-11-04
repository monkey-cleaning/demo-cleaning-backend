// services/authSession.js
// LAB483 — cuánto dura la sesión que se crea en un login.
//
// Los dos logins (adminAuthRoutes / staffAuthRoutes) firman tokens para los
// dos roles por el cross-login: un cleaner que entra por /admin/login termina
// con token de cleaner y viceversa. Los TTL viven acá para que las cuatro
// ramas no se desincronicen.
//
// "Remember me" no emite un token eterno a propósito: un JWT no se puede
// revocar (no hay lista de sesiones), así que un token sin `exp` quedaría
// válido para siempre si alguien lo copia. Un año cumple lo mismo en la
// práctica — nadie vuelve a loguearse — y le pone un techo.

/** Sesión normal, sin tildar "remember me". Mínimo pedido: 7 días. */
export const DEFAULT_TTL = {
  // El celular del cleaner es personal, no un puesto compartido.
  cleaner: "30d",
  "blog-admin": "7d",
};

/** Con "remember me" tildado. */
export const REMEMBER_ME_TTL = "365d";

const FALLBACK_TTL = "7d";

/** `expiresIn` para jwt.sign(). */
export function sessionTtl(role, rememberMe = false) {
  if (rememberMe) return REMEMBER_ME_TTL;
  return DEFAULT_TTL[role] ?? FALLBACK_TTL;
}

/**
 * El checkbox llega como booleano desde nuestro frontend, pero un form viejo
 * (o un cliente que no lo manda) no tiene que activar la sesión larga sin
 * querer: solo `true` y el string "true" cuentan.
 */
export function parseRememberMe(value) {
  return value === true || value === "true";
}
