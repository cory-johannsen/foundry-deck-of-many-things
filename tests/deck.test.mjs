import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import {
  freshPlayDeckState,
  drawFromPlay,
  drawMany,
  dealCelticCross,
  readingFromSpread,
  makeCardsById,
  CELTIC_CROSS_ORDER,
  DIVINATION_CATEGORIES
} from '../scripts/deck.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CARDS = JSON.parse(readFileSync(resolve(__dirname, '../data/cards.json'), 'utf8'));
const BY_ID = makeCardsById(CARDS);

describe('freshPlayDeckState', () => {
  it('contains all 66 cards exactly once', () => {
    const s = freshPlayDeckState(CARDS, 'seed');
    expect(s.remaining).toHaveLength(66);
    expect(new Set(s.remaining).size).toBe(66);
    expect(s.drawn).toEqual([]);
  });

  it('is deterministic for the same seed', () => {
    const a = freshPlayDeckState(CARDS, 'alpha');
    const b = freshPlayDeckState(CARDS, 'alpha');
    expect(a.remaining).toEqual(b.remaining);
  });

  it('produces different orders for different seeds', () => {
    const a = freshPlayDeckState(CARDS, 'alpha');
    const b = freshPlayDeckState(CARDS, 'beta');
    expect(a.remaining).not.toEqual(b.remaining);
  });
});

describe('drawFromPlay', () => {
  it('removes drawn card permanently', () => {
    let s = freshPlayDeckState(CARDS, 'x');
    const first = s.remaining[0];
    const r = drawFromPlay(s, { actorId: 'actor1' });
    expect(r.card).toBe(first);
    expect(r.state.remaining).toHaveLength(65);
    expect(r.state.remaining).not.toContain(first);
    expect(r.state.drawn).toHaveLength(1);
    expect(r.state.drawn[0].cardId).toBe(first);
    expect(r.state.drawn[0].actorId).toBe('actor1');
  });

  it('returns empty reason when deck is exhausted', () => {
    let s = freshPlayDeckState(CARDS, 'x');
    for (let i = 0; i < 66; i++) s = drawFromPlay(s).state;
    const r = drawFromPlay(s);
    expect(r.reason).toBe('empty');
    expect(r.card).toBeNull();
  });
});

describe('drawMany', () => {
  it('stops on a draw-terminating card', () => {
    let s = freshPlayDeckState(CARDS, 'seed-with-void');
    while (!s.remaining.includes('void')) s = freshPlayDeckState(CARDS, String(Math.random()));
    const idx = s.remaining.indexOf('void');
    const before = s.remaining.slice(0, idx);
    s = { ...s, remaining: ['void', ...before, ...s.remaining.slice(idx + 1)] };

    const r = drawMany(BY_ID, s, { n: 5 });
    expect(r.stopped).toBe('terminator');
    expect(r.results).toHaveLength(1);
    expect(r.results[0].cardId).toBe('void');
    expect(r.state.remaining).not.toContain('void');
  });

  it('stops when the deck runs out', () => {
    const nonTerminators = CARDS.filter((c) => !c.rules.draw_terminating).map((c) => c.id);
    let s = freshPlayDeckState(CARDS, 'x');
    s = { ...s, remaining: nonTerminators.slice(0, 2) };
    const r = drawMany(BY_ID, s, { n: 5 });
    expect(r.stopped).toBe('empty');
    expect(r.results).toHaveLength(2);
  });
});

describe('dealCelticCross', () => {
  it('returns exactly 10 unique cards in canonical position order', () => {
    const { spread } = dealCelticCross(CARDS, { seed: 'divi', category: 'situation' });
    expect(spread).toHaveLength(10);
    expect(spread.map((s) => s.position)).toEqual(CELTIC_CROSS_ORDER);
    const ids = spread.map((s) => s.cardId);
    expect(new Set(ids).size).toBe(10);
    for (const s of spread) {
      expect(['upright', 'reversed']).toContain(s.orientation);
    }
  });

  it('rejects unknown category', () => {
    expect(() => dealCelticCross(CARDS, { seed: 'x', category: 'not-real' })).toThrow();
  });

  it('accepts all five canonical categories', () => {
    for (const cat of DIVINATION_CATEGORIES) {
      const { spread } = dealCelticCross(CARDS, { seed: cat, category: cat });
      expect(spread).toHaveLength(10);
    }
  });

  it('is roughly balanced between upright and reversed over many deals', () => {
    let up = 0, down = 0;
    for (let i = 0; i < 200; i++) {
      const { spread } = dealCelticCross(CARDS, { seed: `s${i}`, category: 'situation' });
      for (const s of spread) {
        if (s.orientation === 'upright') up++; else down++;
      }
    }
    const ratio = up / (up + down);
    expect(ratio).toBeGreaterThan(0.4);
    expect(ratio).toBeLessThan(0.6);
  });
});

describe('readingFromSpread', () => {
  it('overrides challenge orientation to upright', () => {
    const { spread } = dealCelticCross(CARDS, { seed: 'r', category: 'situation' });
    const forced = spread.map((s) =>
      s.position === 'challenge' ? { ...s, orientation: 'reversed' } : s
    );
    const reading = readingFromSpread(CARDS, BY_ID, { category: 'situation', spread: forced });
    const challenge = reading.positions.find((p) => p.position === 'challenge');
    expect(challenge.orientation).toBe('reversed');
  });

  it('flags empty divination text', () => {
    const { spread } = dealCelticCross(CARDS, { seed: 'r', category: 'situation' });
    const reading = readingFromSpread(CARDS, BY_ID, { category: 'situation', spread });
    for (const p of reading.positions) {
      expect(p.empty).toBe(true);
    }
  });
});
