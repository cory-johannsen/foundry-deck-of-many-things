/**
 * The Foundry side of a dungeon run: reads and writes the `dungeonRuns` world
 * setting (keyed by scene id — see module.mjs) and calls into the pure logic
 * in dungeon-deck.mjs. `settingsRef` is injectable, same pattern as
 * draw-target.mjs's canvasRef/userRef, so this is testable against an
 * in-memory stub instead of live `game.settings`.
 *
 * `currentIndex` names the room the party is physically STANDING IN, not the
 * room most recently judged. Resolving a room (markRoomOutcome) never moves
 * it — it only decides what comes next and assigns that next room a physical
 * slot number so dungeon-scene.mjs knows what to build. Only the automatic
 * room-entry trigger (advanceToRoom) moves currentIndex, once the party has
 * actually walked there. Physical slots are handed out in the exact order
 * rooms are approached (a plain incrementing counter), never reassigned —
 * see dungeon-layout.mjs for why that needs no reindexing even when a Ruin
 * or Reward inserts or removes a room from the sequence.
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
    history: [],
    // Room 0 is where the party starts — built and occupied at Start, before
    // any resolution happens, so it's the only slot assigned up front.
    physicalSlotByRoomId: { [rooms[0].id]: 0 },
    nextPhysicalSlot: 1,
    lastAutoEntry: null
  };
  return persist(sceneId, state, settingsRef);
}

/**
 * Resolve the CURRENT room as succeeded or failed.
 *
 * Does NOT move currentIndex — see the file docblock. For the goal room this
 * just ends the run. For any other room it resolves the outcome slot, applies
 * any sequence mutation, and — if there's a room after it — assigns that next
 * room its physical slot number the first time it's ever reached (a plain
 * incrementing counter; `dungeon-deck.mjs`'s own mutation logic already
 * decides which logical room that is, this file doesn't need to know why).
 *
 * Returns `nextRoomId`/`nextPhysicalSlot` (both null once there's nothing
 * left, i.e. the goal room was just resolved) so the caller knows what to
 * physically build next.
 */
export async function markRoomOutcome(
  { sceneId, succeeded },
  { settingsRef = defaultSettingsRef(), setpieceIds = [] } = {}
) {
  const state = getRunState(sceneId, { settingsRef });
  if (!state || state.completed) {
    return { state, effectKey: null, mutation: null, nextRoomId: null, nextPhysicalSlot: null };
  }

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
    return { state: newState, effectKey, mutation: null, nextRoomId: null, nextPhysicalSlot: null };
  }

  const template = findOutcomeTemplate(room.outcomeSlotId);
  const { effectKey, mutation } = resolveRoomOutcome(template, succeeded);
  const rooms = (mutation === 'remove_next' || mutation === 'insert_after')
    ? applySequenceMutation(state.rooms, state.currentIndex, mutation, { seed: state.seed, setpieceIds })
    : state.rooms;

  const nextRoomId = rooms[state.currentIndex + 1]?.id ?? null;
  let physicalSlotByRoomId = state.physicalSlotByRoomId;
  let nextPhysicalSlot = state.nextPhysicalSlot;
  let assignedSlot = null;
  if (nextRoomId) {
    if (nextRoomId in physicalSlotByRoomId) {
      assignedSlot = physicalSlotByRoomId[nextRoomId];
    } else {
      assignedSlot = nextPhysicalSlot;
      physicalSlotByRoomId = { ...physicalSlotByRoomId, [nextRoomId]: assignedSlot };
      nextPhysicalSlot += 1;
    }
  }

  const newState = {
    ...state,
    rooms,
    physicalSlotByRoomId,
    nextPhysicalSlot,
    history: [...state.history, { ...base, effectKey }]
  };
  await persist(sceneId, newState, settingsRef);
  return { state: newState, effectKey, mutation, nextRoomId, nextPhysicalSlot: assignedSlot };
}

/**
 * Advance to a room the party has physically walked into. `revealedTokenIds`
 * is whatever was just un-hidden for the discovery, stashed so undo can
 * re-hide exactly those and nothing else. Rejects (without corrupting state)
 * if `roomId` isn't genuinely the room right after the current one — a stray
 * token, or a GM drag-move past a still-locked wall, shouldn't be able to
 * desync the tracker from reality.
 */
export async function advanceToRoom(
  { sceneId, roomId, revealedTokenIds = [] },
  { settingsRef = defaultSettingsRef() } = {}
) {
  const state = getRunState(sceneId, { settingsRef });
  if (!state) return { ok: false, state: null };
  const expectedId = state.rooms[state.currentIndex + 1]?.id ?? null;
  if (!expectedId || expectedId !== roomId) return { ok: false, state };

  const newState = {
    ...state,
    currentIndex: state.currentIndex + 1,
    lastAutoEntry: { roomId, fromIndex: state.currentIndex, toIndex: state.currentIndex + 1, revealedTokenIds }
  };
  await persist(sceneId, newState, settingsRef);
  return { ok: true, state: newState };
}

/**
 * Whether the most recent automatic entry can still be safely undone — false
 * once the entered room has already been judged (Mark Succeeded/Failed),
 * since that may have already cascaded a further door-unlock/build that an
 * undo here would leave dangling.
 */
export function canUndoRoomEntry(state) {
  if (!state?.lastAutoEntry) return false;
  return !state.history.some((h) => h.roomId === state.lastAutoEntry.roomId);
}

export async function undoLastRoomEntry({ sceneId }, { settingsRef = defaultSettingsRef() } = {}) {
  const state = getRunState(sceneId, { settingsRef });
  if (!state || !canUndoRoomEntry(state)) return { ok: false, state: state ?? null, undone: null };

  const undone = state.lastAutoEntry;
  const newState = { ...state, currentIndex: undone.fromIndex, lastAutoEntry: null };
  await persist(sceneId, newState, settingsRef);
  return { ok: true, state: newState, undone };
}

export async function abandonRun({ sceneId }, { settingsRef = defaultSettingsRef() } = {}) {
  const all = settingsRef.get(MODULE_ID, 'dungeonRuns') ?? {};
  if (!(sceneId in all)) return;
  const rest = { ...all };
  delete rest[sceneId];
  await settingsRef.set(MODULE_ID, 'dungeonRuns', rest);
}
