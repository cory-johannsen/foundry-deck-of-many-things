import { describe, it, expect } from 'vitest';
import { createRun, markRoomOutcome, abandonRun, getRunState } from '../scripts/dungeon-runner.mjs';

function makeSettingsStub(initial = {}) {
  let store = { dungeonRuns: initial };
  return {
    get: (moduleId, key) => store[key],
    set: (moduleId, key, value) => { store = { ...store, [key]: value }; }
  };
}

describe('createRun / getRunState', () => {
  it('creates a fresh run scoped to a scene', async () => {
    const settingsRef = makeSettingsStub();
    const state = await createRun({ sceneId: 'scene-1', roomCount: 5 }, { settingsRef });
    expect(state.rooms).toHaveLength(5);
    expect(state.currentIndex).toBe(0);
    expect(state.completed).toBe(false);
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

  it('is deterministic given an explicit seed', async () => {
    const settingsRef = makeSettingsStub();
    const state = await createRun({ sceneId: 's', roomCount: 4, seed: 'fixed' }, { settingsRef });
    expect(state.rooms.map((r) => r.kind)).toEqual(
      (await createRun({ sceneId: 's2', roomCount: 4, seed: 'fixed' }, { settingsRef: makeSettingsStub() }))
        .rooms.map((r) => r.kind)
    );
  });
});

describe('markRoomOutcome', () => {
  it('advances currentIndex and records history on a non-goal room', async () => {
    const settingsRef = makeSettingsStub();
    await createRun({ sceneId: 's', roomCount: 5, seed: 'fixed' }, { settingsRef });
    const { state, effectKey } = await markRoomOutcome({ sceneId: 's', succeeded: true }, { settingsRef });
    expect(state.currentIndex).toBe(1);
    expect(state.history).toHaveLength(1);
    expect(state.history[0].outcome).toBe('succeeded');
    expect(state.history[0].effectKey).toBe(effectKey);
    expect(state.completed).toBe(false);
  });

  it('marks the run completed when the goal room is resolved', async () => {
    const settingsRef = makeSettingsStub();
    await createRun({ sceneId: 's', roomCount: 2, seed: 'fixed' }, { settingsRef });
    // roomCount 2 = one regular room + the goal room.
    await markRoomOutcome({ sceneId: 's', succeeded: true }, { settingsRef });
    const { state, effectKey } = await markRoomOutcome({ sceneId: 's', succeeded: true }, { settingsRef });
    expect(state.completed).toBe(true);
    expect(effectKey).toBe('goal_cleared');
  });

  it('reports goal_failed on a failed goal room', async () => {
    const settingsRef = makeSettingsStub();
    await createRun({ sceneId: 's', roomCount: 2, seed: 'fixed' }, { settingsRef });
    await markRoomOutcome({ sceneId: 's', succeeded: true }, { settingsRef });
    const { effectKey } = await markRoomOutcome({ sceneId: 's', succeeded: false }, { settingsRef });
    expect(effectKey).toBe('goal_failed');
  });

  it('is a no-op once the run is completed', async () => {
    const settingsRef = makeSettingsStub();
    await createRun({ sceneId: 's', roomCount: 2, seed: 'fixed' }, { settingsRef });
    await markRoomOutcome({ sceneId: 's', succeeded: true }, { settingsRef });
    const completedState = (await markRoomOutcome({ sceneId: 's', succeeded: true }, { settingsRef })).state;
    const again = await markRoomOutcome({ sceneId: 's', succeeded: true }, { settingsRef });
    expect(again.state).toEqual(completedState);
  });

  it('is a no-op with no run at all', async () => {
    const settingsRef = makeSettingsStub();
    const result = await markRoomOutcome({ sceneId: 'nope', succeeded: true }, { settingsRef });
    expect(result.state).toBeNull();
    expect(result.effectKey).toBeNull();
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
