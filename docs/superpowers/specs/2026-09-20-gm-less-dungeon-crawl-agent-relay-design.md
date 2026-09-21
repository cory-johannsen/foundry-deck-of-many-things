# GM-less dungeon crawl start/run — agent-relay design

**Tracks:** [#109](https://github.com/cory-johannsen/foundry-deck-of-many-things/issues/109)

**Supersedes:** [2026-09-20-gm-less-dungeon-crawl-design.md](2026-09-20-gm-less-dungeon-crawl-design.md) (archived — its core mechanism doesn't work; see its archive notice for why).

**Depends on (already shipped, unaffected):** [#94](https://github.com/cory-johannsen/foundry-deck-of-many-things/issues/94)'s agent-bridge combat AI and #136's trap-customization bridge both already gate on plain `isGM` and need no changes — they're satisfied automatically whenever the executing client is genuinely a GM, which this design guarantees.

## Why the previous design failed

Foundry requires role ≥ Assistant Gamemaster to create, update, or delete a `Scene` document (confirmed against Foundry 13.351's own source: no `SCENE_CREATE` exists in the grantable `USER_PERMISSIONS` list — Scene's document-level role requirement isn't configurable the way named permissions like `SETTINGS_MODIFY` are). `isGM` is *defined* as that same role check. So any client that could ever pass Scene's permission check already satisfies every `isGM` gate in this codebase — there is no permission a non-GM user can be granted that makes them "act like a GM but not be one." `#onStart`'s very first real step, `createDungeonScene()`, was therefore unreachable for a non-GM host no matter what this module's own code did.

## Premise for this design

A user named "Agent," with genuine Gamemaster-role Foundry credentials, can be logged into a browser session whenever no human GM is present, exactly like a second GM. This is an operational fact the module's code assumes and does not need to detect, verify, or arrange — the same way `tools/agent-loop/poll.mjs` already assumes a relay-connected client exists and simply does nothing useful if one doesn't. **Exactly one GM-role client is assumed connected at a time** (the human GM, or Agent — not both simultaneously). This matches every existing `isGM`-gated hook in this codebase, none of which has ever needed to handle two GMs online at once, and is stated here as an explicit operational rule rather than something built in code: don't log Agent in alongside an active human GM session.

## Mechanism

A non-GM client never mutates dungeon-run state directly. Every mutating `DungeonApp` action branches on `game.user.isGM`:

- **GM caller** (human GM, or Agent's own session): call the existing function directly. Zero change from today's behavior.
- **Non-GM caller:** emit a request over `game.socket`. Every connected client receives it; only the one satisfying `game.user.isGM` acts on it, calling the *exact same* underlying function the GM's own button click would call. The result reaches every client (including the requester) through the normal `dungeonRuns`-setting `updateSetting` broadcast — no response payload carries the actual game-state change, only enough to end a "waiting" spinner or report a timeout.

This is the mirror image of a pattern already in this codebase: `scripts/player-choice.mjs`'s `askPlayer`/`registerChoiceSocket` already prompts a specific player from the GM's client and routes the answer back over `game.socket`. Here the roles are reversed (a non-GM client asks whichever client is GM to act), but the shape — emit, listen, single responder, timeout on no answer — is the same.

## New file: `scripts/dungeon-remote.mjs`

```js
export const SOCKET = "module.deck-of-many-more-things"; // same channel player-choice.mjs uses is fine to share, or a second channel — decide in planning
const DEFAULT_TIMEOUT_MS = 15_000;
const pending = new Map();

/** Non-GM side: ask whichever client is GM to run `actionName` with `args`,
 * and wait for it to actually happen (the resulting broadcast) or time out.
 * `requestingUserId` travels in the envelope explicitly — game.socket does
 * not stamp a sender's identity onto relayed messages on its own, and the
 * GM-side handler needs it (e.g. to set `hostUserId` to the REQUESTER, not
 * to whichever client — Agent's or a human GM's — ends up executing it). */
export function requestDungeonAction(actionName, args, { timeoutMs = DEFAULT_TIMEOUT_MS } = {}) { ... }

/** Registered on every client. Only a GM client acts; every client (GM or
 * not) can receive the ack. */
export function registerDungeonActionSocket() {
  game.socket.on(SOCKET_OR_SUBCHANNEL, async (msg) => {
    if (msg?.type !== "dungeon-action-request") return;
    if (!game.user.isGM) return; // exactly one GM client assumed connected — see premise above
    const result = await DUNGEON_ACTIONS[msg.actionName]?.(msg.args);
    game.socket.emit(..., { type: "dungeon-action-ack", id: msg.id, ok: !!result, error: result?.error });
  });
}
```

The exact request/ack envelope, the allow-listed `DUNGEON_ACTIONS` table (one entry per routable action — `startRun`, `succeedRoom`, `failRoom`, `populateNext`, `undoRoomEntry`, `abandonRun`, `declareVictory`, `declareDefeat`, `startCombatRecovery`, `attemptSkillChallenge`, `continueNarrative`), and whether this shares `player-choice.mjs`'s socket channel (with a `type` discriminator) or opens a second one, are planning-level decisions, not spec-level ones — the shape above is what the plan implements against.

**Idempotency, not locking.** No claim/lock mechanism is built for two GM clients racing on the same request, per the "exactly one GM client" premise above. Where the underlying functions already guard against double-invocation (`markRoomOutcome`'s "already in this room's history" check, documented in `dungeon-runner.mjs`'s own #152 comment), that protection is inherited for free. `createRun`/`createDungeonScene` are the one action that isn't naturally idempotent (two responses would create two scenes) — not a new problem this design introduces, since it's prevented by the same one-GM-at-a-time premise, not by new code.

## Data model (unchanged from the archived spec)

`hostUserId` on the per-scene run state (`dungeon-runner.mjs`) and `findActiveHostedRun` — same shape, repurposed meaning: not "who's been granted elevated permission," but "whose request is driving this run, and whose `DungeonApp` window should be interactive while everyone else's is read-only."

## `openDungeon()` (`module.mjs`)

No more GM-required refusal. Any user may open the tracker:

| Caller | Existing run? | Result |
|---|---|---|
| GM | — | Unchanged: renders normally (interactive, whatever run exists or the setup form). |
| Non-GM | None, or one this user already "hosts" (`hostUserId` matches) | Renders — the setup form for a fresh run, or their own run's current state, interactive. |
| Non-GM | Active run, different `hostUserId` | Warning naming the current host (same collision message as the archived design), no render. |

A non-GM opening a normal GM-run game (`hostUserId: null`, started by an actual GM) now also renders — read-only, since `interactive` is `game.user.isGM || run.hostUserId === game.user.id`, and no non-GM can ever match a null `hostUserId`. This is a deliberate, accepted side effect of removing the outright refusal (a harmless "watch the GM's game" capability), not a new feature being built.

## `#onStart` (`dungeon-app.mjs`)

The room-count/traits/exclude-traits form itself needs no permission to render or fill in — it mutates nothing. On submit:

- **GM:** unchanged — `createDungeonScene()`, `createRun()` (with `hostUserId: null`), build/populate/unlock/activate, exactly as today.
- **Non-GM:** `requestDungeonAction("startRun", { roomCount, traits, excludeTraits, previousSceneId })`. The GM-side handler runs the identical sequence, with `hostUserId: game.user.id` read from the *request's* originating user, not from whichever client executes it (Agent's own `game.user.id` must never end up as the host).

## Every other mutating handler (`dungeon-app.mjs`)

Same branch, same shape, for `#onSucceed`, `#onFail`, `#onPopulateNext`, `#onUndo`, `#onAbandon`, `#resolveCombatRoom` (covers Declare Victory/Defeat), `#onStartCombatRecovery`, `#onAttemptSkillChallenge`, `#onContinueNarrative`:

```js
static async #onSucceed() {
  const sceneId = canvas?.scene?.id;
  if (!sceneId) return;
  if (game.user.isGM) await resolveCurrentRoom(true);
  else await requestDungeonAction("succeedRoom", { sceneId });
  this.render();
}
```

`resolveCurrentRoom`'s existing `{ scene }` override parameter is exactly what the GM-side handler needs to act on the request's `sceneId` rather than its own `canvas.scene` (which may be showing something else entirely — Agent's own session has no reason to be looking at this particular dungeon scene).

## Broadcast / read-only rendering (`dungeon-app.mjs`, `module.mjs`) — unchanged from the archived design

Every non-host, non-GM client auto-opens (or re-renders) its own local `DungeonApp` read-only whenever `findActiveHostedRun()` returns a run, driven by the same `updateSetting`/`canvasReady` hooks and `interactive` flag the archived design already specified. `interactive` simplifies to `game.user.isGM || run.hostUserId === game.user.id` — the archived design's `!activeGM` clause is dropped entirely, since there's no "GM might connect and should regain exclusive control" scenario to guard against under the one-GM-at-a-time premise (if a human GM logs in, Agent should log out first, per the premise — not something this code arbitrates).

## Combat encounter preview (`encounter-generator.mjs`) — unchanged from the archived design

Still auto-accepted (skip `showEncounterPreview`) whenever the active run's `hostUserId` is set, computed from `getRunState(canvas.scene.id)` exactly as before. Still necessary: even though the code now genuinely runs on a GM-privileged client, nobody is watching that client's screen to click Accept/Reroll when it's Agent's unattended session.

## What needs NO changes at all (confirmed against the current codebase)

- `scripts/dungeon-combat.mjs`'s `autoResolveIfDecided`/`autoPlayCombatantTurnIfDue` guards — already plain `isGM`, already satisfied by Agent.
- `scripts/dungeon-scene.mjs`'s `handleDungeonDoorOpened` — already plain `isGM`, already satisfied by Agent. (This was a real bug — C1 — under the archived design, where the acting client genuinely wasn't a GM; it isn't one here.)
- `module.mjs`'s agent-bridge (`getPendingAgentTurn`/`applyAgentDecision`/heartbeat/status) and trap-customization (`getPendingTrapCustomization`/`applyTrapCustomization`) API entries — already plain `isGM`, already satisfied by Agent, and already reachable by `tools/agent-loop/poll.mjs` via the relay against whichever client is online.
- Any `SETTINGS_MODIFY` or other Foundry permission grant — not needed; nothing outside this module's own code enforcement changes.
- Party members physically opening a reveal door — already works today (`WALL_DOORS` is already granted to every role in this world), unaffected by any of this.

## Error handling

- Non-GM starts a crawl while a different host's run is active → warning naming the host, no state change (same as before).
- A routed request with no GM client listening → `requestDungeonAction`'s timeout fires (mirroring `player-choice.mjs`'s `askPlayer` timeout pattern), surfaces a "no GM available" warning to the requester, and the UI stays exactly as it was (no optimistic local update to roll back, since nothing was applied locally in the first place).
- Normal GM-run games are entirely unaffected: `hostUserId` stays `null`, every handler's `game.user.isGM` branch is `true` on the GM's own client exactly as today, and the socket listener never has anything routed to it.

## Testing

- Unit-level: whatever pure logic this introduces (the `DUNGEON_ACTIONS` dispatch table is a plain lookup, not really independent business logic — likely nothing new needs dedicated unit tests beyond what `dungeon-runner.mjs`'s `hostUserId`/`findActiveHostedRun` already have from the archived branch's Task 2, which carries forward unchanged).
- Live verification (required before merge, per project rule): two browser sessions — one logged in as a Trusted-role player with no GM connected except a separately-logged-in "Agent" session, confirming a full crawl (start → room resolution → combat → completion) runs end-to-end through the relay, confirming a second player's read-only broadcast view, and confirming the timeout path when Agent's session is closed mid-request.
