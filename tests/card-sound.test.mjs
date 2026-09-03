import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import {
  SOUND_GROUPS, GROUP_BY_KIND, FALLBACK_GROUP, groupForCard, resolveCardSound, voiceVariant
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

describe('a card whose sound depends on who drew it', () => {
  const withGender = (value) => ({ system: { details: { gender: { value } } } });
  const corpse = cards.find((c) => c.id === 'corpse');

  it('reads feminine pronouns as the female voice', () => {
    // PF2e's gender field is free text — a pronouns box, not a lookup.
    for (const v of ['she/her', 'She/Her', 'her', 'female', 'a woman']) {
      expect(voiceVariant(withGender(v)), v).toBe('female');
    }
  });

  it('does not mistake "he/him" for a feminine reading', () => {
    // "he" is a substring of "she"; only a word match will do.
    for (const v of ['he/him', 'He/Him', 'male']) {
      expect(voiceVariant(withGender(v)), v).toBe('default');
    }
  });

  it('falls to the default when it cannot tell', () => {
    for (const v of ['', 'they/them', 'xe/xem', 'unspecified']) {
      expect(voiceVariant(withGender(v)), v).toBe('default');
    }
    expect(voiceVariant(null)).toBe('default');
    expect(voiceVariant({})).toBe('default');
  });

  it('picks the matching voice for Corpse', () => {
    expect(resolveCardSound(corpse, withGender('she/her'))).toContain('corpse-female.ogg');
    expect(resolveCardSound(corpse, withGender('he/him'))).toContain('corpse-male.ogg');
  });

  it('uses the default voice with no actor at all', () => {
    expect(resolveCardSound(corpse)).toContain('corpse-male.ogg');
    expect(resolveCardSound(corpse, null)).toContain('corpse-male.ogg');
  });

  it('leaves single-file cards untouched by the actor', () => {
    const pit = cards.find((c) => c.id === 'pit');
    expect(resolveCardSound(pit, withGender('she/her'))).toBe(resolveCardSound(pit));
  });

  it('has every variant file on disk', () => {
    for (const [variant, file] of Object.entries(corpse.sound)) {
      const path = new URL('../assets/sounds/' + file, import.meta.url);
      expect(existsSync(path), `${variant}: ${file}`).toBe(true);
    }
  });
});
