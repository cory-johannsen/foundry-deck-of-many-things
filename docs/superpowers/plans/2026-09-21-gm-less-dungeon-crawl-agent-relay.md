# GM-less Dungeon Crawl (Agent Relay) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a non-GM player start and run a full dungeon crawl by routing every mutating action to whichever client is actually logged in as GM (a human GM, or a standing "Agent" GM login) over a socket — never by relaxing this module's own permission checks.

**Architecture:** Every `DungeonApp` action extracts its core logic into an exported, `sceneId`-parametrized function that never touches `canvas?.scene` (it always resolves `game.scenes.get(sceneId)` itself, since it may execute on a relay client whose own canvas shows something unrelated). Each handler branches on `game.user.isGM`: call that function directly (today's behavior, unchanged), or ask whoever is GM to call it via a new `scripts/dungeon-remote.mjs` request/ack socket layer (reusing `player-choice.mjs`'s existing `module.deck-of-many-more-things` channel, discriminated by `type`). The GM-side handler authorizes every request against the run's own tracked host before acting — it never trusts `isGM` alone. This branch already carries an earlier, now-superseded attempt (permission relaxation) — this plan both adds the new mechanism and reverts the parts of that attempt that are no longer needed.

**Tech Stack:** Vanilla JS ES modules, Foundry VTT v13 `ApplicationV2`/Handlebars/socket.io (`game.socket`), Vitest, `foundry-rest` skill for live verification.

**Spec:** `docs/superpowers/specs/2026-09-20-gm-less-dungeon-crawl-agent-relay-design.md`

## Global Constraints

- Module id is `"deck-of-many-more-things"` everywhere (repeated per-file constant, not centralized).
- **Every extracted room/run-action function takes `sceneId` and resolves `game.scenes.get(sceneId)` itself — never `canvas?.scene`.** It may execute on a relay-connected GM/Agent client whose own canvas is showing an unrelated scene. `resolveCurrentRoom` already follows this rule (its existing `{ scene }` override); every new export in this plan must too.
- **The GM-side relay handler must authorize every request via `isAuthorizedRequest` (`dungeon-permissions.mjs`) before executing it — `game.user.isGM` alone is not sufficient authorization for HONORING a request**, only for being allowed to act at all. A request whose `requestingUserId` doesn't match the run's own `hostUserId` (or, for `startRun`, collides with an existing different host) must be rejected.
- Pure logic depending on Foundry globals takes injectable refs with a `typeof game !== "undefined"` fallback (established in `draw-target.mjs`, already used throughout `dungeon-permissions.mjs`).
- Every merged commit needs a `module.json` version bump in the same commit as the change — done once, in the final task.
- This feature requires live multi-client verification via the `foundry-rest` skill before merge (project `CLAUDE.md` rule) — last task, nothing merges until it passes.
- Do not touch `.claude/worktrees/**` (other agents' isolated worktrees) or the archived spec/plan files (`2026-09-20-gm-less-dungeon-crawl-design.md`, `2026-09-20-gm-less-dungeon-crawl.md`) beyond what's already there.

---

## Task 1: Simplify `dungeon-permissions.mjs`, add `isAuthorizedRequest`

**Files:**
- Modify: `scripts/dungeon-permissions.mjs` (currently holds the superseded design's `canActOnDungeon`/`decideOpenDungeon`/`decideGmLessBroadcast`/`withSettingsModifyGrantedTo`)
- Modify: `tests/dungeon-permissions.test.mjs`

**Interfaces:**
- Produces: `canActOnDungeon(run, { userRef } = {})` → `boolean` (simplified: `user.isGM || run?.hostUserId === user?.id`, no more GM-presence detection). `decideOpenDungeon(hostedRun, { userRef } = {})` → `{ action: "render" } | { action: "warnAlreadyHosted", hostUserId }` (simplified: GM always renders, no more `warnGmOnly`). `decideGmLessBroadcast(hostedRun, hasOpenInstance, { userRef } = {})` → `{ action: "none" | "open" | "render" | "close" }` (simplified: no more host-skip branch — the host's own client now also needs the broadcast to catch up after a routed request, since it no longer has fresh local data synchronously the way a direct write gave it). New: `isAuthorizedRequest(actionName, requestingUserId, run)` → `boolean`.
- Consumes: nothing.

- [ ] **Step 1: Replace the test file**

Replace `tests/dungeon-permissions.test.mjs` in full:

```js
// tests/dungeon-permissions.test.mjs
import { describe, it, expect } from "vitest";
import {
  canActOnDungeon,
  decideOpenDungeon,
  decideGmLessBroadcast,
  isAuthorizedRequest,
} from "../scripts/dungeon-permissions.mjs";

const gm = { id: "gm-1", isGM: true };
const player = { id: "player-1", isGM: false };
const otherPlayer = { id: "player-2", isGM: false };

describe("canActOnDungeon", () => {
  it("always allows a GM, regardless of run state", () => {
    expect(canActOnDungeon(null, { userRef: gm })).toBe(true);
    expect(
      canActOnDungeon({ hostUserId: "someone-else" }, { userRef: gm }),
    ).toBe(true);
  });

  it("allows the run's own host", () => {
    const run = { hostUserId: player.id };
    expect(canActOnDungeon(run, { userRef: player })).toBe(true);
  });

  it("denies a non-host, non-GM player", () => {
    const run = { hostUserId: player.id };
    expect(canActOnDungeon(run, { userRef: otherPlayer })).toBe(false);
  });

  it("denies a non-GM when there is no run at all (normal GM-run game path)", () => {
    expect(canActOnDungeon(null, { userRef: player })).toBe(false);
    expect(canActOnDungeon({ hostUserId: null }, { userRef: player })).toBe(
      false,
    );
  });
});

describe("decideOpenDungeon", () => {
  it("always renders for a GM", () => {
    expect(decideOpenDungeon(null, { userRef: gm })).toEqual({
      action: "render",
    });
  });

  it("renders for a non-GM starting fresh with no hosted run", () => {
    expect(decideOpenDungeon(null, { userRef: player })).toEqual({
      action: "render",
    });
  });

  it("renders for a non-GM reopening their own hosted run", () => {
    const hosted = { sceneId: "scene-1", hostUserId: player.id };
    expect(decideOpenDungeon(hosted, { userRef: player })).toEqual({
      action: "render",
    });
  });

  it("warns already-hosted for a different non-GM while someone else's run is active", () => {
    const hosted = { sceneId: "scene-1", hostUserId: player.id };
    expect(decideOpenDungeon(hosted, { userRef: otherPlayer })).toEqual({
      action: "warnAlreadyHosted",
      hostUserId: player.id,
    });
  });
});

describe("decideGmLessBroadcast", () => {
  it("never acts for a GM client", () => {
    const hosted = { sceneId: "scene-1", hostUserId: player.id };
    expect(decideGmLessBroadcast(hosted, false, { userRef: gm })).toEqual({
      action: "none",
    });
  });

  it("opens a fresh instance for the host's own client with none open yet", () => {
    const hosted = { sceneId: "scene-1", hostUserId: player.id };
    expect(
      decideGmLessBroadcast(hosted, false, { userRef: player }),
    ).toEqual({ action: "open" });
  });

  it("re-renders the host's own already-open instance (catches up after a routed request)", () => {
    const hosted = { sceneId: "scene-1", hostUserId: player.id };
    expect(decideGmLessBroadcast(hosted, true, { userRef: player })).toEqual({
      action: "render",
    });
  });

  it("opens a fresh read-only instance for another player with none open yet", () => {
    const hosted = { sceneId: "scene-1", hostUserId: player.id };
    expect(
      decideGmLessBroadcast(hosted, false, { userRef: otherPlayer }),
    ).toEqual({ action: "open" });
  });

  it("re-renders an already-open read-only instance", () => {
    const hosted = { sceneId: "scene-1", hostUserId: player.id };
    expect(
      decideGmLessBroadcast(hosted, true, { userRef: otherPlayer }),
    ).toEqual({ action: "render" });
  });

  it("closes an open instance once no run is hosted any more", () => {
    expect(
      decideGmLessBroadcast(null, true, { userRef: otherPlayer }),
    ).toEqual({ action: "close" });
  });

  it("does nothing when there's no hosted run and nothing open", () => {
    expect(
      decideGmLessBroadcast(null, false, { userRef: otherPlayer }),
    ).toEqual({ action: "none" });
  });
});

describe("isAuthorizedRequest", () => {
  it("authorizes starting a run when nothing else is hosted", () => {
    expect(isAuthorizedRequest("startRun", player.id, null)).toBe(true);
  });

  it("authorizes starting a run that is this same requester's own (retry/reopen)", () => {
    const hosted = { sceneId: "scene-1", hostUserId: player.id };
    expect(isAuthorizedRequest("startRun", player.id, hosted)).toBe(true);
  });

  it("denies starting a run when a different host is already active", () => {
    const hosted = { sceneId: "scene-1", hostUserId: player.id };
    expect(isAuthorizedRequest("startRun", otherPlayer.id, hosted)).toBe(
      false,
    );
  });

  it("authorizes any other action from the run's own tracked host", () => {
    const run = { hostUserId: player.id };
    expect(isAuthorizedRequest("resolveRoom", player.id, run)).toBe(true);
  });

  it("denies any other action from a non-host requester", () => {
    const run = { hostUserId: player.id };
    expect(isAuthorizedRequest("resolveRoom", otherPlayer.id, run)).toBe(
      false,
    );
  });

  it("denies any other action when there is no run at all", () => {
    expect(isAuthorizedRequest("resolveRoom", player.id, null)).toBe(false);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/dungeon-permissions.test.mjs`
Expected: FAIL — old exports/behavior don't match (e.g. `decideOpenDungeon(null, { userRef: player })` currently returns `{ action: "render" }` only when no GM is active, which this test no longer passes `usersRef` for; `isAuthorizedRequest` doesn't exist yet).

- [ ] **Step 3: Replace the implementation**

Replace `scripts/dungeon-permissions.mjs` in full:

```js
/**
 * Decision logic for the GM-less dungeon crawl (#109, agent-relay design) —
 * see docs/superpowers/specs/2026-09-20-gm-less-dungeon-crawl-agent-relay-design.md.
 * Every mutating action still only ever runs on a genuinely GM-privileged
 * client (a human GM, or a client logged in as the world's "Agent" GM
 * account); this file decides two separate things: whether THIS client's
 * own DungeonApp should render interactive vs. read-only, and whether a
 * routed request from another client should be honored.
 *
 * Refs are injectable so this is testable without a live Foundry — same
 * pattern as draw-target.mjs's canvasRef/userRef.
 */
function resolveUser(userRef) {
  return userRef ?? (typeof game !== "undefined" ? game.user : null);
}

/** Whether THIS client's own window should be interactive: a GM always is;
 * otherwise only the run's own tracked host. */
export function canActOnDungeon(run, { userRef = null } = {}) {
  const user = resolveUser(userRef);
  return !!user?.isGM || (!!run?.hostUserId && run.hostUserId === user?.id);
}

/** What `module.mjs`'s `openDungeon()` should do — a GM always renders; a
 * non-GM may render (starting fresh, or reopening their own already-hosted
 * run) unless a *different* player already hosts the one active run. */
export function decideOpenDungeon(hostedRun, { userRef = null } = {}) {
  const user = resolveUser(userRef);
  if (user?.isGM) return { action: "render" };
  if (hostedRun && hostedRun.hostUserId !== user?.id) {
    return { action: "warnAlreadyHosted", hostUserId: hostedRun.hostUserId };
  }
  return { action: "render" };
}

/**
 * What a non-GM client should do with its own local `DungeonApp` instance
 * whenever the `dungeonRuns` setting changes or the canvas settles — open a
 * fresh copy, re-render an existing one, close one whose run just ended, or
 * nothing. This now also drives the HOST's own client: since a non-GM host
 * no longer writes locally (it routes a request and waits), it has no
 * synchronously-fresh data to render from the moment its own request
 * resolves — the broadcast is what actually delivers the update, same as
 * for a read-only viewer. Never touches a GM's own window (never
 * auto-opened; a GM interacts directly and already has fresh data after
 * its own calls).
 */
export function decideGmLessBroadcast(
  hostedRun,
  hasOpenInstance,
  { userRef = null } = {},
) {
  const user = resolveUser(userRef);
  if (user?.isGM) return { action: "none" };
  if (hostedRun) return { action: hasOpenInstance ? "render" : "open" };
  return { action: hasOpenInstance ? "close" : "none" };
}

/**
 * Whether the GM-side relay handler (dungeon-remote.mjs) should honor a
 * routed request from `requestingUserId` — the actual authorization
 * boundary for the whole feature, since the handler itself only checks
 * `game.user.isGM` (am I allowed to act at all), not who asked. For every
 * action except starting a fresh run, the requester must be the run's own
 * tracked host. Starting a run instead just checks there's no *other*
 * active host already — `run` here is whatever `findActiveHostedRun()`
 * returned (world-wide, not scene-specific, since the scene doesn't exist
 * yet when this fires).
 */
export function isAuthorizedRequest(actionName, requestingUserId, run) {
  if (actionName === "startRun") {
    return !run || run.hostUserId === requestingUserId;
  }
  return !!run && run.hostUserId === requestingUserId;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/dungeon-permissions.test.mjs`
Expected: PASS (20 tests)

- [ ] **Step 5: Commit**

```bash
git add scripts/dungeon-permissions.mjs tests/dungeon-permissions.test.mjs
git commit -m "$(cat <<'EOF'
Simplify dungeon-permissions.mjs for the agent-relay design, add isAuthorizedRequest (#109)

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: `dungeon-scene.mjs` — initialize skill-challenge state at room-build time, not render time

**Files:**
- Modify: `scripts/dungeon-scene.mjs`
- No dedicated test file for this file (existing convention — Foundry-glue, Scene/Document heavy).

**Interfaces:**
- Consumes: `ensureSkillChallenge` from `dungeon-runner.mjs` (new import in this file).
- Produces: no new exports — `buildPopulateAndUnlockRoom`'s existing signature/behavior is extended, not changed.

**Why:** `_prepareContext` (in `dungeon-app.mjs`) currently lazily calls `ensureSkillChallenge` (a write) the first time a skill-challenge room is *rendered*. Under the agent-relay design, a client logged in as the relay's GM (e.g. "Agent") never renders `DungeonApp` at all — nobody watches its screen, it only ever executes routed requests. If the run's host is non-GM, that write would then never happen. Moving it into the room-build pipeline (which runs on a genuinely privileged client every time, whether directly by a GM or via a routed `populateNext`/room-resolution request) fixes this and is a strictly better place for it regardless of #109 — it's the same place trap/encounter population already happens for the room that's about to become current.

- [ ] **Step 1: Add the import**

In `scripts/dungeon-scene.mjs`'s existing `dungeon-runner.mjs` import (near the top of the file), add `ensureSkillChallenge`:

```js
import {
  getRunState,
  advanceToRoom,
  undoLastRoomEntry,
  canUndoRoomEntry,
  ensureSkillChallenge,
} from "./dungeon-runner.mjs";
```

(Match against whatever else is already destructured from that import — add `ensureSkillChallenge` to the existing list, don't replace it.)

- [ ] **Step 2: Initialize the challenge in `buildPopulateAndUnlockRoom`**

In `buildPopulateAndUnlockRoom` (`scripts/dungeon-scene.mjs`), the `else` branch (non-combat rooms) currently only handles `puzzle_or_trap`:

```js
  } else {
    // #135: a puzzle_or_trap room's *specific* content (puzzle vs. trap) is
    ...
    if (room.kind === "puzzle_or_trap" && room.setpieceId) {
      ...
    }
    await unlockDoorToSlot(scene, physicalSlot);
  }
```

Add a `skill_challenge` branch right before the `puzzle_or_trap` one:

```js
  } else {
    // #109: a skill_challenge room's Victory Point state used to be
    // lazily attached the first time DungeonApp rendered it — but a
    // client logged in only to relay a GM-less host's requests never
    // renders DungeonApp at all, so that write would never happen for
    // such a run. Attaching it here instead means it's always done by
    // whichever client is actually building the room (a GM directly, or
    // the GM-side relay handler executing a routed request) — the same
    // place trap/encounter population already happens for the room
    // that's about to become current.
    if (room.kind === "skill_challenge") {
      const partyMembers = (game.actors?.party?.members ?? []).filter(
        (m) => m.type === "character",
      );
      await ensureSkillChallenge(scene.id, room.id, {
        seed: state.seed,
        locationTag: room.locationTag,
        partySize: partyMembers.length,
      });
    }
    // #135: a puzzle_or_trap room's *specific* content (puzzle vs. trap) is
    ...
    if (room.kind === "puzzle_or_trap" && room.setpieceId) {
      ...
    }
    await unlockDoorToSlot(scene, physicalSlot);
  }
```

(Leave the existing `puzzle_or_trap` block and its comment exactly as they are — only insert the new `skill_challenge` block above it.)

- [ ] **Step 3: Run the full test suite**

Run: `npx vitest run`
Expected: PASS — no existing test exercises `buildPopulateAndUnlockRoom` directly (matches this file's own no-test convention); confirms nothing else regressed.

- [ ] **Step 4: Commit**

```bash
git add scripts/dungeon-scene.mjs
git commit -m "$(cat <<'EOF'
dungeon-scene: init skill-challenge state at room-build time, not render time (#109)

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: `dungeon-app.mjs` — extract every mutating handler's core logic, branch on isGM

**Files:**
- Modify: `scripts/ui/dungeon-app.mjs`
- Create (stub, replaced by Task 4): `scripts/dungeon-remote.mjs`
- No dedicated test file (existing convention — `ApplicationV2`/DOM-heavy).

**Interfaces:**
- Consumes: nothing new from other tasks (Task 4 will consume THIS task's new exports).
- Produces new exports (all take `sceneId`, all resolve `game.scenes.get(sceneId)` internally, never `canvas?.scene`):
  - `startDungeonRun({ roomCount, traits, excludeTraits, previousSceneId, hostUserId })`
  - `populateNextRoom(sceneId)`
  - `abandonDungeonRun(sceneId)`
  - `resolveCombatRoomOutcome(sceneId, succeeded)`
  - `startCombatRecoveryFor(sceneId)`
  - `recordSkillChallengeOutcome(sceneId, roomId, outcome)`
  - `continueNarrativeRoom(sceneId, objective)`
  - `resolveCurrentRoom` (already exported, unchanged signature)

- [ ] **Step 1: Add the `requestDungeonAction` import (placeholder — Task 4 creates the module)**

At the top of `scripts/ui/dungeon-app.mjs`, replace:

```js
import { canActOnDungeon } from "../dungeon-permissions.mjs";
```

with:

```js
import { canActOnDungeon } from "../dungeon-permissions.mjs";
import { requestDungeonAction } from "../dungeon-remote.mjs";
```

This import will not resolve until Task 4 creates `dungeon-remote.mjs`. To keep this task's own `npx vitest run` green at commit time regardless, create a minimal stub at `scripts/dungeon-remote.mjs` in this same task:

```js
// Stub — Task 4 replaces this with the real relay implementation.
export function requestDungeonAction() {
  return Promise.resolve(false);
}
```

Task 4 will overwrite this file entirely with the real implementation; do not build out any more of it than this stub here.

- [ ] **Step 2: Extract and rewrite `#onStart`**

Replace `#onStart` (`scripts/ui/dungeon-app.mjs`) in full — this removes the old GM-presence pre-check (`if (!game.user.isGM && game.users.some(...))`, no longer meaningful under this design) and extracts the body into a new exported `startDungeonRun`:

```js
  /**
   * Builds a fresh run's entry room, first real room, party placement, and
   * scene activation — the actual privileged work `#onStart` either does
   * directly (a GM) or asks the GM-side relay to do (dungeon-remote.mjs's
   * "startRun" action, for a non-GM host). Never touches `canvas?.scene` —
   * see this plan's Global Constraints.
   */
  static async #onStart() {
    const form = this.element.querySelector("form");
    const roomCount = Math.max(
      2,
      parseInt(form?.querySelector('[name="roomCount"]')?.value ?? "6", 10),
    );
    const traits = readTraitField(this.element, "traits");
    const excludeTraits = readTraitField(this.element, "excludeTraits");
    // Wherever the GM/party were right before starting — teardownDungeonRun
    // (ITEM-18) sends them back here if this run is later abandoned.
    const previousSceneId = canvas?.scene?.id ?? null;

    if (game.user.isGM) {
      await startDungeonRun({
        roomCount,
        traits,
        excludeTraits,
        previousSceneId,
        hostUserId: null,
      });
    } else {
      await requestDungeonAction("startRun", {
        roomCount,
        traits,
        excludeTraits,
        previousSceneId,
      });
    }
    this.render();
  }
```

Add the new exported function right above the `DungeonApp` class (alongside the existing `resolveCurrentRoom` export, same section):

```js
export async function startDungeonRun({
  roomCount,
  traits,
  excludeTraits,
  previousSceneId,
  hostUserId,
}) {
  const scene = await createDungeonScene();
  const setpieces = await loadDungeonSetpieces();
  const state = await createRun(
    {
      sceneId: scene.id,
      roomCount,
      traits,
      excludeTraits,
      previousSceneId,
      hostUserId,
    },
    { setpieceIds: setpieces.map((s) => s.id) },
  );

  // Room 0 is always the safe entry — no encounter, trap or puzzle ever
  // spawns there (see dungeon-deck.mjs's buildRoomSequence).
  const entryRoom = state.rooms[0];
  await buildRoomAtSlot(scene, 0, {
    isGoal: entryRoom.isGoal,
    locationTag: entryRoom.locationTag,
    artVariant: entryRoom.artVariant,
    seed: state.seed,
  });

  // A combat first room's build+populate is deliberately deferred to the
  // next "Populate Next Room" action instead — see #onPopulateNext/
  // populateNextRoom below (ITEM-11).
  const firstRealRoom = state.rooms[1];
  if (firstRealRoom && firstRealRoom.kind !== "combat") {
    await buildPopulateAndUnlockRoom(scene, state, firstRealRoom, 1);
  }

  const partyMembers = (game.actors?.party?.members ?? []).filter(
    (m) => m.type === "character",
  );
  await placePartyInSlot(scene, 0, partyMembers, state.seed);
  await scene.activate();
  // The canvas doesn't finish switching to the new scene the instant
  // activate() resolves — animatePan needs a beat to land on it, same
  // settling delay scene-divination.mjs already relies on for its own
  // post-activate scene work.
  await new Promise((r) => setTimeout(r, 400));
  focusCameraOnSlot(scene, 0, state.seed);
}
```

- [ ] **Step 3: Extract and rewrite `#onSucceed`/`#onFail`**

Replace both in full:

```js
  static async #onSucceed() {
    await DungeonApp.#resolveRoom(this, true);
  }
  static async #onFail() {
    await DungeonApp.#resolveRoom(this, false);
  }

  static async #resolveRoom(app, succeeded) {
    const sceneId = canvas?.scene?.id;
    if (!sceneId) return;
    if (game.user.isGM) {
      await resolveCurrentRoom(succeeded, { scene: game.scenes.get(sceneId) });
    } else {
      await requestDungeonAction("resolveRoom", { sceneId, succeeded });
    }
    app.render();
  }
```

- [ ] **Step 4: Extract and rewrite `#onAttemptSkillChallenge`**

Replace in full — the roll itself stays on the requesting player's own client (an ordinary PF2e check against their own character needs no GM permission and should be attributed to them in chat); only recording the outcome (and resolving the room, if the challenge just finished) is routed:

```js
  static async #onAttemptSkillChallenge() {
    const scene = canvas?.scene;
    const sceneId = scene?.id;
    const state = sceneId ? getRunState(sceneId) : null;
    const currentRoom = state?.rooms[state.currentIndex];
    if (!currentRoom?.challenge) return;

    const form = this.element.querySelector(
      ".dommt-dungeon__skill-challenge-form",
    );
    const actorId = form?.querySelector('[name="actorId"]')?.value;
    const skill = form?.querySelector('[name="skill"]')?.value;
    const actor = actorId ? game.actors.get(actorId) : null;
    if (!actor || !skill) return;

    const dc = dcForAttempt({
      partyLevel: await makeFoundryApi().partyLevel(),
      skill,
      specialtySkills: currentRoom.challenge.specialtySkills,
    });
    const result = await rollSkillChallengeAttempt(actor, skill, dc);
    if (!result) return;

    if (game.user.isGM) {
      await recordSkillChallengeOutcome(sceneId, currentRoom.id, result.outcome);
    } else {
      await requestDungeonAction("recordSkillChallengeOutcome", {
        sceneId,
        roomId: currentRoom.id,
        outcome: result.outcome,
      });
    }
    this.render();
  }
```

Add the new exported function (near `resolveCurrentRoom`):

```js
export async function recordSkillChallengeOutcome(sceneId, roomId, outcome) {
  const newState = await recordSkillChallengeAttempt(sceneId, roomId, outcome);
  const resolved = newState?.rooms.find((r) => r.id === roomId)?.challenge
    ?.resolved;
  if (resolved)
    await resolveCurrentRoom(resolved === "success", {
      scene: game.scenes.get(sceneId),
    });
}
```

- [ ] **Step 5: Extract and rewrite `#onContinueNarrative`**

Replace in full:

```js
  static async #onContinueNarrative() {
    const sceneId = canvas?.scene?.id;
    if (!sceneId) return;
    const textarea = this.element.querySelector(
      '[name="dommt-narrative-objective"]',
    );
    const objective = textarea?.value?.trim() || null;
    if (game.user.isGM) {
      await continueNarrativeRoom(sceneId, objective);
    } else {
      await requestDungeonAction("continueNarrativeRoom", {
        sceneId,
        objective,
      });
    }
    this.render();
  }
```

Add the new exported function:

```js
/**
 * A narrative room's own resolution (#163): saves whatever's in the
 * objective textarea (if anything — see #onContinueNarrative's own comment
 * on why a blank field leaves any existing objective alone) and always
 * resolves the room succeeded, since a narrative beat has nothing to fail.
 */
export async function continueNarrativeRoom(sceneId, objective) {
  if (objective) await setObjective(sceneId, objective);
  await resolveCurrentRoom(true, { scene: game.scenes.get(sceneId) });
}
```

- [ ] **Step 6: Extract and rewrite `#onDeclareVictory`/`#onDeclareDefeat`**

Replace both, and the private `#resolveCombatRoom` they called, in full:

```js
  static async #onDeclareVictory() {
    await DungeonApp.#declareOutcome(this, true);
  }
  static async #onDeclareDefeat() {
    await DungeonApp.#declareOutcome(this, false);
  }

  static async #declareOutcome(app, succeeded) {
    const sceneId = canvas?.scene?.id;
    if (!sceneId) return;
    if (game.user.isGM) {
      await resolveCombatRoomOutcome(sceneId, succeeded);
    } else {
      await requestDungeonAction("declareOutcome", { sceneId, succeeded });
    }
    app.render();
  }
```

Add the new exported function (replaces the removed private `#resolveCombatRoom`'s body):

```js
export async function resolveCombatRoomOutcome(sceneId, succeeded) {
  const scene = game.scenes.get(sceneId);
  const state = scene ? getRunState(sceneId) : null;
  const currentRoom = state?.rooms[state.currentIndex];
  const slot = currentRoom
    ? state.physicalSlotByRoomId[currentRoom.id]
    : null;
  if (slot == null) return;
  await resolveSlotCombat(
    scene,
    slot,
    succeeded ? "victory" : "defeat",
    makeFoundryApi(),
  );
  await resolveCurrentRoom(succeeded, { scene });
}
```

- [ ] **Step 7: Extract and rewrite `#onStartCombatRecovery`**

Replace in full:

```js
  static async #onStartCombatRecovery() {
    const sceneId = canvas?.scene?.id;
    if (!sceneId) return;
    if (game.user.isGM) {
      await startCombatRecoveryFor(sceneId);
    } else {
      await requestDungeonAction("startCombatRecovery", { sceneId });
    }
    this.render();
  }
```

Add the new exported function:

```js
export async function startCombatRecoveryFor(sceneId) {
  const scene = game.scenes.get(sceneId);
  const state = scene ? getRunState(sceneId) : null;
  const currentRoom = state?.rooms[state.currentIndex];
  const slot = currentRoom
    ? state.physicalSlotByRoomId[currentRoom.id]
    : null;
  if (slot == null) return;
  await startCombatForSlot(scene, slot);
}
```

- [ ] **Step 8: Extract and rewrite `#onPopulateNext`**

Replace in full:

```js
  static async #onPopulateNext() {
    const sceneId = canvas?.scene?.id;
    if (!sceneId) return;
    if (game.user.isGM) {
      await populateNextRoom(sceneId);
    } else {
      await requestDungeonAction("populateNext", { sceneId });
    }
    this.render();
  }
```

Add the new exported function:

```js
export async function populateNextRoom(sceneId) {
  const scene = game.scenes.get(sceneId);
  const state = scene ? getRunState(sceneId) : null;
  const nextRoom = state?.rooms[state.currentIndex + 1] ?? null;
  const slot = nextRoom ? state.physicalSlotByRoomId[nextRoom.id] : null;
  if (!scene || slot == null) return;

  // A combat first room's walls don't exist yet the first time this runs
  // for it — startDungeonRun deliberately skipped building it — so build
  // them here too, same as every other recovery this function already
  // covers. A no-op for every normal case, where the room was already
  // built back when the room before it resolved.
  if (!isSlotBuilt(scene, slot)) {
    await buildRoomAtSlot(scene, slot, {
      isGoal: nextRoom.isGoal,
      locationTag: nextRoom.locationTag,
      artVariant: nextRoom.artVariant,
      seed: state.seed,
    });
  }

  await populateSlotEncounter(scene, slot, {
    prefillTraits: state.traits,
    prefillExcludeTraits: state.excludeTraits,
    levelOffsetBias: depthBiasFor({
      physicalSlot: slot,
      roomCount: state.rooms.length,
      isGoal: nextRoom.isGoal,
    }),
    locationTag: nextRoom.locationTag,
    seed: state.seed,
  });
  if (isSlotPopulated(scene, slot)) await unlockDoorToSlot(scene, slot);
}
```

- [ ] **Step 9: Rewrite `#onUndo`**

Replace in full (no extraction needed — `undoRoomEntry` from `dungeon-scene.mjs`, already imported, already takes a bare `sceneId`):

```js
  static async #onUndo() {
    const sceneId = canvas?.scene?.id;
    if (!sceneId) return;
    if (game.user.isGM) {
      await undoRoomEntry(sceneId);
    } else {
      await requestDungeonAction("undoRoomEntry", { sceneId });
    }
    this.render();
  }
```

- [ ] **Step 10: Extract and rewrite `#onAbandon`**

Replace in full — the confirm dialog stays local (it's just a prompt, needs no permission, and must happen on the actual human's screen, not on a headless relay client):

```js
  /**
   * Cancels the run (ITEM-18): confirms first — this now does far more than
   * clear a settings entry, it moves the party out, deletes every NPC actor
   * the run's encounters spawned, and deletes the dungeon scene itself, none
   * of which is undoable. The confirmation itself always happens locally
   * (it's just a prompt); only the actual teardown is routed for a non-GM
   * host.
   */
  static async #onAbandon() {
    const sceneId = canvas?.scene?.id;
    if (!sceneId) return;

    const confirmed = await foundry.applications.api.DialogV2.confirm({
      window: { title: game.i18n.localize("DOMMT.Dungeon.AbandonButton") },
      content: `<p>${game.i18n.localize("DOMMT.Dungeon.AbandonConfirm")}</p>`,
      rejectClose: false,
    });
    if (!confirmed) return;

    if (game.user.isGM) {
      await abandonDungeonRun(sceneId);
    } else {
      await requestDungeonAction("abandonRun", { sceneId });
    }
    this.close();
  }
```

Add the new exported function:

```js
export async function abandonDungeonRun(sceneId) {
  const scene = game.scenes.get(sceneId);
  const state = getRunState(sceneId);
  await abandonRun({ sceneId });
  if (scene)
    await teardownDungeonRun(scene, {
      previousSceneId: state?.previousSceneId ?? null,
    });
}
```

- [ ] **Step 11: Simplify `_prepareContext`'s skill-challenge block to a pure read**

Replace the skill-challenge block in `_prepareContext` (`scripts/ui/dungeon-app.mjs`):

```js
    // #162: lazily attach a fresh Victory Point challenge to the current
    // room the first time it's rendered — ensureSkillChallenge is itself a
    ...
    let challenge = null;
    if (isSkillChallenge) {
      ...
      if (raw) {
        challenge = {
          ...
        };
      }
    }
```

with:

```js
    // #162/#109: the challenge is now attached at room-build time
    // (dungeon-scene.mjs's buildPopulateAndUnlockRoom), not lazily on
    // render — this is a pure read of whatever's already persisted.
    let challenge = null;
    if (isSkillChallenge && currentRoom.challenge) {
      const raw = currentRoom.challenge;
      challenge = {
        vp: raw.vp,
        vpTarget: raw.vpTarget,
        attemptsRemaining: raw.attemptBudget - raw.attemptsUsed,
        specialtySkills: raw.specialtySkills.map((slug) => ({
          slug,
          label: skillLabel(slug),
        })),
        allSkills: ALL_SKILLS.map((slug) => ({
          slug,
          label: skillLabel(slug),
          isSpecialty: raw.specialtySkills.includes(slug),
        })),
      };
    }
```

`ensureSkillChallenge` is no longer called in this file (Task 2 moved the call into `dungeon-scene.mjs`) — remove it from this file's `../dungeon-runner.mjs` import. Replace:

```js
import {
  getRunState,
  createRun,
  markRoomOutcome,
  abandonRun,
  canUndoRoomEntry,
  ensureSkillChallenge,
  recordSkillChallengeAttempt,
  setObjective,
} from "../dungeon-runner.mjs";
```

with:

```js
import {
  getRunState,
  createRun,
  markRoomOutcome,
  abandonRun,
  canUndoRoomEntry,
  recordSkillChallengeAttempt,
  setObjective,
} from "../dungeon-runner.mjs";
```

- [ ] **Step 12: Fix the disable-selector to not disable the window's own chrome**

In `_onRender` (`scripts/ui/dungeon-app.mjs`), replace:

```js
      this.element.querySelectorAll("button[data-action]").forEach((btn) => {
        if (btn.dataset.action !== "hide") btn.disabled = true;
      });
```

with:

```js
      // Scoped to .window-content, not the whole element — the frame's own
      // header also has data-action buttons (close, toggleControls) that
      // must stay usable for a read-only viewer.
      this.element
        .querySelectorAll(".window-content button[data-action]")
        .forEach((btn) => {
          if (btn.dataset.action !== "hide") btn.disabled = true;
        });
```

- [ ] **Step 13: Run the full test suite**

Run: `npx vitest run`
Expected: PASS — Step 1's stub `dungeon-remote.mjs` makes the import graph resolve; Task 4 replaces the stub with the real implementation afterward.

- [ ] **Step 14: Commit**

```bash
git add scripts/ui/dungeon-app.mjs scripts/dungeon-remote.mjs
git commit -m "$(cat <<'EOF'
dungeon-app: extract every handler's core logic, branch on isGM to route or act directly (#109)

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 4: New `scripts/dungeon-remote.mjs` — the request/ack relay socket layer

**Files:**
- Modify (overwrite the stub Task 3 created): `scripts/dungeon-remote.mjs`
- Modify: `lang/en.json` (one new key)
- No dedicated test file — this is Foundry-socket glue, matching `player-choice.mjs`'s own precedent (no test file either), which this file's shape directly mirrors. Its one piece of real decision logic (`isAuthorizedRequest`) already has full unit coverage in Task 1.

**Interfaces:**
- Consumes: `SOCKET` from `player-choice.mjs` (reuse the existing channel — Foundry module sockets are conventionally exactly `module.<id>`; adding a second ad-hoc channel name risks not being delivered the same way). `getRunState`, `findActiveHostedRun` from `dungeon-runner.mjs`. `isAuthorizedRequest` from `dungeon-permissions.mjs`. `startDungeonRun`, `resolveCurrentRoom`, `populateNextRoom`, `abandonDungeonRun`, `resolveCombatRoomOutcome`, `startCombatRecoveryFor`, `recordSkillChallengeOutcome`, `continueNarrativeRoom` from `ui/dungeon-app.mjs` (Task 3). `undoRoomEntry` from `dungeon-scene.mjs`.
- Produces: `requestDungeonAction(actionName, args, { timeoutMs } = {})` → `Promise<boolean>` (consumed by Task 3's handlers, already wired). `registerDungeonActionSocket()` → registered once on `ready` (Task 5 wires this).

- [ ] **Step 1: Add the lang key**

In `lang/en.json`, immediately after the existing `"DOMMT.Dungeon.AlreadyHostedWarning"` line, add:

```json
  "DOMMT.Dungeon.RequestFailedWarning": "That request couldn't be completed — check that a GM is connected.",
```

- [ ] **Step 2: Write `scripts/dungeon-remote.mjs`**

```js
/**
 * Routes a non-GM host's dungeon-crawl actions to whichever client is
 * actually logged in as GM (a human GM, or the world's standing "Agent"
 * GM login) — see docs/superpowers/specs/2026-09-20-gm-less-dungeon-crawl-agent-relay-design.md.
 * Mirrors player-choice.mjs's own GM-to-player prompt pattern, inverted: a
 * non-GM client asks whichever client is GM to act, instead of a GM asking
 * a specific player to answer. Shares that file's socket channel (a
 * Foundry module socket is conventionally exactly `module.<id>` — a second
 * ad-hoc channel name isn't guaranteed to be delivered the same way),
 * discriminated by `type`.
 */
import { SOCKET } from "./player-choice.mjs";
import { getRunState, findActiveHostedRun } from "./dungeon-runner.mjs";
import { isAuthorizedRequest } from "./dungeon-permissions.mjs";
import {
  startDungeonRun,
  resolveCurrentRoom,
  populateNextRoom,
  abandonDungeonRun,
  resolveCombatRoomOutcome,
  startCombatRecoveryFor,
  recordSkillChallengeOutcome,
  continueNarrativeRoom,
} from "./ui/dungeon-app.mjs";
import { undoRoomEntry } from "./dungeon-scene.mjs";

const MODULE_ID = "deck-of-many-more-things";
const DEFAULT_TIMEOUT_MS = 15_000;
const pending = new Map();

/** One entry per routable action — every function here already exists as
 * one of dungeon-app.mjs's `sceneId`-parametrized exports (or
 * dungeon-scene.mjs's `undoRoomEntry`), so this table is pure dispatch,
 * nothing more. `args` always carries whatever the action needs, plus
 * `requestingUserId` (only `startRun` uses it — to set the new run's
 * `hostUserId` to whoever actually asked, not to this client's own id). */
const DUNGEON_ACTIONS = {
  startRun: (args) => startDungeonRun({ ...args, hostUserId: args.requestingUserId }),
  resolveRoom: (args) =>
    resolveCurrentRoom(args.succeeded, { scene: game.scenes.get(args.sceneId) }),
  populateNext: (args) => populateNextRoom(args.sceneId),
  undoRoomEntry: (args) => undoRoomEntry(args.sceneId),
  abandonRun: (args) => abandonDungeonRun(args.sceneId),
  declareOutcome: (args) => resolveCombatRoomOutcome(args.sceneId, args.succeeded),
  startCombatRecovery: (args) => startCombatRecoveryFor(args.sceneId),
  recordSkillChallengeOutcome: (args) =>
    recordSkillChallengeOutcome(args.sceneId, args.roomId, args.outcome),
  continueNarrativeRoom: (args) =>
    continueNarrativeRoom(args.sceneId, args.objective),
};

/**
 * Non-GM side: ask whichever client is GM to run `actionName` with `args`,
 * and wait for its ack (or time out). Resolves `true`/`false` — the caller
 * (dungeon-app.mjs's handlers) doesn't otherwise branch on the result, it
 * just re-renders either way and lets the broadcast (decideGmLessBroadcast)
 * deliver the actual state change once it lands.
 */
export function requestDungeonAction(
  actionName,
  args,
  { timeoutMs = DEFAULT_TIMEOUT_MS } = {},
) {
  const id = foundry.utils.randomID();
  return new Promise((resolve) => {
    const done = (ok) => {
      if (!pending.has(id)) return;
      clearTimeout(pending.get(id).timer);
      pending.delete(id);
      if (!ok)
        ui.notifications.warn(
          game.i18n.localize("DOMMT.Dungeon.RequestFailedWarning"),
        );
      resolve(ok);
    };
    const timer = setTimeout(() => done(false), timeoutMs);
    pending.set(id, { done, timer });

    game.socket.emit(SOCKET, {
      type: "dungeon-action-request",
      id,
      actionName,
      args,
      requestingUserId: game.user.id,
    });
  });
}

/**
 * Registered on every client (alongside registerChoiceSocket, same
 * channel). A non-GM client's own request never reaches here — only the
 * ack does; a GM client's own actions never emit a request either (they
 * call the dungeon-app.mjs functions directly). Only a client that is
 * genuinely GM ever executes an incoming request, and even then only
 * after isAuthorizedRequest confirms the requester is entitled to ask for
 * it — game.user.isGM alone answers "am I allowed to act," not "should I
 * honor THIS ask."
 */
export function registerDungeonActionSocket() {
  game.socket.on(SOCKET, async (msg) => {
    if (msg?.type === "dungeon-action-ack") {
      pending.get(msg.id)?.done(!!msg.ok);
      return;
    }
    if (msg?.type !== "dungeon-action-request") return;
    if (!game.user.isGM) return;

    const handler = DUNGEON_ACTIONS[msg.actionName];
    const run =
      msg.actionName === "startRun"
        ? findActiveHostedRun()
        : getRunState(msg.args?.sceneId);
    let ok = false;
    if (handler && isAuthorizedRequest(msg.actionName, msg.requestingUserId, run)) {
      try {
        await handler({ ...msg.args, requestingUserId: msg.requestingUserId });
        ok = true;
      } catch (e) {
        console.error(
          `${MODULE_ID} | dungeon action "${msg.actionName}" failed`,
          e,
        );
      }
    }
    game.socket.emit(SOCKET, {
      type: "dungeon-action-ack",
      id: msg.id,
      ok,
    });
  });
}
```

- [ ] **Step 3: Run the full test suite**

Run: `npx vitest run`
Expected: PASS — `dungeon-app.mjs`'s import of `requestDungeonAction` now resolves for real; every existing test file still passes.

- [ ] **Step 4: Commit**

```bash
git add scripts/dungeon-remote.mjs lang/en.json
git commit -m "$(cat <<'EOF'
Add dungeon-remote.mjs: relay a non-GM host's actions to whoever is GM (#109)

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 5: `module.mjs` — revert the permission-relaxation attempt, wire the new relay, rewrite `openDungeon`

**Files:**
- Modify: `scripts/module.mjs`
- No dedicated test file (existing convention).

**Interfaces:**
- Consumes: `decideOpenDungeon` (Task 1, now the simplified 2-outcome version), `findActiveHostedRun` (`dungeon-runner.mjs`, unchanged), `registerDungeonActionSocket` (Task 4).
- Produces: no new exports.

- [ ] **Step 1: Fix imports**

Replace:

```js
import {
  abandonRun,
  getRunState,
  findActiveHostedRun,
} from "./dungeon-runner.mjs";
import {
  canActOnDungeon,
  decideOpenDungeon,
  decideGmLessBroadcast,
  withSettingsModifyGrantedTo,
} from "./dungeon-permissions.mjs";
```

with:

```js
import { abandonRun, getRunState, findActiveHostedRun } from "./dungeon-runner.mjs";
import { decideOpenDungeon, decideGmLessBroadcast } from "./dungeon-permissions.mjs";
import { registerDungeonActionSocket } from "./dungeon-remote.mjs";
```

(`canActOnDungeon`/`withSettingsModifyGrantedTo` are no longer used anywhere in this file after the reverts below.)

- [ ] **Step 2: Rewrite `openDungeon`**

Replace:

```js
    openDungeon: () => {
      const decision = decideOpenDungeon(findActiveHostedRun());
      if (decision.action === "warnGmOnly")
        return ui.notifications.warn(
          game.i18n.localize("DOMMT.Dungeon.GmOnlyWarning"),
        );
      if (decision.action === "warnAlreadyHosted") {
        const hostUser = game.users.get(decision.hostUserId);
        return ui.notifications.warn(
          game.i18n.format("DOMMT.Dungeon.AlreadyHostedWarning", {
            host: hostUser?.name ?? "?",
          }),
        );
      }
      return new DungeonApp().render(true);
    },
```

with:

```js
    // #109: any user may open the tracker now — a GM always renders; a
    // non-GM renders too (the setup form for a fresh run, or their own
    // already-hosted run's current state) unless a *different* player
    // already hosts the one active run.
    openDungeon: () => {
      const decision = decideOpenDungeon(findActiveHostedRun());
      if (decision.action === "warnAlreadyHosted") {
        const hostUser = game.users.get(decision.hostUserId);
        return ui.notifications.warn(
          game.i18n.format("DOMMT.Dungeon.AlreadyHostedWarning", {
            host: hostUser?.name ?? "?",
          }),
        );
      }
      return new DungeonApp().render(true);
    },
```

- [ ] **Step 3: Revert `resetDungeon` to plain `isGM`**

Replace:

```js
    resetDungeon: async (sceneId) => {
      const targetSceneId = sceneId ?? canvas?.scene?.id;
      if (!targetSceneId) return;
      if (!canActOnDungeon(getRunState(targetSceneId)))
        return ui.notifications.warn(
          game.i18n.localize("DOMMT.Dungeon.GmOnlyWarning"),
        );
      const scene = game.scenes.get(targetSceneId);
      const state = getRunState(targetSceneId);
      await abandonRun({ sceneId: targetSceneId });
      if (scene)
        await teardownDungeonRun(scene, {
          previousSceneId: state?.previousSceneId ?? null,
        });
    },
```

with:

```js
    resetDungeon: async (sceneId) => {
      if (!game.user.isGM)
        return ui.notifications.warn(
          game.i18n.localize("DOMMT.Dungeon.GmOnlyWarning"),
        );
      const targetSceneId = sceneId ?? canvas?.scene?.id;
      if (!targetSceneId) return;
      const scene = game.scenes.get(targetSceneId);
      const state = getRunState(targetSceneId);
      await abandonRun({ sceneId: targetSceneId });
      if (scene)
        await teardownDungeonRun(scene, {
          previousSceneId: state?.previousSceneId ?? null,
        });
    },
```

- [ ] **Step 4: Revert `getPendingAgentTurn`/`applyAgentDecision` to plain `isGM`**

Replace:

```js
    getPendingAgentTurn: async (combatId) => {
      const combat = game.combats.get(combatId ?? game.combat?.id);
      const run = combat?.scene ? getRunState(combat.scene.id) : null;
      if (!canActOnDungeon(run))
        return ui.notifications.warn(
          game.i18n.localize("DOMMT.Dungeon.GmOnlyWarning"),
        );
      return combat ? await getPendingAgentTurn(combat) : null;
    },
    applyAgentDecision: (
      combatId,
      combatantId,
      candidateId,
      rationale = null,
    ) => {
      const combat = game.combats.get(combatId);
      const run = combat?.scene ? getRunState(combat.scene.id) : null;
      if (!canActOnDungeon(run))
        return ui.notifications.warn(
          game.i18n.localize("DOMMT.Dungeon.GmOnlyWarning"),
        );
      return combat
        ? applyAgentDecision(combat, combatantId, candidateId, rationale)
        : null;
    },
```

with:

```js
    getPendingAgentTurn: async (combatId) => {
      if (!game.user.isGM)
        return ui.notifications.warn(
          game.i18n.localize("DOMMT.Dungeon.GmOnlyWarning"),
        );
      const combat = game.combats.get(combatId ?? game.combat?.id);
      return combat ? await getPendingAgentTurn(combat) : null;
    },
    applyAgentDecision: (
      combatId,
      combatantId,
      candidateId,
      rationale = null,
    ) => {
      if (!game.user.isGM)
        return ui.notifications.warn(
          game.i18n.localize("DOMMT.Dungeon.GmOnlyWarning"),
        );
      const combat = game.combats.get(combatId);
      return combat
        ? applyAgentDecision(combat, combatantId, candidateId, rationale)
        : null;
    },
```

- [ ] **Step 5: Revert `recordAgentLoopHeartbeat`/`getAgentLoopStatus`/`postAgentLoopStatus` to plain `isGM`**

Replace each `if (!canActOnDungeon(findActiveHostedRun()))` with `if (!game.user.isGM)` — three occurrences, same warning body each time (`ui.notifications.warn(game.i18n.localize("DOMMT.Dungeon.GmOnlyWarning"))`), rest of each function body unchanged.

- [ ] **Step 6: Revert `getPendingTrapCustomization`/`applyTrapCustomization` to plain `isGM`**

Replace:

```js
    getPendingTrapCustomization: (sceneId) => {
      const targetSceneId = sceneId ?? canvas?.scene?.id;
      if (!canActOnDungeon(getRunState(targetSceneId)))
        return ui.notifications.warn(
          game.i18n.localize("DOMMT.Dungeon.GmOnlyWarning"),
        );
      return getPendingTrapCustomization(targetSceneId);
    },
    applyTrapCustomization: (actorId, customization) => {
      if (!canActOnDungeon(findActiveHostedRun()))
        return ui.notifications.warn(
          game.i18n.localize("DOMMT.Dungeon.GmOnlyWarning"),
        );
      return applyTrapCustomization(actorId, customization);
    },
```

with:

```js
    getPendingTrapCustomization: (sceneId) => {
      if (!game.user.isGM)
        return ui.notifications.warn(
          game.i18n.localize("DOMMT.Dungeon.GmOnlyWarning"),
        );
      return getPendingTrapCustomization(sceneId ?? canvas?.scene?.id);
    },
    applyTrapCustomization: (actorId, customization) => {
      if (!game.user.isGM)
        return ui.notifications.warn(
          game.i18n.localize("DOMMT.Dungeon.GmOnlyWarning"),
        );
      return applyTrapCustomization(actorId, customization);
    },
```

- [ ] **Step 7: Remove the `SETTINGS_MODIFY` grant, register the relay socket**

In the `Hooks.once("ready", ...)` block's `if (game.user.isGM) { ... }` section, replace:

```js
    try {
      await ensureDivinationScene();
    } catch (e) {
      console.error(`${MODULE_ID} | ensureDivinationScene failed`, e);
    }
    // #109: a non-GM host writing the dungeonRuns (or any other world)
    // setting needs Foundry's own SETTINGS_MODIFY permission — a plain
    // isGM check in this module's own code is not enough, Foundry enforces
    // this itself server-side. Idempotent: only writes when a role is
    // actually missing, and preserves every existing grant.
    try {
      const updated = withSettingsModifyGrantedTo(
        game.settings.get("core", "permissions"),
        [CONST.USER_ROLES.PLAYER, CONST.USER_ROLES.TRUSTED],
      );
      if (updated) await game.settings.set("core", "permissions", updated);
    } catch (e) {
      console.error(`${MODULE_ID} | granting SETTINGS_MODIFY failed`, e);
    }
  }
```

with:

```js
    try {
      await ensureDivinationScene();
    } catch (e) {
      console.error(`${MODULE_ID} | ensureDivinationScene failed`, e);
    }
  }
```

Then, right after the `Hooks.once("ready", registerChoiceSocket);` line (further down the file), add:

```js
Hooks.once("ready", registerDungeonActionSocket);
```

- [ ] **Step 8: Register the broadcast hook on `createSetting` too, not just `updateSetting`**

Foundry's `game.settings.set` calls `Setting.create` (firing `createSetting`, not `updateSetting`) the very first time a given setting is ever written in a world — `dungeonRuns` starts as `{}` (its registered default) and is never pre-created, so a world's first-ever dungeon run's initial write fires `createSetting`. Every write after that is an update. Without this, only the very first run in a fresh world would rely on the `canvasReady` hook to catch up (a moment later) rather than the settings hook firing immediately.

Replace:

```js
Hooks.on("updateSetting", (setting) => {
  if (setting.key !== `${MODULE_ID}.dungeonRuns`) return;
  syncGmLessDungeonBroadcast();
});
```

with:

```js
function onDungeonRunsSettingChanged(setting) {
  if (setting.key !== `${MODULE_ID}.dungeonRuns`) return;
  syncGmLessDungeonBroadcast();
}
Hooks.on("updateSetting", onDungeonRunsSettingChanged);
Hooks.on("createSetting", onDungeonRunsSettingChanged);
```

- [ ] **Step 9: Run the full test suite**

Run: `npx vitest run`
Expected: PASS — confirms the import graph resolves cleanly (no leftover reference to `canActOnDungeon`/`withSettingsModifyGrantedTo` in this file) and nothing else regressed.

- [ ] **Step 10: Commit**

```bash
git add scripts/module.mjs
git commit -m "$(cat <<'EOF'
module.mjs: revert permission relaxation, wire the relay, simplify openDungeon (#109)

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 6: `dungeon-combat.mjs` — revert the two hook guards to plain `isGM`

**Files:**
- Modify: `scripts/dungeon-combat.mjs`

**Why:** Under the agent-relay design, `autoPlayCombatantTurnIfDue`/`autoResolveIfDecided` need no changes at all — they already only fire for whichever single client is genuinely GM, and that's always true now (a human GM, or Agent). The `canActOnDungeon`-based gating from the superseded design is unnecessary complexity that should be reverted.

- [ ] **Step 1: Revert the two guards**

Find `autoResolveIfDecided`'s guard (currently):

```js
  const run = combat.scene ? getRunState(combat.scene.id) : null;
  if (!canActOnDungeon(run) || !game.combats.has(combat.id)) return null;
```

Replace with:

```js
  if (!game.user.isGM || !game.combats.has(combat.id)) return null;
```

Find `autoPlayCombatantTurnIfDue`'s guard (currently):

```js
  const run = combat.scene ? getRunState(combat.scene.id) : null;
  if (!canActOnDungeon(run) || !isModuleCombat(combat)) return;
```

Replace with:

```js
  if (!game.user.isGM || !isModuleCombat(combat)) return;
```

- [ ] **Step 2: Remove the now-unused imports**

Remove `import { getRunState } from "./dungeon-runner.mjs";` and `import { canActOnDungeon } from "./dungeon-permissions.mjs";` from the top of `scripts/dungeon-combat.mjs` — confirm first (grep the file) that nothing else in it still references `getRunState` or `canActOnDungeon`; if something does, leave that specific import in place and say so in your report.

- [ ] **Step 3: Run the full test suite**

Run: `npx vitest run`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add scripts/dungeon-combat.mjs
git commit -m "$(cat <<'EOF'
dungeon-combat: revert to plain isGM guards — unnecessary under the relay design (#109)

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 7: `encounter-generator.mjs` — revert the entry gate to plain `isGM`, keep the preview skip

**Files:**
- Modify: `scripts/encounter-generator.mjs`

**Why:** `generateEncounter()` now only ever runs on a genuinely GM-privileged client (called directly by a GM, or via a routed `populateNext`/`startRun` request executed by the GM-side relay handler) — the `canActOnDungeon` gate is no longer needed. The preview-skip behavior (auto-accepting Accept/Reroll/Cancel during a GM-less run) is still needed and unchanged: nobody watches the relay client's screen to click through that dialog.

- [ ] **Step 1: Revert the entry gate, keep `skipPreview`**

Replace:

```js
  // #109: canvas.scene is already the dungeon scene by the time a room
  // population calls this (populateSlotEncounter never overrides it) — the
  // standalone "DOMMT: Generate Encounter" macro's scene never has a run at
  // all, so `run` is null there and canActOnDungeon reduces to plain isGM.
  const run = getRunState(canvas.scene.id);
  if (!canActOnDungeon(run)) {
    ui.notifications.warn(game.i18n.localize("DOMMT.Encounter.GmOnlyWarning"));
    return;
  }
  // A GM-less run has no GM present to click Accept/Reroll — the first
  // dealt roster is used directly (see the spec's "Combat encounter
  // preview" section).
  const skipPreview = Boolean(run?.hostUserId);
```

with:

```js
  if (!game.user.isGM) {
    ui.notifications.warn(game.i18n.localize("DOMMT.Encounter.GmOnlyWarning"));
    return;
  }
  // #109: canvas.scene is already the dungeon scene by the time a room
  // population calls this (populateSlotEncounter never overrides it) — the
  // standalone "DOMMT: Generate Encounter" macro's scene never has a run at
  // all, so `run` is null there. A GM-less run's host isn't the one
  // executing this (it always runs on whichever client is genuinely GM —
  // see dungeon-remote.mjs), so nobody's watching this client's screen to
  // click Accept/Reroll: the first dealt roster is used directly instead.
  const run = getRunState(canvas.scene.id);
  const skipPreview = Boolean(run?.hostUserId);
```

- [ ] **Step 2: Remove the now-unused import**

Remove `import { canActOnDungeon } from "./dungeon-permissions.mjs";` from the top of `scripts/encounter-generator.mjs`. Keep `import { getRunState } from "./dungeon-runner.mjs";` — still used for `skipPreview`.

- [ ] **Step 3: Run the full test suite**

Run: `npx vitest run`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add scripts/encounter-generator.mjs
git commit -m "$(cat <<'EOF'
encounter-generator: revert entry gate to plain isGM, keep preview skip (#109)

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 8: Version bump, live verification, PR, merge

**Files:**
- Modify: `module.json` (version bump)

- [ ] **Step 1: Bump the version**

Read `module.json`'s current `"version"` field, bump the patch number, update it.

```bash
git add module.json
git commit -m "$(cat <<'EOF'
Bump version for #109 (GM-less dungeon crawl, agent-relay design)

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

- [ ] **Step 2: Run the full test suite one more time**

Run: `npx vitest run`
Expected: PASS, full suite green.

- [ ] **Step 3: Push and open the PR**

```bash
git push -u origin worktree-issue-109-gm-less-dungeon-crawl
gh pr create --title "Allow GM-less dungeon crawl start/run via GM-role relay (#109)" --body "$(cat <<'EOF'
## Summary
- Non-GM host can start and run a full dungeon crawl by routing every mutating action to whichever client is logged in as GM (a human GM, or the world's standing "Agent" account)
- Broadcasts the tracker to every other connected client (interactive for the host, read-only for everyone else)
- Skips the combat encounter preview during a GM-less run
- Supersedes an earlier permission-relaxation attempt on this same branch, abandoned after final review found Foundry requires role >= Assistant GM to create/update/delete Scene documents — no permission grant makes that reachable for a non-GM client

Closes #109

## Test plan
- [ ] `npx vitest run` passes
- [ ] Live multi-client verification via foundry-rest (see below) passes
EOF
)"
```

- [ ] **Step 4: Live multi-client verification (required before merge — do not skip)**

Needs a second real browser session logged in as a non-GM player (a Trusted-role account), plus the "Agent" GM account logged into a third session, all connected to the same world with the relay module active. Once `curl -s "$FOUNDRY_BASE_URL/clients"` lists both the player's and Agent's clients online:

1. As the non-GM player: run the "DOMMT: Dungeon Crawl" macro with no human GM connected. Confirm it opens the setup dialog (not a refusal).
2. Start a run. Confirm the request reaches Agent's session and the scene/run actually gets created — check the player's own `DungeonApp` re-renders showing the new run (via the broadcast, not instantly).
3. Confirm a third client (another non-host player, if available) sees the tracker open automatically, read-only.
4. Resolve a room (Succeed/Fail), populate the next room, and run a full combat encounter through to victory — confirm the encounter preview was skipped and the room actually advances.
5. Reach a skill-challenge room if the generated layout includes one; confirm the challenge state initializes correctly (this exercises Task 2's room-build-time change) and an attempt can be recorded.
6. Log Agent's session out mid-request (or simulate no GM available) and confirm the requesting player sees the "request failed" warning after the timeout, rather than hanging silently.
7. Abandon the run as the host; confirm the confirmation dialog appears on the host's own screen (not Agent's) and the teardown actually happens.

Record the outcome. If anything fails, fix it and re-verify — do not merge on a partial pass.

- [ ] **Step 5: Merge**

Per project rule (`CLAUDE.md`): this PR requires the live verification above before auto-merging. Once it passes:

```bash
gh pr merge --squash
```
