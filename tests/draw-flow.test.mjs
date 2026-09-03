import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { extraDrawsFor } from '../scripts/draw-run.mjs';
import { peelCards, returnCard } from '../scripts/keep-one.mjs';

const cards = JSON.parse(readFileSync(new URL('../data/cards.json', import.meta.url)));
const BY_ID = new Map(cards.map((c) => [c.id, c]));

describe('extraDrawsFor', () => {
  it('grants Fool its two further draws', () => {
    // Fool deducted the experience and then simply stopped.
    expect(extraDrawsFor(BY_ID.get('fool'))).toBe(2);
  });

  it('grants Puzzle its one', () => {
    expect(extraDrawsFor(BY_ID.get('puzzle'))).toBe(1);
  });

  it('leaves Jester to its choice', () => {
    // Its two draws are one side of a question not yet answered.
    expect(extraDrawsFor(BY_ID.get('jester'))).toBe(0);
  });

  it('leaves Tower to turn its own cards over', () => {
    expect(extraDrawsFor(BY_ID.get('tower'))).toBe(0);
  });

  it('grants nothing for an ordinary card', () => {
    expect(extraDrawsFor(BY_ID.get('star'))).toBe(0);
    expect(extraDrawsFor(null)).toBe(0);
    expect(extraDrawsFor({})).toBe(0);
  });
});

describe('peeling cards for Tower', () => {
  const state = (remaining) => ({ remaining: [...remaining], drawn: [] });

  it('takes the requested number off the deck', () => {
    const r = peelCards(state(['a', 'b', 'c']), 2);
    expect(r.drawn).toHaveLength(2);
    expect(r.state.remaining).toHaveLength(1);
  });

  it('stops at what the deck actually holds', () => {
    const r = peelCards(state(['a']), 2);
    expect(r.drawn).toEqual(['a']);
    expect(r.state.remaining).toHaveLength(0);
  });

  it('copes with an empty deck', () => {
    const r = peelCards(state([]), 2);
    expect(r.drawn).toEqual([]);
  });
});

describe('returning the card that was not kept', () => {
  it('puts it back where it can be drawn again', () => {
    // The player never received it; removing it would quietly shrink the deck.
    const after = returnCard({ remaining: ['x'], drawn: [{ cardId: 'y' }] }, 'y');
    expect(after.remaining).toContain('y');
    expect(after.drawn).toHaveLength(0);
  });

  it('does not duplicate a card already in the deck', () => {
    const after = returnCard({ remaining: ['y'], drawn: [] }, 'y');
    expect(after.remaining.filter((c) => c === 'y')).toHaveLength(1);
  });

  it('ignores a missing id', () => {
    const before = { remaining: ['x'], drawn: [] };
    expect(returnCard(before, null)).toBe(before);
  });
});
