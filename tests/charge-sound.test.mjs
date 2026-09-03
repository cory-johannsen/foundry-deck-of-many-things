import { describe, it, expect } from 'vitest';
import { isChargeSpend, cardIdOf } from '../scripts/charge-sound.mjs';

const badge = (value) => ({ system: { badge: { type: 'counter', value } } });
const change = (value) => ({ system: { badge: { value } } });

describe('isChargeSpend', () => {
  it('fires when a counter goes down', () => {
    expect(isChargeSpend(3, change(2))).toBe(true);
    expect(isChargeSpend(1, change(0))).toBe(true);
  });

  it('ignores a counter going up', () => {
    // A GM correcting a mistake, not a charge being used.
    expect(isChargeSpend(1, change(3))).toBe(false);
  });

  it('ignores an unchanged counter', () => {
    expect(isChargeSpend(2, change(2))).toBe(false);
  });

  it('ignores updates that do not touch the badge', () => {
    expect(isChargeSpend(2, { name: 'Renamed' })).toBe(false);
    expect(isChargeSpend(2, { system: { duration: { value: 5 } } })).toBe(false);
    expect(isChargeSpend(2, {})).toBe(false);
    expect(isChargeSpend(2, null)).toBe(false);
  });

  it('ignores an effect that never had a counter', () => {
    expect(isChargeSpend(undefined, change(2))).toBe(false);
    expect(isChargeSpend(null, change(2))).toBe(false);
  });
});

describe('cardIdOf', () => {
  it('reads the card stamped on the effect', () => {
    const item = { flags: { 'deck-of-many-more-things': { cardId: 'moon' } } };
    expect(cardIdOf(item)).toBe('moon');
  });

  it('returns null for an effect from somewhere else', () => {
    expect(cardIdOf({ flags: { 'other-module': { cardId: 'x' } } })).toBeNull();
    expect(cardIdOf({ flags: {} })).toBeNull();
    expect(cardIdOf({})).toBeNull();
    expect(cardIdOf(null)).toBeNull();
  });
});

describe('every charge-bearing card is traceable back to itself', () => {
  it('stamps a cardId on effects that carry a counter', async () => {
    const { readFileSync } = await import('node:fs');
    const { applyCardEffect } = await import('../scripts/card-effects.mjs');
    const cards = JSON.parse(readFileSync(new URL('../data/cards.json', import.meta.url)));

    const actor = { id: 'a1', name: 'T', system: {
      details: { xp: { value: 0, max: 1000 }, level: { value: 5 }, age: { value: '30' } },
      attributes: { hp: { value: 10, max: 10 } }, skills: { diplomacy: { rank: 0 } } } };

    const unstamped = [];
    for (const card of cards) {
      const effects = [];
      const api = {
        updateActor: async () => {}, increaseCondition: async () => {},
        createEffect: async (_i, e) => { effects.push(e); },
        postChatCard: async () => {}, addCoins: async () => {},
        grantItems: async () => {}, removeItems: async () => {},
        spawnCreatures: async () => {}, grantInnateSpells: async () => {},
        listLanguages: async () => [], getCoins: async () => ({}),
        listGear: async () => [], etchRune: async () => {},
        removeCoins: async () => {},
        findItems: async () => [{ pack: 'p', id: 'i', name: 'Spell', type: 'spell', level: 1, rarity: 'common', traits: ['magical'] }],
        findCreatures: async () => [], findWorldActors: async () => [], listItems: async () => []
      };
      await applyCardEffect({ card, actor, api, rng: () => 0.5, confirmGate: false });
      for (const e of effects) {
        if (e.system?.badge && !cardIdOf(e)) unstamped.push(`${card.name}: ${e.name}`);
      }
    }
    expect(unstamped).toEqual([]);
  });
});
