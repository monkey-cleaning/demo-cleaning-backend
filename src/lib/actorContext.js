// lib/actorContext.js
//
// LAB418 (portado de Monkey Cleaning) — contexto de "quién está haciendo este
// cambio", propagado sin tener que pasarlo por la firma de cada función.
//
// - En requests del panel: lo setea `requireAdmin` con el usuario del JWT.
// - En requests del portal de cleaners: lo setea `requireCleaner`.
// - En jobs/crons: cada job envuelve su corrida con runWithActor(...).
// - En rutas públicas: se setea actor 'client' / source 'public'.
//
// Si nadie lo setea (script suelto, camino no cubierto), getActor() devuelve
// 'system' y getSource() devuelve 'platform' — nunca tira.

import { AsyncLocalStorage } from "node:async_hooks";

/** @typedef {{ actor: string, source?: string }} ActorContext */

/** @type {AsyncLocalStorage<ActorContext>} */
const storage = new AsyncLocalStorage();

/**
 * Corre `fn` con el contexto de actor dado. Todo lo que se ejecute dentro
 * (incluidos los await encadenados) ve ese actor vía getActor().
 *
 * @param {ActorContext} ctx
 * @param {(...args: any[]) => any} fn
 */
export function runWithActor(ctx, fn) {
  return storage.run({ source: "platform", ...ctx }, fn);
}

/** Usuario actual: 'yudith1', 'tech', 'cron', 'client'... */
export function getActor() {
  return storage.getStore()?.actor ?? "system";
}

/** Origen del cambio: 'platform' | 'cron' | 'public'. */
export function getSource() {
  return storage.getStore()?.source ?? "platform";
}
