import { describe, it, expect } from 'vitest';
import {
  buildRoomSequence,
  resolveRoomOutcome,
  applySequenceMutation,
  findOutcomeTemplate,
  OUTCOME_SLOT_TEMPLATES,
  depthBiasFor,
  MAX_DEPTH_BIAS,
  locationTagAt,
  LOCATION_TAGS
} from '../scripts/dungeon-deck.mjs';

describe('buildRoomSequence', () => {
  it('ends with a combat goal room carrying no outcome slot', () => {
    const rooms = buildRoomSequence({ seed: 'alpha', roomCount: 6 });
    const goal = rooms.at(-1);
    expect(goal.isGoal).toBe(true);
    expect(goal.kind).toBe('combat');
    expect(goal.outcomeSlotId).toBeNull();
    expect(goal.setpieceId).toBeNull();
  });

  it('respects roomCount, including the goal room', () => {
    const rooms = buildRoomSequence({ seed: 'alpha', roomCount: 4 });
    expect(rooms).toHaveLength(4);
    expect(rooms.slice(0, 3).every((r) => !r.isGoal)).toBe(true);
  });

  it('rejects a roomCount below 2', () => {
    expect(() => buildRoomSequence({ seed: 'alpha', roomCount: 1 })).toThrow();
    expect(() => buildRoomSequence({ seed: 'alpha', roomCount: 0 })).toThrow();
  });

  it('is deterministic for the same seed', () => {
    const a = buildRoomSequence({ seed: 'alpha', roomCount: 8, setpieceIds: ['x', 'y', 'z'] });
    const b = buildRoomSequence({ seed: 'alpha', roomCount: 8, setpieceIds: ['x', 'y', 'z'] });
    expect(a).toEqual(b);
  });

  it('produces different sequences for different seeds', () => {
    const a = buildRoomSequence({ seed: 'alpha', roomCount: 8 });
    const b = buildRoomSequence({ seed: 'beta', roomCount: 8 });
    expect(a).not.toEqual(b);
  });

  it('every non-goal room carries an outcome slot that resolves to a real template', () => {
    const rooms = buildRoomSequence({ seed: 'gamma', roomCount: 10 });
    for (const room of rooms.filter((r) => !r.isGoal)) {
      expect(findOutcomeTemplate(room.outcomeSlotId)).not.toBeNull();
    }
  });

  it('gives every room a locationTag, including the goal room', () => {
    const rooms = buildRoomSequence({ seed: 'epsilon', roomCount: 7 });
    for (const room of rooms) {
      expect(LOCATION_TAGS).toContain(room.locationTag);
    }
  });

  it('only assigns a set-piece to puzzle_or_trap rooms, and only when set-pieces are supplied', () => {
    const withPieces = buildRoomSequence({ seed: 'delta', roomCount: 12, setpieceIds: ['p1', 'p2'] });
    for (const room of withPieces) {
      if (room.kind === 'puzzle_or_trap') expect(['p1', 'p2']).toContain(room.setpieceId);
      else expect(room.setpieceId).toBeNull();
    }
    const withoutPieces = buildRoomSequence({ seed: 'delta', roomCount: 12, setpieceIds: [] });
    for (const room of withoutPieces) expect(room.setpieceId).toBeNull();
  });
});

describe('resolveRoomOutcome', () => {
  it('reads the reward branch on success and the ruin branch on failure, for every template', () => {
    for (const template of OUTCOME_SLOT_TEMPLATES) {
      const reward = resolveRoomOutcome(template, true);
      expect(reward.effectKey).toBe(template.reward.key);
      expect(reward.mutation).toBe(template.reward.mutation ?? null);

      const ruin = resolveRoomOutcome(template, false);
      expect(ruin.effectKey).toBe(template.ruin.key);
      expect(ruin.mutation).toBe(template.ruin.mutation ?? null);
    }
  });
});

describe('applySequenceMutation', () => {
  const rooms = () => buildRoomSequence({ seed: 'seq', roomCount: 5 });

  it('remove_next drops the following room', () => {
    const before = rooms();
    const after = applySequenceMutation(before, 0, 'remove_next', { seed: 'seq' });
    expect(after).toHaveLength(before.length - 1);
    expect(after[0].id).toBe(before[0].id);
    expect(after[1].id).toBe(before[2].id);
  });

  it('remove_next is a no-op when the next room is the goal room', () => {
    const before = rooms();
    const lastNonGoalIndex = before.length - 2;
    const after = applySequenceMutation(before, lastNonGoalIndex, 'remove_next', { seed: 'seq' });
    expect(after).toBe(before);
  });

  it('insert_after adds one room without disturbing the goal room at the end', () => {
    const before = rooms();
    const after = applySequenceMutation(before, 1, 'insert_after', { seed: 'seq' });
    expect(after).toHaveLength(before.length + 1);
    expect(after.at(-1).isGoal).toBe(true);
    expect(after.at(-1).id).toBe(before.at(-1).id);
    expect(after[2].isGoal).toBe(false);
  });

  it('the inserted room carries a locationTag like any other room', () => {
    const before = rooms();
    const after = applySequenceMutation(before, 1, 'insert_after', { seed: 'seq' });
    expect(LOCATION_TAGS).toContain(after[2].locationTag);
  });

  it('an unrecognised mutation is a no-op', () => {
    const before = rooms();
    expect(applySequenceMutation(before, 0, null, { seed: 'seq' })).toBe(before);
    expect(applySequenceMutation(before, 0, 'rerun_encounter', { seed: 'seq' })).toBe(before);
  });
});

describe('depthBiasFor', () => {
  it('is zero at room 0', () => {
    expect(depthBiasFor({ physicalSlot: 0, roomCount: 8, isGoal: false })).toBe(0);
  });

  it('always gives the goal room the maximum bias, regardless of dungeon length', () => {
    expect(depthBiasFor({ physicalSlot: 1, roomCount: 2, isGoal: true })).toBe(MAX_DEPTH_BIAS);
    expect(depthBiasFor({ physicalSlot: 19, roomCount: 20, isGoal: true })).toBe(MAX_DEPTH_BIAS);
  });

  it('is monotonically non-decreasing across a dungeon\'s non-goal rooms', () => {
    const roomCount = 9;
    let previous = -Infinity;
    for (let slot = 0; slot < roomCount - 1; slot += 1) {
      const bias = depthBiasFor({ physicalSlot: slot, roomCount, isGoal: false });
      expect(bias).toBeGreaterThanOrEqual(previous);
      previous = bias;
    }
  });

  it('never exceeds MAX_DEPTH_BIAS', () => {
    for (let slot = 0; slot < 10; slot += 1) {
      expect(depthBiasFor({ physicalSlot: slot, roomCount: 10, isGoal: false })).toBeLessThanOrEqual(MAX_DEPTH_BIAS);
    }
  });
});

describe('locationTagAt', () => {
  it('always returns a member of LOCATION_TAGS', () => {
    for (let i = 0; i < 20; i += 1) {
      expect(LOCATION_TAGS).toContain(locationTagAt('seed', i));
    }
  });

  it('is deterministic for the same seed and index', () => {
    expect(locationTagAt('alpha', 3)).toBe(locationTagAt('alpha', 3));
  });

  it('varies across indices (not the same tag every time)', () => {
    const tags = new Set(Array.from({ length: 20 }, (_, i) => locationTagAt('alpha', i)));
    expect(tags.size).toBeGreaterThan(1);
  });
});
