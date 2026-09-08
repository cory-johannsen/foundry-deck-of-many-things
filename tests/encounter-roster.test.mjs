import { describe, it, expect } from 'vitest';
import { resolveEncounterRoster } from '../scripts/encounter-roster.mjs';

function makeStubApi(pool) {
  const calls = [];
  return {
    calls,
    async findCreatures(opts) {
      calls.push(opts);
      return pool.filter((c) =>
        (opts.minLevel == null || c.level >= opts.minLevel)
        && (opts.maxLevel == null || c.level <= opts.maxLevel)
        && !(opts.excludeTraits ?? []).some((t) => (c.traits ?? []).includes(t)));
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
