import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { applyCardEffect } from '../scripts/card-effects.mjs';
import { planCardEffect, replayPlan } from '../scripts/effect-plan.mjs';

const cards = JSON.parse(readFileSync(new URL('../data/cards.json', import.meta.url)));
const BY_ID = new Map(cards.map((c) => [c.id, c]));

const actorOf = (over = {}) => ({
  id: 'a1',
  name: 'Target',
  system: {
    details: { xp: { value: 200, max: 1000 }, level: { value: 5 } },
    attributes: { hp: { value: 40, max: 40 } },
    ...over
  }
});

/** Records writes, answers reads from fixtures. */
const makeApi = ({ items = [], creatures = [], carried = [] } = {}) => {
  const spy = { updates: [], conditions: [], effects: [], coins: [], granted: [], removed: [], spawned: [] };
  return {
    spy,
    updateActor: async (_id, u) => { spy.updates.push(u); },
    increaseCondition: async (_id, c, v) => { spy.conditions.push({ c, v }); },
    createEffect: async (_id, e) => { spy.effects.push(e); },
    postChatCard: async () => {},
    addCoins: async (_id, c) => { spy.coins.push(c); },
    grantItems: async (_id, e) => { spy.granted.push(...e); },
    removeItems: async (_id, ids) => { spy.removed.push(...ids); },
    spawnCreatures: async (e, o) => { spy.spawned.push({ e, o }); },
    findItems: async () => items,
    findCreatures: async () => creatures,
    listItems: async () => carried
  };
};

const run = (id, { actor = actorOf(), api = makeApi(), rng = () => 0.5, params = null } = {}) => {
  const card = params
    ? { ...BY_ID.get(id), mechanics: { ...BY_ID.get(id).mechanics, params } }
    : BY_ID.get(id);
  return applyCardEffect({ card, actor, api, rng, confirmGate: false }).then((r) => ({ r, api }));
};

describe('experience', () => {
  it('banks the XP and leaves levelling to the sheet', async () => {
    // Sun grants 2,000. Setting level.value directly would skip the feats and
    // boosts a level carries, leaving a level 7 character with a level 5 build.
    const { r, api } = await run('sun', { api: makeApi({ items: [] }) });
    const u = api.spy.updates[0];
    expect(u['system.details.xp.value']).toBe(2200);
    expect(u['system.details.level.value']).toBeUndefined();
    expect(r.log).toContain('2200/1000');
  });

  it('says how many level-ups are owed, since the bar alone is easy to misread', async () => {
    const { r } = await run('sun', { api: makeApi({ items: [] }) });
    expect(r.log).toContain('level up 2 times');
  });

  it('does not claim a level-up when the grant does not earn one', async () => {
    const card = { ...BY_ID.get('sun'), mechanics: { kind: 'xp_gain', params: { xp: 100 } } };
    const r = await applyCardEffect({
      card, actor: actorOf(), api: makeApi(), rng: () => 0.5, confirmGate: false
    });
    expect(r.log).not.toContain('level up');
  });

  it('drains a level when the loss exceeds progress', async () => {
    const { r, api } = await run('fool');   // 1,000 XP from 200/1000 at level 5
    const u = api.spy.updates[0];
    expect(u['system.details.level.value']).toBe(4);
    expect(u['system.details.xp.value']).toBe(200);
    expect(r.log).toContain('level 5 → 4');
  });

  it('never drains below level 1', async () => {
    const actor = actorOf({ details: { xp: { value: 10, max: 1000 }, level: { value: 1 } } });
    const { api } = await run('fool', { actor });
    const u = api.spy.updates[0];
    expect(u['system.details.level.value']).toBe(1);
    expect(u['system.details.xp.value']).toBe(0);
  });

  it('still banks XP at level 20 without promising a level-up', async () => {
    const actor = actorOf({ details: { xp: { value: 0, max: 1000 }, level: { value: 20 } } });
    const { r, api } = await run('sun', { actor });
    expect(api.spy.updates[0]['system.details.xp.value']).toBe(2000);
    expect(r.log).not.toContain('level up');
  });
});

describe('choices', () => {
  it('asks before granting a hoard rather than picking for the GM', async () => {
    const { r, api } = await run('gem');
    expect(r.mode).toBe('gm');
    expect(r.meta.requires).toBe('choose_option');
    expect(r.meta.options).toHaveLength(2);
    expect(api.spy.coins).toHaveLength(0);      // nothing granted while asking
  });

  it('grants the chosen hoard once the choice is made', async () => {
    const params = { ...BY_ID.get('gem').mechanics.params, chosen: '1' };
    const { api } = await run('gem', { params });
    expect(api.spy.coins[0]).toEqual({ gp: 50000 });
  });

  it('asks which element before granting immunity', async () => {
    const { r } = await run('elemental');
    expect(r.meta.requires).toBe('choose_option');
    expect(r.meta.paramKey).toBe('element');
  });

  it('writes an Immunity rule for the chosen element', async () => {
    const { api } = await run('elemental', { params: { element: 'fire' } });
    expect(api.spy.effects[0].system.rules[0]).toEqual({ key: 'Immunity', type: 'fire' });
  });
});

describe('damage and conditions', () => {
  it('converts the fall to PF2e damage and knocks the target prone', async () => {
    // rng 0.5 on (3d6)*10 -> deterministic; damage is half the distance, capped 75.
    const { r, api } = await run('pit');
    const hp = api.spy.updates[0]['system.attributes.hp.value'];
    const feet = Number(/fell (\d+) ft/.exec(r.log)[1]);
    // HP floors at 0 rather than going negative.
    expect(hp).toBe(Math.max(40 - Math.min(Math.floor(feet / 2), 75), 0));
    expect(api.spy.conditions).toContainEqual({ c: 'prone', v: 1 });
  });

  it('caps fall damage at 75', async () => {
    const { api } = await run('pit', { params: { distance_ft_formula: '1000' } });
    expect(api.spy.updates[0]['system.attributes.hp.value']).toBe(0);
  });

  it('petrifies rather than describing petrification', async () => {
    const { api } = await run('statue');
    expect(api.spy.conditions).toContainEqual({ c: 'petrified', v: 1 });
  });
});

describe('item grants', () => {
  const items = [
    { pack: 'p', id: '1', name: 'Flaming Sword', type: 'weapon', level: 5, rarity: 'uncommon', traits: ['magical'] },
    { pack: 'p', id: '2', name: 'Dull Blade', type: 'weapon', level: 2, rarity: 'uncommon', traits: ['magical'] }
  ];

  it('grants a real item and names it in the log', async () => {
    const { r, api } = await run('key', { api: makeApi({ items }), rng: () => 0 });
    expect(api.spy.granted).toEqual([{ pack: 'p', id: '1' }]);
    expect(r.log).toContain('Flaming Sword');
  });

  it('falls back to the GM when the compendium has nothing suitable', async () => {
    const { r, api } = await run('key', { api: makeApi({ items: [] }) });
    expect(r.mode).toBe('gm');
    expect(api.spy.granted).toHaveLength(0);
  });

  it('refuses a merely uncommon weapon that is not magical', async () => {
    // Key asked for a magic weapon and was handed a level 0 Thundermace:
    // uncommon, but mundane. Rarity is not magic.
    const mundane = [{ pack: 'p', id: 'x', name: 'Thundermace', type: 'weapon',
                       level: 0, rarity: 'uncommon', traits: [] }];
    const { r, api } = await run('key', { api: makeApi({ items: mundane }) });
    expect(api.spy.granted).toHaveLength(0);
    expect(r.mode).toBe('gm');
    expect(r.log).toContain('no magical');
  });

  it('prefers items the character could actually use', async () => {
    const spread = [
      { pack: 'p', id: 'low', name: 'Handy Blade', type: 'weapon', level: 4, rarity: 'uncommon', traits: ['magical'] },
      { pack: 'p', id: 'high', name: 'Staff of Ruin', type: 'weapon', level: 19, rarity: 'rare', traits: ['magical'] }
    ];
    // findItems honours maxLevel, as the real one does.
    const api = { ...makeApi({ items: spread }),
      findItems: async ({ maxLevel = null } = {}) =>
        spread.filter((i) => maxLevel == null || i.level <= maxLevel) };
    const seen = [];
    api.grantItems = async (_i, e) => { seen.push(...e); };
    await applyCardEffect({ card: BY_ID.get('key'), actor: actorOf(), api, rng: () => 0.999, confirmGate: false });
    expect(seen[0].id).toBe('low');    // level 5 actor: 19 is out of band
  });

  it('destroys only what the actor actually carries', async () => {
    const carried = [{ id: 'i1', name: 'Wand' }, { id: 'i2', name: 'Cloak' }];
    const { r, api } = await run('talons', { api: makeApi({ carried }) });
    expect(api.spy.removed).toEqual(['i1', 'i2']);
    expect(r.log).toContain('Wand, Cloak');
  });

  it('says so plainly when there is nothing to destroy', async () => {
    const { r, api } = await run('talons', { api: makeApi({ carried: [] }) });
    expect(api.spy.removed).toHaveLength(0);
    expect(r.log).toContain('nothing to destroy');
  });
});

describe('spawning', () => {
  const creatures = [{ pack: 'b', id: 'c1', name: 'Gelatinous Cube', level: 3 }];

  it('places a hostile with hostile disposition', async () => {
    const { api } = await run('ooze', { api: makeApi({ creatures }) });
    expect(api.spy.spawned[0].o.disposition).toBe(-1);
    expect(api.spy.spawned[0].o.nearActorId).toBe('a1');
  });

  it('places an ally as friendly', async () => {
    const { api } = await run('knight', { api: makeApi({ creatures }) });
    expect(api.spy.spawned[0].o.disposition).toBe(1);
  });

  it('defers to the GM when the bestiary yields nothing', async () => {
    const { r } = await run('monstrosity', { api: makeApi({ creatures: [] }) });
    expect(r.mode).toBe('gm');
  });
});

describe('planning covers the new handlers too', () => {
  it('names the item in the plan and grants that same item on replay', async () => {
    const items = [{ pack: 'p', id: '1', name: 'Flaming Sword', type: 'weapon', level: 5, rarity: 'uncommon', traits: ['magical'] }];
    const real = makeApi({ items });
    const plan = await planCardEffect({ card: BY_ID.get('key'), actor: actorOf(), api: real });

    expect(plan.result.log).toContain('Flaming Sword');
    expect(real.spy.granted).toHaveLength(0);      // planning wrote nothing

    await replayPlan(plan.calls, real);
    expect(real.spy.granted).toEqual([{ pack: 'p', id: '1' }]);
  });

  it('reads compendia during planning even though writes are held', async () => {
    let reads = 0;
    const real = { ...makeApi(), findCreatures: async () => { reads += 1; return [{ pack: 'b', id: 'c1', name: 'Wraith', level: 6 }]; } };
    const plan = await planCardEffect({ card: BY_ID.get('undead'), actor: actorOf(), api: real });
    expect(reads).toBeGreaterThan(0);
    expect(plan.result.log).toContain('Wraith');
    expect(plan.calls.map((c) => c.method)).toContain('spawnCreatures');
  });
});

describe('beast form', () => {
  const forms = [
    { pack: 'pf2e.spell-effects', id: 'f1', name: 'Spell Effect: Animal Form (Bear)', type: 'effect', level: 2, rarity: 'common' },
    { pack: 'pf2e.spell-effects', id: 'f2', name: 'Spell Effect: Animal Form (Shark)', type: 'effect', level: 2, rarity: 'common' },
    { pack: 'pf2e.spell-effects', id: 'f3', name: 'Spell Effect: Dragon Form', type: 'effect', level: 6, rarity: 'common' }
  ];

  it('grants a real battle form rather than a note to the GM', async () => {
    const { r, api } = await run('beast', { api: makeApi({ items: forms }), rng: () => 0 });
    expect(r.mode).toBe('auto');
    expect(api.spy.granted[0].pack).toBe('pf2e.spell-effects');
    expect(r.log).toContain('bear');
  });

  it('only ever picks an Animal Form, never Dragon Form', async () => {
    // rng at the top of the range would reach Dragon Form if it were in the pool.
    const { api } = await run('beast', { api: makeApi({ items: forms }), rng: () => 0.999 });
    expect(['f1', 'f2']).toContain(api.spy.granted[0].id);
  });

  it('replaces the spell duration with the card roll, in days', async () => {
    const { r, api } = await run('beast', { api: makeApi({ items: forms }) });
    const days = Number(/for (\d+) days/.exec(r.log)[1]);
    expect(days).toBeGreaterThanOrEqual(2);
    expect(days).toBeLessThanOrEqual(24);
    expect(api.spy.granted[0].updates['system.duration'])
      .toMatchObject({ value: days, unit: 'days' });
  });

  it('is held for confirmation, since it replaces the character for weeks', async () => {
    const res = await applyCardEffect({
      card: BY_ID.get('beast'), actor: actorOf(), api: makeApi({ items: forms })
    });
    expect(res.mode).toBe('gm');
    expect(res.meta.kind).toBe('needs_confirm');
  });

  it('falls back to the GM when no form is installed', async () => {
    const { r } = await run('beast', { api: makeApi({ items: [] }) });
    expect(r.mode).toBe('gm');
    expect(r.log).toMatch(/transform by hand for \d+ days/);
  });
});

describe('spawning asks for the right kind of creature', () => {
  // A bestiary stub that honours the trait filter, so a handler reaching for
  // the wrong kind gets nothing rather than silently getting a mantis.
  const bestiary = (creatures) => ({
    ...makeApi(),
    spy: undefined,
    findCreatures: async ({ traits = [], minLevel = null, maxLevel = null } = {}) =>
      creatures.filter((c) =>
        (!traits.length || traits.some((t) => c.traits.includes(t)))
        && (minLevel == null || c.level >= minLevel)
        && (maxLevel == null || c.level <= maxLevel))
  });

  const world = [
    { pack: 'b', id: 'mantis', name: 'Giant Mantis', level: 3, traits: ['animal'] },
    { pack: 'b', id: 'wight', name: 'Wight', level: 5, traits: ['undead'] },
    { pack: 'b', id: 'ghoul', name: 'Ghoul', level: 4, traits: ['undead'] },
    { pack: 'b', id: 'cube', name: 'Gelatinous Cube', level: 6, traits: ['ooze'] }
  ];

  const spawnSpy = (api) => {
    const seen = [];
    return [{ ...api, spawnCreatures: async (e, o) => { seen.push({ e, o }); } }, seen];
  };

  it('spawns an undead for Undead, never an animal', async () => {
    // The exact regression: PF2e names no undead "revenant" or "wraith", so a
    // name filter found nothing and fell through to a Giant Mantis.
    const [api, seen] = spawnSpy(bestiary(world));
    for (const rng of [() => 0, () => 0.5, () => 0.999]) {
      await applyCardEffect({ card: BY_ID.get('undead'), actor: actorOf(), api, rng, confirmGate: false });
    }
    const ids = seen.map((s) => s.e[0].id);
    expect(ids).not.toContain('mantis');
    expect(ids.every((id) => ['wight', 'ghoul'].includes(id))).toBe(true);
  });

  it('spawns an ooze for Ooze', async () => {
    const [api, seen] = spawnSpy(bestiary(world));
    await applyCardEffect({ card: BY_ID.get('ooze'), actor: actorOf(), api, rng: () => 0.5, confirmGate: false });
    expect(seen[0].e[0].id).toBe('cube');
  });

  it('gives up rather than substituting when the kind is absent', async () => {
    const [api, seen] = spawnSpy(bestiary([world[0]]));   // only an animal exists
    const res = await applyCardEffect({
      card: BY_ID.get('undead'), actor: actorOf(), api, rng: () => 0.5, confirmGate: false
    });
    expect(seen).toHaveLength(0);
    expect(res.mode).toBe('gm');
    expect(res.log).toContain('undead');
  });

  it('widens the level band before giving up, but never the kind', async () => {
    // Skull wants undead at level 8-16; only a level 5 undead exists.
    const [api, seen] = spawnSpy(bestiary([world[0], world[1]]));
    const res = await applyCardEffect({
      card: BY_ID.get('skull'), actor: actorOf(), api, rng: () => 0.5, confirmGate: false
    });
    expect(seen[0].e[0].id).toBe('wight');
    expect(res.log).toContain('outside the usual level');
  });
});
