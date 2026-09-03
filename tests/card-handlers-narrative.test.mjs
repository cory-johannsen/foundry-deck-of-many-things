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

const makeApi = ({ items = [], creatures = [], worldActors = [], languages = [], coins = {} } = {}) => {
  const spy = { updates: [], conditions: [], effects: [], granted: [], spawned: [], innate: [], coinsRemoved: [] };
  return {
    spy,
    updateActor: async (_i, u) => { spy.updates.push(u); },
    increaseCondition: async (_i, c, v) => { spy.conditions.push({ c, v }); },
    createEffect: async (_i, e) => { spy.effects.push(e); },
    postChatCard: async () => {}, addCoins: async () => {},
    grantItems: async (_i, e) => { spy.granted.push(...e); },
    removeItems: async () => {},
    spawnCreatures: async (e, o) => { spy.spawned.push({ e, o }); },
    grantInnateSpells: async (_i, e, o) => { spy.innate.push({ e, o }); },
    listLanguages: async () => languages,
    getCoins: async () => coins,
    removeCoins: async (_i, c) => { spy.coinsRemoved.push(c); },
    findItems: async () => items,
    findCreatures: async () => creatures,
    listItems: async () => [],
    findWorldActors: async () => worldActors,
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
    const granted = api.spy.innate[0].e;
    expect(granted).toHaveLength(3);
    expect(new Set(granted.map((g) => g.id)).size).toBe(3);
  });

  it('puts cantrips in a spellcasting entry at will, with no daily limit', async () => {
    // A spell belonging to no entry cannot be cast at all.
    const { api } = await run('well', { api: makeApi({ items: cantrips }) });
    expect(api.spy.innate[0].o.uses).toBeNull();
  });

  it('grants the named spell with its daily use, not a separate counter', async () => {
    const spell = [{ pack: 'pf2e.spells-srd', id: 's1', name: 'Speak with Plants', type: 'spell', level: 2, rarity: 'common' }];
    const { r, api } = await run('plant', { api: makeApi({ items: spell }) });
    expect(api.spy.innate[0].e).toEqual([{ pack: 'pf2e.spells-srd', id: 's1' }]);
    expect(api.spy.innate[0].o.uses).toBe(1);
    // The old shape put the allowance on a badge effect beside the spell,
    // which described the limit without enforcing it.
    expect(api.spy.effects).toHaveLength(0);
    expect(r.log).toContain('Speak with Plants (1/day)');
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
    expect(api.spy.updates).toHaveLength(0);
    expect(r.log).toContain('set it by hand');
  });

  it('leaves no effect icon behind, the change being instantaneous', async () => {
    // An icon would sit on the sheet forever describing something already
    // written into the age.
    const { api } = await run('crossroads');
    expect(api.spy.effects).toHaveLength(0);
    expect(api.spy.updates[0]).toHaveProperty('system.details.age.value');
  });

  it('imposes a real Will penalty and social bonus, not a note', async () => {
    // The card used to flip alignment, which PF2e has no field for, so it
    // recorded a marker and changed nothing.
    const { r, api } = await run('balance');
    const rules = api.spy.effects[0].system.rules;
    expect(rules).toContainEqual(
      { key: 'FlatModifier', selector: 'will', type: 'status', value: -2 });
    for (const skill of ['deception', 'diplomacy', 'intimidation']) {
      expect(rules, skill).toContainEqual(
        { key: 'FlatModifier', selector: skill, type: 'status', value: 2 });
    }
    expect(r.log).toContain('Will');
  });

  it('puts both halves on one effect, so removing it undoes the card', async () => {
    const { api } = await run('balance');
    expect(api.spy.effects).toHaveLength(1);
    expect(api.spy.effects[0].system.rules).toHaveLength(4);
  });

  it('honours the magnitudes from params', async () => {
    const card = { ...BY_ID.get('balance'), mechanics: { kind: 'moral_inversion',
      params: { will_penalty: 3, social_bonus: 1, skills: ['deception'] } } };
    const api = makeApi();
    await applyCardEffect({ card, actor: actorOf(), api, rng: () => 0.5, confirmGate: false });
    expect(api.spy.effects[0].system.rules).toEqual([
      { key: 'FlatModifier', selector: 'will', type: 'status', value: -3 },
      { key: 'FlatModifier', selector: 'deception', type: 'status', value: 1 }
    ]);
  });
});

describe('every card is now handled', () => {
  it('leaves no card posting a bare GM stub', async () => {
    const stubs = [];
    for (const card of cards) {
      // A world that actually has content: an empty stub makes cards report
      // "nothing available", which is not the same as being unimplemented.
      const api = makeApi({
        items: [{ pack: 'p', id: 'i1', name: 'Thing', type: 'spell', level: 1, rarity: 'common', traits: ['magical'], traditions: ['arcane'] }],
        creatures: [{ pack: 'b', id: 'c1', name: 'Beast', level: 5, traits: ['undead','ooze','humanoid','construct','dragon','beast','fiend','devil'] }],
        worldActors: [{ id: 'n1', name: 'Someone', level: 3, hasArt: true }],
        languages: [{ value: 'aklo', label: 'Aklo' }]
      });
      const res = await applyCardEffect({
        card, actor: actorOf(), api, rng: () => 0.5, confirmGate: false
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
                        'moral_inversion', 'permanent_enemy', 'beast_form', 'fiend_deal']) {
      expect(requiresConfirmation(kind), kind).toBe(true);
    }
    for (const kind of ['wish', 'sage_query', 'resurrection_grant',
                        'three_cantrips', 'skill_proficiencies', 'throne_persuasion']) {
      expect(requiresConfirmation(kind), kind).toBe(false);
    }
  });
});

describe('what the player actually sees on the sheet', () => {
  // An effect's name is stored, not rendered, so a translation key passed into
  // `name` ends up hovering over the icon verbatim. That is what happened to
  // Euryale: "DOMMT.Effects.Euryale.Label".
  it('never leaves a translation key as an effect name', async () => {
    const offenders = [];
    for (const card of cards) {
      const api = makeApi({
        items: [{ pack: 'p', id: 'i1', name: 'Thing', type: 'spell', level: 1, rarity: 'common', traditions: ['arcane'] }],
        creatures: [{ pack: 'b', id: 'c1', name: 'Beast', level: 5, traits: ['undead','ooze','humanoid','construct','dragon','beast','fiend','devil'] }],
        languages: [{ value: 'aklo', label: 'Aklo' }, { value: 'jotun', label: 'Jotun' }]
      });
      await applyCardEffect({ card, actor: actorOf(), api, rng: () => 0.5, confirmGate: false });
      for (const e of api.spy.effects) {
        if (/^[A-Z][A-Za-z]*\.[A-Za-z.]+$/.test(e.name)) offenders.push(`${card.name}: ${e.name}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('gives every effect a non-empty, human-readable name', async () => {
    const bad = [];
    for (const card of cards) {
      const api = makeApi({
        items: [{ pack: 'p', id: 'i1', name: 'Thing', type: 'spell', level: 1, rarity: 'common', traditions: ['arcane'] }],
        creatures: [{ pack: 'b', id: 'c1', name: 'Beast', level: 5, traits: ['undead','ooze','humanoid','construct','dragon','beast','fiend','devil'] }],
        languages: [{ value: 'aklo', label: 'Aklo' }, { value: 'jotun', label: 'Jotun' }]
      });
      await applyCardEffect({ card, actor: actorOf(), api, rng: () => 0.5, confirmGate: false });
      for (const e of api.spy.effects) {
        if (!e.name || !/[a-z]/.test(e.name) || !/\s/.test(e.name)) bad.push(`${card.name}: ${e.name}`);
      }
    }
    expect(bad).toEqual([]);
  });
});

describe('spells go into an entry of their own tradition', () => {
  // Traditions sit in their own array, never among the traits — mirroring
  // PF2e, where Speak with Plants lists plant/wood as traits and primal as a
  // tradition.
  const mixed = [
    { pack: 'p', id: 'a', name: 'Arcane Cantrip', type: 'spell', level: 0, rarity: 'common', traits: ['cantrip'], traditions: ['arcane'] },
    { pack: 'p', id: 'b', name: 'Primal Cantrip', type: 'spell', level: 0, rarity: 'common', traits: ['cantrip'], traditions: ['primal'] },
    { pack: 'p', id: 'c', name: 'Divine Cantrip', type: 'spell', level: 0, rarity: 'common', traits: ['cantrip'], traditions: ['divine'] }
  ];

  it('files each spell under its own tradition rather than one guess', async () => {
    // An innate entry carries a single tradition, and Well draws from any of
    // them — filing an arcane cantrip under primal would misreport its DC.
    const { api } = await run('well', { api: makeApi({ items: mixed }) });
    const traditions = api.spy.innate.map((c) => c.o.tradition).sort();
    expect(traditions).toEqual(['arcane', 'divine', 'primal']);
  });

  it('names each entry after its tradition, so they do not collide', async () => {
    const { api } = await run('well', { api: makeApi({ items: mixed }) });
    const names = api.spy.innate.map((c) => c.o.entryName);
    expect(new Set(names).size).toBe(names.length);
    expect(names[0]).toMatch(/Deck of Many More Things \((Arcane|Divine|Primal)\)/);
  });

  it('uses one entry when the spells share a tradition', async () => {
    const primal = mixed.filter((s) => s.traditions.includes('primal'));
    const { api } = await run('plant', { api: makeApi({ items: primal }) });
    expect(api.spy.innate).toHaveLength(1);
    expect(api.spy.innate[0].o.tradition).toBe('primal');
  });
});

describe('a spell\'s tradition is not one of its traits', () => {
  it('reads the traditions array, as PF2e stores it', async () => {
    // Speak with Plants: traits are concentrate/manipulate/plant/wood, and the
    // traditions are divine/occult/primal. Reading traits filed it as arcane.
    const swp = [{ pack: 'pf2e.spells-srd', id: 's1', name: 'Speak with Plants', type: 'spell',
                   level: 2, rarity: 'common',
                   traits: ['concentrate', 'manipulate', 'plant', 'wood'],
                   traditions: ['divine', 'occult', 'primal'] }];
    const { api } = await run('plant', { api: makeApi({ items: swp }) });
    expect(api.spy.innate[0].o.tradition).toBe('divine');
    expect(api.spy.innate[0].o.tradition).not.toBe('arcane');
  });

  it('falls back to arcane only when a spell truly has no tradition', async () => {
    const none = [{ pack: 'p', id: 'x', name: 'Odd Spell', type: 'spell', level: 1,
                    rarity: 'common', traits: [], traditions: [] }];
    const { api } = await run('plant', { api: makeApi({ items: none }) });
    expect(api.spy.innate[0].o.tradition).toBe('arcane');
  });
});

describe('Book asks for the languages instead of describing them', () => {
  const langs = Array.from({ length: 12 }, (_, i) => ({ value: `l${i}`, label: `Lang ${i}` }));

  it('rolls a number and offers a choice of that many', async () => {
    const { r } = await run('book', { api: makeApi({ languages: langs }) });
    expect(r.meta.requires).toBe('choose_many');
    expect(r.meta.count).toBeGreaterThanOrEqual(3);   // 1d6+2
    expect(r.meta.count).toBeLessThanOrEqual(8);
    expect(r.meta.options).toHaveLength(12);
  });

  it('carries the rolled count forward so re-planning asks the same question', async () => {
    // Without this the count is re-rolled after the answer and the player is
    // granted a different number than they chose for.
    const { r } = await run('book', { api: makeApi({ languages: langs }) });
    expect(r.meta.persist.count).toBe(r.meta.count);
  });

  it('writes the chosen languages once they are picked', async () => {
    const card = { ...BY_ID.get('book'), mechanics: { kind: 'learn_languages',
      params: { count: 2, languages: ['aklo', 'jotun'] } } };
    const actor = actorOf();
    actor.system.details.languages = { value: ['common'] };
    const api = makeApi({ languages: langs });
    const r = await applyCardEffect({ card, actor, api, rng: () => 0.5, confirmGate: false });
    expect(api.spy.updates[0]['system.details.languages.value'])
      .toEqual(['common', 'aklo', 'jotun']);
    expect(r.log).toContain('aklo, jotun');
  });

  it('never offers a language the character already speaks', async () => {
    // The api filters by what is known; the handler must not add its own.
    const { r } = await run('book', { api: makeApi({ languages: [{ value: 'aklo', label: 'Aklo' }] }) });
    expect(r.meta.options.map((o) => o.value)).toEqual(['aklo']);
  });

  it('cannot ask for more languages than remain', async () => {
    const { r } = await run('book', { api: makeApi({ languages: [{ value: 'aklo', label: 'Aklo' }] }) });
    expect(r.meta.count).toBe(1);
  });

  it('says so when there is nothing left to learn', async () => {
    const { r } = await run('book', { api: makeApi({ languages: [] }) });
    expect(r.mode).toBe('gm');
    expect(r.log).toContain('no languages left');
  });
});
