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
const makeApi = ({ items = [], creatures = [], carried = [], worldActors = [], languages = [], coins = {}, gear = [] } = {}) => {
  const spy = { updates: [], conditions: [], effects: [], coins: [], granted: [], removed: [], spawned: [], innate: [], coinsRemoved: [], etched: [], built: [] };
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
    grantInnateSpells: async (_i, e, o) => { spy.innate.push({ e, o }); },
    listLanguages: async () => languages,
    getCoins: async () => coins,
    listGear: async () => gear,
    etchRune: async (_i, id, slug) => { spy.etched.push({ id, slug }); },
    spawnBuiltCreature: async (d, o) => { spy.built.push({ d, o }); },
    removeCoins: async (_i, c) => { spy.coinsRemoved.push(c); },
    findItems: async () => items,
    findCreatures: async () => creatures,
    listItems: async () => carried,
    findWorldActors: async () => worldActors,
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
  it('rolls the hoard instead of asking — both piles are worth the same', async () => {
    const { r, api } = await run('gem');
    expect(r.mode).toBe('auto');
    expect(api.spy.coins[0]).toEqual({ gp: 50000 });
  });

  it('still honours an explicit choice, for a GM who wants to pick', async () => {
    const params = { ...BY_ID.get('gem').mechanics.params, chosen: '0' };
    const { r } = await run('gem', { params });
    expect(r.log).toMatch(/jewelry/);
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
    const { api } = await run('construct', { api: makeApi({ creatures }) });
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
    const plan = await planCardEffect({ card: BY_ID.get('skull'), actor: actorOf(), api: real });
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

  it('applies without asking', async () => {
    const res = await applyCardEffect({
      card: BY_ID.get('beast'), actor: actorOf(), api: makeApi({ items: forms })
    });
    expect(res.mode).toBe('auto');
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

  it('spawns an undead for Skull, never an animal', async () => {
    // The exact regression: PF2e names no undead "revenant" or "wraith", so a
    // name filter found nothing and fell through to a Giant Mantis.
    const [api, seen] = spawnSpy(bestiary(world));
    for (const rng of [() => 0, () => 0.5, () => 0.999]) {
      await applyCardEffect({ card: BY_ID.get('skull'), actor: actorOf(), api, rng, confirmGate: false });
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
      card: BY_ID.get('skull'), actor: actorOf(), api, rng: () => 0.5, confirmGate: false
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

describe('spawning prefers the world over the compendium', () => {
  // The SRD bestiaries ship no token art, so a compendium summon arrives as
  // the default silhouette. Fiend produced an artless Hellwasp Swarm.
  const worldNpc = { id: 'w1', name: 'Aller Rosk', level: 5, hasArt: true, folder: 'Otari' };
  const packNpc = { pack: 'b', id: 'c1', name: 'Generic Thug', level: 5, traits: ['humanoid'] };

  const api = ({ world = [], pack = [] } = {}) => {
    const spawned = [];
    return [{
      ...makeApi(),
      findWorldActors: async () => world,
      findCreatures: async () => pack,
      spawnCreatures: async (e, o) => { spawned.push({ e, o }); }
    }, spawned];
  };

  it('takes a world NPC when one fits, and spawns it by actor id', async () => {
    const [a, spawned] = api({ world: [worldNpc], pack: [packNpc] });
    const r = await applyCardEffect({ card: BY_ID.get('construct'), actor: actorOf(), api: a, rng: () => 0.5, confirmGate: false });
    expect(spawned[0].e[0]).toEqual({ actorId: 'w1' });
    expect(r.meta.source).toBe('world');
    expect(r.log).toContain('Aller Rosk');
  });

  it('falls back to the compendium when the world has nobody suitable', async () => {
    const [a, spawned] = api({ world: [], pack: [packNpc] });
    const r = await applyCardEffect({ card: BY_ID.get('construct'), actor: actorOf(), api: a, rng: () => 0.5, confirmGate: false });
    expect(spawned[0].e[0]).toEqual({ pack: 'b', id: 'c1' });
    expect(r.meta.source).toBe('compendium');
  });

  it('gives up rather than spawning the wrong kind, world or not', async () => {
    const [a, spawned] = api({ world: [], pack: [] });
    const r = await applyCardEffect({ card: BY_ID.get('skull'), actor: actorOf(), api: a, rng: () => 0.5, confirmGate: false });
    expect(spawned).toHaveLength(0);
    expect(r.mode).toBe('gm');
  });
});

describe('Rogue turns an existing NPC against you', () => {
  const world = [
    { id: 'n1', name: 'Aller Rosk', level: 5, folder: 'Otari', hasArt: true },
    { id: 'n2', name: 'Augrael', level: 3, folder: 'Otari', hasArt: true }
  ];
  const api = (worldActors) => {
    const spy = { effects: [], chat: [], spawned: [] };
    return [{
      ...makeApi(),
      findWorldActors: async () => worldActors,
      createEffect: async (_i, e) => { spy.effects.push(e); },
      postChatCard: async (p) => { spy.chat.push(p); },
      spawnCreatures: async (e, o) => { spy.spawned.push({ e, o }); }
    }, spy];
  };

  it('picks from the world and places no token', async () => {
    const [a, spy] = api(world);
    const r = await applyCardEffect({ card: BY_ID.get('rogue'), actor: actorOf(), api: a, rng: () => 0, confirmGate: false });
    expect(spy.spawned).toHaveLength(0);
    expect(r.meta.enemyId).toBe('n1');
  });

  it('keeps the identity out of the public log and the effect', async () => {
    const [a, spy] = api(world);
    const r = await applyCardEffect({ card: BY_ID.get('rogue'), actor: actorOf(), api: a, rng: () => 0, confirmGate: false });
    expect(r.log).not.toContain('Aller Rosk');
    expect(JSON.stringify(spy.effects)).not.toContain('Aller Rosk');
  });

  it('tells the GM who, in a whisper', async () => {
    const [a, spy] = api(world);
    const r = await applyCardEffect({ card: BY_ID.get('rogue'), actor: actorOf(), api: a, rng: () => 0, confirmGate: false });
    expect(spy.chat[0].whisperGM).toBe(true);
    expect(spy.chat[0].content).toContain('Aller Rosk');
    expect(r.gmNote).toContain('Aller Rosk');
  });

  it('asks the GM when the world has no NPCs at all', async () => {
    const [a, spy] = api([]);
    const r = await applyCardEffect({ card: BY_ID.get('rogue'), actor: actorOf(), api: a, rng: () => 0.5, confirmGate: false });
    expect(r.mode).toBe('gm');
    expect(spy.effects).toHaveLength(0);
  });
});

describe('Ruin actually takes the wealth', () => {
  // It used to stamp a timestamp on the actor and ask the GM to do it by hand.
  const carried = [
    { id: 't1', name: 'Emerald', type: 'treasure' },
    { id: 't2', name: 'Ivory', type: 'treasure' }
  ];
  const api = ({ coins = {}, items = [] } = {}) => {
    const spy = { removedItems: [], removedCoins: [] };
    return [{
      ...makeApi(),
      getCoins: async () => coins,
    listGear: async () => gear,
    etchRune: async (_i, id, slug) => { spy.etched.push({ id, slug }); },
    spawnBuiltCreature: async (d, o) => { spy.built.push({ d, o }); },
      removeCoins: async (_i, c) => { spy.removedCoins.push(c); },
      listItems: async () => items,
      removeItems: async (_i, ids) => { spy.removedItems.push(...ids); }
    }, spy];
  };

  it('takes the coins', async () => {
    const [a, spy] = api({ coins: { gp: 100, sp: 5 } });
    const r = await applyCardEffect({ card: BY_ID.get('ruin'), actor: actorOf(), api: a, rng: () => 0.5, confirmGate: false });
    expect(spy.removedCoins[0]).toEqual({ gp: 100, sp: 5 });
    expect(r.log).toContain('100 gp');
  });

  it('takes the mundane valuables', async () => {
    const [a, spy] = api({ items: carried });
    const r = await applyCardEffect({ card: BY_ID.get('ruin'), actor: actorOf(), api: a, rng: () => 0.5, confirmGate: false });
    expect(spy.removedItems).toEqual(['t1', 't2']);
    expect(r.log).toContain('Emerald, Ivory');
  });

  it('asks only for non-magical treasure, never the enchanted gear', async () => {
    const asked = [];
    const [a] = api();
    a.listItems = async (_i, opts) => { asked.push(opts); return []; };
    await applyCardEffect({ card: BY_ID.get('ruin'), actor: actorOf(), api: a, rng: () => 0.5, confirmGate: false });
    expect(asked).toContainEqual({ types: ['treasure'], magical: 'exclude' });
  });

  it('says so plainly when there is nothing mundane to lose', async () => {
    const [a, spy] = api({ coins: { gp: 0 }, items: [] });
    const r = await applyCardEffect({ card: BY_ID.get('ruin'), actor: actorOf(), api: a, rng: () => 0.5, confirmGate: false });
    expect(spy.removedCoins).toHaveLength(0);
    expect(spy.removedItems).toHaveLength(0);
    expect(r.log).toContain('nothing mundane left to lose');
  });

  it('applies without asking — it does one definite thing', async () => {
    const [a, spy] = api({ coins: { gp: 100 }, items: carried });
    const r = await applyCardEffect({ card: BY_ID.get('ruin'), actor: actorOf(), api: a });
    expect(r.mode).toBe('auto');
    expect(spy.removedCoins).toHaveLength(1);
  });
});

describe('Ruin does not take the same money twice', () => {
  it('leaves coin items to the coin api', async () => {
    // PF2e keeps coins as treasure items: "Gold Pieces" sits in the same list
    // as a gemstone, so listing treasure naively removes coin a second time.
    const { makeFoundryApi } = await import('../scripts/foundry-api.mjs');
    const items = [
      { id: 'c1', name: 'Gold Pieces', type: 'treasure', isCoinage: true, system: { stackGroup: 'coins', traits: {} } },
      { id: 'g1', name: 'Hematite', type: 'treasure', isCoinage: false, system: { stackGroup: 'gems', traits: {} } }
    ];
    globalThis.game = { actors: { get: () => ({ items, inventory: {} }) } };
    const listed = await makeFoundryApi().listItems('a1', { types: ['treasure'], magical: 'exclude' });
    expect(listed.map((i) => i.name)).toEqual(['Hematite']);
    delete globalThis.game;
  });
});

describe('runes go onto what the character wields', () => {
  // Stairway granted "Giant-Killing", which is a weapon property rune, not an
  // object. PF2e models it as plain `equipment` with only a `magical` trait —
  // nothing marks it as a rune except its usage.
  const rune = { pack: 'p', id: 'r1', name: 'Giant-Killing', type: 'equipment', level: 8,
                 rarity: 'rare', traits: ['magical'], usage: 'etched-onto-a-weapon',
                 slug: 'giant-killing' };
  const thing = { pack: 'p', id: 't1', name: 'Cloak of Elvenkind', type: 'equipment', level: 7,
                  rarity: 'uncommon', traits: ['magical'], usage: 'worncloak', slug: 'cloak' };

  const withGear = (items, gear) => {
    const spy = { granted: [], etched: [] };
    return [{
      ...makeApi(),
      findItems: async () => items,
      listGear: async () => gear,
      grantItems: async (_i, e) => { spy.granted.push(...e); },
      etchRune: async (_i, id, slug) => { spy.etched.push({ id, slug }); }
    }, spy];
  };
  const axe = { id: 'w1', name: 'Battle Axe', type: 'weapon', wielded: true, propertyRunes: [] };
  const spare = { id: 'w2', name: 'Spare Dagger', type: 'weapon', wielded: false, propertyRunes: [] };

  const draw = (api) => applyCardEffect({
    card: BY_ID.get('stairway'), actor: actorOf(), api, rng: () => 0, confirmGate: false });

  it('etches the rune onto the weapon rather than handing it over loose', async () => {
    const [api, spy] = withGear([rune], [axe]);
    const r = await draw(api);
    expect(spy.etched).toEqual([{ id: 'w1', slug: 'giant-killing' }]);
    expect(spy.granted).toHaveLength(0);
    expect(r.log).toContain('etched onto your Battle Axe');
  });

  it('prefers the weapon actually in hand', async () => {
    const [api, spy] = withGear([rune], [spare, axe]);
    await draw(api);
    expect(spy.etched[0].id).toBe('w1');
  });

  it('uses a carried weapon when none is wielded', async () => {
    const [api, spy] = withGear([rune], [spare]);
    await draw(api);
    expect(spy.etched[0].id).toBe('w2');
  });

  it('picks something else when there is nothing to etch onto', async () => {
    // A rune granted to someone with no weapon is an inert object.
    const [api, spy] = withGear([rune, thing], []);
    const r = await draw(api);
    expect(spy.etched).toHaveLength(0);
    expect(spy.granted).toEqual([{ pack: 'p', id: 't1' }]);
    expect(r.log).toContain('Cloak of Elvenkind');
  });

  it('still grants ordinary items as objects', async () => {
    const [api, spy] = withGear([thing], [axe]);
    await draw(api);
    expect(spy.granted).toEqual([{ pack: 'p', id: 't1' }]);
    expect(spy.etched).toHaveLength(0);
  });
});

describe('rune keys and fundamentals', () => {
  it('converts a compendium slug into the key a weapon expects', async () => {
    // PF2e stores whatever slug it is handed and applies nothing when the two
    // disagree, so a wrong key looks exactly like a working one.
    const { runeKey } = await import('../scripts/foundry-api.mjs');
    expect(runeKey('giant-killing')).toBe('giantKilling');
    expect(runeKey('hauling')).toBe('hauling');
  });

  it('moves a grade to the front, as the system keys it', async () => {
    const { runeKey } = await import('../scripts/foundry-api.mjs');
    expect(runeKey('giant-killing-greater')).toBe('greaterGiantKilling');
    expect(runeKey('corrosive-major')).toBe('majorCorrosive');
    expect(runeKey('flaming-lesser')).toBe('lesserFlaming');
  });

  it('copes with an empty or missing slug', async () => {
    const { runeKey } = await import('../scripts/foundry-api.mjs');
    expect(runeKey('')).toBe('');
    expect(runeKey(null)).toBe('');
  });

  it('never offers a fundamental rune as a wondrous item', async () => {
    const { isFundamentalRune } = await import('../scripts/card-handlers-extra.mjs');
    // These live in their own fields; etching one as a property does nothing.
    for (const slug of ['mythic-striking', 'mythic-weapon-potency', 'resilient-greater']) {
      expect(isFundamentalRune({ usage: 'etched-onto-a-weapon', slug }), slug).toBe(true);
    }
    expect(isFundamentalRune({ usage: 'etched-onto-a-weapon', slug: 'giant-killing' })).toBe(false);
    expect(isFundamentalRune({ usage: 'worncloak', slug: 'cloak' })).toBe(false);
  });
});

describe('Monstrosity respects the size its card demands', () => {
  // It summoned a Soul Feeder: an aberration of level 10, and Small. The trait
  // and level filters passed it because nothing looked at size.
  const world = [
    { id: 'sf', name: 'Soul Feeder', level: 10, size: 'sm', hasArt: true },
    { id: 'ch', name: 'Chuul', level: 7, size: 'lg', hasArt: true },
    { id: 'fr', name: 'Froghemoth', level: 12, size: 'huge', hasArt: true }
  ];

  const api = (pool) => {
    const spawned = [];
    return [{
      ...makeApi(),
      // A stub that honours minSize, as the real lookup now does.
      findWorldActors: async ({ minSize = null } = {}) => {
        const order = ['tiny', 'sm', 'med', 'lg', 'huge', 'grg'];
        const want = { large: 'lg' }[minSize] ?? minSize;
        return pool.filter((c) => !want || order.indexOf(c.size) >= order.indexOf(want));
      },
      findCreatures: async () => [],
      spawnCreatures: async (e, o) => { spawned.push({ e, o }); }
    }, spawned];
  };

  const draw = (a, rng) => applyCardEffect({
    card: BY_ID.get('monstrosity'), actor: actorOf(), api: a, rng, confirmGate: false });

  it('never summons something Small, whatever the roll', async () => {
    const [a, spawned] = api(world);
    for (const rng of [() => 0, () => 0.5, () => 0.999]) await draw(a, rng);
    expect(spawned.map((s) => s.e[0].actorId)).not.toContain('sf');
  });

  it('summons only Large or larger', async () => {
    const [a, spawned] = api(world);
    for (const rng of [() => 0, () => 0.999]) await draw(a, rng);
    expect(spawned.every((s) => ['ch', 'fr'].includes(s.e[0].actorId))).toBe(true);
  });

  it('gives up rather than shrinking the requirement', async () => {
    // Only a Small candidate exists; the card asks the GM instead.
    const [a, spawned] = api([world[0]]);
    const r = await draw(a, () => 0.5);
    expect(spawned).toHaveLength(0);
    expect(r.mode).toBe('gm');
    expect(r.log).toContain('large or larger');
  });

  it('leaves cards with no size requirement alone', async () => {
    const [a, spawned] = api(world);
    await applyCardEffect({ card: BY_ID.get('construct'), actor: actorOf(), api: a, rng: () => 0, confirmGate: false });
    expect(spawned).toHaveLength(1);   // Small is fine for an ally
  });
});

describe('sizeAtLeast', () => {
  it('reads the word a card uses as the code PF2e stores', async () => {
    const { sizeAtLeast } = await import('../scripts/foundry-api.mjs');
    expect(sizeAtLeast('lg', 'large')).toBe(true);
    expect(sizeAtLeast('sm', 'large')).toBe(false);
    expect(sizeAtLeast('huge', 'large')).toBe(true);
    expect(sizeAtLeast('grg', 'large')).toBe(true);
    expect(sizeAtLeast('med', 'large')).toBe(false);
  });

  it('treats a missing size as medium', async () => {
    const { sizeAtLeast } = await import('../scripts/foundry-api.mjs');
    expect(sizeAtLeast(undefined, 'large')).toBe(false);
    expect(sizeAtLeast(undefined, 'med')).toBe(true);
  });

  it('imposes nothing when no minimum is asked for', async () => {
    const { sizeAtLeast } = await import('../scripts/foundry-api.mjs');
    expect(sizeAtLeast('tiny', null)).toBe(true);
  });
});

describe('a summoning brings one creature, not a formation', () => {
  // Fiend answered with a "Vicious Levaloch Squad" — PF2e's `troop` trait
  // marks a single actor standing in for a whole unit.
  const world = [
    { id: 'sq', name: 'Vicious Levaloch Squad', level: 18, size: 'lg', hasArt: true,
      traits: ['devil', 'fiend', 'troop'] },
    { id: 'bz', name: 'Barbazu', level: 5, size: 'med', hasArt: true, traits: ['devil', 'fiend'] }
  ];
  const honouring = (pool) => async ({ excludeTraits = [], traits = [] } = {}) => pool
    .filter((c) => !traits.length || traits.some((t) => c.traits.includes(t)))
    .filter((c) => !excludeTraits.some((t) => c.traits.includes(t)));

  it('never summons a troop for Fiend', async () => {
    const spawned = [];
    const api = { ...makeApi(), findCreatures: honouring(world),
                  spawnCreatures: async (e, o) => { spawned.push({ e, o }); } };
    for (const rng of [() => 0, () => 0.5, () => 0.999]) {
      await applyCardEffect({ card: BY_ID.get('fiend'), actor: actorOf(), api, rng, confirmGate: false });
    }
    expect(spawned.map((s) => s.e[0].id)).not.toContain('sq');
    expect(spawned.every((s) => s.e[0].id === 'bz')).toBe(true);
  });

  it('never summons a troop for a spawn card either', async () => {
    const spawned = [];
    const api = { ...makeApi(),
      findWorldActors: honouring(world.map((c) => ({ ...c, hasArt: true }))),
      findCreatures: honouring(world),
      spawnCreatures: async (e, o) => { spawned.push({ e, o }); } };
    for (const rng of [() => 0, () => 0.999]) {
      await applyCardEffect({ card: BY_ID.get('rogue'), actor: actorOf(), api, rng, confirmGate: false });
    }
    expect(spawned.every((s) => (s.e[0].actorId ?? s.e[0].id) !== 'sq')).toBe(true);
  });

  it('names the devil for Flames without picking a troop', async () => {
    const effects = [];
    const api = { ...makeApi(), findCreatures: honouring(world),
                  createEffect: async (_i, e) => { effects.push(e); } };
    await applyCardEffect({ card: BY_ID.get('flames'), actor: actorOf(), api, rng: () => 0.999, confirmGate: false });
    expect(effects[0].name).toContain('Barbazu');
    expect(effects[0].name).not.toContain('Squad');
  });
});

describe('Ruin destroys a deed Throne handed out', () => {
  // Throne grants the deed to a keep as an effect; Ruin destroys the documents
  // that establish ownership. Drawing one then the other should cost it.
  const deed = { id: 'd1', name: 'Deed to a Keep', type: 'effect',
                 dommt: { cardId: 'throne', kind: 'deed' } };
  const other = { id: 'e1', name: 'Wish (2 remaining)', type: 'effect',
                  dommt: { cardId: 'moon' } };

  const api = ({ effects = [], treasure = [], coins = {} } = {}) => {
    const spy = { removed: [], removedCoins: [] };
    return [{
      ...makeApi(),
      getCoins: async () => coins,
      removeCoins: async (_i, c) => { spy.removedCoins.push(c); },
      listItems: async (_i, { types } = {}) =>
        (types?.includes('effect') ? effects : treasure),
      removeItems: async (_i, ids) => { spy.removed.push(...ids); }
    }, spy];
  };
  const draw = (a) => applyCardEffect({
    card: BY_ID.get('ruin'), actor: actorOf(), api: a, rng: () => 0.5, confirmGate: false });

  it('tears up the deed', async () => {
    const [a, spy] = api({ effects: [deed] });
    const r = await draw(a);
    expect(spy.removed).toContain('d1');
    expect(r.log).toContain('Deed to a Keep, torn up');
  });

  it('leaves the other effects alone', async () => {
    // A wish owed is not an ownership document.
    const [a, spy] = api({ effects: [deed, other] });
    await draw(a);
    expect(spy.removed).toContain('d1');
    expect(spy.removed).not.toContain('e1');
  });

  it('recognises a deed by its mark, not its name', async () => {
    const renamed = { ...deed, name: 'Title to a Manor' };
    const [a, spy] = api({ effects: [renamed] });
    await draw(a);
    expect(spy.removed).toContain('d1');
  });

  it('ignores an effect from elsewhere that merely looks like one', async () => {
    const foreign = { id: 'x1', name: 'Deed to a Keep', type: 'effect', dommt: null };
    const [a, spy] = api({ effects: [foreign] });
    await draw(a);
    expect(spy.removed).not.toContain('x1');
  });

  it('still says deeds are gone when the character never had one', async () => {
    const [a] = api({ coins: { gp: 10 } });
    const r = await draw(a);
    expect(r.log).toContain('yours to narrate');
  });
});

describe('Knight builds a warrior to match the character', () => {
  // It used to lift an actor out of the world — conscripting a creature with
  // its own place in the campaign — and always a 4th-level one.
  const drawer = (level, ancestry) => ({
    id: 'a1', name: 'Drawer',
    system: { details: { level: { value: level },
                         ...(ancestry ? { ancestry: { name: ancestry, trait: ancestry.toLowerCase() } } : {}) } }
  });
  const spy = () => {
    const built = [];
    return [{ ...makeApi(), spawnBuiltCreature: async (d, o) => { built.push({ d, o }); } }, built];
  };
  const draw = (actor, api) => applyCardEffect({
    card: BY_ID.get('knight'), actor, api, rng: () => 0.5, confirmGate: false });

  it('matches the level of whoever drew it, not a fixed 4', async () => {
    for (const level of [1, 7, 13, 20]) {
      const [api, built] = spy();
      await draw(drawer(level, 'Human'), api);
      expect(built[0].d.system.details.level.value, `level ${level}`).toBe(level);
    }
  });

  it('shares the drawing character’s ancestry', async () => {
    const [api, built] = spy();
    const r = await draw(drawer(7, 'Dwarf'), api);
    expect(built[0].d.name).toBe('Dwarf Warrior');
    expect(built[0].d.system.traits.value).toContain('dwarf');
    expect(r.log).toContain('dwarf warrior');
  });

  it('falls back to a human knight when the sheet says nothing', async () => {
    const [api, built] = spy();
    const r = await draw(drawer(5, null), api);
    expect(built[0].d.name).toBe('Human Warrior');
    expect(r.log).toContain('human knight in plate');
  });

  it('never takes an actor out of the world', async () => {
    let askedWorld = false;
    const [api, built] = spy();
    api.findWorldActors = async () => { askedWorld = true; return []; };
    await draw(drawer(7, 'Elf'), api);
    expect(askedWorld).toBe(false);
    expect(built).toHaveLength(1);
  });

  it('arrives as an ally', async () => {
    const [api, built] = spy();
    await draw(drawer(7, 'Human'), api);
    expect(built[0].o.disposition).toBe(1);
    expect(built[0].d.prototypeToken.disposition).toBe(1);
  });

  it('carries the statblock for its level', async () => {
    const [api, built] = spy();
    await draw(drawer(7, 'Human'), api);
    const s = built[0].d.system;
    expect(s.attributes.ac.value).toBe(25);
    expect(s.attributes.hp.max).toBe(120);
    expect(built[0].d.items[0].system.bonus.value).toBe(18);
  });

  it('clamps a level outside the table rather than breaking', async () => {
    const [api, built] = spy();
    await draw(drawer(25, 'Human'), api);
    expect(built[0].d.system.details.level.value).toBe(20);
  });
});
