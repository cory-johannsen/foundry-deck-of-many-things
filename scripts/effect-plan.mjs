import { applyCardEffect } from './card-effects.mjs';

/**
 * Planning a card effect instead of applying it outright.
 *
 * The GM must be able to back out of any stage of resolution with nothing
 * written to the actor. Handlers, though, decide *and* write in one pass: they
 * roll dice, read current values and call the api as they go. Asking them what
 * they would do therefore means letting them run against an api that records
 * calls rather than performing them.
 *
 * The recorded calls are then replayed on confirmation instead of re-running
 * the handler. That matters for handlers that roll: re-running would roll
 * again, and the GM would be shown one number and dealt another.
 *
 * This is only safe because no handler reads an api return value — every one
 * of them awaits a write and moves on. A handler that starts depending on what
 * the api hands back would need a real read-side here.
 */
export function makeRecordingApi() {
  const calls = [];
  const record = (method) => async (...args) => { calls.push({ method, args }); };
  return {
    calls,
    api: {
      updateActor: record('updateActor'),
      increaseCondition: record('increaseCondition'),
      createEffect: record('createEffect'),
      postChatCard: record('postChatCard')
    }
  };
}

/**
 * Run a card's handler without writing anything.
 * Returns the handler result plus the writes it wanted to make.
 */
export async function planCardEffect({ card, actor, rng = Math.random }) {
  const { api, calls } = makeRecordingApi();
  const result = await applyCardEffect({ card, actor, api, rng, autoApplyEnabled: true });
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
