import { test } from "node:test";
import assert from "node:assert/strict";

import { sessionTtl, parseRememberMe, REMEMBER_ME_TTL } from "../src/services/authSession.js";

test("sesión normal: cleaner 30 días, admin 7 días (mínimo pedido en LAB483)", () => {
  assert.equal(sessionTtl("cleaner"), "30d");
  assert.equal(sessionTtl("blog-admin"), "7d");
});

test('"remember me" alarga la sesión para los dos roles', () => {
  assert.equal(sessionTtl("cleaner", true), REMEMBER_ME_TTL);
  assert.equal(sessionTtl("blog-admin", true), REMEMBER_ME_TTL);
});

test("un rol desconocido no se queda sin vencimiento", () => {
  assert.equal(sessionTtl("otro"), "7d");
});

test("solo true o 'true' activan la sesión larga", () => {
  assert.equal(parseRememberMe(true), true);
  assert.equal(parseRememberMe("true"), true);
  for (const v of [undefined, null, false, "false", "on", 1, "1", {}]) {
    assert.equal(parseRememberMe(v), false, `${JSON.stringify(v)} no debería activarla`);
  }
});
