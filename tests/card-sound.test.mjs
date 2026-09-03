import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import {
  SOUND_GROUPS, GROUP_BY_KIND, FALLBACK_GROUP, groupForCard, resolveCardSound
} from '../scripts/card-sound.mjs';

const cards = JSON.parse(readFileSync(new URL('../data/cards.json', import.meta.url)));

describe('every card makes a sound', () => {
  it('maps all 66 cards to a real sound file', () => {
    const silent = cards.filter((c) => !resolveCardSound(c));
    expect(silent).toEqual([]);
    expect(cards).toHaveLength(66);
  });

  it('has a group for every mechanics kind in the deck', () => {
    // Without this, a new card silently falls back and nobody notices.
    const ungrouped = [...new Set(cards.map((c) => c.mechanics.kind))]
      .filter((k) => !GROUP_BY_KIND[k]);
    expect(ungrouped).toEqual([]);
  });

  it('points every group at a declared file', () => {
    const groups = [...new Set(Object.values(GROUP_BY_KIND))];
    for (const g of groups) expect(SOUND_GROUPS[g], `group ${g}`).toBeTruthy();
    expect(SOUND_GROUPS[FALLBACK_GROUP]).toBeTruthy();
  });

  it('declares no group that no card uses', () => {
    const used = new Set([...Object.values(GROUP_BY_KIND), FALLBACK_GROUP]);
    expect(Object.keys(SOUND_GROUPS).filter((g) => !used.has(g))).toEqual([]);
  });
});

describe('resolveCardSound', () => {
  const card = (over = {}) => ({ id: 'x', mechanics: { kind: 'stat_bump' }, ...over });

  it('uses the effect group when the card names no sound of its own', () => {
    expect(resolveCardSound(card()))
      .toBe('modules/deck-of-many-more-things/assets/sounds/card-boon.ogg');
  });

  it('lets a card override its group with a bare filename', () => {
    expect(resolveCardSound(card({ sound: 'skull-laugh.ogg' })))
      .toBe('modules/deck-of-many-more-things/assets/sounds/skull-laugh.ogg');
  });

  it('passes a path through untouched so a card can point anywhere', () => {
    const p = 'modules/deck-of-many-more-things/assets/sounds/cards/skull.ogg';
    expect(resolveCardSound(card({ sound: p }))).toBe(p);
  });

  it('falls back rather than going silent on an unknown kind', () => {
    const c = card({ mechanics: { kind: 'not_a_real_kind' } });
    expect(groupForCard(c)).toBe(FALLBACK_GROUP);
    expect(resolveCardSound(c)).toContain(SOUND_GROUPS[FALLBACK_GROUP]);
  });
});

describe('the files actually exist', () => {
  // resolveCardSound returns a module-relative path; strip the prefix to reach
  // it on disk. A card mapped to a filename nobody ever added is still silent.
  const onDisk = (p) => new URL('../' + p.replace('modules/deck-of-many-more-things/', ''),
                                import.meta.url);

  it('has a real file behind every card, including the GM-only ones', () => {
    const missing = cards
      .map((c) => ({ name: c.name, path: resolveCardSound(c) }))
      .filter((x) => !existsSync(onDisk(x.path)));
    expect(missing).toEqual([]);
  });

  it('covers the narrative cards that resolve without touching the actor', () => {
    // These apply no changes at all, so nothing about their sound can depend
    // on a write having happened.
    for (const id of ['beast', 'moon', 'sage', 'fiend', 'fates']) {
      const card = cards.find((c) => c.id === id);
      expect(existsSync(onDisk(resolveCardSound(card))), id).toBe(true);
    }
  });
});
