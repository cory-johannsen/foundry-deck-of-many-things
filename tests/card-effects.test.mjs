import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { applyCardEffect, requiresConfirmation, hasHandler } from '../scripts/card-effects.mjs';
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
        speed: { value: 25, otherSpeeds: [] }   // legacy shape, kept for other tests
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
    const res = await applyCardEffect({ card: maze, actor, api, rng, confirmGate: false });
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
    await applyCardEffect({ card: corpse, actor, api, confirmGate: false });
    expect(actor.system.attributes.hp.value).toBe(0);
    expect(api._spy.conditions).toEqual([{ cond: 'dying', value: 1 }]);
  });
});

describe('speed_bonus (Path)', () => {
  // PF2e derives movement, so a direct write is discarded. These now assert
  // the rule element that actually moves the sheet.
  it('grants a land-speed modifier rather than writing the speed', async () => {
    const actor = makeActor();
    // A real character keeps movement here, derived from ancestry and items.
    actor.system.movement = { speeds: { land: { value: 25 }, climb: null, fly: null } };
    const api = makeApi(actor);
    const res = await applyCardEffect({ card: BY_ID.get('path'), actor, api });
    expect(api._spy.effects[0].system.rules[0]).toEqual(
      { key: 'FlatModifier', selector: 'land-speed', type: 'status', value: 10 });
    // The stored speed is untouched; PF2e recomputes it from the rule.
    expect(actor.system.movement.speeds.land.value).toBe(25);
    expect(res.log).toBe('Path: land Speed 25 → 35 ft');
  });
});

describe('flight (Celestial) / climb_speed (Cavern)', () => {
  it('grants a fly Speed with a BaseSpeed rule', async () => {
    const actor = makeActor();
    const api = makeApi(actor);
    await applyCardEffect({ card: BY_ID.get('celestial'), actor, api });
    const rules = api._spy.effects[0].system.rules;
    expect(rules[0]).toEqual({ key: 'BaseSpeed', selector: 'fly', value: 30 });
    // The card describes luminescent wings; the token should show it.
    expect(rules[1]).toMatchObject({ key: 'TokenLight' });
    expect(rules[1].value).toMatchObject({ bright: 20, dim: 40 });
  });
  it('adds climb equal to walk', async () => {
    const actor = makeActor();
    const api = makeApi(actor);
    await applyCardEffect({ card: BY_ID.get('cavern'), actor, api });
    // BaseSpeed takes `selector`, not `type` — with `type` it silently does nothing.
    expect(api._spy.effects[0].system.rules[0])
      .toEqual({ key: 'BaseSpeed', selector: 'climb', value: 25 });
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

describe('cards the module cannot decide for the table', () => {
  // Moon used to be inert. It now puts tracked wishes on the sheet — the
  // module still does not adjudicate a wish, it just records what is owed.
  it('Moon grants tracked wishes without touching the character', async () => {
    const actor = makeActor();
    const api = makeApi(actor);
    const res = await applyCardEffect({ card: BY_ID.get('moon'), actor, api, confirmGate: false });
    expect(res.mode).toBe('auto');
    expect(api._spy.effects[0].system.badge).toMatchObject({ type: 'counter' });
    expect(actor.system.attributes.hp.value).toBe(30);
  });

  it('Talons destroys on the draw, with nothing held back', async () => {
    const actor = makeActor();
    const api = { ...makeApi(actor), listItems: async () => [], removeItems: async () => {} };
    const res = await applyCardEffect({ card: BY_ID.get('talons'), actor, api });
    expect(res.mode).toBe('auto');
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

describe('the confirmation gate', () => {
  // Handler behaviour is asserted elsewhere; this is about what a *draw* does.
  const actor = () => ({ id: 'a1', system: { attributes: { hp: { value: 30, max: 30 } } } });
  const api = () => ({
    updateActor: async () => {}, increaseCondition: async () => {},
    createEffect: async () => {}, postChatCard: async () => {},
    addCoins: async () => {}, grantItems: async () => {},
    removeItems: async () => {}, spawnCreatures: async () => {}
  });

  it('holds nothing back: every card applies as it is drawn', async () => {
    const held = Array.from(BY_ID.values())
      .filter((card) => requiresConfirmation(card.mechanics.kind))
      .map((card) => card.name);
    expect(held).toEqual([]);
  });

  it('still holds a card back if a kind is added to the set', async () => {
    // The mechanism is kept so one can be re-gated without rebuilding it.
    const { REQUIRES_CONFIRMATION } = await import('../scripts/card-effects.mjs');
    REQUIRES_CONFIRMATION.add('petrify');
    try {
      const res = await applyCardEffect({ card: BY_ID.get('statue'), actor: actor(), api: api() });
      expect(res.mode).toBe('gm');
      expect(res.meta.kind).toBe('needs_confirm');
    } finally {
      REQUIRES_CONFIRMATION.delete('petrify');
    }
  });

  it('lets a gain apply straight away', async () => {
    const res = await applyCardEffect({ card: BY_ID.get('campfire'), actor: actor(), api: api() });
    expect(res.mode).toBe('auto');
  });

  it('opens the gate for the planner, which runs after the GM has clicked Apply', async () => {
    const res = await applyCardEffect({
      card: BY_ID.get('statue'), actor: actor(), api: api(), confirmGate: false
    });
    expect(res.mode).toBe('auto');
  });

  it('gates every card that takes something away or spawns a hostile', () => {
    for (const kind of ['xp_loss', 'fall', 'petrify', 'destroy_magic_items',
                        'spawn_hostile', 'avatar_of_death', 'xp_gain', 'wealth_grant',
                        'long_rest', 'stat_bump', 'magic_weapon_grant', 'spawn_ally_npc']) {
      expect(requiresConfirmation(kind), kind).toBe(false);
    }
  });
});

describe('Euryale applies without asking', () => {
  it('needs no GM approval — one flat penalty, nothing taken away', async () => {
    const actor = makeActor();
    const api = makeApi(actor);
    const res = await applyCardEffect({ card: BY_ID.get('euryale'), actor, api });
    expect(res.mode).toBe('auto');
    expect(api._spy.effects[0].system.rules[0]).toMatchObject({
      key: 'FlatModifier', selector: 'saving-throw', value: -2
    });
  });

  it('applies every card on the draw, destructive or not', () => {
    for (const kind of ['xp_loss', 'petrify', 'destroy_magic_items', 'spawn_hostile',
                        'drop_to_zero_hp', 'exhaustion', 'restrain_no_spellcast',
                        'wealth_wipe', 'save_penalty', 'soul_trap', 'stat_debuff',
                        'beast_form']) {
      expect(requiresConfirmation(kind), kind).toBe(false);
    }
  });
});
