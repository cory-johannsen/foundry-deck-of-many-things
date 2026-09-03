import { applyCardEffect } from './card-effects.mjs';
import { WRITE_METHODS, READ_METHODS } from './foundry-api.mjs';

/**
 * Planning a card effect instead of applying it outright.
 *
 * The GM must be able to back out of any stage of resolution with nothing
 * written to the actor. Handlers, though, decide *and* write in one pass: they
 * roll dice, pick items out of compendia, read current values and call the api
 * as they go. Asking them what they would do therefore means letting them run
 * against an api whose writes are recorded rather than performed.
 *
 * Reads still happen for real. A handler that grants "a random magic weapon"
 * has to pick the weapon while planning, or the GM would be asked to approve
 * an unnamed item — and the weapon picked during planning is the one recorded,
 * so the confirmation and the outcome always name the same thing.
 *
 * The recorded calls are replayed on confirmation rather than the handler
 * being re-run. That matters wherever a handler rolls or chooses at random:
 * re-running would roll again, and the GM would be shown one result and dealt
 * another.
 *
 * This is only safe because no handler reads a *write* method's return value —
 * every one of them awaits a write and moves on.
 */
export function makeRecordingApi(realApi = null) {
  const calls = [];
  const api = {};
  for (const m of WRITE_METHODS) {
    api[m] = async (...args) => { calls.push({ method: m, args }); };
  }
  for (const m of READ_METHODS) {
    api[m] = async (...args) => (realApi?.[m] ? realApi[m](...args) : []);
  }
  return { calls, api };
}

/**
 * Run a card's handler without writing anything.
 * Returns the handler result plus the writes it wanted to make.
 */
export async function planCardEffect({ card, actor, rng = Math.random, api: realApi = null }) {
  const { api, calls } = makeRecordingApi(realApi);
  const result = await applyCardEffect({
    card, actor, api, rng, autoApplyEnabled: true, confirmGate: false
  });
  return { result, calls };
}

/** Perform a plan's recorded writes, in order, against the real api. */
export async function replayPlan(calls, api) {
  for (const { method, args } of calls) {
    const fn = api[method];
    if (typeof fn !== 'function') {
      throw new Error(`Cannot replay unknown api call: ${method}`);
    }
    await fn(...args);
  }
  return calls.length;
}
