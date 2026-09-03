import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { checkCards, toNumber } from '../tools/card-text-checks.mjs';

const cards = JSON.parse(readFileSync(new URL('../data/cards.json', import.meta.url)));
const clone = () => JSON.parse(JSON.stringify(cards));
const withCard = (id, fn) => { const c = clone(); fn(c.find((x) => x.id === id)); return c; };

describe('the deck as it stands', () => {
  it('says what it does', () => {
    expect(checkCards(cards)).toEqual([]);
  });
});

describe('the bug this exists for', () => {
  // Tavern shipped claiming +1 in its summary and +2 in its full text while
  // granting +1. The schema passed it and every test passed it.
  const tavern = () => withCard('tavern', (c) => {
    c.rules.summary = 'Your Charisma bonus increases by 1 (max 22).';
    c.rules.full = 'Your Charisma score increases by 2, to a maximum of 22.';
  });

  it('catches the prose contradicting the params', () => {
    const kinds = checkCards(tavern()).map((p) => p.kind);
    expect(kinds).toContain('params-mismatch');
  });

  it('catches the summary contradicting the full text', () => {
    const kinds = checkCards(tavern()).map((p) => p.kind);
    expect(kinds).toContain('self-contradiction');
  });

  it('names the card and both numbers, so the report is actionable', () => {
    const p = checkCards(tavern()).find((x) => x.kind === 'self-contradiction');
    expect(p.card).toBe('Tavern');
    expect(p.detail).toMatch(/summary says .*1.*full text says .*2/);
  });
});

describe('drift between params and prose', () => {
  const drifts = [
    ['sun', (c) => { c.mechanics.params.xp = 5000; }],
    ['fool', (c) => { c.mechanics.params.xp = 250; }],
    ['path', (c) => { c.mechanics.params.walk_ft = 15; }],
    ['well', (c) => { c.mechanics.params.count = 5; }],
    ['ship', (c) => { c.mechanics.params.count = 2; }],
    ['aberration', (c) => { c.mechanics.params.range_ft = 30; }],
    ['jester', (c) => { c.mechanics.params.xp_alternative = 2000; }],
    ['lance', (c) => { c.mechanics.params.delta_mod = 3; }],
    ['expert', (c) => { c.mechanics.params.delta_mod = 2; }]
  ];

  for (const [id, mutate] of drifts) {
    it(`catches ${id} drifting`, () => {
      const found = checkCards(withCard(id, mutate));
      expect(found.length, JSON.stringify(found)).toBeGreaterThan(0);
    });
  }
});

describe('staying quiet when it should', () => {
  it('does not fault prose that simply states no figure', () => {
    const c = withCard('expert', (x) => {
      x.rules.summary = 'Your reflexes sharpen.';
      x.rules.full = 'Your reflexes sharpen permanently.';
    });
    expect(checkCards(c)).toEqual([]);
  });

  it('accepts a card that mentions the right number among others', () => {
    // "+1, to a maximum of +7" states two numbers; only the increase is claimed.
    const c = withCard('expert', (x) => {
      x.rules.full = 'Your Dexterity modifier increases by 1, to a maximum of +7, permanently.';
    });
    expect(checkCards(c)).toEqual([]);
  });

  it('ignores kinds it has no rule for', () => {
    const c = withCard('moon', (x) => { x.mechanics.params.count_dice = '9d9'; });
    expect(checkCards(c).filter((p) => p.card === 'Moon')).toEqual([]);
  });

  it('skips a card whose params do not pin the number down', () => {
    const c = withCard('sun', (x) => { delete x.mechanics.params.xp; });
    expect(checkCards(c).filter((p) => p.kind === 'params-mismatch')).toEqual([]);
  });
});

describe('toNumber', () => {
  it('reads the forms card text actually uses', () => {
    expect(toNumber('1,000')).toBe(1000);
    expect(toNumber('three')).toBe(3);
    expect(toNumber('+7')).toBe(7);
    expect(toNumber('90')).toBe(90);
  });

  it('returns null for anything it cannot read', () => {
    expect(toNumber('several')).toBeNull();
    expect(toNumber(null)).toBeNull();
    expect(toNumber('')).toBeNull();
  });
});

describe('every card narrates what it does', () => {
  it('gives all 66 a line of narration', () => {
    const missing = cards.filter((c) => !c.rules.narration?.trim()).map((c) => c.name);
    expect(missing).toEqual([]);
  });

  it('names the card in its own narration, so the line stands alone', () => {
    const unnamed = cards
      .filter((c) => !new RegExp(`\\b${c.name}\\b`, 'i').test(c.rules.narration ?? ''))
      .map((c) => c.name);
    expect(unnamed).toEqual([]);
  });

  it('keeps narration distinct from the divination flavour', () => {
    // The two describe different things: what the card does, and what its
    // imagery means when it is read rather than drawn.
    const same = cards.filter((c) => c.rules.narration === c.flavor).map((c) => c.name);
    expect(same).toEqual([]);
  });

  it('leaves the mechanical summary to the summary', () => {
    // Narration should not be where a number lives; that is what drifts.
    const numeric = cards
      .filter((c) => /\b\d+(st|nd|rd|th)?\b/.test((c.rules.narration ?? '').replace(/\bd\d+\b/g, '')))
      .map((c) => `${c.name}: ${c.rules.narration}`);
    expect(numeric).toEqual([]);
  });
});

describe('growHeight', () => {
  it('reads the forms a player writes a height in', async () => {
    const { growHeight } = await import('../scripts/card-effects.mjs');
    expect(growHeight("5'10\"", 7)).toBe("6'5\"");
    expect(growHeight('5 ft 10 in', 7)).toBe("6'5\"");
    expect(growHeight('70', 7)).toBe("6'5\"");
  });

  it('carries inches over into feet', async () => {
    const { growHeight } = await import('../scripts/card-effects.mjs');
    expect(growHeight("5'11\"", 2)).toBe("6'1\"");
  });

  it('leaves alone what it cannot read, rather than guessing', async () => {
    const { growHeight } = await import('../scripts/card-effects.mjs');
    expect(growHeight('quite tall', 7)).toBeNull();
    expect(growHeight('', 7)).toBeNull();
    expect(growHeight(null, 7)).toBeNull();
  });
});
