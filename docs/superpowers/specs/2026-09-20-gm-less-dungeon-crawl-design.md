> **ARCHIVED — superseded by [2026-09-20-gm-less-dungeon-crawl-agent-relay-design.md](2026-09-20-gm-less-dungeon-crawl-agent-relay-design.md).**
>
> This design's core mechanism (relax `isGM` checks + grant Foundry's `SETTINGS_MODIFY` permission so a non-GM host can act directly) does not work: Foundry requires role ≥ Assistant Gamemaster to create/update/delete `Scene` documents (and to spawn Actors/Tokens for encounters), and `isGM` is *defined* as that same role check — so any client that could pass those document-permission checks already satisfies every `isGM` gate in the codebase. `SETTINGS_MODIFY` alone (which this spec verified live and got right) covers world-*settings* writes only, not documents, and there is no equivalent grantable permission for Scene creation. Caught by the final whole-branch review on the implementation branch (`worktree-issue-109-gm-less-dungeon-crawl`), before merge. Kept here for history — the permission research in this file (the `SETTINGS_MODIFY`/`game.permissions` findings, the `Setting` document schema findings) is still accurate and still useful background, just insufficient on its own.

# GM-less dungeon crawl start/run — design (ARCHIVED)

**Tracks:** [#109](https://github.com/cory-johannsen/foundry-deck-of-many-things/issues/109)

**Depends on (already shipped, unaffected):** [#94](https://github.com/cory-johannsen/foundry-deck-of-many-things/issues/94)'s agent-bridge combat AI (candidate/decision loop + heuristic timeout fallback) keeps working exactly as today; the only change here is *who* is allowed to call its API surface.

**Explicitly out of scope:** dynamic puzzle/trap generation. #94 already split that out as unfiled follow-up scope; #109 doesn't touch it — narrative/puzzle/trap rooms keep drawing from the existing static setpiece pool, with the human "was this solved?" call made by the crawl's host player instead of a GM (see Room dialogs below).

## Problem

The dungeon crawl (`DungeonApp`, `scripts/module.mjs`'s `openDungeon()`) only starts and only ever renders on whichever client is logged in as GM — a single `if (!game.user.isGM) return warn(...)` gate on entry, and a purely local `ApplicationV2` instance with no cross-client broadcast once open. If no GM is logged in, nobody can run a crawl at all.

## Goal

Let a player start and run a full crawl with no GM client present: the initial setup dialog (room count, traits) works unchanged for whoever ran the macro; every other GM-only decision point in the flow either transfers to that player (room resolution) or is skipped in favor of automatic acceptance (combat encounter preview); every other connected player sees the crawl's state live, read-only.

## Permission prerequisite (verified live)

Relaxing our own `isGM` checks is not sufficient by itself: Foundry enforces its own server-side permission on `game.settings.set()` for `scope: "world"` settings, independent of anything this module's code decides. It requires the connecting user to hold Foundry's `SETTINGS_MODIFY` permission (`CONST.USER_PERMISSIONS.SETTINGS_MODIFY`), which is a per-role grant configured in `game.permissions` (Foundry's "Configure Permissions" menu). Confirmed live against the project's world: `SETTINGS_MODIFY` is currently granted only to roles `[3, 4]` (Assistant GM, Gamemaster) — every actual player account is role `2` (Trusted) and cannot write world settings today. `Setting` documents also have no `ownership` field (confirmed from `foundry.documents.BaseSetting`'s schema: `_id, key, value, user, _stats`), so a per-document ownership override — the alternative considered — isn't available for this document type.

The fix: the module's existing GM-gated `ready`-hook setup (`Hooks.once("ready")` in `module.mjs`, which already runs `ensureWorldMacros`/`ensureDivinationScene` only `if (game.user.isGM)`) also idempotently merges roles `PLAYER` (1) and `TRUSTED` (2) into `game.permissions.SETTINGS_MODIFY`, preserving whatever roles are already granted rather than overwriting them. This runs automatically the next time a GM logs in — no manual "Configure Permissions" step for the user. Everything else in this design (the `canActOnDungeon` checks, `hostUserId` tracking) remains the actual authorization layer on top of this baseline Foundry permission; granting `SETTINGS_MODIFY` only makes the write *possible*, not unconditional.

## Data model

`dungeonRuns` world-setting entry (`scripts/dungeon-runner.mjs`) gains one field, alongside the existing `previousSceneId`:

```js
{
  // ...existing fields...
  hostUserId: string | null,   // set once, when a non-GM starts a run with no GM active
}
```

`hostUserId` is the only new persisted state. It is not a "mode flag" — its mere presence on the active run *is* "this run is in GM-less mode." It is never cleared or reassigned while the run is active, even if a GM later logs in (see Edge cases). It's cleared (reset to `null`) when the run ends (victory/defeat/abandon/reset) or a new run starts.

## Gating

New helper, `scripts/dungeon-permissions.mjs`:

```js
export function canActOnDungeon(run) {
  if (game.user.isGM) return true;
  const activeGM = game.users.some(u => u.isGM && u.active);
  return !activeGM && run?.hostUserId === game.user.id;
}
```

Every existing bare `if (!game.user.isGM)` guard on a per-run action is replaced with a `canActOnDungeon(run)` check:

- `scripts/module.mjs`: `resetDungeon`, `getPendingAgentTurn`, `applyAgentDecision`, `recordAgentLoopHeartbeat`, `getAgentLoopStatus`, `postAgentLoopStatus`.
- `scripts/dungeon-combat.mjs`: the `updateCombat`/combat-resolution hook guards (currently ~lines 259, 1250).
- `scripts/encounter-generator.mjs`: `generateEncounter`.

**Not changed:** the `ready`-hook macro/scene installation block in `module.mjs` (`if (game.user.isGM)`) — one-time world setup, unrelated to per-run gating. Other module surfaces (deck admin, divination) are untouched; this only relaxes crawl-run actions, per the agreed trust model that any connected player can be trusted with what #109 is explicitly asking for.

### `openDungeon()` — special-cased entry point

There's no existing run to check permissions against yet, so this gets its own branching instead of a plain `canActOnDungeon` call:

| Caller | Active GM? | Existing run? | Result |
|---|---|---|---|
| GM | — | — | Unchanged: always allowed. |
| Non-GM | Yes | — | Unchanged: "GM required" warning. |
| Non-GM | No | None, or one this user already hosts | Allowed. Sets `hostUserId = game.user.id` on the run if not already set. |
| Non-GM | No | Active run, different `hostUserId` | Warning naming the current host; no state change. |

## Broadcast: making `DungeonApp` visible to everyone

`DungeonApp` (`scripts/ui/dungeon-app.mjs`) stays a local `ApplicationV2` — no new networked widget type. What's new is that every client gets its own instance driven by shared state, instead of only the caller's client ever constructing one.

- Register `Hooks.on('updateSetting', ...)` filtered to the module's `dungeonRuns` key (Foundry already broadcasts world-setting changes to every client for free).
- When that fires and the run is active with `hostUserId` set: every client other than the host auto-opens (or re-renders, if already open) its own local `DungeonApp` instance mirroring the shared run state, in **read-only** mode.
- `DungeonApp` gains an `interactive` flag computed per client via `canActOnDungeon(run)`. When false, every action control (Succeed/Fail/Populate Next/Declare Victory/Declare Defeat/Abandon/etc.) renders **disabled**, not hidden — read-only viewers see full live state, just can't act.
- The disabled button is only a UI nicety, not the actual enforcement: `DungeonApp`'s action handlers call `dungeon-runner.mjs`/`dungeon-scene.mjs` functions directly, bypassing `module.api` entirely. Each mutating handler (Start excepted, which is already gated by `openDungeon()`'s own entry check) re-checks `canActOnDungeon(getRunState(sceneId))` itself at the moment of the click and no-ops if it fails. This is what actually stops a read-only viewer who bypasses the disabled button, and what actually revokes the host's own access the instant a GM connects (see Edge cases below) — it isn't just cosmetic.
- The host's own client is unaffected by this hook — it already has its own interactive instance open from calling the macro.
- When the run ends (`hostUserId` cleared / status leaves `active`), the same hook closes any auto-opened read-only instances on other clients.
- Host disconnect/reconnect needs no special handling: `hostUserId` is compared by user id, not session, so interactive control returns automatically to that same player when they reconnect. If they never return and no GM logs in, the run stays frozen read-only for everyone — no host-reassignment logic exists or is planned.

### Edge case: a GM logs in mid-run

Not specially handled beyond what `canActOnDungeon` already does. `hostUserId` is left untouched, but per the agreed detection rule ("a GM logging in mid-run immediately regains exclusive control"), `canActOnDungeon` requires *no* active GM for the host branch — so the instant any GM is active, the host's own further actions are rejected too, not just other players'. The host's window doesn't repaint itself just because a GM's connection state changed elsewhere (no `dungeonRuns` update fires for that), so it can briefly look interactive when it no longer is; the action handlers re-check `canActOnDungeon` at the moment of the click (see Room dialogs below) and simply no-op instead of mutating, re-rendering the host's own view into read-only at that point. The GM is not auto-opened; if they want to see or run the crawl themselves they open it via the macro like normal.

## Room dialogs (narrative / puzzle / trap)

No new dialog classes. `DungeonApp`'s existing single-template rendering (`_prepareContext`, `dungeon-tracker.hbs`) already covers these room kinds. The only change is the broadcast + `interactive` gating described above: the host sees and clicks Succeed/Fail exactly as a GM would today (this is the human judgment call the issue's "automatically determined" language does *not* apply to — resolving a room is reassigned to the host, not automated); everyone else watches read-only.

## Combat encounter preview

`generateEncounter()` (`scripts/encounter-generator.mjs`) gains a `skipPreview` parameter, alongside the existing `skipThemeDialog`. Every caller computes it as `Boolean(run?.hostUserId)` — true for the entire duration of any GM-less run, applied uniformly to every encounter roster generated during that run (room-population and any other path alike). When true, `showEncounterPreview`'s Accept/Reroll/Cancel `DialogV2.wait` is skipped entirely and the first dealt roster is used directly.

Agent-controlled combat turns (#94) are unaffected beyond the gating change already covered above — `tools/agent-loop/poll.mjs` keeps working whether the browser session it's driving belongs to a GM or a GM-less host.

## Error handling

- Second non-GM player starting a crawl while a different host's run is active → warning naming the current host (see `openDungeon()` table above), no state change.
- A read-only viewer's disabled controls never reach the server; each action handler's own `canActOnDungeon` re-check (see Broadcast section above) is what actually rejects it if a disabled control were somehow bypassed, not a `module.api` layer.
- Normal GM-run games are entirely unaffected: `hostUserId` stays `null`, `canActOnDungeon` reduces to today's plain `isGM` check, the `updateSetting` broadcast hook never triggers an auto-open.

## Testing

- Unit-level: `canActOnDungeon` (GM; host with no GM active; host with a GM active; neither host nor GM) and `openDungeon()`'s branching table above, alongside whatever existing coverage `dungeon-runner.mjs`/`module.mjs` already have.
- Live verification required before merge (per project rule: session/UI-mechanics changes need real multi-client testing, not just unit tests) via the `foundry-rest` skill: two-plus browser sessions — a non-GM starting a crawl with no GM logged in, confirming read-only broadcast to a second player's client, confirming disabled controls on the read-only side, and confirming a GM logging in mid-run can take over without breaking the host's own session.
