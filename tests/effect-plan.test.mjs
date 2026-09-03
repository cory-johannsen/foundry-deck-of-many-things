import { describe, it, expect } from 'vitest';
import { makeRecordingApi, planCardEffect, replayPlan } from '../scripts/effect-plan.mjs';

const cardOf = (kind, params, name = 'Test') => ({
  id: 'test', name, rules: { full: '' }, mechanics: { kind, params }
});

const actorOf = (system) => ({ id: 'a1', name: 'Target', system });

/** Records what the real api would have been asked to do. */
const spyApi = () => {
  const done = [];
  const rec = (m) => async (...args) => { done.push({ method: m, args }); };
  return {
    done,
    updateActor: rec('updateActor'),
    increaseCondition: rec('increaseCondition'),
    createEffect: rec('createEffect'),
    postChatCard: rec('postChatCard')
  };
};

describe('planCardEffect — decides without writing', () => {
  it('reports the outcome while leaving the actor untouched', async () => {
    const actor = actorOf({ movement: { speeds: { land: { value: 25 } } } });
    const plan = await planCardEffect({
      card: cardOf('speed_bonus', { walk_ft: 10 }, 'Path'), actor
    });
    expect(plan.result.log).toBe('Path: land Speed 25 → 35 ft');
    expect(plan.calls).toHaveLength(1);
    // The plan is a description; the actor still reads 25.
    expect(actor.system.movement.speeds.land.value).toBe(25);
  });

  it('captures the write it intended to make', async () => {
    const plan = await planCardEffect({
      card: cardOf('speed_bonus', { walk_ft: 10 }), actor: actorOf({ movement: { speeds: { land: { value: 25 } } } })
    });
    expect(plan.calls[0].method).toBe('createEffect');
    expect(plan.calls[0].args[1].system.rules[0])
      .toEqual({ key: 'FlatModifier', selector: 'land-speed', type: 'status', value: 10 });
  });

  it('plans nothing for a card that needs a GM decision first', async () => {
    const plan = await planCardEffect({
      card: cardOf('stat_bump', { ability: 'any', delta_mod: 1 }), actor: actorOf({})
    });
    expect(plan.result.mode).toBe('gm');
    expect(plan.calls).toHaveLength(0);
  });
});

describe('replayPlan — the only thing that writes', () => {
  it('performs the planned calls in order', async () => {
    const api = spyApi();
    const plan = await planCardEffect({
      card: cardOf('speed_bonus', { walk_ft: 10 }), actor: actorOf({ movement: { speeds: { land: { value: 25 } } } })
    });
    await replayPlan(plan.calls, api);
    expect(api.done).toHaveLength(1);
    expect(api.done[0].method).toBe('createEffect');
  });

  it('writes nothing when a cancelled plan is never replayed', async () => {
    const api = spyApi();
    await planCardEffect({
      card: cardOf('speed_bonus', { walk_ft: 10 }), actor: actorOf({ movement: { speeds: { land: { value: 25 } } } })
    });
    // GM cancelled: replayPlan is simply not called.
    expect(api.done).toHaveLength(0);
  });

  it('applies exactly the number the GM was shown, not a fresh roll', async () => {
    // A handler that rolls would roll again if the handler were re-run on
    // confirm. Replaying the plan is what keeps preview and outcome identical.
    const rolls = [6, 2];
    let i = 0;
    const rng = () => { const v = rolls[Math.min(i, rolls.length - 1)] / 6; i += 1; return v - 1e-9; };
    const actor = actorOf({ abilities: { str: { mod: 3 } } });
    const plan = await planCardEffect({
      card: cardOf('stat_debuff', { ability: 'str', delta_formula: '1d6' }), actor, rng
    });
    const shown = plan.calls[0].args[1]['system.abilities.str.mod'];
    const api = spyApi();
    await replayPlan(plan.calls, api);
    expect(api.done[0].args[1]['system.abilities.str.mod']).toBe(shown);
    expect(plan.result.log).toContain(`→ ${shown}`);
  });

  it('refuses to replay a call the api does not implement', async () => {
    await expect(replayPlan([{ method: 'nope', args: [] }], spyApi()))
      .rejects.toThrow(/unknown api call: nope/);
  });
});

describe('makeRecordingApi', () => {
  it('records every api method a handler may reach for', async () => {
    const { api, calls } = makeRecordingApi();
    await api.updateActor('a', { x: 1 });
    await api.increaseCondition('a', 'clumsy', 1);
    await api.createEffect('a', { name: 'e' });
    await api.postChatCard({ content: 'c' });
    expect(calls.map((c) => c.method))
      .toEqual(['updateActor', 'increaseCondition', 'createEffect', 'postChatCard']);
  });
});
