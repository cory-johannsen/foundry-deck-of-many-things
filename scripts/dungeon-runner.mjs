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
import {
  buildRoomSequence,
  findOutcomeTemplate,
  resolveRoomOutcome,
  applySequenceMutation,
} from "./dungeon-deck.mjs";
import {
  initSkillChallengeState,
  applySkillChallengeAttempt,
} from "./skill-challenge-mechanics.mjs";

const MODULE_ID = "deck-of-many-more-things";

function defaultSettingsRef() {
  return {
    get: (...args) => game.settings.get(...args),
    set: (...args) => game.settings.set(...args),
  };
}

async function persist(sceneId, state, settingsRef) {
  const all = settingsRef.get(MODULE_ID, "dungeonRuns") ?? {};
  await settingsRef.set(MODULE_ID, "dungeonRuns", { ...all, [sceneId]: state });
  return state;
}

/** The dungeon run for this scene, or null if none has been started. */
export function getRunState(
  sceneId,
  { settingsRef = defaultSettingsRef() } = {},
) {
  const all = settingsRef.get(MODULE_ID, "dungeonRuns") ?? {};
  return all[sceneId] ?? null;
}

export async function createRun(
  {
    sceneId,
    roomCount,
    traits = [],
    excludeTraits = [],
    seed = null,
    previousSceneId = null,
    hostUserId = null,
  },
  { settingsRef = defaultSettingsRef(), setpieceIds = [] } = {},
) {
  const runSeed =
    seed ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const rooms = buildRoomSequence({ seed: runSeed, roomCount, setpieceIds });
  // Room 0 is where the party starts — built and occupied at Start, before
  // any resolution happens, so it's the only slot normally assigned up
  // front. The one exception: room 0 is always the safe entry, which has
  // nothing to resolve (no outcomeSlotId — markRoomOutcome never runs for
  // it), so the room right after it also needs its physical slot assigned
  // here rather than waiting on a markRoomOutcome call that will never come.
  const physicalSlotByRoomId = { [rooms[0].id]: 0 };
  let nextPhysicalSlot = 1;
  if (rooms[0].kind === "safe_entry" && rooms[1]) {
    physicalSlotByRoomId[rooms[1].id] = 1;
    nextPhysicalSlot = 2;
  }
  const state = {
    seed: runSeed,
    createdAt: Date.now(),
    traits,
    excludeTraits,
    rooms,
    currentIndex: 0,
    completed: false,
    history: [],
    physicalSlotByRoomId,
    nextPhysicalSlot,
    lastAutoEntry: null,
    // The scene the party was viewing right before this run started (ITEM-18)
    // — where to send them back to if the run is later cancelled. Null if
    // they started with no scene active at all.
    previousSceneId,
    // A narrative room's own "direction for the rest of the run" (#163) —
    // free text the GM sets, persisting run-wide (not per-room) once set,
    // the same way the Journey Spread's own Reward/Ruin outcomes already
    // shape what happens next without being tied to any one room's own
    // display. Null until a narrative room sets one.
    objective: null,
    // #109: the non-GM player who started this run when no GM was active —
    // null for a normal GM-run game. The sole authorization signal for a
    // non-GM to act on this run (dungeon-permissions.mjs's
    // canActOnDungeon) and the sole trigger for broadcasting it read-only
    // to every other client (module.mjs's syncGmLessDungeonBroadcast).
    hostUserId,
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
  { settingsRef = defaultSettingsRef(), setpieceIds = [] } = {},
) {
  const state = getRunState(sceneId, { settingsRef });
  if (!state || state.completed) {
    return {
      state,
      effectKey: null,
      mutation: null,
      nextRoomId: null,
      nextPhysicalSlot: null,
    };
  }

  const room = state.rooms[state.currentIndex];
  // #152 investigation: resolving a room never moves currentIndex (see this
  // file's own docblock) — only actually walking into the next one does, via
  // advanceToRoom. That means the Succeed/Fail/Declare Victory/Declare Defeat
  // button stays live and pointed at the same "current" room for the entire
  // window between resolving it and the party physically opening the next
  // room's reveal door, with no disabling/debounce on those buttons
  // (ui/dungeon-app.mjs's #onSucceed etc.). A double-click (or a slow click
  // registering twice before the first await resolves and re-renders) would
  // resolve the same room's outcome a second time — reapplying its reward/
  // ruin mutation and re-running buildPopulateAndUnlockRoom for whatever
  // comes next a second time (duplicate walls, a second set of monsters).
  // Guarded here, once, at the single place every resolution path funnels
  // through, rather than patching each caller's button individually.
  if (state.history.some((h) => h.roomId === room.id)) {
    return {
      state,
      effectKey: null,
      mutation: null,
      nextRoomId: null,
      nextPhysicalSlot: null,
    };
  }
  // The entry (see buildRoomSequence) has no outcome slot and nothing to
  // resolve; its own transition happens automatically (createRun/
  // dungeon-app.mjs's Start flow), never through here. Guard rather than
  // crash on findOutcomeTemplate(null) if this is ever somehow reached
  // anyway. A mid-dungeon rest room also has no outcome slot (ITEM-5), but
  // unlike the entry it IS reached through the normal door-reveal flow, so
  // it falls through below instead of returning here — see the `safe_rest`
  // branch just past this guard.
  if (!room.isGoal && room.outcomeSlotId == null && room.kind !== "safe_rest") {
    return {
      state,
      effectKey: null,
      mutation: null,
      nextRoomId: null,
      nextPhysicalSlot: null,
    };
  }

  const base = {
    roomId: room.id,
    kind: room.kind,
    outcome: succeeded ? "succeeded" : "failed",
    resolvedAt: Date.now(),
  };

  if (room.isGoal) {
    const effectKey = succeeded ? "goal_cleared" : "goal_failed";
    const newState = {
      ...state,
      completed: true,
      history: [...state.history, { ...base, effectKey }],
    };
    await persist(sceneId, newState, settingsRef);
    return {
      state: newState,
      effectKey,
      mutation: null,
      nextRoomId: null,
      nextPhysicalSlot: null,
    };
  }

  // A rest room has nothing to reward or ruin — just move the sequence along
  // to whatever comes after it, same slot-assignment bookkeeping as any
  // other room (ITEM-5), rather than running findOutcomeTemplate/
  // resolveRoomOutcome against its null outcomeSlotId.
  const { effectKey, mutation } =
    room.kind === "safe_rest"
      ? { effectKey: "rest_room_passed", mutation: null }
      : resolveRoomOutcome(findOutcomeTemplate(room.outcomeSlotId), succeeded);
  const rooms =
    mutation === "remove_next" || mutation === "insert_after"
      ? applySequenceMutation(state.rooms, state.currentIndex, mutation, {
          seed: state.seed,
          setpieceIds,
        })
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
      physicalSlotByRoomId = {
        ...physicalSlotByRoomId,
        [nextRoomId]: assignedSlot,
      };
      nextPhysicalSlot += 1;
    }
  }

  const newState = {
    ...state,
    rooms,
    physicalSlotByRoomId,
    nextPhysicalSlot,
    history: [...state.history, { ...base, effectKey }],
  };
  await persist(sceneId, newState, settingsRef);
  return {
    state: newState,
    effectKey,
    mutation,
    nextRoomId,
    nextPhysicalSlot: assignedSlot,
  };
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
  { settingsRef = defaultSettingsRef() } = {},
) {
  const state = getRunState(sceneId, { settingsRef });
  if (!state) return { ok: false, state: null };
  const expectedId = state.rooms[state.currentIndex + 1]?.id ?? null;
  if (!expectedId || expectedId !== roomId) return { ok: false, state };

  const newState = {
    ...state,
    currentIndex: state.currentIndex + 1,
    lastAutoEntry: {
      roomId,
      fromIndex: state.currentIndex,
      toIndex: state.currentIndex + 1,
      revealedTokenIds,
    },
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

export async function undoLastRoomEntry(
  { sceneId },
  { settingsRef = defaultSettingsRef() } = {},
) {
  const state = getRunState(sceneId, { settingsRef });
  if (!state || !canUndoRoomEntry(state))
    return { ok: false, state: state ?? null, undone: null };

  const undone = state.lastAutoEntry;
  const newState = {
    ...state,
    currentIndex: undone.fromIndex,
    lastAutoEntry: null,
  };
  await persist(sceneId, newState, settingsRef);
  return { ok: true, state: newState, undone };
}

export async function abandonRun(
  { sceneId },
  { settingsRef = defaultSettingsRef() } = {},
) {
  const all = settingsRef.get(MODULE_ID, "dungeonRuns") ?? {};
  if (!(sceneId in all)) return;
  const rest = { ...all };
  delete rest[sceneId];
  await settingsRef.set(MODULE_ID, "dungeonRuns", rest);
}

/**
 * The scene id and host of whichever GM-less run is currently active
 * (not completed, hostUserId set) anywhere in the world, or null if none.
 * Used to keep a second non-GM player from starting a competing run
 * (module.mjs's openDungeon) and to drive the read-only broadcast to every
 * other client (#109). At most one should ever exist in practice, since
 * openDungeon() itself refuses to start a second one.
 */
export function findActiveHostedRun({ settingsRef = defaultSettingsRef() } = {}) {
  const all = settingsRef.get(MODULE_ID, "dungeonRuns") ?? {};
  for (const [sceneId, state] of Object.entries(all)) {
    if (state && !state.completed && state.hostUserId) {
      return { sceneId, hostUserId: state.hostUserId };
    }
  }
  return null;
}

/**
 * Like findActiveHostedRun, but also matches a run that just completed —
 * used by the broadcast hook (module.mjs's syncGmLessDungeonBroadcast) so
 * a run's completion is actually shown to everyone instead of silently
 * closing their tracker the instant the goal room resolves. Only an
 * abandoned/reset run (its entry deleted entirely from dungeonRuns) should
 * ever stop showing up here — findActiveHostedRun's own `!completed`
 * exclusion stays correct for its own purpose (openDungeon()'s "is a
 * different host already running something" collision check, where a
 * finished run shouldn't block a fresh start).
 */
export function findHostedRunForBroadcast({ settingsRef = defaultSettingsRef() } = {}) {
  const all = settingsRef.get(MODULE_ID, "dungeonRuns") ?? {};
  for (const [sceneId, state] of Object.entries(all)) {
    if (state?.hostUserId) return { sceneId, hostUserId: state.hostUserId };
  }
  return null;
}

/**
 * Lazily attaches a fresh Victory Point challenge (#162) to `roomId`'s own
 * room object the first time it's needed — a no-op if that room already
 * has one, so a re-render (or a recovery retry) never rerolls its
 * specialty skills mid-challenge. `initSkillChallengeState` itself is pure
 * (`skill-challenge-mechanics.mjs`); this is only the read-mutate-persist
 * wrapper around it, same shape every other room-state write in this file
 * already uses.
 */
export async function ensureSkillChallenge(
  sceneId,
  roomId,
  { seed, locationTag, partySize },
  { settingsRef = defaultSettingsRef() } = {},
) {
  const state = getRunState(sceneId, { settingsRef });
  if (!state) return null;
  const room = state.rooms.find((r) => r.id === roomId);
  if (!room || room.challenge) return state;
  const challenge = initSkillChallengeState({
    seed,
    roomId,
    locationTag,
    partySize,
  });
  const rooms = state.rooms.map((r) =>
    r.id === roomId ? { ...r, challenge } : r,
  );
  const newState = { ...state, rooms };
  await persist(sceneId, newState, settingsRef);
  return newState;
}

/**
 * Sets (or clears, with `objective: null`) the run's current narrative
 * objective (#163) — a plain, run-wide field, not scoped to any one room,
 * so it's visible from `getRunState` regardless of where the party is by
 * the time a player asks "wait, what were we doing again?" A blank/
 * whitespace-only string is treated the same as `null` (nothing to show),
 * rather than persisting an empty-looking objective line.
 */
export async function setObjective(
  sceneId,
  objective,
  { settingsRef = defaultSettingsRef() } = {},
) {
  const state = getRunState(sceneId, { settingsRef });
  if (!state) return null;
  const trimmed = objective?.trim();
  const newState = { ...state, objective: trimmed ? trimmed : null };
  await persist(sceneId, newState, settingsRef);
  return newState;
}

/**
 * Records one resolved skill-challenge attempt (#162) against `roomId`'s
 * own Victory Point state — a no-op if that room has no challenge attached
 * yet (`ensureSkillChallenge` never ran) or it's already resolved
 * (`applySkillChallengeAttempt` itself is already a no-op past that point
 * too; this wrapper just avoids the pointless persist).
 */
export async function recordSkillChallengeAttempt(
  sceneId,
  roomId,
  outcome,
  { settingsRef = defaultSettingsRef() } = {},
) {
  const state = getRunState(sceneId, { settingsRef });
  if (!state) return null;
  const room = state.rooms.find((r) => r.id === roomId);
  if (!room?.challenge || room.challenge.resolved) return state;
  const challenge = applySkillChallengeAttempt(room.challenge, outcome);
  const rooms = state.rooms.map((r) =>
    r.id === roomId ? { ...r, challenge } : r,
  );
  const newState = { ...state, rooms };
  await persist(sceneId, newState, settingsRef);
  return newState;
}
