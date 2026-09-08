/**
 * The Foundry side of a dungeon run: reads and writes the `dungeonRuns` world
 * setting (keyed by scene id — see module.mjs) and calls into the pure logic
 * in dungeon-deck.mjs. `settingsRef` is injectable, same pattern as
 * draw-target.mjs's canvasRef/userRef, so this is testable against an
 * in-memory stub instead of live `game.settings`.
 */
import { buildRoomSequence, findOutcomeTemplate, resolveRoomOutcome, applySequenceMutation } from './dungeon-deck.mjs';

const MODULE_ID = 'deck-of-many-more-things';

function defaultSettingsRef() {
  return {
    get: (...args) => game.settings.get(...args),
    set: (...args) => game.settings.set(...args)
  };
}

async function persist(sceneId, state, settingsRef) {
  const all = settingsRef.get(MODULE_ID, 'dungeonRuns') ?? {};
  await settingsRef.set(MODULE_ID, 'dungeonRuns', { ...all, [sceneId]: state });
  return state;
}

/** The dungeon run for this scene, or null if none has been started. */
export function getRunState(sceneId, { settingsRef = defaultSettingsRef() } = {}) {
  const all = settingsRef.get(MODULE_ID, 'dungeonRuns') ?? {};
  return all[sceneId] ?? null;
}

export async function createRun(
  { sceneId, roomCount, traits = [], excludeTraits = [], seed = null },
  { settingsRef = defaultSettingsRef(), setpieceIds = [] } = {}
) {
  const runSeed = seed ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const rooms = buildRoomSequence({ seed: runSeed, roomCount, setpieceIds });
  const state = {
    seed: runSeed,
    createdAt: Date.now(),
    traits,
    excludeTraits,
    rooms,
    currentIndex: 0,
    completed: false,
    history: []
  };
  return persist(sceneId, state, settingsRef);
}

/**
 * Resolve the CURRENT room as succeeded or failed.
 *
 * The goal room has no outcome slot: resolving it just ends the run and
 * records a distinct completion outcome. Every other room resolves its
 * outcome slot, applies any resulting sequence mutation, and advances.
 * `mutation` is returned as-is (including 'rerun_encounter', which changes
 * nothing about the sequence) so the caller knows what to prompt the GM with.
 *
 * A no-op (state unchanged) is returned if there is no run, or it is already
 * completed — callers should check `getRunState` before offering the action,
 * this is just a safety net against a stale UI double-click.
 */
export async function markRoomOutcome(
  { sceneId, succeeded },
  { settingsRef = defaultSettingsRef(), setpieceIds = [] } = {}
) {
  const state = getRunState(sceneId, { settingsRef });
  if (!state || state.completed) return { state, effectKey: null, mutation: null };

  const room = state.rooms[state.currentIndex];
  const base = {
    roomId: room.id,
    kind: room.kind,
    outcome: succeeded ? 'succeeded' : 'failed',
    resolvedAt: Date.now()
  };

  if (room.isGoal) {
    const effectKey = succeeded ? 'goal_cleared' : 'goal_failed';
    const newState = { ...state, completed: true, history: [...state.history, { ...base, effectKey }] };
    await persist(sceneId, newState, settingsRef);
    return { state: newState, effectKey, mutation: null };
  }

  const template = findOutcomeTemplate(room.outcomeSlotId);
  const { effectKey, mutation } = resolveRoomOutcome(template, succeeded);
  const rooms = (mutation === 'remove_next' || mutation === 'insert_after')
    ? applySequenceMutation(state.rooms, state.currentIndex, mutation, { seed: state.seed, setpieceIds })
    : state.rooms;

  const newState = {
    ...state,
    rooms,
    currentIndex: state.currentIndex + 1,
    history: [...state.history, { ...base, effectKey }]
  };
  await persist(sceneId, newState, settingsRef);
  return { state: newState, effectKey, mutation };
}

export async function abandonRun({ sceneId }, { settingsRef = defaultSettingsRef() } = {}) {
  const all = settingsRef.get(MODULE_ID, 'dungeonRuns') ?? {};
  if (!(sceneId in all)) return;
  const rest = { ...all };
  delete rest[sceneId];
  await settingsRef.set(MODULE_ID, 'dungeonRuns', rest);
}
