import { describe, it, expect } from "vitest";
import {
  createRun,
  markRoomOutcome,
  advanceToRoom,
  undoLastRoomEntry,
  canUndoRoomEntry,
  abandonRun,
  getRunState,
  ensureSkillChallenge,
  recordSkillChallengeAttempt,
  setObjective,
} from "../scripts/dungeon-runner.mjs";

function makeSettingsStub(initial = {}) {
  let store = { dungeonRuns: initial };
  return {
    get: (moduleId, key) => store[key],
    set: (moduleId, key, value) => {
      store = { ...store, [key]: value };
    },
  };
}

/** Moves currentIndex from the safe entry (room 0) to the first real room
 * (room 1) — its physical slot is already assigned by createRun, so this
 * never needs markRoomOutcome, matching how the real door-open trigger
 * reaches it. */
async function advancePastEntry(sceneId, settingsRef) {
  const state = getRunState(sceneId, { settingsRef });
  return advanceToRoom({ sceneId, roomId: state.rooms[1].id }, { settingsRef });
}

describe("createRun / getRunState", () => {
  it("creates a fresh run scoped to a scene: a safe entry room prepended, not counted in roomCount", async () => {
    const settingsRef = makeSettingsStub();
    const state = await createRun(
      { sceneId: "scene-1", roomCount: 5 },
      { settingsRef },
    );
    // roomCount (5) + the prepended entry room.
    expect(state.rooms).toHaveLength(6);
    expect(state.rooms[0].kind).toBe("safe_entry");
    expect(state.rooms[0].outcomeSlotId).toBeNull();
    expect(state.currentIndex).toBe(0);
    expect(state.completed).toBe(false);
    // The entry has nothing to resolve, so the first real room's slot is
    // also pre-assigned — see dungeon-runner.mjs's createRun.
    expect(state.physicalSlotByRoomId).toEqual({
      [state.rooms[0].id]: 0,
      [state.rooms[1].id]: 1,
    });
    expect(state.nextPhysicalSlot).toBe(2);
    expect(state.lastAutoEntry).toBeNull();
    expect(state.previousSceneId).toBeNull();
    expect(state.objective).toBeNull();
    expect(getRunState("scene-1", { settingsRef })).toEqual(state);
  });

  it("records the scene the party started from, for teardownDungeonRun to return them to (ITEM-18)", async () => {
    const settingsRef = makeSettingsStub();
    const state = await createRun(
      { sceneId: "scene-1", roomCount: 5, previousSceneId: "tavern-scene" },
      { settingsRef },
    );
    expect(state.previousSceneId).toBe("tavern-scene");
  });

  it("returns null for a scene with no run", () => {
    const settingsRef = makeSettingsStub();
    expect(getRunState("nothing-here", { settingsRef })).toBeNull();
  });

  it("keeps two scenes independent", async () => {
    const settingsRef = makeSettingsStub();
    await createRun(
      { sceneId: "scene-a", roomCount: 3, seed: "a" },
      { settingsRef },
    );
    await createRun(
      { sceneId: "scene-b", roomCount: 6, seed: "b" },
      { settingsRef },
    );
    const a = getRunState("scene-a", { settingsRef });
    const b = getRunState("scene-b", { settingsRef });
    expect(a.rooms).toHaveLength(4); // 3 + entry
    expect(b.rooms).toHaveLength(7); // 6 + entry
    expect(a.seed).toBe("a");
    expect(b.seed).toBe("b");
  });
});

describe("markRoomOutcome", () => {
  it("is a no-op on the safe entry room — nothing to resolve, no crash on a null outcome slot", async () => {
    const settingsRef = makeSettingsStub();
    await createRun(
      { sceneId: "s", roomCount: 5, seed: "fixed" },
      { settingsRef },
    );
    const before = getRunState("s", { settingsRef });
    const result = await markRoomOutcome(
      { sceneId: "s", succeeded: true },
      { settingsRef },
    );
    expect(result.effectKey).toBeNull();
    expect(result.mutation).toBeNull();
    expect(result.nextRoomId).toBeNull();
    expect(result.state).toEqual(before); // untouched — no history entry, no mutation
  });

  it("does not move currentIndex, and reports the next room + its assigned physical slot", async () => {
    const settingsRef = makeSettingsStub();
    await createRun(
      { sceneId: "s", roomCount: 5, seed: "fixed" },
      { settingsRef },
    );
    await advancePastEntry("s", settingsRef);
    const before = getRunState("s", { settingsRef });
    const { state, nextRoomId, nextPhysicalSlot } = await markRoomOutcome(
      { sceneId: "s", succeeded: true },
      { settingsRef },
    );
    expect(state.currentIndex).toBe(before.currentIndex);
    expect(state.history).toHaveLength(1);
    expect(nextRoomId).toBe(state.rooms[2].id);
    expect(nextPhysicalSlot).toBe(2); // slot 0: entry, slot 1: first real room, slot 2: this one
    expect(state.physicalSlotByRoomId[nextRoomId]).toBe(2);
    expect(state.nextPhysicalSlot).toBe(3);
  });

  it("assigns each newly-reached room the next slot number in order", async () => {
    const settingsRef = makeSettingsStub();
    await createRun(
      { sceneId: "s", roomCount: 5, seed: "fixed" },
      { settingsRef },
    );
    await advancePastEntry("s", settingsRef);
    const r1 = await markRoomOutcome(
      { sceneId: "s", succeeded: true },
      { settingsRef },
    );
    await advanceToRoom(
      { sceneId: "s", roomId: r1.nextRoomId },
      { settingsRef },
    );
    const r2 = await markRoomOutcome(
      { sceneId: "s", succeeded: true },
      { settingsRef },
    );
    expect(r2.nextPhysicalSlot).toBe(3);
  });

  it("marks the run completed when the goal room is resolved, with no next room", async () => {
    const settingsRef = makeSettingsStub();
    await createRun(
      { sceneId: "s", roomCount: 2, seed: "fixed" },
      { settingsRef },
    );
    await advancePastEntry("s", settingsRef);
    await markRoomOutcome({ sceneId: "s", succeeded: true }, { settingsRef });
    await advanceToRoom(
      { sceneId: "s", roomId: getRunState("s", { settingsRef }).rooms[2].id },
      { settingsRef },
    );
    const { state, effectKey, nextRoomId } = await markRoomOutcome(
      { sceneId: "s", succeeded: true },
      { settingsRef },
    );
    expect(state.completed).toBe(true);
    expect(effectKey).toBe("goal_cleared");
    expect(nextRoomId).toBeNull();
  });

  it("reports goal_failed on a failed goal room", async () => {
    const settingsRef = makeSettingsStub();
    await createRun(
      { sceneId: "s", roomCount: 2, seed: "fixed" },
      { settingsRef },
    );
    await advancePastEntry("s", settingsRef);
    await markRoomOutcome({ sceneId: "s", succeeded: true }, { settingsRef });
    await advanceToRoom(
      { sceneId: "s", roomId: getRunState("s", { settingsRef }).rooms[2].id },
      { settingsRef },
    );
    const { effectKey } = await markRoomOutcome(
      { sceneId: "s", succeeded: false },
      { settingsRef },
    );
    expect(effectKey).toBe("goal_failed");
  });

  it("is a no-op once the run is completed", async () => {
    const settingsRef = makeSettingsStub();
    await createRun(
      { sceneId: "s", roomCount: 2, seed: "fixed" },
      { settingsRef },
    );
    await advancePastEntry("s", settingsRef);
    await markRoomOutcome({ sceneId: "s", succeeded: true }, { settingsRef });
    await advanceToRoom(
      { sceneId: "s", roomId: getRunState("s", { settingsRef }).rooms[2].id },
      { settingsRef },
    );
    await markRoomOutcome({ sceneId: "s", succeeded: true }, { settingsRef });
    const completedState = getRunState("s", { settingsRef });
    const again = await markRoomOutcome(
      { sceneId: "s", succeeded: true },
      { settingsRef },
    );
    expect(again.state).toEqual(completedState);
    expect(again.nextRoomId).toBeNull();
  });

  it("is a no-op with no run at all", async () => {
    const settingsRef = makeSettingsStub();
    const result = await markRoomOutcome(
      { sceneId: "nope", succeeded: true },
      { settingsRef },
    );
    expect(result.state).toBeNull();
    expect(result.nextRoomId).toBeNull();
  });

  // #152 investigation: currentIndex doesn't move until the party actually
  // walks into the next room (advanceToRoom), so the room just resolved
  // stays "current" — and its Succeed/Fail/Declare Victory/Declare Defeat
  // button stays live in the UI — for the entire window before that. A
  // double-click (or a slow click registering twice) used to re-resolve the
  // same room a second time: reapplying its reward/ruin mutation and
  // re-assigning/rebuilding whatever came next all over again.
  it("is a no-op resolving the same room a second time before the party has moved on", async () => {
    const settingsRef = makeSettingsStub();
    await createRun(
      { sceneId: "s", roomCount: 5, seed: "fixed" },
      { settingsRef },
    );
    await advancePastEntry("s", settingsRef);
    const first = await markRoomOutcome(
      { sceneId: "s", succeeded: true },
      { settingsRef },
    );
    expect(first.nextRoomId).not.toBeNull();

    const again = await markRoomOutcome(
      { sceneId: "s", succeeded: true },
      { settingsRef },
    );
    expect(again.effectKey).toBeNull();
    expect(again.mutation).toBeNull();
    expect(again.nextRoomId).toBeNull();
    expect(again.state).toEqual(first.state); // untouched — no second history entry, no re-mutation
  });

  it("auto-advances past a mid-dungeon rest room (ITEM-5): no reward/ruin, but still assigns the next room its slot", async () => {
    const settingsRef = makeSettingsStub();
    // roomCount 10 always gets a rest room (above MID_DUNGEON_REST_THRESHOLD).
    await createRun(
      { sceneId: "s", roomCount: 10, seed: "rest-runner" },
      { settingsRef },
    );
    await advancePastEntry("s", settingsRef);

    // Walk forward, resolving each room in turn, until currentIndex itself
    // lands on the rest room.
    let state = getRunState("s", { settingsRef });
    while (state.rooms[state.currentIndex].kind !== "safe_rest") {
      const { nextRoomId } = await markRoomOutcome(
        { sceneId: "s", succeeded: true },
        { settingsRef },
      );
      await advanceToRoom(
        { sceneId: "s", roomId: nextRoomId },
        { settingsRef },
      );
      state = getRunState("s", { settingsRef });
    }

    const before = state;
    const {
      state: after,
      effectKey,
      mutation,
      nextRoomId,
      nextPhysicalSlot,
    } = await markRoomOutcome(
      { sceneId: "s", succeeded: true },
      { settingsRef },
    );
    expect(effectKey).toBe("rest_room_passed");
    expect(mutation).toBeNull();
    expect(nextRoomId).toBe(before.rooms[before.currentIndex + 1].id);
    expect(nextPhysicalSlot).toBeTypeOf("number");
    expect(after.physicalSlotByRoomId[nextRoomId]).toBe(nextPhysicalSlot);
    expect(after.history.at(-1)).toMatchObject({
      roomId: before.rooms[before.currentIndex].id,
      effectKey: "rest_room_passed",
    });
  });
});

describe("advanceToRoom", () => {
  it("advances currentIndex and records lastAutoEntry straight from the entry room, no markRoomOutcome needed", async () => {
    const settingsRef = makeSettingsStub();
    const created = await createRun(
      { sceneId: "s", roomCount: 5, seed: "fixed" },
      { settingsRef },
    );
    const nextRoomId = created.rooms[1].id; // slot already assigned by createRun
    const { ok, state } = await advanceToRoom(
      { sceneId: "s", roomId: nextRoomId, revealedTokenIds: ["t1"] },
      { settingsRef },
    );
    expect(ok).toBe(true);
    expect(state.currentIndex).toBe(1);
    expect(state.lastAutoEntry).toEqual({
      roomId: nextRoomId,
      fromIndex: 0,
      toIndex: 1,
      revealedTokenIds: ["t1"],
    });
  });

  it("advances a second time, past a real room, the normal markRoomOutcome-driven way", async () => {
    const settingsRef = makeSettingsStub();
    await createRun(
      { sceneId: "s", roomCount: 5, seed: "fixed" },
      { settingsRef },
    );
    await advancePastEntry("s", settingsRef);
    const { nextRoomId } = await markRoomOutcome(
      { sceneId: "s", succeeded: true },
      { settingsRef },
    );
    const { ok, state } = await advanceToRoom(
      { sceneId: "s", roomId: nextRoomId },
      { settingsRef },
    );
    expect(ok).toBe(true);
    expect(state.currentIndex).toBe(2);
  });

  it("rejects a roomId that is not genuinely the next room, without mutating state", async () => {
    const settingsRef = makeSettingsStub();
    await createRun(
      { sceneId: "s", roomCount: 5, seed: "fixed" },
      { settingsRef },
    );
    const before = getRunState("s", { settingsRef });
    const { ok, state } = await advanceToRoom(
      { sceneId: "s", roomId: "not-a-real-room" },
      { settingsRef },
    );
    expect(ok).toBe(false);
    expect(state).toEqual(before);
    expect(getRunState("s", { settingsRef })).toEqual(before);
  });

  it("is a no-op for a scene with no run", async () => {
    const settingsRef = makeSettingsStub();
    const { ok, state } = await advanceToRoom(
      { sceneId: "nope", roomId: "x" },
      { settingsRef },
    );
    expect(ok).toBe(false);
    expect(state).toBeNull();
  });
});

describe("canUndoRoomEntry / undoLastRoomEntry", () => {
  it("can undo right after the automatic entry-to-first-room transition", async () => {
    const settingsRef = makeSettingsStub();
    const created = await createRun(
      { sceneId: "s", roomCount: 5, seed: "fixed" },
      { settingsRef },
    );
    const nextRoomId = created.rooms[1].id;
    await advanceToRoom({ sceneId: "s", roomId: nextRoomId }, { settingsRef });
    expect(canUndoRoomEntry(getRunState("s", { settingsRef }))).toBe(true);

    const { ok, state, undone } = await undoLastRoomEntry(
      { sceneId: "s" },
      { settingsRef },
    );
    expect(ok).toBe(true);
    expect(state.currentIndex).toBe(0);
    expect(state.lastAutoEntry).toBeNull();
    expect(undone.roomId).toBe(nextRoomId);
  });

  it("cannot undo once the entered room has already been judged", async () => {
    const settingsRef = makeSettingsStub();
    const created = await createRun(
      { sceneId: "s", roomCount: 5, seed: "fixed" },
      { settingsRef },
    );
    const nextRoomId = created.rooms[1].id;
    await advanceToRoom({ sceneId: "s", roomId: nextRoomId }, { settingsRef });
    await markRoomOutcome({ sceneId: "s", succeeded: true }, { settingsRef });
    expect(canUndoRoomEntry(getRunState("s", { settingsRef }))).toBe(false);

    const { ok } = await undoLastRoomEntry({ sceneId: "s" }, { settingsRef });
    expect(ok).toBe(false);
  });

  it("is a no-op when there is nothing to undo", async () => {
    const settingsRef = makeSettingsStub();
    await createRun(
      { sceneId: "s", roomCount: 5, seed: "fixed" },
      { settingsRef },
    );
    expect(canUndoRoomEntry(getRunState("s", { settingsRef }))).toBe(false);
    const { ok } = await undoLastRoomEntry({ sceneId: "s" }, { settingsRef });
    expect(ok).toBe(false);
  });
});

describe("abandonRun", () => {
  it("removes only the targeted scene", async () => {
    const settingsRef = makeSettingsStub();
    await createRun({ sceneId: "scene-a", roomCount: 3 }, { settingsRef });
    await createRun({ sceneId: "scene-b", roomCount: 3 }, { settingsRef });
    await abandonRun({ sceneId: "scene-a" }, { settingsRef });
    expect(getRunState("scene-a", { settingsRef })).toBeNull();
    expect(getRunState("scene-b", { settingsRef })).not.toBeNull();
  });

  it("is a no-op for a scene with no run", async () => {
    const settingsRef = makeSettingsStub();
    await expect(
      abandonRun({ sceneId: "nothing" }, { settingsRef }),
    ).resolves.not.toThrow();
  });
});

describe("ensureSkillChallenge / recordSkillChallengeAttempt", () => {
  it("attaches a fresh challenge to the named room only", async () => {
    const settingsRef = makeSettingsStub();
    const created = await createRun(
      { sceneId: "s", roomCount: 5, seed: "fixed" },
      { settingsRef },
    );
    const roomId = created.rooms[1].id;
    const state = await ensureSkillChallenge(
      "s",
      roomId,
      { seed: "fixed", locationTag: "undead", partySize: 4 },
      { settingsRef },
    );
    const room = state.rooms.find((r) => r.id === roomId);
    expect(room.challenge).toBeTruthy();
    expect(room.challenge.vp).toBe(0);
    expect(room.challenge.resolved).toBeNull();
    // Every other room stays untouched.
    expect(
      state.rooms.find((r) => r.id === created.rooms[2].id).challenge,
    ).toBeUndefined();
  });

  it("is a no-op if the room already has a challenge (never rerolls it)", async () => {
    const settingsRef = makeSettingsStub();
    const created = await createRun(
      { sceneId: "s", roomCount: 5, seed: "fixed" },
      { settingsRef },
    );
    const roomId = created.rooms[1].id;
    const first = await ensureSkillChallenge(
      "s",
      roomId,
      { seed: "fixed", locationTag: "undead", partySize: 4 },
      { settingsRef },
    );
    const firstChallenge = first.rooms.find((r) => r.id === roomId).challenge;
    const second = await ensureSkillChallenge(
      "s",
      roomId,
      { seed: "fixed", locationTag: "undead", partySize: 4 },
      { settingsRef },
    );
    expect(second.rooms.find((r) => r.id === roomId).challenge).toEqual(
      firstChallenge,
    );
  });

  it("is a no-op with no run at all", async () => {
    const settingsRef = makeSettingsStub();
    const result = await ensureSkillChallenge(
      "nope",
      "room-x",
      { seed: "s", locationTag: null, partySize: 4 },
      { settingsRef },
    );
    expect(result).toBeNull();
  });

  it("records an attempt's VP delta against the room's own challenge", async () => {
    const settingsRef = makeSettingsStub();
    const created = await createRun(
      { sceneId: "s", roomCount: 5, seed: "fixed" },
      { settingsRef },
    );
    const roomId = created.rooms[1].id;
    await ensureSkillChallenge(
      "s",
      roomId,
      { seed: "fixed", locationTag: "undead", partySize: 4 },
      { settingsRef },
    );
    const state = await recordSkillChallengeAttempt("s", roomId, "success", {
      settingsRef,
    });
    const room = state.rooms.find((r) => r.id === roomId);
    expect(room.challenge.vp).toBe(1);
    expect(room.challenge.attemptsUsed).toBe(1);
  });

  it("is a no-op if the room has no challenge attached yet", async () => {
    const settingsRef = makeSettingsStub();
    const created = await createRun(
      { sceneId: "s", roomCount: 5, seed: "fixed" },
      { settingsRef },
    );
    const roomId = created.rooms[1].id;
    const state = await recordSkillChallengeAttempt("s", roomId, "success", {
      settingsRef,
    });
    const room = state.rooms.find((r) => r.id === roomId);
    expect(room.challenge).toBeUndefined();
  });

  it("is a no-op once the challenge is already resolved", async () => {
    const settingsRef = makeSettingsStub();
    const created = await createRun(
      { sceneId: "s", roomCount: 5, seed: "fixed" },
      { settingsRef },
    );
    const roomId = created.rooms[1].id;
    await ensureSkillChallenge(
      "s",
      roomId,
      { seed: "fixed", locationTag: "undead", partySize: 4 },
      { settingsRef },
    );
    // Drive it to a resolved failure (attemptBudget 6 for partySize 4).
    let state;
    for (let i = 0; i < 6; i += 1) {
      state = await recordSkillChallengeAttempt("s", roomId, "failure", {
        settingsRef,
      });
    }
    const resolvedChallenge = state.rooms.find(
      (r) => r.id === roomId,
    ).challenge;
    expect(resolvedChallenge.resolved).toBe("failure");
    const again = await recordSkillChallengeAttempt(
      "s",
      roomId,
      "criticalSuccess",
      { settingsRef },
    );
    expect(again.rooms.find((r) => r.id === roomId).challenge).toEqual(
      resolvedChallenge,
    );
  });

  it("is a no-op with no run at all", async () => {
    const settingsRef = makeSettingsStub();
    const result = await recordSkillChallengeAttempt(
      "nope",
      "room-x",
      "success",
      { settingsRef },
    );
    expect(result).toBeNull();
  });
});

describe("setObjective", () => {
  it("sets a run-wide objective, visible regardless of the current room", async () => {
    const settingsRef = makeSettingsStub();
    await createRun(
      { sceneId: "s", roomCount: 5, seed: "fixed" },
      { settingsRef },
    );
    const state = await setObjective("s", "Find the missing relic", {
      settingsRef,
    });
    expect(state.objective).toBe("Find the missing relic");
    expect(getRunState("s", { settingsRef }).objective).toBe(
      "Find the missing relic",
    );
  });

  it("overwrites a previously-set objective rather than accumulating a log", async () => {
    const settingsRef = makeSettingsStub();
    await createRun(
      { sceneId: "s", roomCount: 5, seed: "fixed" },
      { settingsRef },
    );
    await setObjective("s", "First objective", { settingsRef });
    const state = await setObjective("s", "Second objective", { settingsRef });
    expect(state.objective).toBe("Second objective");
  });

  it("treats a blank/whitespace-only string as clearing the objective", async () => {
    const settingsRef = makeSettingsStub();
    await createRun(
      { sceneId: "s", roomCount: 5, seed: "fixed" },
      { settingsRef },
    );
    await setObjective("s", "Something", { settingsRef });
    const state = await setObjective("s", "   ", { settingsRef });
    expect(state.objective).toBeNull();
  });

  it("clears the objective when called with null", async () => {
    const settingsRef = makeSettingsStub();
    await createRun(
      { sceneId: "s", roomCount: 5, seed: "fixed" },
      { settingsRef },
    );
    await setObjective("s", "Something", { settingsRef });
    const state = await setObjective("s", null, { settingsRef });
    expect(state.objective).toBeNull();
  });

  it("is a no-op with no run at all", async () => {
    const settingsRef = makeSettingsStub();
    const result = await setObjective("nope", "Anything", { settingsRef });
    expect(result).toBeNull();
  });
});
