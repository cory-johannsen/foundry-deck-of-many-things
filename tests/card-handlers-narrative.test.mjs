import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { applyCardEffect, requiresConfirmation } from '../scripts/card-effects.mjs';

const cards = JSON.parse(readFileSync(new URL('../data/cards.json', import.meta.url)));
const BY_ID = new Map(cards.map((c) => [c.id, c]));

const actorOf = (over = {}) => ({
  id: 'a1',
  name: 'Target',
  system: {
    details: { xp: { value: 0, max: 1000 }, level: { value: 5 }, age: { value: '30' } },
    attributes: { hp: { value: 40, max: 40 } },
    skills: {
      acrobatics: { rank: 0 }, arcana: { rank: 1 }, athletics: { rank: 0 },
      diplomacy: { rank: 1 }, medicine: { rank: 2 }, stealth: { rank: 0 }
    },
    ...over
  }
});

const makeApi = ({ items = [], creatures = [] } = {}) => {
  const spy = { updates: [], conditions: [], effects: [], granted: [], spawned: [] };
  return {
    spy,
    updateActor: async (_i, u) => { spy.updates.push(u); },
    increaseCondition: async (_i, c, v) => { spy.conditions.push({ c, v }); },
    createEffect: async (_i, e) => { spy.effects.push(e); },
    postChatCard: async () => {}, addCoins: async () => {},
    grantItems: async (_i, e) => { spy.granted.push(...e); },
    removeItems: async () => {},
    spawnCreatures: async (e, o) => { spy.spawned.push({ e, o }); },
    findItems: async () => items,
    findCreatures: async () => creatures,
    listItems: async () => []
  };
};

const run = (id, { actor = actorOf(), api = makeApi(), rng = () => 0.5 } = {}) =>
  applyCardEffect({ card: BY_ID.get(id), actor, api, rng, confirmGate: false })
    .then((r) => ({ r, api }));

describe('tracked uses', () => {
  it('puts a counter on the sheet rather than a note in chat', async () => {
    const { r, api } = await run('moon');
    expect(r.mode).toBe('auto');
    expect(api.spy.effects[0].system.badge.type).toBe('counter');
    expect(api.spy.effects[0].system.badge.value).toBeGreaterThanOrEqual(1);
  });

  it('carries the card\'s validity window as the effect duration', async () => {
    const { api } = await run('sage');   // one use, good for a year
    expect(api.spy.effects[0].system.duration).toMatchObject({ value: 365, unit: 'days' });
    expect(api.spy.effects[0].system.badge.value).toBe(1);
  });

  it('leaves an open-ended card unlimited', async () => {
    const { api } = await run('fates');
    expect(api.spy.effects[0].system.duration.unit).toBe('unlimited');
  });

  it('rolls the count for cards that vary', async () => {
    const { api } = await run('door');   // 1d4 castings of Gate
    const n = api.spy.effects[0].system.badge.value;
    expect(n).toBeGreaterThanOrEqual(1);
    expect(n).toBeLessThanOrEqual(4);
  });

  it('covers both resurrection cards from one handler', async () => {
    for (const id of ['temple', 'tomb']) {
      const { api } = await run(id);
      expect(api.spy.effects[0].system.badge.value, id).toBe(1);
    }
  });
});

describe('spell grants', () => {
  const cantrips = Array.from({ length: 6 }, (_, i) => ({
    pack: 'pf2e.spells-srd', id: `c${i}`, name: `Cantrip ${i}`, type: 'spell', level: 0, rarity: 'common'
  }));

  it('grants three different cantrips, not the same one three times', async () => {
    const { api } = await run('well', { api: makeApi({ items: cantrips }) });
    expect(api.spy.granted).toHaveLength(3);
    expect(new Set(api.spy.granted.map((g) => g.id)).size).toBe(3);
  });

  it('grants the named spell and a per-day counter for it', async () => {
    const spell = [{ pack: 'pf2e.spells-srd', id: 's1', name: 'Speak with Plants', type: 'spell', level: 2, rarity: 'common' }];
    const { r, api } = await run('plant', { api: makeApi({ items: spell }) });
    expect(api.spy.granted).toEqual([{ pack: 'pf2e.spells-srd', id: 's1' }]);
    expect(api.spy.effects[0].system.badge.value).toBe(1);
    expect(r.log).toContain('Speak with Plants');
  });

  it('defers when the compendium has no match', async () => {
    const { r } = await run('well', { api: makeApi({ items: [] }) });
    expect(r.mode).toBe('gm');
  });
});

describe('skills', () => {
  it('trains the three least-trained skills', async () => {
    const { api } = await run('ship');
    const u = api.spy.updates[0];
    // acrobatics, athletics and stealth are all rank 0.
    expect(u['system.skills.acrobatics.rank']).toBe(1);
    expect(u['system.skills.athletics.rank']).toBe(1);
    expect(u['system.skills.stealth.rank']).toBe(1);
    expect(u['system.skills.medicine.rank']).toBeUndefined();
  });

  it('raises Diplomacy to at least Expert and hands over the keep', async () => {
    const { r, api } = await run('throne');
    expect(api.spy.updates[0]['system.skills.diplomacy.rank']).toBe(2);
    expect(api.spy.effects.some((e) => /Keep/.test(e.name))).toBe(true);
    expect(r.log).toContain('Expert');
  });

  it('still reaches Expert from untrained', async () => {
    const actor = actorOf({ skills: { diplomacy: { rank: 0 } } });
    const { api } = await run('throne', { actor });
    expect(api.spy.updates[0]['system.skills.diplomacy.rank']).toBe(2);
  });
});

describe('removal from play', () => {
  it('entombs and knocks out, and ends the draw', async () => {
    const { api } = await run('donjon');
    expect(api.spy.conditions).toContainEqual({ c: 'unconscious', v: 1 });
    expect(api.spy.updates[0]['flags.deck-of-many-more-things.drawsEnded']).toBe(true);
  });

  it('exiles to the Feywild awake, and ends the draw', async () => {
    const { api } = await run('fey');
    expect(api.spy.conditions).toHaveLength(0);
    expect(api.spy.updates[0]['flags.deck-of-many-more-things.drawsEnded']).toBe(true);
  });
});

describe('named adversaries', () => {
  const fiends = [{ pack: 'b', id: 'd1', name: 'Barbazu', level: 5, traits: ['devil', 'fiend'] }];

  it('names the devil as an enemy without placing a token', async () => {
    const { r, api } = await run('flames', { api: makeApi({ creatures: fiends }) });
    expect(api.spy.spawned).toHaveLength(0);
    expect(api.spy.effects[0].name).toContain('Barbazu');
    expect(r.log).toContain('sworn enemy');
  });

  it('places the fiend, since the card says it appears', async () => {
    const { api } = await run('fiend', { api: makeApi({ creatures: fiends }) });
    expect(api.spy.spawned[0].o.disposition).toBe(0);   // indifferent, not hostile
  });
});

describe('age and alignment', () => {
  it('shifts the recorded age in one direction or the other', async () => {
    const { r, api } = await run('crossroads');
    const next = Number(api.spy.updates[0]['system.details.age.value']);
    expect(Math.abs(next - 30)).toBeGreaterThanOrEqual(1);
    expect(r.log).toMatch(/age 30 → \d+/);
  });

  it('never ages anyone below one year old', async () => {
    const actor = actorOf({ details: { age: { value: '2' }, xp: { value: 0, max: 1000 }, level: { value: 5 } } });
    const { api } = await run('crossroads', { actor, rng: () => 0.99 });
    expect(Number(api.spy.updates[0]['system.details.age.value'])).toBeGreaterThanOrEqual(1);
  });

  it('copes with a sheet that records no age', async () => {
    const actor = actorOf({ details: { age: { value: '' }, xp: { value: 0, max: 1000 }, level: { value: 5 } } });
    const { r, api } = await run('crossroads', { actor });
    expect(api.spy.updates).toHaveLength(0);          // nothing written
    expect(api.spy.effects).toHaveLength(1);          // but still recorded
    expect(r.log).toContain('no age recorded');
  });

  it('records the wrench rather than writing an alignment PF2e does not have', async () => {
    const { r, api } = await run('balance');
    expect(api.spy.updates).toHaveLength(0);
    expect(api.spy.effects[0].name).toContain('Balance');
    expect(r.log).toContain('no alignment field');
  });
});

describe('every card is now handled', () => {
  it('leaves no card posting a bare GM stub', async () => {
    const stubs = [];
    for (const card of cards) {
      const res = await applyCardEffect({
        card, actor: actorOf(), api: makeApi(), rng: () => 0.5, confirmGate: false
      });
      if (res.meta?.kind === 'gm_only' && !/compendium|bestiary|by hand|yourself/.test(res.log)) {
        stubs.push(card.name);
      }
    }
    // What remains is only ever "the compendium had nothing", never "not implemented".
    expect(stubs).toEqual([]);
  });

  it('gates everything that removes, ages, rewrites or sets an enemy on the character', () => {
    for (const kind of ['trap_extraplanar', 'feywild_transport', 'age_shift',
                        'alignment_flip', 'permanent_enemy', 'beast_form', 'fiend_deal']) {
      expect(requiresConfirmation(kind), kind).toBe(true);
    }
    for (const kind of ['wish', 'sage_query', 'resurrection_grant',
                        'three_cantrips', 'skill_proficiencies', 'throne_persuasion']) {
      expect(requiresConfirmation(kind), kind).toBe(false);
    }
  });
});
