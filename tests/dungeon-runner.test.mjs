import { describe, it, expect } from 'vitest';
import {
  createRun, markRoomOutcome, advanceToRoom, undoLastRoomEntry, canUndoRoomEntry,
  abandonRun, getRunState
} from '../scripts/dungeon-runner.mjs';

function makeSettingsStub(initial = {}) {
  let store = { dungeonRuns: initial };
  return {
    get: (moduleId, key) => store[key],
    set: (moduleId, key, value) => { store = { ...store, [key]: value }; }
  };
}

describe('createRun / getRunState', () => {
  it('creates a fresh run scoped to a scene, room 0 already physically placed', async () => {
    const settingsRef = makeSettingsStub();
    const state = await createRun({ sceneId: 'scene-1', roomCount: 5 }, { settingsRef });
    expect(state.rooms).toHaveLength(5);
    expect(state.currentIndex).toBe(0);
    expect(state.completed).toBe(false);
    expect(state.physicalSlotByRoomId).toEqual({ [state.rooms[0].id]: 0 });
    expect(state.nextPhysicalSlot).toBe(1);
    expect(state.lastAutoEntry).toBeNull();
    expect(getRunState('scene-1', { settingsRef })).toEqual(state);
  });

  it('returns null for a scene with no run', () => {
    const settingsRef = makeSettingsStub();
    expect(getRunState('nothing-here', { settingsRef })).toBeNull();
  });

  it('keeps two scenes independent', async () => {
    const settingsRef = makeSettingsStub();
    await createRun({ sceneId: 'scene-a', roomCount: 3, seed: 'a' }, { settingsRef });
    await createRun({ sceneId: 'scene-b', roomCount: 6, seed: 'b' }, { settingsRef });
    const a = getRunState('scene-a', { settingsRef });
    const b = getRunState('scene-b', { settingsRef });
    expect(a.rooms).toHaveLength(3);
    expect(b.rooms).toHaveLength(6);
    expect(a.seed).toBe('a');
    expect(b.seed).toBe('b');
  });
});

describe('markRoomOutcome', () => {
  it('does not move currentIndex, and reports the next room + its assigned physical slot', async () => {
    const settingsRef = makeSettingsStub();
    await createRun({ sceneId: 's', roomCount: 5, seed: 'fixed' }, { settingsRef });
    const before = getRunState('s', { settingsRef });
    const { state, nextRoomId, nextPhysicalSlot } = await markRoomOutcome({ sceneId: 's', succeeded: true }, { settingsRef });
    expect(state.currentIndex).toBe(before.currentIndex);
    expect(state.history).toHaveLength(1);
    expect(nextRoomId).toBe(state.rooms[1].id);
    expect(nextPhysicalSlot).toBe(1);
    expect(state.physicalSlotByRoomId[nextRoomId]).toBe(1);
    expect(state.nextPhysicalSlot).toBe(2);
  });

  it('assigns each newly-reached room the next slot number in order', async () => {
    const settingsRef = makeSettingsStub();
    await createRun({ sceneId: 's', roomCount: 5, seed: 'fixed' }, { settingsRef });
    const r1 = await markRoomOutcome({ sceneId: 's', succeeded: true }, { settingsRef });
    await advanceToRoom({ sceneId: 's', roomId: r1.nextRoomId }, { settingsRef });
    const r2 = await markRoomOutcome({ sceneId: 's', succeeded: true }, { settingsRef });
    expect(r2.nextPhysicalSlot).toBe(2);
  });

  it('marks the run completed when the goal room is resolved, with no next room', async () => {
    const settingsRef = makeSettingsStub();
    await createRun({ sceneId: 's', roomCount: 2, seed: 'fixed' }, { settingsRef });
    await markRoomOutcome({ sceneId: 's', succeeded: true }, { settingsRef });
    await advanceToRoom({ sceneId: 's', roomId: getRunState('s', { settingsRef }).rooms[1].id }, { settingsRef });
    const { state, effectKey, nextRoomId } = await markRoomOutcome({ sceneId: 's', succeeded: true }, { settingsRef });
    expect(state.completed).toBe(true);
    expect(effectKey).toBe('goal_cleared');
    expect(nextRoomId).toBeNull();
  });

  it('reports goal_failed on a failed goal room', async () => {
    const settingsRef = makeSettingsStub();
    await createRun({ sceneId: 's', roomCount: 2, seed: 'fixed' }, { settingsRef });
    await markRoomOutcome({ sceneId: 's', succeeded: true }, { settingsRef });
    await advanceToRoom({ sceneId: 's', roomId: getRunState('s', { settingsRef }).rooms[1].id }, { settingsRef });
    const { effectKey } = await markRoomOutcome({ sceneId: 's', succeeded: false }, { settingsRef });
    expect(effectKey).toBe('goal_failed');
  });

  it('is a no-op once the run is completed', async () => {
    const settingsRef = makeSettingsStub();
    await createRun({ sceneId: 's', roomCount: 2, seed: 'fixed' }, { settingsRef });
    await markRoomOutcome({ sceneId: 's', succeeded: true }, { settingsRef });
    await advanceToRoom({ sceneId: 's', roomId: getRunState('s', { settingsRef }).rooms[1].id }, { settingsRef });
    await markRoomOutcome({ sceneId: 's', succeeded: true }, { settingsRef });
    const completedState = getRunState('s', { settingsRef });
    const again = await markRoomOutcome({ sceneId: 's', succeeded: true }, { settingsRef });
    expect(again.state).toEqual(completedState);
    expect(again.nextRoomId).toBeNull();
  });

  it('is a no-op with no run at all', async () => {
    const settingsRef = makeSettingsStub();
    const result = await markRoomOutcome({ sceneId: 'nope', succeeded: true }, { settingsRef });
    expect(result.state).toBeNull();
    expect(result.nextRoomId).toBeNull();
  });
});

describe('advanceToRoom', () => {
  it('advances currentIndex and records lastAutoEntry when the roomId matches the true next room', async () => {
    const settingsRef = makeSettingsStub();
    await createRun({ sceneId: 's', roomCount: 5, seed: 'fixed' }, { settingsRef });
    const { nextRoomId } = await markRoomOutcome({ sceneId: 's', succeeded: true }, { settingsRef });
    const { ok, state } = await advanceToRoom({ sceneId: 's', roomId: nextRoomId, revealedTokenIds: ['t1'] }, { settingsRef });
    expect(ok).toBe(true);
    expect(state.currentIndex).toBe(1);
    expect(state.lastAutoEntry).toEqual({ roomId: nextRoomId, fromIndex: 0, toIndex: 1, revealedTokenIds: ['t1'] });
  });

  it('rejects a roomId that is not genuinely the next room, without mutating state', async () => {
    const settingsRef = makeSettingsStub();
    await createRun({ sceneId: 's', roomCount: 5, seed: 'fixed' }, { settingsRef });
    const before = getRunState('s', { settingsRef });
    const { ok, state } = await advanceToRoom({ sceneId: 's', roomId: 'not-a-real-room' }, { settingsRef });
    expect(ok).toBe(false);
    expect(state).toEqual(before);
    expect(getRunState('s', { settingsRef })).toEqual(before);
  });

  it('is a no-op for a scene with no run', async () => {
    const settingsRef = makeSettingsStub();
    const { ok, state } = await advanceToRoom({ sceneId: 'nope', roomId: 'x' }, { settingsRef });
    expect(ok).toBe(false);
    expect(state).toBeNull();
  });
});

describe('canUndoRoomEntry / undoLastRoomEntry', () => {
  it('can undo right after an automatic entry', async () => {
    const settingsRef = makeSettingsStub();
    await createRun({ sceneId: 's', roomCount: 5, seed: 'fixed' }, { settingsRef });
    const { nextRoomId } = await markRoomOutcome({ sceneId: 's', succeeded: true }, { settingsRef });
    await advanceToRoom({ sceneId: 's', roomId: nextRoomId }, { settingsRef });
    expect(canUndoRoomEntry(getRunState('s', { settingsRef }))).toBe(true);

    const { ok, state, undone } = await undoLastRoomEntry({ sceneId: 's' }, { settingsRef });
    expect(ok).toBe(true);
    expect(state.currentIndex).toBe(0);
    expect(state.lastAutoEntry).toBeNull();
    expect(undone.roomId).toBe(nextRoomId);
  });

  it('cannot undo once the entered room has already been judged', async () => {
    const settingsRef = makeSettingsStub();
    await createRun({ sceneId: 's', roomCount: 5, seed: 'fixed' }, { settingsRef });
    const { nextRoomId } = await markRoomOutcome({ sceneId: 's', succeeded: true }, { settingsRef });
    await advanceToRoom({ sceneId: 's', roomId: nextRoomId }, { settingsRef });
    await markRoomOutcome({ sceneId: 's', succeeded: true }, { settingsRef });
    expect(canUndoRoomEntry(getRunState('s', { settingsRef }))).toBe(false);

    const { ok } = await undoLastRoomEntry({ sceneId: 's' }, { settingsRef });
    expect(ok).toBe(false);
  });

  it('is a no-op when there is nothing to undo', async () => {
    const settingsRef = makeSettingsStub();
    await createRun({ sceneId: 's', roomCount: 5, seed: 'fixed' }, { settingsRef });
    expect(canUndoRoomEntry(getRunState('s', { settingsRef }))).toBe(false);
    const { ok } = await undoLastRoomEntry({ sceneId: 's' }, { settingsRef });
    expect(ok).toBe(false);
  });
});

describe('abandonRun', () => {
  it('removes only the targeted scene', async () => {
    const settingsRef = makeSettingsStub();
    await createRun({ sceneId: 'scene-a', roomCount: 3 }, { settingsRef });
    await createRun({ sceneId: 'scene-b', roomCount: 3 }, { settingsRef });
    await abandonRun({ sceneId: 'scene-a' }, { settingsRef });
    expect(getRunState('scene-a', { settingsRef })).toBeNull();
    expect(getRunState('scene-b', { settingsRef })).not.toBeNull();
  });

  it('is a no-op for a scene with no run', async () => {
    const settingsRef = makeSettingsStub();
    await expect(abandonRun({ sceneId: 'nothing' }, { settingsRef })).resolves.not.toThrow();
  });
});
