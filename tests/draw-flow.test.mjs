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

  it('puts it back at a random position, not the bottom', () => {
    // Appending would promise the player when it next comes up.
    const deck = ['a', 'b', 'c', 'd'];
    const front = returnCard({ remaining: [...deck], drawn: [] }, 'y', () => 0);
    const back = returnCard({ remaining: [...deck], drawn: [] }, 'y', () => 0.999);
    const middle = returnCard({ remaining: [...deck], drawn: [] }, 'y', () => 0.5);
    expect(front.remaining[0]).toBe('y');
    expect(back.remaining.at(-1)).toBe('y');
    expect(middle.remaining.indexOf('y')).toBeGreaterThan(0);
    expect(middle.remaining.indexOf('y')).toBeLessThan(deck.length);
  });

  it('reaches every position in the deck across many returns', () => {
    const seen = new Set();
    for (let i = 0; i <= 20; i += 1) {
      const r = returnCard({ remaining: ['a', 'b', 'c'], drawn: [] }, 'y', () => i / 20);
      seen.add(r.remaining.indexOf('y'));
    }
    expect([...seen].sort()).toEqual([0, 1, 2, 3]);
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

describe('Tower shows both cards and what each would do', () => {
  const stubApi = () => ({
    updateActor: async () => {}, increaseCondition: async () => {}, createEffect: async () => {},
    postChatCard: async () => {}, addCoins: async () => {}, grantItems: async () => {},
    removeItems: async () => {}, spawnCreatures: async () => {}, grantInnateSpells: async () => {},
    removeCoins: async () => {}, etchRune: async () => {},
    findItems: async () => [], findCreatures: async () => [], listItems: async () => [],
    findWorldActors: async () => [], listLanguages: async () => [], getCoins: async () => ({}),
    listGear: async () => []
  });
  const byId = new Map([
    ['star', { id: 'star', name: 'Star', art: { front: 'assets/cards-labeled/star.png' },
               rules: { summary: 'blurb' },
               mechanics: { kind: 'stat_bump', params: { ability: 'str', delta_mod: 1 } } }],
    ['path', { id: 'path', name: 'Path', art: { front: 'assets/cards-labeled/path.png' },
               rules: { summary: 'blurb' },
               mechanics: { kind: 'speed_bonus', params: { walk_ft: 10 } } }],
    ['tower', { id: 'tower', name: 'Tower', rules: { summary: '' },
                mechanics: { kind: 'draw_two_keep_one', params: {} } }]
  ]);
  const actor = () => ({ id: 'a1', system: {
    abilities: { str: { mod: 2 } }, movement: { speeds: { land: { value: 25 } } } } });
  const state = () => ({ remaining: ['star', 'path', 'c', 'd'], drawn: [] });

  const run = async (pick) => {
    let seen = null;
    const posted = [];
    const replayed = [];
    const out = await (await import('../scripts/keep-one.mjs')).drawTwoKeepOne({
      state: state(), byId, actor: actor(), api: stubApi(), rng: () => 0.5,
      ask: async (args) => { seen = args; return pick; },
      applyAndPost: async (c) => { posted.push(c.id); },
      applyPlanned: async (c, plan) => { posted.push(c.id); replayed.push(plan.result.log); }
    });
    return { out, seen, posted, replayed };
  };

  it('offers a panel per card carrying its art and its planned outcome', async () => {
    // Choosing between two names says almost nothing; the point of turning
    // them over is seeing what you are picking between.
    const { seen } = await run('path');
    expect(seen.options.map((o) => o.label)).toEqual(['Star', 'Path']);
    expect(seen.options[0].img).toContain('star.png');
    expect(seen.options[1].detail).toContain('land Speed 25 → 35');
  });

  it('shows the outcome, not the card blurb', async () => {
    const { seen } = await run('path');
    expect(seen.options.every((o) => o.detail !== 'blurb')).toBe(true);
  });

  it('applies the card that was chosen', async () => {
    const { posted } = await run('path');
    expect(posted).toEqual(['path']);
  });

  it('lands the outcome that was shown, by replaying the plan', async () => {
    // Re-running a handler that rolls would show one result and deal another.
    const { seen, replayed } = await run('path');
    const shown = seen.options.find((o) => o.value === 'path').detail;
    expect(replayed).toEqual([shown]);
  });

  it('returns the other card to the deck rather than burning it', async () => {
    const { out } = await run('path');
    expect(out.discarded).toEqual(['star']);
    expect(out.state.remaining).toContain('star');
  });

  it('keeps the first card if nobody answers', async () => {
    let seen = null;
    const posted = [];
    await (await import('../scripts/keep-one.mjs')).drawTwoKeepOne({
      state: state(), byId, actor: actor(), api: stubApi(), rng: () => 0.5,
      ask: async (a) => { seen = a; return null; },
      applyAndPost: async (c) => { posted.push(c.id); },
      applyPlanned: async (c) => { posted.push(c.id); }
    });
    expect(posted).toEqual(['star']);
  });

  it('does not ask when only one card remains', async () => {
    let asked = false;
    const posted = [];
    await (await import('../scripts/keep-one.mjs')).drawTwoKeepOne({
      state: { remaining: ['star'], drawn: [] }, byId, actor: actor(), api: stubApi(),
      ask: async () => { asked = true; return null; },
      applyAndPost: async (c) => { posted.push(c.id); },
      applyPlanned: async (c) => { posted.push(c.id); }
    });
    expect(asked).toBe(false);
    expect(posted).toEqual(['star']);
  });
});
