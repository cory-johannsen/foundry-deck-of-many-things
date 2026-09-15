import { describe, it, expect } from 'vitest';
import { resolveEncounterRoster } from '../scripts/encounter-roster.mjs';

function makeStubApi(pool) {
  const calls = [];
  return {
    calls,
    async findCreatures(opts) {
      calls.push(opts);
      return pool.filter((c) => {
        const traits = c.traits ?? [];
        if (opts.minLevel != null && c.level < opts.minLevel) return false;
        if (opts.maxLevel != null && c.level > opts.maxLevel) return false;
        if ((opts.excludeTraits ?? []).some((t) => traits.includes(t))) return false;
        if ((opts.traits ?? []).length && !opts.traits.some((t) => traits.includes(t))) return false;
        if (opts.requireTrait && !traits.includes(opts.requireTrait)) return false;
        return true;
      });
    }
  };
}

const seq = (values) => {
  let i = 0;
  return () => values[Math.min(i++, values.length - 1)];
};

describe('resolveEncounterRoster', () => {
  it('queries at partyLevel + levelOffset, with tolerance', async () => {
    const api = makeStubApi([{ pack: 'p', id: 'goblin', name: 'Goblin', level: 3, traits: [] }]);
    const resolved = { foes: [{ id: 's1', kind: 'creature', levelOffset: -2 }] };
    const roster = await resolveEncounterRoster({ resolved, api, partyLevel: 5, rng: () => 0 });
    expect(roster.foes).toHaveLength(1);
    expect(roster.foes[0].name).toBe('Goblin');
    expect(api.calls[0].minLevel).toBe(2);
    expect(api.calls[0].maxLevel).toBe(4);
  });

  it('always excludes troop and swarm, even when the caller did not ask', async () => {
    const api = makeStubApi([{ pack: 'p', id: 'x', name: 'X', level: 5, traits: [] }]);
    const resolved = { foes: [{ id: 's1', kind: 'creature', levelOffset: 0 }] };
    await resolveEncounterRoster({ resolved, api, partyLevel: 5, excludeTraits: [], rng: () => 0 });
    expect(api.calls[0].excludeTraits).toEqual(expect.arrayContaining(['troop', 'swarm']));
  });

  it('resolves a group to the same creature repeated', async () => {
    const api = makeStubApi([{ pack: 'p', id: 'g', name: 'Goblin', level: 5, traits: [] }]);
    const resolved = {
      foes: [
        { id: 's1', kind: 'creature', levelOffset: 0, group: 'pack' },
        { id: 's2', kind: 'creature', levelOffset: 0, group: 'pack' }
      ]
    };
    const roster = await resolveEncounterRoster({ resolved, api, partyLevel: 5, rng: () => 0 });
    expect(roster.foes).toHaveLength(2);
    expect(roster.foes[0].id).toBe('g');
    expect(roster.foes[1].id).toBe('g');
    // Only one bestiary query for the whole group, not one per slot.
    expect(api.calls).toHaveLength(1);
  });

  it('expands countsAs into a higher count on a single foe entry', async () => {
    const api = makeStubApi([{ pack: 'p', id: 'rat', name: 'Giant Rat', level: 5, traits: [] }]);
    const resolved = { foes: [{ id: 's1', kind: 'creature', levelOffset: 0, countsAs: 4 }] };
    const roster = await resolveEncounterRoster({ resolved, api, partyLevel: 5, rng: () => 0 });
    expect(roster.foes[0].count).toBe(4);
  });

  it('warns instead of throwing when no creature matches a slot', async () => {
    const api = makeStubApi([]);
    const resolved = { foes: [{ id: 's1', kind: 'creature', levelOffset: 0 }] };
    const roster = await resolveEncounterRoster({ resolved, api, partyLevel: 5, rng: () => 0 });
    expect(roster.foes).toHaveLength(0);
    expect(roster.warnings).toHaveLength(1);
  });

  it('resolves friend, lurker and twins into their own roster slots', async () => {
    const api = makeStubApi([
      { pack: 'p', id: 'ally', name: 'Wandering Cleric', level: 4, traits: [] },
      { pack: 'p', id: 'sneak', name: 'Ambusher', level: 5, traits: [] },
      { pack: 'p', id: 'twin', name: 'Displacer Beast', level: 5, traits: [] }
    ]);
    const resolved = {
      foes: [],
      friend: { id: 'friend', kind: 'friend', levelOffset: -1 },
      lurker: { id: 'lurker', kind: 'lurker', levelOffset: 0 },
      twins: [
        { id: 'twinA', kind: 'twin', levelOffset: 0, twinPairId: 'twinB' },
        { id: 'twinB', kind: 'twin', levelOffset: 0, twinPairId: 'twinA' }
      ],
      noncombat: null,
      goal: null
    };
    const roster = await resolveEncounterRoster({ resolved, api, partyLevel: 5, rng: seq([0, 0, 0]) });
    expect(roster.friend).toBeTruthy();
    expect(roster.lurker).toBeTruthy();
    expect(roster.twins).toHaveLength(2);
    expect(roster.approxXp).toBeGreaterThan(0);
  });

  it('passes noncombat and goal through untouched', async () => {
    const api = makeStubApi([]);
    const resolved = { foes: [], noncombat: { id: 'nc' }, goal: { id: 'g' } };
    const roster = await resolveEncounterRoster({ resolved, api, partyLevel: 5 });
    expect(roster.noncombat).toEqual({ id: 'nc' });
    expect(roster.goal).toEqual({ id: 'g' });
  });
});

describe('levelOffsetBias', () => {
  it('shifts the queried level band', async () => {
    const api = makeStubApi([{ pack: 'p', id: 'x', name: 'X', level: 8, traits: [] }]);
    const resolved = { foes: [{ id: 's1', kind: 'creature', levelOffset: 0 }] };
    await resolveEncounterRoster({ resolved, api, partyLevel: 5, levelOffsetBias: 3, rng: () => 0 });
    expect(api.calls[0].minLevel).toBe(7);
    expect(api.calls[0].maxLevel).toBe(9);
  });

  it('raises the reported approximate severity', async () => {
    // Spans both the unbiased band ([4,6]) and the biased one ([6,8]) so
    // both calls actually find a creature — approxXp is a function of the
    // slot's levelOffset + bias, not of which creature happened to match.
    const api = makeStubApi([
      { pack: 'p', id: 'lo', name: 'Lo', level: 5, traits: [] },
      { pack: 'p', id: 'hi', name: 'Hi', level: 8, traits: [] }
    ]);
    const resolved = { foes: [{ id: 's1', kind: 'creature', levelOffset: 0 }] };
    const withoutBias = await resolveEncounterRoster({ resolved, api, partyLevel: 5, rng: () => 0 });
    const withBias = await resolveEncounterRoster({ resolved, api, partyLevel: 5, levelOffsetBias: 2, rng: () => 0 });
    expect(withoutBias.foes).toHaveLength(1);
    expect(withBias.foes).toHaveLength(1);
    expect(withBias.approxXp).toBeGreaterThan(withoutBias.approxXp);
  });

  it('applies uniformly to friend, lurker and twins, not just regular foes', async () => {
    const api = makeStubApi([{ pack: 'p', id: 'x', name: 'X', level: 9, traits: [] }]);
    const resolved = { foes: [], lurker: { id: 'l', kind: 'lurker', levelOffset: 0 } };
    await resolveEncounterRoster({ resolved, api, partyLevel: 5, levelOffsetBias: 3, rng: () => 0 });
    expect(api.calls[0].minLevel).toBe(7);
  });
});

describe('requireTrait (per-location restriction)', () => {
  it('is passed through to findCreatures as an ANDed filter', async () => {
    const api = makeStubApi([{ pack: 'p', id: 'g', name: 'Ghoul', level: 5, traits: ['undead'] }]);
    const resolved = { foes: [{ id: 's1', kind: 'creature', levelOffset: 0 }] };
    await resolveEncounterRoster({ resolved, api, partyLevel: 5, requireTrait: 'undead', rng: () => 0 });
    expect(api.calls[0].requireTrait).toBe('undead');
  });

  it('warns instead of throwing when nothing carries the required trait', async () => {
    const api = makeStubApi([{ pack: 'p', id: 'g', name: 'Goblin', level: 5, traits: ['humanoid'] }]);
    const resolved = { foes: [{ id: 's1', kind: 'creature', levelOffset: 0 }] };
    const roster = await resolveEncounterRoster({ resolved, api, partyLevel: 5, requireTrait: 'undead', rng: () => 0 });
    expect(roster.foes).toHaveLength(0);
    expect(roster.warnings).toHaveLength(1);
  });

  it('drops the broader dungeon-wide traits before ever dropping the room\'s own required trait', async () => {
    // Satisfies requireTrait only — incompatible with the dungeon-wide theme.
    const api = makeStubApi([{ pack: 'p', id: 'g', name: 'Ghoul', level: 5, traits: ['undead'] }]);
    const resolved = { foes: [{ id: 's1', kind: 'creature', levelOffset: 0 }] };
    const roster = await resolveEncounterRoster({
      resolved, api, partyLevel: 5, traits: ['dragon'], requireTrait: 'undead', rng: () => 0
    });
    expect(roster.foes).toHaveLength(1);
    expect(roster.foes[0].id).toBe('g');
    // Two failed attempts (Monster-Core-first, then full packs, both still
    // requiring 'dragon') before the loosened final attempt succeeds.
    expect(api.calls).toHaveLength(3);
    expect(api.calls.at(-1).traits).toEqual([]);
    expect(api.calls.at(-1).requireTrait).toBe('undead');
  });

  it('never loosens requireTrait itself, even as a last resort', async () => {
    const api = makeStubApi([{ pack: 'p', id: 'g', name: 'Goblin', level: 5, traits: ['humanoid'] }]);
    const resolved = { foes: [{ id: 's1', kind: 'creature', levelOffset: 0 }] };
    const roster = await resolveEncounterRoster({
      resolved, api, partyLevel: 5, traits: ['dragon'], requireTrait: 'undead', rng: () => 0
    });
    expect(roster.foes).toHaveLength(0);
    expect(roster.warnings).toHaveLength(1);
    expect(api.calls.every((c) => c.requireTrait === 'undead')).toBe(true);
  });
});
