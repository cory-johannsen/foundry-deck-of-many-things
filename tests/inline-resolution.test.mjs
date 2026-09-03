import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { pendingKind } from '../scripts/gm-resolution.mjs';
import { requiresConfirmation } from '../scripts/card-effects.mjs';

const cards = JSON.parse(readFileSync(new URL('../data/cards.json', import.meta.url)));
const BY_ID = new Map(cards.map((c) => [c.id, c]));

/** The condition the draw loop uses to resolve a card where it stands. */
const resolvesInline = (result, actor) =>
  result.mode === 'gm' && !!actor && pendingKind(result.meta) !== 'acknowledge';

describe('a card that asks a question asks it as it is drawn', () => {
  const actor = { id: 'a1' };

  it('resolves Jester where it stands, with no Apply button in between', () => {
    const result = { mode: 'gm', meta: { requires: 'choose_option', paramKey: 'chosen' } };
    expect(resolvesInline(result, actor)).toBe(true);
  });

  it('resolves an ability choice the same way', () => {
    const result = { mode: 'gm', meta: { requires: 'choose_ability', delta: 1 } };
    expect(resolvesInline(result, actor)).toBe(true);
  });

  it('resolves a multi-select the same way', () => {
    const result = { mode: 'gm', meta: { requires: 'choose_many', count: 3, options: [] } };
    expect(resolvesInline(result, actor)).toBe(true);
  });

  it('leaves a card with no actor pending, rather than interrupting a batch', () => {
    // The GM says who it lands on when they are ready.
    const result = { mode: 'gm', meta: { requires: 'choose_option' } };
    expect(resolvesInline(result, null)).toBe(false);
  });

  it('leaves a card that only wants acknowledging pending', () => {
    const result = { mode: 'gm', meta: { kind: 'gm_only' } };
    expect(resolvesInline(result, actor)).toBe(false);
  });

  it('does nothing for a card that already applied', () => {
    expect(resolvesInline({ mode: 'auto', meta: null }, actor)).toBe(false);
  });
});

describe('no confirmation after the answer is given', () => {
  it('asks for no confirmation on any card, the gate being empty', () => {
    // Jester used to show a choice dialog and then an "are you sure" for the
    // same decision.
    const stillConfirms = cards
      .filter((c) => requiresConfirmation(c.mechanics.kind))
      .map((c) => c.name);
    expect(stillConfirms).toEqual([]);
  });

  it('would confirm again if a kind were put back in the set', async () => {
    const { REQUIRES_CONFIRMATION } = await import('../scripts/card-effects.mjs');
    REQUIRES_CONFIRMATION.add('bonus_draws');
    try {
      expect(requiresConfirmation(BY_ID.get('jester').mechanics.kind)).toBe(true);
    } finally {
      REQUIRES_CONFIRMATION.delete('bonus_draws');
    }
  });
});
