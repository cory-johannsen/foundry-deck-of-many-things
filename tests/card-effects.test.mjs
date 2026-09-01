import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { applyCardEffect, hasHandler } from '../scripts/card-effects.mjs';
import { makeCardsById } from '../scripts/deck.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CARDS = JSON.parse(readFileSync(resolve(__dirname, '../data/cards.json'), 'utf8'));
const BY_ID = makeCardsById(CARDS);

function makeActor(overrides = {}) {
  return {
    id: 'actor-under-test',
    system: {
      abilities: {
        str: { mod: 2 }, dex: { mod: 1 }, con: { mod: 0 },
        int: { mod: 0 }, wis: { mod: 3 }, cha: { mod: 1 }
      },
      attributes: {
        hp: { value: 30, max: 40 },
        speed: { value: 25, otherSpeeds: [] }
      },
      traits: { size: { value: 'med' } },
      details: { xp: { value: 300 }, languages: { value: ['common'] } }
    },
    ...overrides
  };
}

function makeApi(actor) {
  const posted = [];
  const conditions = [];
  const effects = [];
  return {
    async updateActor(_id, updates) {
      for (const [path, value] of Object.entries(updates)) {
        setDeep(actor, path, value);
      }
    },
    async increaseCondition(_id, cond, value) { conditions.push({ cond, value }); },
    async createEffect(_id, data) { effects.push(data); },
    async postChatCard(payload) { posted.push(payload); },
    _spy: { posted, conditions, effects }
  };
}

function setDeep(obj, path, value) {
  const keys = path.split('.');
  let cur = obj;
  for (let i = 0; i < keys.length - 1; i++) {
    if (cur[keys[i]] == null) cur[keys[i]] = {};
    cur = cur[keys[i]];
  }
  cur[keys[keys.length - 1]] = value;
}

const seededRng = (values) => {
  let i = 0;
  return () => values[(i++) % values.length];
};

describe('handler registration', () => {
  it('has a handler for every card kind in the deck', () => {
    for (const card of CARDS) {
      expect(hasHandler(card.mechanics.kind)).toBe(true);
    }
  });
});

describe('stat_bump (Star, Warrior, Mage, etc.)', () => {
  it('bumps the specified ability mod up to the PF2e cap', () => {
    const actor = makeActor();
    const api = makeApi(actor);
    const warrior = BY_ID.get('warrior');
    return applyCardEffect({ card: warrior, actor, api }).then((res) => {
      expect(res.mode).toBe('auto');
      expect(actor.system.abilities.str.mod).toBe(3);
    });
  });

  it('surfaces GM choice for Star (ability=any)', async () => {
    const actor = makeActor();
    const api = makeApi(actor);
    const star = BY_ID.get('star');
    const res = await applyCardEffect({ card: star, actor, api });
    expect(res.mode).toBe('gm');
    expect(actor.system.abilities.str.mod).toBe(2);
  });
});

describe('all_stats_bump (Lance)', () => {
  it('boosts every ability mod by +1', async () => {
    const actor = makeActor();
    const api = makeApi(actor);
    const lance = BY_ID.get('lance');
    const res = await applyCardEffect({ card: lance, actor, api });
    expect(res.mode).toBe('auto');
    expect(actor.system.abilities.str.mod).toBe(3);
    expect(actor.system.abilities.wis.mod).toBe(4);
  });
});

describe('exhaustion (Maze)', () => {
  it('rolls levels and applies PF2e-mapped conditions', async () => {
    const actor = makeActor();
    const api = makeApi(actor);
    const maze = BY_ID.get('maze');
    const rng = seededRng([0.66]); // 1d3 → floor(0.66*3)+1 = 2
    const res = await applyCardEffect({ card: maze, actor, api, rng });
    expect(res.mode).toBe('auto');
    expect(api._spy.conditions).toEqual([
      { cond: 'fatigued', value: 1 },
      { cond: 'drained', value: 1 }
    ]);
  });
});

describe('drop_to_zero_hp (Corpse)', () => {
  it('zeroes HP and applies Dying 1', async () => {
    const actor = makeActor();
    const api = makeApi(actor);
    const corpse = BY_ID.get('corpse');
    await applyCardEffect({ card: corpse, actor, api });
    expect(actor.system.attributes.hp.value).toBe(0);
    expect(api._spy.conditions).toEqual([{ cond: 'dying', value: 1 }]);
  });
});

describe('speed_bonus (Path)', () => {
  it('adds walking speed', async () => {
    const actor = makeActor();
    const api = makeApi(actor);
    const path = BY_ID.get('path');
    await applyCardEffect({ card: path, actor, api });
    expect(actor.system.attributes.speed.value).toBe(35);
  });
});

describe('flight (Celestial) / climb_speed (Cavern)', () => {
  it('adds a fly speed to otherSpeeds', async () => {
    const actor = makeActor();
    const api = makeApi(actor);
    await applyCardEffect({ card: BY_ID.get('celestial'), actor, api });
    expect(actor.system.attributes.speed.otherSpeeds).toContainEqual({ type: 'fly', value: 30 });
  });
  it('adds climb equal to walk', async () => {
    const actor = makeActor();
    const api = makeApi(actor);
    await applyCardEffect({ card: BY_ID.get('cavern'), actor, api });
    expect(actor.system.attributes.speed.otherSpeeds).toContainEqual({ type: 'climb', value: 25 });
  });
});

describe('save_penalty (Euryale)', () => {
  it('creates a persistent status-penalty effect', async () => {
    const actor = makeActor();
    const api = makeApi(actor);
    await applyCardEffect({ card: BY_ID.get('euryale'), actor, api });
    expect(api._spy.effects).toHaveLength(1);
    expect(api._spy.effects[0].system.rules[0]).toMatchObject({
      key: 'FlatModifier', selector: 'saving-throw', value: -2
    });
  });
});

describe('long_rest (Campfire)', () => {
  it('restores HP to max', async () => {
    const actor = makeActor({ system: { ...makeActor().system, attributes: { ...makeActor().system.attributes, hp: { value: 5, max: 40 } } } });
    const api = makeApi(actor);
    await applyCardEffect({ card: BY_ID.get('campfire'), actor, api });
    expect(actor.system.attributes.hp.value).toBe(40);
  });
});

describe('size_grow (Giant)', () => {
  it('bumps size one step and adds HP', async () => {
    const actor = makeActor();
    const api = makeApi(actor);
    const rng = seededRng([0.5]);
    await applyCardEffect({ card: BY_ID.get('giant'), actor, api, rng });
    expect(actor.system.traits.size.value).toBe('lg');
    expect(actor.system.attributes.hp.max).toBe(60);
  });
});

describe('GM-adjudication cards', () => {
  it('Moon (wish) never auto-mutates', async () => {
    const actor = makeActor();
    const api = makeApi(actor);
    const res = await applyCardEffect({ card: BY_ID.get('moon'), actor, api });
    expect(res.mode).toBe('gm');
    expect(actor.system.attributes.hp.value).toBe(30);
  });
  it('Talons (destroy items) posts GM card', async () => {
    const actor = makeActor();
    const api = makeApi(actor);
    const res = await applyCardEffect({ card: BY_ID.get('talons'), actor, api });
    expect(res.mode).toBe('gm');
  });
});

describe('autoApplyEnabled=false', () => {
  it('short-circuits every card to a manual GM entry', async () => {
    const actor = makeActor();
    const api = makeApi(actor);
    const res = await applyCardEffect({ card: BY_ID.get('warrior'), actor, api, autoApplyEnabled: false });
    expect(res.mode).toBe('gm');
    expect(actor.system.abilities.str.mod).toBe(2);
  });
});
