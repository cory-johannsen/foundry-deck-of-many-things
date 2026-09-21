> **ARCHIVED — the design this plan implements does not work; see the archive notice at the top of `docs/superpowers/specs/2026-09-20-gm-less-dungeon-crawl-design.md`.** A fresh spec/plan pair follows a different architecture (routing a non-GM host's actions to a real GM-role client — e.g. a standing "Agent" login — rather than relaxing permissions). This plan's tasks were fully implemented and reviewed on `worktree-issue-109-gm-less-dungeon-crawl`; that work is not merged and most of it will not carry forward as-is, though `scripts/ui/dungeon-app.mjs`'s read-only broadcast mechanism (Task 6) and `dungeon-runner.mjs`'s `hostUserId` field (Task 2) are expected to be reusable, repurposed pieces.

# GM-less Dungeon Crawl Implementation Plan (ARCHIVED)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a non-GM player start and run a full dungeon crawl with no GM logged in — the initial setup dialog stays interactive for whoever ran the macro, every other GM-only decision point either transfers to that player (room resolution) or auto-accepts (combat preview), and every other connected client watches read-only.

**Architecture:** A `hostUserId` field on the per-scene run state (`dungeon-runner.mjs`) is the sole signal that a run is GM-less and who owns it. A new `dungeon-permissions.mjs` holds small, injectable-ref pure decision functions (same `typeof game !== "undefined"` fallback idiom as `draw-target.mjs`) that every gated call site delegates to. Foundry's own `SETTINGS_MODIFY` user permission — separate from anything this module checks — must also be granted to non-GM roles for a world-setting write to succeed at all; the module's existing GM-gated setup does that once, idempotently. `DungeonApp` becomes visible on every client by reacting to the `dungeonRuns` setting's own `updateSetting` broadcast, rendered read-only via the same permission check its own action handlers now enforce directly (they call `dungeon-runner.mjs`/`dungeon-scene.mjs` directly and never went through `module.api`, so the check has to live there, not just in disabled buttons).

**Tech Stack:** Vanilla JS ES modules, Foundry VTT v13 `ApplicationV2`/Handlebars, Vitest for unit tests, `foundry-rest` skill (self-hosted relay) for live verification.

**Spec:** `docs/superpowers/specs/2026-09-20-gm-less-dungeon-crawl-design.md`

## Global Constraints

- Module id is `"deck-of-many-more-things"` everywhere (`MODULE_ID` constant, repeated per-file — matches existing convention, do not centralize).
- Pure logic that depends on Foundry globals must take injectable refs with a `typeof game !== "undefined" ? game.xxx : null` fallback — the established pattern in `draw-target.mjs`/`dungeon-runner.mjs`, required for Vitest coverage since there is no live Foundry in the test environment.
- Every merged commit needs a `module.json` version bump in the same commit as the change (project rule) — done once, in the final task, not per-task.
- This feature requires live multi-client verification via the `foundry-rest` skill before merge (project `CLAUDE.md` rule: session/UI-mechanics changes need real testing) — it is the last task, and nothing merges until it passes.
- Do not touch `.claude/worktrees/**` — those are other agents' isolated worktrees, not this repo's live source.

---

## Task 1: `dungeon-permissions.mjs` — pure gating/decision logic

**Files:**
- Create: `scripts/dungeon-permissions.mjs`
- Test: `tests/dungeon-permissions.test.mjs`

**Interfaces:**
- Produces: `canActOnDungeon(run, { userRef, usersRef } = {})` → `boolean`; `decideOpenDungeon(hostedRun, { userRef, usersRef } = {})` → `{ action: "render" } | { action: "warnGmOnly" } | { action: "warnAlreadyHosted", hostUserId }`; `decideGmLessBroadcast(hostedRun, hasOpenInstance, { userRef } = {})` → `{ action: "none" | "open" | "render" | "close" }`; `withSettingsModifyGrantedTo(currentPermissions, roles)` → merged permissions object, or `null` if nothing needed to change.
- Consumes: nothing (this is the bottom of the new dependency graph — every other task's file imports from here).

- [ ] **Step 1: Write the failing tests**

```js
// tests/dungeon-permissions.test.mjs
import { describe, it, expect } from "vitest";
import {
  canActOnDungeon,
  decideOpenDungeon,
  decideGmLessBroadcast,
  withSettingsModifyGrantedTo,
} from "../scripts/dungeon-permissions.mjs";

const gm = { id: "gm-1", isGM: true };
const player = { id: "player-1", isGM: false };
const otherPlayer = { id: "player-2", isGM: false };
const noActiveUsers = [gm, player, otherPlayer].map((u) => ({ ...u, active: false }));
const gmActive = [{ ...gm, active: true }, { ...player, active: true }];
const gmInactive = [{ ...gm, active: false }, { ...player, active: true }];

describe("canActOnDungeon", () => {
  it("always allows a GM, regardless of run state", () => {
    expect(
      canActOnDungeon(null, { userRef: gm, usersRef: noActiveUsers }),
    ).toBe(true);
    expect(
      canActOnDungeon({ hostUserId: "someone-else" }, { userRef: gm, usersRef: noActiveUsers }),
    ).toBe(true);
  });

  it("allows the run's own host when no GM is active", () => {
    const run = { hostUserId: player.id };
    expect(
      canActOnDungeon(run, { userRef: player, usersRef: gmInactive }),
    ).toBe(true);
  });

  it("denies the host once any GM is active", () => {
    const run = { hostUserId: player.id };
    expect(
      canActOnDungeon(run, { userRef: player, usersRef: gmActive }),
    ).toBe(false);
  });

  it("denies a non-host, non-GM player even with no active GM", () => {
    const run = { hostUserId: player.id };
    expect(
      canActOnDungeon(run, { userRef: otherPlayer, usersRef: gmInactive }),
    ).toBe(false);
  });

  it("denies a non-GM when there is no run at all", () => {
    expect(
      canActOnDungeon(null, { userRef: player, usersRef: gmInactive }),
    ).toBe(false);
  });
});

describe("decideOpenDungeon", () => {
  it("always renders for a GM", () => {
    expect(decideOpenDungeon(null, { userRef: gm, usersRef: noActiveUsers })).toEqual({
      action: "render",
    });
  });

  it("warns GM-only when a GM is active and caller isn't", () => {
    expect(
      decideOpenDungeon(null, { userRef: player, usersRef: gmActive }),
    ).toEqual({ action: "warnGmOnly" });
  });

  it("renders for a non-GM starting fresh with no GM active and no hosted run", () => {
    expect(
      decideOpenDungeon(null, { userRef: player, usersRef: gmInactive }),
    ).toEqual({ action: "render" });
  });

  it("renders for a non-GM reopening their own hosted run", () => {
    const hosted = { sceneId: "scene-1", hostUserId: player.id };
    expect(
      decideOpenDungeon(hosted, { userRef: player, usersRef: gmInactive }),
    ).toEqual({ action: "render" });
  });

  it("warns already-hosted for a different non-GM while someone else's run is active", () => {
    const hosted = { sceneId: "scene-1", hostUserId: player.id };
    expect(
      decideOpenDungeon(hosted, { userRef: otherPlayer, usersRef: gmInactive }),
    ).toEqual({ action: "warnAlreadyHosted", hostUserId: player.id });
  });
});

describe("decideGmLessBroadcast", () => {
  it("never acts for a GM client", () => {
    const hosted = { sceneId: "scene-1", hostUserId: player.id };
    expect(decideGmLessBroadcast(hosted, false, { userRef: gm })).toEqual({
      action: "none",
    });
  });

  it("never acts on the host's own client", () => {
    const hosted = { sceneId: "scene-1", hostUserId: player.id };
    expect(decideGmLessBroadcast(hosted, false, { userRef: player })).toEqual({
      action: "none",
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

  it("closes an open read-only instance once no run is hosted any more", () => {
    expect(decideGmLessBroadcast(null, true, { userRef: otherPlayer })).toEqual({
      action: "close",
    });
  });

  it("does nothing when there's no hosted run and nothing open", () => {
    expect(decideGmLessBroadcast(null, false, { userRef: otherPlayer })).toEqual({
      action: "none",
    });
  });
});

describe("withSettingsModifyGrantedTo", () => {
  it("adds missing roles, preserving existing ones and other permission keys", () => {
    const current = { SETTINGS_MODIFY: [3, 4], OTHER_PERM: [4] };
    expect(withSettingsModifyGrantedTo(current, [1, 2])).toEqual({
      SETTINGS_MODIFY: [1, 2, 3, 4],
      OTHER_PERM: [4],
    });
  });

  it("returns null when every requested role is already granted", () => {
    const current = { SETTINGS_MODIFY: [1, 2, 3, 4] };
    expect(withSettingsModifyGrantedTo(current, [1, 2])).toBeNull();
  });

  it("treats a missing SETTINGS_MODIFY entry as granting nobody", () => {
    expect(withSettingsModifyGrantedTo({}, [1, 2])).toEqual({
      SETTINGS_MODIFY: [1, 2],
    });
  });

  it("treats null current permissions the same as empty", () => {
    expect(withSettingsModifyGrantedTo(null, [1])).toEqual({
      SETTINGS_MODIFY: [1],
    });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/dungeon-permissions.test.mjs`
Expected: FAIL — `Cannot find module '../scripts/dungeon-permissions.mjs'`

- [ ] **Step 3: Write the implementation**

```js
// scripts/dungeon-permissions.mjs
/**
 * Authorization for the GM-less dungeon crawl (#109) — a GM can always act;
 * otherwise only a run's own designated host, and only while no GM is
 * connected (a GM logging in mid-run immediately regains exclusive
 * control). See docs/superpowers/specs/2026-09-20-gm-less-dungeon-crawl-design.md.
 *
 * Refs are injectable so this is testable without a live Foundry — same
 * pattern as draw-target.mjs's canvasRef/userRef.
 */
function resolveUser(userRef) {
  return userRef ?? (typeof game !== "undefined" ? game.user : null);
}
function resolveUsers(usersRef) {
  return usersRef ?? (typeof game !== "undefined" ? game.users : null);
}
function isAnyGmActive(usersRef) {
  const users = resolveUsers(usersRef);
  return !!users?.some?.((u) => u.isGM && u.active);
}

export function canActOnDungeon(run, { userRef = null, usersRef = null } = {}) {
  const user = resolveUser(userRef);
  if (user?.isGM) return true;
  if (isAnyGmActive(usersRef)) return false;
  return !!run?.hostUserId && run.hostUserId === user?.id;
}

/**
 * What `module.mjs`'s `openDungeon()` should do — a GM always renders; a
 * non-GM is refused while any GM is active; otherwise they may render
 * (either starting fresh or reopening their own already-hosted run), unless
 * a *different* player already hosts the one active GM-less run.
 */
export function decideOpenDungeon(
  hostedRun,
  { userRef = null, usersRef = null } = {},
) {
  const user = resolveUser(userRef);
  if (user?.isGM) return { action: "render" };
  if (isAnyGmActive(usersRef)) return { action: "warnGmOnly" };
  if (hostedRun && hostedRun.hostUserId !== user?.id) {
    return { action: "warnAlreadyHosted", hostUserId: hostedRun.hostUserId };
  }
  return { action: "render" };
}

/**
 * What a non-host, non-GM client should do with its own local `DungeonApp`
 * instance whenever the `dungeonRuns` setting changes or the canvas
 * settles — open a fresh read-only copy, re-render an existing one, close
 * one whose run just ended, or nothing. Never touches the host's own
 * window (it manages itself via its own action handlers' render() calls)
 * or a GM's (never auto-opened).
 */
export function decideGmLessBroadcast(
  hostedRun,
  hasOpenInstance,
  { userRef = null } = {},
) {
  const user = resolveUser(userRef);
  if (user?.isGM) return { action: "none" };
  if (hostedRun?.hostUserId === user?.id) return { action: "none" };
  if (hostedRun) return { action: hasOpenInstance ? "render" : "open" };
  return { action: hasOpenInstance ? "close" : "none" };
}

/**
 * Merges `roles` into `currentPermissions.SETTINGS_MODIFY` (Foundry's own
 * "Modify World Settings" user permission), preserving every other role and
 * every other permission key already there. Returns null when nothing
 * needs to change, so the caller can skip a pointless settings write.
 * Foundry enforces this permission on `game.settings.set` for world-scope
 * settings independent of anything this module checks — see the spec's
 * "Permission prerequisite" section for how this was confirmed live.
 */
export function withSettingsModifyGrantedTo(currentPermissions, roles) {
  const existing = currentPermissions?.SETTINGS_MODIFY ?? [];
  const missing = roles.filter((r) => !existing.includes(r));
  if (!missing.length) return null;
  return {
    ...currentPermissions,
    SETTINGS_MODIFY: [...existing, ...missing].sort((a, b) => a - b),
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/dungeon-permissions.test.mjs`
Expected: PASS (22 tests)

- [ ] **Step 5: Commit**

```bash
git add scripts/dungeon-permissions.mjs tests/dungeon-permissions.test.mjs
git commit -m "$(cat <<'EOF'
Add dungeon-permissions.mjs: pure gating logic for GM-less crawls (#109)

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: `dungeon-runner.mjs` — `hostUserId` and `findActiveHostedRun`

**Files:**
- Modify: `scripts/dungeon-runner.mjs:53-103` (`createRun`), add new export after `abandonRun` (currently ending at line 318)
- Test: `tests/dungeon-runner.test.mjs`

**Interfaces:**
- Consumes: nothing new.
- Produces: `createRun(...)` now accepts an optional `hostUserId = null` field in its first argument and stores it on the returned/persisted state. New export `findActiveHostedRun({ settingsRef } = {})` → `{ sceneId, hostUserId } | null`.

- [ ] **Step 1: Write the failing tests**

Add to `tests/dungeon-runner.test.mjs` (alongside the existing `createRun`/`getRunState` describe block — the file already imports `createRun`, `getRunState`, and the `makeSettingsStub` helper shown in the existing file):

```js
import { findActiveHostedRun } from "../scripts/dungeon-runner.mjs";

describe("createRun hostUserId", () => {
  it("defaults hostUserId to null for a normal GM-run game", async () => {
    const settingsRef = makeSettingsStub();
    const state = await createRun({ sceneId: "scene-1", roomCount: 5 }, { settingsRef });
    expect(state.hostUserId).toBeNull();
  });

  it("stores an explicit hostUserId for a GM-less run", async () => {
    const settingsRef = makeSettingsStub();
    const state = await createRun(
      { sceneId: "scene-1", roomCount: 5, hostUserId: "player-1" },
      { settingsRef },
    );
    expect(state.hostUserId).toBe("player-1");
    expect(getRunState("scene-1", { settingsRef }).hostUserId).toBe("player-1");
  });
});

describe("findActiveHostedRun", () => {
  it("returns null when nothing is hosted", async () => {
    const settingsRef = makeSettingsStub();
    await createRun({ sceneId: "scene-1", roomCount: 5 }, { settingsRef });
    expect(findActiveHostedRun({ settingsRef })).toBeNull();
  });

  it("finds the one active hosted run", async () => {
    const settingsRef = makeSettingsStub();
    await createRun({ sceneId: "scene-1", roomCount: 5 }, { settingsRef });
    await createRun(
      { sceneId: "scene-2", roomCount: 5, hostUserId: "player-1" },
      { settingsRef },
    );
    expect(findActiveHostedRun({ settingsRef })).toEqual({
      sceneId: "scene-2",
      hostUserId: "player-1",
    });
  });

  it("ignores a completed run even if it was hosted", async () => {
    const settingsRef = makeSettingsStub();
    await createRun(
      { sceneId: "scene-1", roomCount: 1, hostUserId: "player-1" },
      { settingsRef },
    );
    // Resolve straight to the goal room to mark it completed.
    const state = getRunState("scene-1", { settingsRef });
    const completed = { ...state, completed: true };
    await settingsRef.set("deck-of-many-more-things", "dungeonRuns", {
      ...settingsRef.get("deck-of-many-more-things", "dungeonRuns"),
      "scene-1": completed,
    });
    expect(findActiveHostedRun({ settingsRef })).toBeNull();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/dungeon-runner.test.mjs`
Expected: FAIL — `state.hostUserId` is `undefined` not `null`; `findActiveHostedRun` is not exported

- [ ] **Step 3: Implement**

In `createRun`'s destructured argument (`scripts/dungeon-runner.mjs:54-61`), add `hostUserId = null`:

```js
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
```

In the state object literal (`scripts/dungeon-runner.mjs:79-101`), add the field after `objective: null,`:

```js
    objective: null,
    // #109: the non-GM player who started this run when no GM was active —
    // null for a normal GM-run game. The sole authorization signal for a
    // non-GM to act on this run (dungeon-permissions.mjs's
    // canActOnDungeon) and the sole trigger for broadcasting it read-only
    // to every other client (module.mjs's syncGmLessDungeonBroadcast).
    hostUserId,
  };
```

After `abandonRun` (end of file, currently line 318), add:

```js
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
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/dungeon-runner.test.mjs`
Expected: PASS (all existing tests plus the 5 new ones)

- [ ] **Step 5: Commit**

```bash
git add scripts/dungeon-runner.mjs tests/dungeon-runner.test.mjs
git commit -m "$(cat <<'EOF'
dungeon-runner: track a GM-less run's host, add findActiveHostedRun (#109)

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: `module.mjs` — permission grant, `openDungeon` rewrite, gate relaxation, broadcast hooks

**Files:**
- Modify: `scripts/module.mjs`
- No dedicated unit test file exists for `module.mjs` today (it's Hooks-registration glue tightly coupled to live Foundry globals — the codebase's existing convention, e.g. `dungeon-combat.mjs`/`encounter-generator.mjs` have none either); this task is covered by Task 1's unit tests (the decision functions it calls) and by Task 8's live verification.

**Interfaces:**
- Consumes: `canActOnDungeon`, `decideOpenDungeon`, `decideGmLessBroadcast`, `withSettingsModifyGrantedTo` from Task 1; `getRunState`, `findActiveHostedRun` from Task 2.
- Produces: no new exports — this file is the composition root.

- [ ] **Step 1: Add imports**

At the top of `scripts/module.mjs`, change:

```js
import { abandonRun, getRunState } from "./dungeon-runner.mjs";
```

to:

```js
import { abandonRun, getRunState, findActiveHostedRun } from "./dungeon-runner.mjs";
import {
  canActOnDungeon,
  decideOpenDungeon,
  decideGmLessBroadcast,
  withSettingsModifyGrantedTo,
} from "./dungeon-permissions.mjs";
```

- [ ] **Step 2: Grant `SETTINGS_MODIFY` during the existing GM-gated ready setup**

In the `Hooks.once("ready", ...)` block (`scripts/module.mjs:245-256`), change:

```js
  if (game.user.isGM) {
    try {
      await ensureWorldMacros();
    } catch (e) {
      console.error(`${MODULE_ID} | ensureWorldMacros failed`, e);
    }
    try {
      await ensureDivinationScene();
    } catch (e) {
      console.error(`${MODULE_ID} | ensureDivinationScene failed`, e);
    }
  }
```

to:

```js
  if (game.user.isGM) {
    try {
      await ensureWorldMacros();
    } catch (e) {
      console.error(`${MODULE_ID} | ensureWorldMacros failed`, e);
    }
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

- [ ] **Step 3: Rewrite `openDungeon` and gate the other `isGM`-checked API entries**

Replace the `openDungeon` entry (`scripts/module.mjs:129-135`):

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

Replace `resetDungeon` (`scripts/module.mjs:139-153`):

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

Replace `getPendingAgentTurn` (`scripts/module.mjs:158-165`):

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
```

Replace `applyAgentDecision` (`scripts/module.mjs:166-180`):

```js
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

Replace `recordAgentLoopHeartbeat`, `getAgentLoopStatus`, `postAgentLoopStatus` (`scripts/module.mjs:185-226`) — these have no scene of their own, so gate on whatever GM-less run is currently active, if any:

```js
    recordAgentLoopHeartbeat: ({
      provider = null,
      pollIntervalMs = null,
    } = {}) => {
      if (!canActOnDungeon(findActiveHostedRun()))
        return ui.notifications.warn(
          game.i18n.localize("DOMMT.Dungeon.GmOnlyWarning"),
        );
      return game.settings.set(MODULE_ID, "agentLoopHeartbeat", {
        timestamp: Date.now(),
        provider,
        pollIntervalMs,
      });
    },
    getAgentLoopStatus: () => {
      if (!canActOnDungeon(findActiveHostedRun()))
        return ui.notifications.warn(
          game.i18n.localize("DOMMT.Dungeon.GmOnlyWarning"),
        );
      return agentLoopStatus();
    },
    postAgentLoopStatus: async () => {
      if (!canActOnDungeon(findActiveHostedRun()))
        return ui.notifications.warn(
          game.i18n.localize("DOMMT.Dungeon.GmOnlyWarning"),
        );
      const status = agentLoopStatus();
      const key = status.connected
        ? "DOMMT.Dungeon.Combat.AgentLoopStatusConnected"
        : status.lastSeenMs
          ? "DOMMT.Dungeon.Combat.AgentLoopStatusStale"
          : "DOMMT.Dungeon.Combat.AgentLoopStatusNeverSeen";
      const content = game.i18n.format(key, {
        provider: status.provider ?? "?",
        seconds: status.secondsAgo ?? 0,
      });
      const gmIds = ChatMessage.getWhisperRecipients("GM").map((u) => u.id);
      return ChatMessage.create({ content, whisper: gmIds });
    },
```

Replace `getPendingTrapCustomization`/`applyTrapCustomization` (`scripts/module.mjs:230-243`):

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

- [ ] **Step 4: Add the read-only broadcast hooks**

After the existing `openDungeonTrackerIfNotOpen` function and its `updateWall` hook (`scripts/module.mjs`, right after the block ending at line 408), add:

```js
/**
 * #109: keeps every non-host, non-GM client's DungeonApp in sync with a
 * GM-less run — opens a read-only copy when one starts, re-renders it on
 * every change, and closes it once the run ends. The host's own window is
 * already open from calling the macro and manages itself via its own
 * action handlers' render() calls; a GM is never auto-opened.
 */
function syncGmLessDungeonBroadcast() {
  const existing = foundry.applications.instances.get("dommt-dungeon-app");
  const decision = decideGmLessBroadcast(findActiveHostedRun(), !!existing);
  if (decision.action === "open") new DungeonApp().render(true);
  else if (decision.action === "render") existing.render();
  else if (decision.action === "close") existing.close();
}

Hooks.on("updateSetting", (setting) => {
  if (setting.key !== `${MODULE_ID}.dungeonRuns`) return;
  syncGmLessDungeonBroadcast();
});
// A client's canvas may still be mid-transition to the dungeon scene when
// the setting update above first fires (see ui/dungeon-app.mjs's own
// _onRender comment on the same scene.activate() timing) — canvasReady
// re-syncs once it's settled.
Hooks.on("canvasReady", syncGmLessDungeonBroadcast);
```

- [ ] **Step 5: Run the full unit suite to confirm nothing else broke**

Run: `npx vitest run`
Expected: PASS — this file has no direct unit tests, but this confirms the import graph resolves and nothing else regressed.

- [ ] **Step 6: Commit**

```bash
git add scripts/module.mjs
git commit -m "$(cat <<'EOF'
module.mjs: grant SETTINGS_MODIFY, relax gates for a GM-less crawl host (#109)

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 4: `dungeon-combat.mjs` — gate the two automatic-resolution hook guards

**Files:**
- Modify: `scripts/dungeon-combat.mjs:260`, `:1301`
- No dedicated unit test file exists for this file today (same convention as Task 3) — covered by Task 8's live verification.

**Interfaces:**
- Consumes: `canActOnDungeon` (Task 1), `getRunState` (Task 2, already indirectly available — needs a new import).

- [ ] **Step 1: Add imports**

Near the top of `scripts/dungeon-combat.mjs` (alongside its existing imports), add:

```js
import { getRunState } from "./dungeon-runner.mjs";
import { canActOnDungeon } from "./dungeon-permissions.mjs";
```

- [ ] **Step 2: Gate `autoResolveIfDecided`**

At `scripts/dungeon-combat.mjs:260`, replace:

```js
async function autoResolveIfDecided(combat) {
  if (!game.user.isGM || !game.combats.has(combat.id)) return null;
```

with:

```js
async function autoResolveIfDecided(combat) {
  const run = combat.scene ? getRunState(combat.scene.id) : null;
  if (!canActOnDungeon(run) || !game.combats.has(combat.id)) return null;
```

- [ ] **Step 3: Gate `autoPlayCombatantTurnIfDue`**

At `scripts/dungeon-combat.mjs:1301`, replace:

```js
export async function autoPlayCombatantTurnIfDue(combat) {
  if (!game.user.isGM || !isModuleCombat(combat)) return;
```

with:

```js
export async function autoPlayCombatantTurnIfDue(combat) {
  const run = combat.scene ? getRunState(combat.scene.id) : null;
  if (!canActOnDungeon(run) || !isModuleCombat(combat)) return;
```

- [ ] **Step 4: Run the full unit suite**

Run: `npx vitest run`
Expected: PASS — no existing tests exercise these two functions directly (per the repo's own convention noted above); this confirms nothing else regressed.

- [ ] **Step 5: Commit**

```bash
git add scripts/dungeon-combat.mjs
git commit -m "$(cat <<'EOF'
dungeon-combat: gate auto-resolution hooks on canActOnDungeon, not bare isGM (#109)

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 5: `encounter-generator.mjs` — gate + skip the preview in GM-less mode

**Files:**
- Modify: `scripts/encounter-generator.mjs:171-231`
- No dedicated unit test file exists for this file today (same convention) — covered by Task 8's live verification.

**Interfaces:**
- Consumes: `canActOnDungeon` (Task 1), `getRunState` (Task 2).

- [ ] **Step 1: Add imports**

Near the top of `scripts/encounter-generator.mjs`:

```js
import { getRunState } from "./dungeon-runner.mjs";
import { canActOnDungeon } from "./dungeon-permissions.mjs";
```

- [ ] **Step 2: Replace the entry gate and compute `run`/`skipPreview`**

In `generateEncounter` (`scripts/encounter-generator.mjs:171-188`), replace:

```js
export async function generateEncounter({
  prefillTraits = [],
  prefillExcludeTraits = [],
  originArea = null,
  forceHidden = false,
  extraFlags = null,
  levelOffsetBias = 0,
  locationTag = null,
  skipThemeDialog = false,
} = {}) {
  if (!game.user.isGM) {
    ui.notifications.warn(game.i18n.localize("DOMMT.Encounter.GmOnlyWarning"));
    return;
  }
  if (!canvas?.scene) {
    ui.notifications.warn(game.i18n.localize("DOMMT.Encounter.NoSceneWarning"));
    return;
  }
```

with:

```js
export async function generateEncounter({
  prefillTraits = [],
  prefillExcludeTraits = [],
  originArea = null,
  forceHidden = false,
  extraFlags = null,
  levelOffsetBias = 0,
  locationTag = null,
  skipThemeDialog = false,
} = {}) {
  if (!canvas?.scene) {
    ui.notifications.warn(game.i18n.localize("DOMMT.Encounter.NoSceneWarning"));
    return;
  }
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

- [ ] **Step 3: Skip the preview dialog when `skipPreview` is true**

In the dealing loop (`scripts/encounter-generator.mjs:212-231`), replace:

```js
    const action = await showEncounterPreview(roster);
    if (action === "accept") break;
    if (action !== "reroll") return;
    seed = freshSeed();
```

with:

```js
    const action = skipPreview ? "accept" : await showEncounterPreview(roster);
    if (action === "accept") break;
    if (action !== "reroll") return;
    seed = freshSeed();
```

- [ ] **Step 4: Run the full unit suite**

Run: `npx vitest run`
Expected: PASS — `encounter-deck.test.mjs`/`encounter-roster.test.mjs` cover the pure logic this file calls into, not `generateEncounter` itself; confirms no regression there.

- [ ] **Step 5: Commit**

```bash
git add scripts/encounter-generator.mjs
git commit -m "$(cat <<'EOF'
encounter-generator: gate on canActOnDungeon, auto-accept preview in GM-less mode (#109)

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 6: `dungeon-app.mjs` + `dungeon-tracker.hbs` — broadcast, read-only rendering, per-handler guards

**Files:**
- Modify: `scripts/ui/dungeon-app.mjs`
- Modify: `templates/dungeon-tracker.hbs`
- No dedicated unit test file exists for this file today (same convention, `ApplicationV2`/DOM-heavy) — covered by Task 8's live verification.

**Interfaces:**
- Consumes: `canActOnDungeon` (Task 1); `createRun` (Task 2, already imported — now also passes `hostUserId`).

- [ ] **Step 1: Add the import**

At the top of `scripts/ui/dungeon-app.mjs`:

```js
import { canActOnDungeon } from "../dungeon-permissions.mjs";
```

- [ ] **Step 2: Pass `hostUserId` when starting a run**

In `#onStart` (`scripts/ui/dungeon-app.mjs:358-361`), replace:

```js
    const state = await createRun(
      { sceneId: scene.id, roomCount, traits, excludeTraits, previousSceneId },
      { setpieceIds: setpieces.map((s) => s.id) },
    );
```

with:

```js
    const state = await createRun(
      {
        sceneId: scene.id,
        roomCount,
        traits,
        excludeTraits,
        previousSceneId,
        // #109: null for a GM (a normal game); the caller's own id when a
        // non-GM starts it — openDungeon() has already refused this call
        // unless that's actually allowed (no GM active, no competing run).
        hostUserId: game.user.isGM ? null : game.user.id,
      },
      { setpieceIds: setpieces.map((s) => s.id) },
    );
```

- [ ] **Step 3: Compute `interactive`/`hostName` in `_prepareContext` and disable controls in `_onRender`**

In `_prepareContext`, right after `const activeCombat = ...` (`scripts/ui/dungeon-app.mjs:203-206`) and before the `isSkillChallenge` block, add:

```js
    // #109: whether THIS client may act on the run, not just whether one
    // exists — false for every read-only broadcast viewer, and also false
    // for the run's own host once any GM connects (see dungeon-permissions.mjs).
    const interactive = canActOnDungeon(state);
    const hostName = state.hostUserId
      ? (game.users.get(state.hostUserId)?.name ?? "?")
      : null;
```

In the returned context object (`scripts/ui/dungeon-app.mjs:259-267`, right after `hasRun: true,`), add:

```js
      hasRun: true,
      interactive,
      hostName,
```

In `_onRender` (`scripts/ui/dungeon-app.mjs:332-341`), replace:

```js
  _onRender(context, options) {
    super._onRender(context, options);
    wireTraitPickerButtons(this.element, context.availableTraits ?? []);
    // Re-frame the current room on every render, not just on the one-shot
    // automatic room-entry trigger — see focusCameraOnSlot's own docs for why
    // that trigger alone isn't reliable with a five-token party.
    if (context.currentSlot != null && canvas?.scene?.id === context.sceneId) {
      focusCameraOnSlot(canvas.scene, context.currentSlot, context.seed);
    }
  }
```

with:

```js
  _onRender(context, options) {
    super._onRender(context, options);
    wireTraitPickerButtons(this.element, context.availableTraits ?? []);
    // Re-frame the current room on every render, not just on the one-shot
    // automatic room-entry trigger — see focusCameraOnSlot's own docs for why
    // that trigger alone isn't reliable with a five-token party.
    if (context.currentSlot != null && canvas?.scene?.id === context.sceneId) {
      focusCameraOnSlot(canvas.scene, context.currentSlot, context.seed);
    }
    // #109: a read-only broadcast viewer (or a host who's lost exclusive
    // control because a GM connected) sees every control disabled except
    // Hide, which only closes their own local window. This is a UI nicety,
    // not the real enforcement — each mutating action handler below
    // re-checks canActOnDungeon itself.
    if (context.hasRun && !context.interactive) {
      this.element.querySelectorAll("footer button[data-action]").forEach((btn) => {
        if (btn.dataset.action !== "hide") btn.disabled = true;
      });
    }
  }
```

- [ ] **Step 4: Guard every mutating action handler**

Replace `#onSucceed`/`#onFail` (`scripts/ui/dungeon-app.mjs:401-408`):

```js
  static async #onSucceed() {
    const sceneId = canvas?.scene?.id;
    if (!sceneId || !canActOnDungeon(getRunState(sceneId))) return;
    await resolveCurrentRoom(true);
    this.render();
  }
  static async #onFail() {
    const sceneId = canvas?.scene?.id;
    if (!sceneId || !canActOnDungeon(getRunState(sceneId))) return;
    await resolveCurrentRoom(false);
    this.render();
  }
```

In `#onAttemptSkillChallenge` (`scripts/ui/dungeon-app.mjs:421-426`), add the guard right after `state` is resolved:

```js
  static async #onAttemptSkillChallenge() {
    const scene = canvas?.scene;
    const sceneId = scene?.id;
    const state = sceneId ? getRunState(sceneId) : null;
    if (!canActOnDungeon(state)) return;
    const currentRoom = state?.rooms[state.currentIndex];
    if (!currentRoom?.challenge) return;
```

In `#onContinueNarrative` (`scripts/ui/dungeon-app.mjs:463-466`):

```js
  static async #onContinueNarrative() {
    const sceneId = canvas?.scene?.id;
    if (!sceneId || !canActOnDungeon(getRunState(sceneId))) return;
    const textarea = this.element.querySelector(
      '[name="dommt-narrative-objective"]',
    );
```

In `#resolveCombatRoom` (`scripts/ui/dungeon-app.mjs:489-493`):

```js
  static async #resolveCombatRoom(app, succeeded) {
    const scene = canvas?.scene;
    const sceneId = scene?.id;
    const state = sceneId ? getRunState(sceneId) : null;
    if (!canActOnDungeon(state)) return;
    const currentRoom = state?.rooms[state.currentIndex];
```

In `#onStartCombatRecovery` (`scripts/ui/dungeon-app.mjs:511-515`):

```js
  static async #onStartCombatRecovery() {
    const scene = canvas?.scene;
    const sceneId = scene?.id;
    const state = sceneId ? getRunState(sceneId) : null;
    if (!canActOnDungeon(state)) return;
    const currentRoom = state?.rooms[state.currentIndex];
```

In `#onPopulateNext` (`scripts/ui/dungeon-app.mjs:540-544`):

```js
  static async #onPopulateNext() {
    const scene = canvas?.scene;
    const sceneId = scene?.id;
    const state = sceneId ? getRunState(sceneId) : null;
    if (!canActOnDungeon(state)) return;
    const nextRoom = state?.rooms[state.currentIndex + 1] ?? null;
```

In `#onUndo` (`scripts/ui/dungeon-app.mjs:577-582`):

```js
  static async #onUndo() {
    const sceneId = canvas?.scene?.id;
    if (!sceneId || !canActOnDungeon(getRunState(sceneId))) return;
    await undoRoomEntry(sceneId);
    this.render();
  }
```

In `#onAbandon` (`scripts/ui/dungeon-app.mjs:591-594`), add the guard right after `sceneId` is resolved, before the confirm dialog (so a read-only viewer never even sees the confirmation prompt):

```js
  static async #onAbandon() {
    const scene = canvas?.scene;
    const sceneId = scene?.id;
    if (!sceneId || !canActOnDungeon(getRunState(sceneId))) return;

    const confirmed = await foundry.applications.api.DialogV2.confirm({
```

- [ ] **Step 5: Add the read-only hint to the template**

In `templates/dungeon-tracker.hbs`, right after the opening `<div class="dommt-dungeon">` on the `hasRun` branch (line 3), add:

```handlebars
      {{#unless interactive}}
        <p class="hint">{{localize "DOMMT.Dungeon.ReadOnlyHint" host=hostName}}</p>
      {{/unless}}
```

- [ ] **Step 6: Run the full unit suite**

Run: `npx vitest run`
Expected: PASS — no existing tests exercise `DungeonApp` directly (`ApplicationV2`/DOM-heavy, per the repo's own convention); confirms nothing else regressed.

- [ ] **Step 7: Commit**

```bash
git add scripts/ui/dungeon-app.mjs templates/dungeon-tracker.hbs
git commit -m "$(cat <<'EOF'
dungeon-app: broadcast read-only to every client, guard every action handler (#109)

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 7: Localization strings

**Files:**
- Modify: `lang/en.json`

**Interfaces:** none (leaf task).

- [ ] **Step 1: Add the two new keys**

In `lang/en.json`, immediately after the existing `"DOMMT.Dungeon.GmOnlyWarning"` line (line 81), add:

```json
  "DOMMT.Dungeon.AlreadyHostedWarning": "A dungeon crawl is already in progress, hosted by {host}.",
  "DOMMT.Dungeon.ReadOnlyHint": "{host} is running this crawl — you're viewing read-only.",
```

- [ ] **Step 2: Validate the JSON parses**

Run: `node -e "JSON.parse(require('fs').readFileSync('lang/en.json', 'utf8')); console.log('ok')"`
Expected: `ok`

- [ ] **Step 3: Commit**

```bash
git add lang/en.json
git commit -m "$(cat <<'EOF'
Add lang strings for GM-less dungeon crawl (#109)

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 8: Version bump, live verification, PR, merge

**Files:**
- Modify: `module.json` (version bump)

- [ ] **Step 1: Bump the version**

Read `module.json`'s current `"version"` field, bump the patch number, and update it (project rule: every merged commit needs a version bump in the same commit as the change — this is that commit, at the end of the branch).

```bash
git add module.json
git commit -m "$(cat <<'EOF'
Bump version for #109 (GM-less dungeon crawl)

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

- [ ] **Step 2: Run the full test suite one more time**

Run: `npx vitest run`
Expected: PASS, full suite green.

- [ ] **Step 3: Push and open the PR**

```bash
git push -u origin <branch-name>
gh pr create --title "Allow GM-less dungeon crawl start/run (#109)" --body "$(cat <<'EOF'
## Summary
- Non-GM host can start and run a full dungeon crawl with no GM logged in
- Broadcasts the tracker read-only to every other connected client
- Skips the combat encounter preview in this mode (auto-accepts)
- Grants Foundry's own SETTINGS_MODIFY permission to Player/Trusted roles during setup — required for the write to succeed at all, independent of this module's own gating

Closes #109

## Test plan
- [ ] `npx vitest run` passes
- [ ] Live multi-client verification via foundry-rest (see below) passes
EOF
)"
```

- [ ] **Step 4: Live multi-client verification (required before merge — do not skip)**

This needs a second real browser session logged in as a non-GM player, with the relay's module connected under that session too (the single relay connection used throughout this plan's research was always the GM's own browser). Ask the user to open a second browser (or profile) and log in as one of the world's Player/Trusted accounts, with the relay active there, before continuing. Once `curl -s "$FOUNDRY_BASE_URL/clients"` lists a second online client:

1. As the non-GM client: with the GM logged out (or, if that's not practical to arrange live, temporarily set the GM user's role away from Gamemaster for this check only, then back), run the "DOMMT: Dungeon Crawl" macro. Confirm it opens with the setup dialog rather than warning GM-only.
2. Start a run. Confirm the second client's `DungeonApp` opens automatically, read-only (controls disabled except Hide, read-only hint visible).
3. Resolve a room from the host's client. Confirm the read-only client's view updates to match.
4. Log the GM back in (restore their role if it was changed). Confirm the host's next action attempt no-ops (per `canActOnDungeon`'s "GM regains exclusive control" rule) and their view flips read-only on next render.
5. Confirm a combat room's encounter preview was skipped during the GM-less portion (check chat log / that no Accept/Reroll dialog blocked progress).

Record the outcome. If anything fails, fix it and re-verify — do not merge on a partial pass.

- [ ] **Step 5: Merge**

Per project rule (`CLAUDE.md`): this PR requires the live verification above before auto-merging. Once it passes:

```bash
gh pr merge --squash
```
