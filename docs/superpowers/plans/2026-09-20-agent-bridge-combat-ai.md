# Agent-Controlled Combat AI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let an external decision-maker (Claude API v1, Laya later) control an agent-flagged combatant's full 3-action PF2e turn (Strikes at correctly-increasing MAP, posture-based movement) instead of ITEM-8's fixed heuristic, via a self-hosted `foundry-rest` relay and a polling script — with every actual game mutation staying inside this module's own existing helpers.

**Architecture:** A small in-module change (`dungeon-combat.mjs`/`module.mjs`) adds an `agentControlled` flag, a per-action timeout/fallback to the existing heuristic, and two new `module.api` methods (`getPendingAgentTurn`/`applyAgentDecision`) that are the *only* way an external process can read or mutate agent-controlled turn state. A new pure module (`scripts/agent-candidates.mjs`) builds the candidate-action list and per-turn state transitions with no Foundry dependency, so it's directly unit-tested. A new external tool (`tools/agent-loop/`) polls the two API methods via a self-hosted `foundryvtt-rest-api-relay` and asks a pluggable provider (Claude v1) which candidate to take.

**Tech Stack:** Vitest (existing), Node.js native `fetch` (no new HTTP dependency), the existing `foundry-rest` relay protocol (`POST {BASE}/execute-js?clientId=...`), Anthropic Messages API with tool-use for structured decisions.

**Spec:** `docs/superpowers/specs/2026-09-20-agent-bridge-combat-ai-design.md`

## Global Constraints

- Never let the external poller run arbitrary script content in Foundry — it only ever calls `module.api.getPendingAgentTurn()` and `module.api.applyAgentDecision(combatId, combatantId, candidateId)`. No other Foundry mutation path is exposed to it.
- v1 scope is Strikes + Stride only — no spellcasting/non-strike actions (#101), no real pathfinding (#100), no hazard-tile detection (#103), no Laya adapter (#102, blocked).
- Party combatants never get `agentControlled` — reuse the existing `partyActorIds()` split (ITEM-8's reopening), never Foundry's `hasPlayerOwner`.
- A `foundry-rest`-bound script must never contain: `globalThis`, `import(`, `eval(`, `new Function`, `XMLHttpRequest`, `game.settings.set`, `apiKey`, `password`, `localStorage`, `sessionStorage` — the relay scans raw text and refuses the whole call if any appear, even inside a comment or string.
- Every merged commit bumps `module.json`'s version (patch for this — it's additive, not a breaking change to existing dungeon-crawl behavior).
- Foundry-API-touching code in `dungeon-combat.mjs`/`module.mjs` gets no unit tests (same established precedent as the rest of that file) — live-verify via `foundry-rest` instead, entirely against scratch actors/scenes/combats, never a real run.

---

## Task 1: Pure candidate-enumeration module

**Files:**
- Create: `scripts/agent-candidates.mjs`
- Test: `tests/agent-candidates.test.mjs`

**Interfaces:**
- Produces (consumed by Task 3): `initAgentTurnState()`, `buildCandidateList({ opponents, readyActions, turnState, hazard, hasRangedOrReach })`, `applyCandidateToTurnState(turnState, candidate)`, `buildDecisionContext({ self, opponents, candidates, roundNumber })`, constants `MAX_ACTIONS_PER_TURN`, `AGENT_MELEE_REACH_SQUARES`.

- [ ] **Step 1: Create the feature branch**

This project ships every change through a feature branch → PR → merge, never a direct commit to `main` (see Task 9). Create it now so every task's commits land here:
```bash
git checkout -b feat/agent-bridge-combat-ai
```

- [ ] **Step 2: Write the failing test file**

```js
// tests/agent-candidates.test.mjs
import { describe, it, expect } from 'vitest';
import {
  initAgentTurnState, buildMovementCandidates, buildStrikeCandidates, endTurnCandidate,
  buildCandidateList, applyCandidateToTurnState, buildDecisionContext,
  MAX_ACTIONS_PER_TURN, AGENT_MELEE_REACH_SQUARES
} from '../scripts/agent-candidates.mjs';

describe('initAgentTurnState', () => {
  it('starts with a full action budget and no MAP penalty', () => {
    expect(initAgentTurnState()).toEqual({ actionsRemaining: MAX_ACTIONS_PER_TURN, mapIncrement: 0 });
  });
});

describe('buildMovementCandidates', () => {
  const opponentFar = { id: 'opp1', name: 'Fighter', distanceSquares: 3 };
  const opponentAdjacent = { id: 'opp2', name: 'Cleric', distanceSquares: 1 };

  it('offers approach for an opponent beyond melee reach', () => {
    const candidates = buildMovementCandidates({ opponents: [opponentFar], hazard: null, hasRangedOrReach: false });
    expect(candidates).toEqual([
      { id: 'stride:approach:opp1', type: 'stride', posture: 'approach', targetId: 'opp1', cost: 1, summary: 'Move toward Fighter' }
    ]);
  });

  it('does not offer approach for an opponent already at melee reach', () => {
    const candidates = buildMovementCandidates({ opponents: [opponentAdjacent], hazard: null, hasRangedOrReach: false });
    expect(candidates).toEqual([]);
  });

  it('offers retreat for a nearby opponent only when the combatant has ranged/reach', () => {
    const withoutRanged = buildMovementCandidates({ opponents: [opponentAdjacent], hazard: null, hasRangedOrReach: false });
    expect(withoutRanged).toEqual([]);

    const withRanged = buildMovementCandidates({ opponents: [opponentAdjacent], hazard: null, hasRangedOrReach: true });
    expect(withRanged).toEqual([
      { id: 'stride:retreat:opp2', type: 'stride', posture: 'retreat', targetId: 'opp2', cost: 1, summary: 'Move away from Cleric' }
    ]);
  });

  it('does not offer retreat for an opponent already far away, even with ranged/reach', () => {
    const candidates = buildMovementCandidates({ opponents: [opponentFar], hazard: null, hasRangedOrReach: true });
    expect(candidates).toEqual([
      { id: 'stride:approach:opp1', type: 'stride', posture: 'approach', targetId: 'opp1', cost: 1, summary: 'Move toward Fighter' }
    ]);
  });

  it('offers reposition when a hazard is within 1 square, and not otherwise', () => {
    const near = buildMovementCandidates({ opponents: [], hazard: { distanceSquares: 1 }, hasRangedOrReach: false });
    expect(near).toEqual([
      { id: 'stride:reposition', type: 'stride', posture: 'reposition', targetId: null, cost: 1, summary: 'Move away from the nearby hazard' }
    ]);

    const far = buildMovementCandidates({ opponents: [], hazard: { distanceSquares: 2 }, hasRangedOrReach: false });
    expect(far).toEqual([]);

    const none = buildMovementCandidates({ opponents: [], hazard: null, hasRangedOrReach: false });
    expect(none).toEqual([]);
  });
});

describe('buildStrikeCandidates', () => {
  const claw = { slug: 'claw', label: 'Claw', variantCount: 3, reachSquares: AGENT_MELEE_REACH_SQUARES };
  const opponentAdjacent = { id: 'opp1', name: 'Fighter', distanceSquares: 1 };
  const opponentFar = { id: 'opp2', name: 'Cleric', distanceSquares: 3 };

  it('offers a strike against every opponent within reach, at the current MAP variant', () => {
    const candidates = buildStrikeCandidates({ readyActions: [claw], opponents: [opponentAdjacent, opponentFar], mapIncrement: 0 });
    expect(candidates).toEqual([
      { id: 'strike:claw:opp1', type: 'strike', actionSlug: 'claw', targetId: 'opp1', variantIndex: 0, cost: 1, summary: 'Claw vs Fighter (variant 0)' }
    ]);
  });

  it('clamps the variant index to the action\'s own variant count', () => {
    const candidates = buildStrikeCandidates({ readyActions: [claw], opponents: [opponentAdjacent], mapIncrement: 5 });
    expect(candidates[0].variantIndex).toBe(2); // claw.variantCount - 1
  });

  it('respects a reach greater than melee', () => {
    const tentacle = { slug: 'tentacle', label: 'Tentacle', variantCount: 3, reachSquares: 4 };
    const candidates = buildStrikeCandidates({ readyActions: [tentacle], opponents: [opponentFar], mapIncrement: 0 });
    expect(candidates).toEqual([
      { id: 'strike:tentacle:opp2', type: 'strike', actionSlug: 'tentacle', targetId: 'opp2', variantIndex: 0, cost: 1, summary: 'Tentacle vs Cleric (variant 0)' }
    ]);
  });
});

describe('endTurnCandidate', () => {
  it('is always the same zero-cost candidate', () => {
    expect(endTurnCandidate()).toEqual({ id: 'endTurn', type: 'endTurn', cost: 0, summary: 'End turn' });
  });
});

describe('buildCandidateList', () => {
  const claw = { slug: 'claw', label: 'Claw', variantCount: 3, reachSquares: AGENT_MELEE_REACH_SQUARES };
  const opponent = { id: 'opp1', name: 'Fighter', distanceSquares: 1 };

  it('combines movement, strike, and endTurn candidates when actions remain', () => {
    const turnState = { actionsRemaining: 3, mapIncrement: 0 };
    const candidates = buildCandidateList({ opponents: [opponent], readyActions: [claw], turnState, hazard: null, hasRangedOrReach: false });
    expect(candidates.map((c) => c.id)).toEqual(['strike:claw:opp1', 'endTurn']);
  });

  it('offers only endTurn once actions are exhausted', () => {
    const turnState = { actionsRemaining: 0, mapIncrement: 1 };
    const candidates = buildCandidateList({ opponents: [opponent], readyActions: [claw], turnState, hazard: null, hasRangedOrReach: false });
    expect(candidates).toEqual([endTurnCandidate()]);
  });
});

describe('applyCandidateToTurnState', () => {
  it('decrements actionsRemaining by the candidate\'s cost', () => {
    const next = applyCandidateToTurnState({ actionsRemaining: 3, mapIncrement: 0 }, { type: 'stride', cost: 1 });
    expect(next).toEqual({ actionsRemaining: 2, mapIncrement: 0 });
  });

  it('increments mapIncrement only for a strike', () => {
    const next = applyCandidateToTurnState({ actionsRemaining: 3, mapIncrement: 0 }, { type: 'strike', cost: 1 });
    expect(next).toEqual({ actionsRemaining: 2, mapIncrement: 1 });
  });

  it('zeroes actionsRemaining for endTurn regardless of what remained', () => {
    const next = applyCandidateToTurnState({ actionsRemaining: 2, mapIncrement: 1 }, { type: 'endTurn', cost: 0 });
    expect(next).toEqual({ actionsRemaining: 0, mapIncrement: 1 });
  });
});

describe('buildDecisionContext', () => {
  it('shapes self/opponents/candidates/roundNumber for a provider, trimming candidates to id+summary', () => {
    const context = buildDecisionContext({
      self: { name: 'Yamaraj', hp: 40 },
      opponents: [{ id: 'opp1', name: 'Fighter', distanceSquares: 1, hp: 30 }],
      candidates: [{ id: 'strike:claw:opp1', type: 'strike', actionSlug: 'claw', targetId: 'opp1', variantIndex: 0, cost: 1, summary: 'Claw vs Fighter (variant 0)' }],
      roundNumber: 2
    });
    expect(context).toEqual({
      self: { name: 'Yamaraj', hp: 40 },
      opponents: [{ id: 'opp1', name: 'Fighter', distanceSquares: 1, hp: 30 }],
      candidates: [{ id: 'strike:claw:opp1', summary: 'Claw vs Fighter (variant 0)' }],
      roundNumber: 2
    });
  });
});
```

- [ ] **Step 3: Run the test file to verify it fails**

Run: `npx vitest run tests/agent-candidates.test.mjs`
Expected: FAIL — `Cannot find module '../scripts/agent-candidates.mjs'`

- [ ] **Step 4: Write the implementation**

```js
// scripts/agent-candidates.mjs
/**
 * Pure combat-turn decision logic for agent-controlled combatants — no
 * Foundry API surface at all, so it's directly unit-testable with plain
 * objects. `dungeon-combat.mjs` is the only caller: it does every real
 * Combat/Actor/Token read (converting positions to `distanceSquares`, ready
 * actions to `{slug, label, variantCount, reachSquares}`, etc.) and owns
 * applying whichever candidate gets chosen back to the actual game — see
 * `docs/superpowers/specs/2026-09-20-agent-bridge-combat-ai-design.md`.
 */

export const MAX_ACTIONS_PER_TURN = 3;
export const AGENT_MELEE_REACH_SQUARES = 1;

/** Fresh per-turn bookkeeping — reset the instant an agent-controlled
 * combatant's turn becomes current. */
export function initAgentTurnState() {
  return { actionsRemaining: MAX_ACTIONS_PER_TURN, mapIncrement: 0 };
}

/**
 * Movement-posture candidates. `approach` is offered for every opponent
 * beyond melee reach; `retreat` only for an opponent already close (within
 * melee reach + 1) and only when this combatant has some ranged/reach
 * option (a pure melee brawler never wants to back off); `reposition` once,
 * only when a `hazard` is given and within 1 square.
 */
export function buildMovementCandidates({ opponents, hazard = null, hasRangedOrReach = false }) {
  const candidates = [];
  for (const opponent of opponents) {
    if (opponent.distanceSquares > AGENT_MELEE_REACH_SQUARES) {
      candidates.push({
        id: `stride:approach:${opponent.id}`, type: 'stride', posture: 'approach',
        targetId: opponent.id, cost: 1, summary: `Move toward ${opponent.name}`
      });
    } else if (hasRangedOrReach) {
      candidates.push({
        id: `stride:retreat:${opponent.id}`, type: 'stride', posture: 'retreat',
        targetId: opponent.id, cost: 1, summary: `Move away from ${opponent.name}`
      });
    }
  }
  if (hazard && hazard.distanceSquares <= 1) {
    candidates.push({
      id: 'stride:reposition', type: 'stride', posture: 'reposition',
      targetId: null, cost: 1, summary: 'Move away from the nearby hazard'
    });
  }
  return candidates;
}

/**
 * One candidate per ready action x each opponent currently within that
 * action's own reach, at the strike variant matching the turn's current
 * `mapIncrement` (clamped to the action's own variant count — a standard
 * PF2e strike always has exactly 3: no penalty, -4/-5, -8/-10, confirmed
 * live against a real bestiary actor during planning).
 */
export function buildStrikeCandidates({ readyActions, opponents, mapIncrement }) {
  const candidates = [];
  for (const action of readyActions) {
    const variantIndex = Math.min(mapIncrement, action.variantCount - 1);
    for (const opponent of opponents) {
      if (opponent.distanceSquares > action.reachSquares) continue;
      candidates.push({
        id: `strike:${action.slug}:${opponent.id}`, type: 'strike',
        actionSlug: action.slug, targetId: opponent.id, variantIndex, cost: 1,
        summary: `${action.label} vs ${opponent.name} (variant ${variantIndex})`
      });
    }
  }
  return candidates;
}

/** Always available — lets the agent stop spending actions early. */
export function endTurnCandidate() {
  return { id: 'endTurn', type: 'endTurn', cost: 0, summary: 'End turn' };
}

/** Full candidate list for one decision iteration. */
export function buildCandidateList({ opponents, readyActions, turnState, hazard = null, hasRangedOrReach = false }) {
  if (turnState.actionsRemaining <= 0) return [endTurnCandidate()];
  return [
    ...buildMovementCandidates({ opponents, hazard, hasRangedOrReach }),
    ...buildStrikeCandidates({ readyActions, opponents, mapIncrement: turnState.mapIncrement }),
    endTurnCandidate()
  ];
}

/** New turn state after applying `candidate` — a pure transition, no side effects. */
export function applyCandidateToTurnState(turnState, candidate) {
  if (candidate.type === 'endTurn') return { ...turnState, actionsRemaining: 0 };
  const mapIncrement = candidate.type === 'strike' ? turnState.mapIncrement + 1 : turnState.mapIncrement;
  return { actionsRemaining: turnState.actionsRemaining - candidate.cost, mapIncrement };
}

/** The JSON context handed to a decision provider alongside its candidates
 * — candidates are trimmed to `{id, summary}` since a provider only ever
 * needs to pick an id, never the caller-side execution details. */
export function buildDecisionContext({ self, opponents, candidates, roundNumber }) {
  return { self, opponents, candidates: candidates.map(({ id, summary }) => ({ id, summary })), roundNumber };
}
```

- [ ] **Step 5: Run the test file to verify it passes**

Run: `npx vitest run tests/agent-candidates.test.mjs`
Expected: PASS, all tests green

- [ ] **Step 6: Run the full suite to confirm nothing else broke**

Run: `npm test`
Expected: all existing tests still pass, plus the new file

- [ ] **Step 7: Commit**

```bash
git add scripts/agent-candidates.mjs tests/agent-candidates.test.mjs
git commit -m "Add pure candidate-enumeration logic for agent-controlled combat turns"
```

---

## Task 2: Flag combatants agent-controlled by default, factor out the heuristic, add timeout/fallback

**Files:**
- Modify: `scripts/dungeon-combat.mjs`

**Interfaces:**
- Consumes: nothing new from other tasks.
- Produces (consumed by Task 3): `playHeuristicTurn(combat, combatant)`, exported `AGENT_TIMEOUT_MS` constant, `armAgentTimeout(combat, combatant)`.

- [ ] **Step 1: Read the current file to confirm line numbers before editing**

Run: `grep -n "^async function startCombat\|^export async function autoPlayCombatantTurnIfDue" scripts/dungeon-combat.mjs`

- [ ] **Step 2: Default new NPC combatants to agent-controlled**

Replace the body of `startCombat` (currently):
```js
async function startCombat(scene, flagKey, flagValue) {
  const tokens = combatantTokens(scene, flagKey, flagValue);
  if (!tokens.length) return null;
  const combat = await Combat.create({ scene: scene.id });
  await combat.setFlag(MODULE_ID, flagKey, flagValue);
  const combatants = await combat.createEmbeddedDocuments(
    'Combatant', tokens.map((t) => ({ tokenId: t.id, sceneId: scene.id }))
  );
  await combat.rollInitiative(combatants.map((c) => c.id), { skipDialog: true });
  await combat.startCombat();
  return combat;
}
```
with:
```js
/**
 * Every non-party combatant defaults to agent-controlled (flags.dommt.
 * agentControlled) the instant it's added to a Combat — a GM can disable it
 * per-combatant via the Combat Tracker's own context menu (module.mjs's
 * getCombatTrackerEntryContext hook). Party combatants never get the flag,
 * matching the partyActorIds() split ITEM-8's own reopening already uses.
 */
async function startCombat(scene, flagKey, flagValue) {
  const tokens = combatantTokens(scene, flagKey, flagValue);
  if (!tokens.length) return null;
  const combat = await Combat.create({ scene: scene.id });
  await combat.setFlag(MODULE_ID, flagKey, flagValue);
  const partyIds = partyActorIds();
  const combatants = await combat.createEmbeddedDocuments(
    'Combatant', tokens.map((t) => ({
      tokenId: t.id, sceneId: scene.id,
      ...(partyIds.has(t.actor?.id) ? {} : { flags: { [MODULE_ID]: { agentControlled: true } } })
    }))
  );
  await combat.rollInitiative(combatants.map((c) => c.id), { skipDialog: true });
  await combat.startCombat();
  return combat;
}
```

- [ ] **Step 3: Add a `toggleAgentControlled` helper, exported for module.mjs's context-menu hook**

Add this new function right after `startCombat` (before `export const startCombatForSlot = ...`):
```js
/** Flips a single combatant's agentControlled flag — the GM's per-combatant
 * override (module.mjs's Combat Tracker context-menu entry). A no-op guard
 * against toggling a real party member on by mistake, since one should
 * never have the flag in the first place. */
export async function toggleAgentControlled(combatant) {
  if (partyActorIds().has(combatant.actor?.id)) return;
  const current = combatant.getFlag(MODULE_ID, 'agentControlled') ?? false;
  await combatant.setFlag(MODULE_ID, 'agentControlled', !current);
}
```

- [ ] **Step 4: Factor the heuristic's turn-playing body into its own function**

Replace the body of `autoPlayCombatantTurnIfDue` (currently ends with the inline target/step/strike/nextTurn logic) — find:
```js
  await new Promise((resolve) => setTimeout(resolve, AUTO_PLAY_DELAY_MS));
  // Another client (or the combat auto-resolving mid-wait) may have already
  // moved things on — don't act on a stale turn.
  if (!game.combats.has(combat.id) || combat.combatant?.id !== combatant.id) return;

  const target = nearestOpponent(combat, combatant);
  if (target) {
    await stepToward(combat, combatant, target.combatant, target.distanceSquares);
    await rollAndApplyStrike(combatant, target.combatant);
  }

  if (game.combats.has(combat.id) && combat.combatant?.id === combatant.id) {
    await combat.nextTurn();
  }
}
```
and replace with:
```js
  await new Promise((resolve) => setTimeout(resolve, AUTO_PLAY_DELAY_MS));
  // Another client (or the combat auto-resolving mid-wait) may have already
  // moved things on — don't act on a stale turn.
  if (!game.combats.has(combat.id) || combat.combatant?.id !== combatant.id) return;
  await playHeuristicTurn(combat, combatant);
}

/** ITEM-8's original heuristic turn: move adjacent to the nearest opponent
 * if not already, strike once, apply the result, advance the turn — shared
 * by the non-agent-controlled path above and the agent-timeout fallback
 * below, so both use exactly the same behavior. */
async function playHeuristicTurn(combat, combatant) {
  const target = nearestOpponent(combat, combatant);
  if (target) {
    await stepToward(combat, combatant, target.combatant, target.distanceSquares);
    await rollAndApplyStrike(combatant, target.combatant);
  }
  if (game.combats.has(combat.id) && combat.combatant?.id === combatant.id) {
    await combat.nextTurn();
  }
}
```

- [ ] **Step 5: Add the agent-controlled branch and the timeout/fallback**

Replace the guard-and-defeated section of `autoPlayCombatantTurnIfDue`:
```js
export async function autoPlayCombatantTurnIfDue(combat) {
  if (!game.user.isGM || !isModuleCombat(combat)) return;
  const combatant = combat.combatant;
  if (!combatant || partyActorIds().has(combatant.actor?.id) || combatant.actor?.hasPlayerOwner) return;

  if (combatant.isDefeated) {
    await combat.nextTurn();
    return;
  }

  await new Promise((resolve) => setTimeout(resolve, AUTO_PLAY_DELAY_MS));
```
with:
```js
export async function autoPlayCombatantTurnIfDue(combat) {
  if (!game.user.isGM || !isModuleCombat(combat)) return;
  const combatant = combat.combatant;
  if (!combatant || partyActorIds().has(combatant.actor?.id) || combatant.actor?.hasPlayerOwner) return;

  if (combatant.isDefeated) {
    await combat.nextTurn();
    return;
  }

  if (combatant.getFlag(MODULE_ID, 'agentControlled')) {
    // Not awaited — arms a background timeout and returns immediately, same
    // fire-and-forget style module.mjs's own updateCombat hook already uses
    // to call this function. getPendingAgentTurn/applyAgentDecision (Task 3)
    // are the only things that act on this turn in the meantime.
    armAgentTimeout(combat, combatant);
    return;
  }

  await new Promise((resolve) => setTimeout(resolve, AUTO_PLAY_DELAY_MS));
```

- [ ] **Step 6: Add the timeout constant and `armAgentTimeout`**

Add near the top of the "ITEM-8" section, right after `const AUTO_PLAY_DELAY_MS = 700;`:
```js
// How long an agent-controlled combatant's turn waits for an external
// decision (via getPendingAgentTurn/applyAgentDecision, Task 3) before
// falling back to the heuristic for the rest of that turn — re-armed after
// every applied action, not just once per turn, so a poller that stalls
// mid-turn (rather than never starting at all) still recovers.
export const AGENT_TIMEOUT_MS = 45000;

/** Waits AGENT_TIMEOUT_MS, then — if nothing external acted on this exact
 * turn in the meantime — notifies the GM and finishes the turn with the
 * heuristic instead of leaving it stalled forever. */
export async function armAgentTimeout(combat, combatant) {
  await new Promise((resolve) => setTimeout(resolve, AGENT_TIMEOUT_MS));
  if (!game.combats.has(combat.id) || combat.combatant?.id !== combatant.id) return;
  ui.notifications.warn(
    game.i18n.format('DOMMT.Dungeon.Combat.AgentTimeoutWarning', { name: combatant.name })
  );
  const gmIds = ChatMessage.getWhisperRecipients('GM').map((u) => u.id);
  await ChatMessage.create({
    content: game.i18n.format('DOMMT.Dungeon.Combat.AgentTimeoutChat', { name: combatant.name }),
    whisper: gmIds
  });
  await playHeuristicTurn(combat, combatant);
}
```

- [ ] **Step 7: Run the full test suite — this task has no new unit tests, so this only confirms nothing broke**

Run: `npm test`
Expected: all existing tests pass unchanged (this file has no pure-function test surface, same precedent as the rest of it)

- [ ] **Step 8: Commit**

```bash
git add scripts/dungeon-combat.mjs
git commit -m "Default non-party combatants to agent-controlled, add per-turn timeout fallback"
```

---

## Task 3: `getPendingAgentTurn` / `applyAgentDecision`

**Files:**
- Modify: `scripts/dungeon-combat.mjs`

**Interfaces:**
- Consumes: `initAgentTurnState`, `buildCandidateList`, `applyCandidateToTurnState`, `buildDecisionContext` from `scripts/agent-candidates.mjs` (Task 1); `playHeuristicTurn`, `armAgentTimeout` from Task 2 (same file, already in scope).
- Produces (consumed by Task 4): `getPendingAgentTurn(combat)`, `applyAgentDecision(combat, combatantId, candidateId)`.

- [ ] **Step 1: Add the import**

At the top of `scripts/dungeon-combat.mjs`, add alongside the existing imports:
```js
import {
  initAgentTurnState, buildCandidateList, applyCandidateToTurnState, buildDecisionContext
} from './agent-candidates.mjs';
```

- [ ] **Step 2: Add turn-state read/write helpers and the reach/range computation**

Add these near `combatantOpponents`/`chebyshevSquares` (same section):
```js
/** Reach for one ready action, in squares — a `reach-N` trait (N in feet)
 * takes priority; otherwise a ranged action's own range increment (feet);
 * otherwise plain melee reach. Confirmed live during planning: a PF2e
 * strike's own `.traits` array carries entries like `{name: 'reach-20', ...}`,
 * and `.item.system.range` is `{increment, max}` in feet for a ranged
 * attack, `null` for melee. */
function actionReachSquares(action, gridDistanceFt) {
  const reachTrait = (action.traits ?? []).find((t) => /^reach-\d+$/.test(t.name ?? ''));
  if (reachTrait) return Number(reachTrait.name.split('-')[1]) / gridDistanceFt;
  const rangeIncrement = action.item?.system?.range?.increment;
  if (rangeIncrement) return rangeIncrement / gridDistanceFt;
  return MELEE_REACH_SQUARES;
}

/** Reads back Combat's own per-turn agent bookkeeping, or a fresh one if
 * this is the first time this exact combatant's turn is seen. */
function getAgentTurnState(combat, combatantId) {
  const stored = combat.getFlag(MODULE_ID, 'agentTurnState');
  if (stored?.combatantId === combatantId) return { actionsRemaining: stored.actionsRemaining, mapIncrement: stored.mapIncrement };
  return initAgentTurnState();
}

async function setAgentTurnState(combat, combatantId, turnState) {
  await combat.setFlag(MODULE_ID, 'agentTurnState', { combatantId, ...turnState });
}
```

- [ ] **Step 3: Add `getPendingAgentTurn`**

```js
/**
 * The current decision point for the due combatant, or `null` if there's
 * nothing for an external agent to decide right now (no combat due, the
 * current combatant isn't agent-controlled, or it's already defeated). The
 * *only* read surface `tools/agent-loop`'s poller uses — see module.mjs's
 * api.getPendingAgentTurn.
 */
export function getPendingAgentTurn(combat) {
  if (!isModuleCombat(combat)) return null;
  const combatant = combat.combatant;
  if (!combatant || combatant.isDefeated || !combatant.getFlag(MODULE_ID, 'agentControlled')) return null;

  const turnState = getAgentTurnState(combat, combatant.id);
  const gridSize = combat.scene?.grid?.size ?? 100;
  const gridDistanceFt = combat.scene?.grid?.distance ?? 5;

  const opponents = combatantOpponents(combat, combatant).map((c) => ({
    id: c.id, name: c.name,
    distanceSquares: chebyshevSquares(combatant.token, c.token, gridSize),
    hp: c.actor?.system?.attributes?.hp?.value ?? null
  }));

  const readyActions = (combatant.actor?.system?.actions ?? [])
    .filter((a) => a.type === 'strike' && a.ready !== false)
    .map((a) => ({
      slug: a.item?.slug ?? a.slug ?? a.label,
      label: a.label,
      variantCount: a.variants?.length ?? 1,
      reachSquares: actionReachSquares(a, gridDistanceFt)
    }));
  const hasRangedOrReach = readyActions.some((a) => a.reachSquares > MELEE_REACH_SQUARES);

  const self = {
    name: combatant.name,
    hp: combatant.actor?.system?.attributes?.hp?.value ?? null,
    conditions: Array.from(combatant.actor?.conditions ?? []).map((c) => c.slug)
  };

  const candidates = buildCandidateList({ opponents, readyActions, turnState, hazard: null, hasRangedOrReach });
  return {
    combatId: combat.id,
    combatantId: combatant.id,
    context: buildDecisionContext({ self, opponents, candidates, roundNumber: combat.round }),
    candidates
  };
}
```

- [ ] **Step 4: Add candidate-execution helpers (generalized Stride/Strike)**

```js
/** Moves `combatant`'s token up to its own speed, straight toward or away
 * from `target`'s token depending on `posture` — the same math stepToward
 * already uses (no wall-avoidance, no real pathfinding, see #100), just
 * parameterized by direction instead of always approaching. A no-op if
 * already at the desired distance or with no speed to move. */
async function strideByPosture(combat, combatant, posture, target) {
  const gridSize = combat.scene?.grid?.size ?? 100;
  const gridDistanceFt = combat.scene?.grid?.distance ?? 5;
  const speedFt = combatant.actor?.system?.movement?.speeds?.land?.value ?? 0;
  const speedSquares = Math.floor(speedFt / gridDistanceFt);
  if (speedSquares <= 0 || !target) return;

  const me = combatant.token;
  const dest = target.token;
  const dx = Math.sign(dest.x - me.x) || 0;
  const dy = Math.sign(dest.y - me.y) || 0;
  const sign = posture === 'retreat' ? -1 : 1;
  await me.update({ x: me.x + sign * dx * gridSize * speedSquares, y: me.y + sign * dy * gridSize * speedSquares });
}

/** Rolls one strike at a specific MAP `variantIndex` against `target` and
 * applies damage on a hit — the same dialog-suppression/roll/damage/
 * applyDamage sequence rollAndApplyStrike already uses, generalized to a
 * caller-chosen variant instead of always variants[0]. */
async function rollAndApplyStrikeAtVariant(combatant, target, actionSlug, variantIndex) {
  const strike = (combatant.actor?.system?.actions ?? [])
    .find((a) => a.type === 'strike' && a.ready !== false && (a.item?.slug ?? a.slug ?? a.label) === actionSlug);
  if (!strike) return null;

  const prevShowCheck = game.user.flags?.pf2e?.settings?.showCheckDialogs;
  const prevShowDamage = game.user.flags?.pf2e?.settings?.showDamageDialogs;
  await game.user.update({
    'flags.pf2e.settings.showCheckDialogs': false,
    'flags.pf2e.settings.showDamageDialogs': false
  });
  try {
    const targetRef = { document: target.token };
    const variant = strike.variants[Math.min(variantIndex, strike.variants.length - 1)];
    await variant.roll({ target: targetRef, createMessage: true });
    const outcome = game.messages.contents.at(-1)?.flags?.pf2e?.context?.outcome ?? null;
    if (outcome === 'success' || outcome === 'criticalSuccess') {
      const damageRoll = await strike.damage({ target: targetRef, outcome, createMessage: true });
      if (damageRoll) await target.actor.applyDamage({ damage: damageRoll, token: target.token, outcome });
    }
    return outcome;
  } finally {
    await game.user.update({
      'flags.pf2e.settings.showCheckDialogs': prevShowCheck,
      'flags.pf2e.settings.showDamageDialogs': prevShowDamage
    });
  }
}
```

- [ ] **Step 5: Add `applyAgentDecision`**

```js
/**
 * Executes exactly one chosen candidate for `combatantId`'s current turn in
 * `combat`, updates the per-turn state, and advances the turn once actions
 * run out or `endTurn` was chosen. Returns the pending-turn shape for the
 * *next* iteration (same shape getPendingAgentTurn returns), or `null` once
 * the turn has actually ended. The only mutation path an external process
 * ever reaches — see module.mjs's api.applyAgentDecision.
 */
export async function applyAgentDecision(combat, combatantId, candidateId) {
  const pending = getPendingAgentTurn(combat);
  if (!pending || pending.combatantId !== combatantId) return null;
  const candidate = pending.candidates.find((c) => c.id === candidateId);
  if (!candidate) return null;

  const combatant = combat.combatant;
  if (candidate.type === 'stride') {
    const target = candidate.targetId ? combatantOpponents(combat, combatant).find((c) => c.id === candidate.targetId) : null;
    await strideByPosture(combat, combatant, candidate.posture, target);
  } else if (candidate.type === 'strike') {
    const target = combatantOpponents(combat, combatant).find((c) => c.id === candidate.targetId);
    if (target) await rollAndApplyStrikeAtVariant(combatant, target, candidate.actionSlug, candidate.variantIndex);
  }

  const turnState = getAgentTurnState(combat, combatantId);
  const nextTurnState = applyCandidateToTurnState(turnState, candidate);
  await setAgentTurnState(combat, combatantId, nextTurnState);

  if (nextTurnState.actionsRemaining <= 0) {
    if (game.combats.has(combat.id) && combat.combatant?.id === combatantId) await combat.nextTurn();
    return null;
  }
  // Actions remain — re-arm the timeout for the next decision rather than
  // leaving this turn permanently unwatched after one action.
  armAgentTimeout(combat, combatant);
  return getPendingAgentTurn(combat);
}
```

- [ ] **Step 6: Run the full test suite**

Run: `npm test`
Expected: all tests pass (no new unit tests here — Foundry-API-touching, live-verified in Task 5)

- [ ] **Step 7: Commit**

```bash
git add scripts/dungeon-combat.mjs
git commit -m "Add getPendingAgentTurn/applyAgentDecision for external agent-controlled turns"
```

---

## Task 4: Expose the API, add the GM toggle, add i18n strings

**Files:**
- Modify: `scripts/module.mjs`
- Modify: `lang/en.json`

**Interfaces:**
- Consumes: `getPendingAgentTurn`, `applyAgentDecision`, `toggleAgentControlled` from `scripts/dungeon-combat.mjs` (Tasks 2–3).

- [ ] **Step 1: Extend the existing dungeon-combat.mjs import**

Change:
```js
import { maybeResolveCombatForActor, maybeResolveCombatForCombatant, autoPlayCombatantTurnIfDue } from './dungeon-combat.mjs';
```
to:
```js
import {
  maybeResolveCombatForActor, maybeResolveCombatForCombatant, autoPlayCombatantTurnIfDue,
  getPendingAgentTurn, applyAgentDecision, toggleAgentControlled
} from './dungeon-combat.mjs';
```

- [ ] **Step 2: Add the two `module.api` methods**

In the `module.api = {...}` object (inside `Hooks.once('ready', ...)`), add after the existing `resetDungeon` entry:
```js
    resetDungeon: async (sceneId) => {
      if (!game.user.isGM) return ui.notifications.warn(game.i18n.localize('DOMMT.Dungeon.GmOnlyWarning'));
      const targetSceneId = sceneId ?? canvas?.scene?.id;
      if (!targetSceneId) return;
      const scene = game.scenes.get(targetSceneId);
      const state = getRunState(targetSceneId);
      await abandonRun({ sceneId: targetSceneId });
      if (scene) await teardownDungeonRun(scene, { previousSceneId: state?.previousSceneId ?? null });
    },
    // The only surface tools/agent-loop's poller ever calls — read the
    // current decision point for whichever agent-controlled combatant's
    // turn is due, or apply exactly one chosen candidate. Never exposes
    // arbitrary script access.
    getPendingAgentTurn: (combatId) => {
      const combat = game.combats.get(combatId ?? game.combat?.id);
      return combat ? getPendingAgentTurn(combat) : null;
    },
    applyAgentDecision: (combatId, combatantId, candidateId) => {
      const combat = game.combats.get(combatId);
      return combat ? applyAgentDecision(combat, combatantId, candidateId) : null;
    }
```

- [ ] **Step 3: Add the Combat Tracker context-menu toggle**

Add near the other `Hooks.on(...)` registrations (after the `getSceneControlButtons` block):
```js
/**
 * GM per-combatant override for the agentControlled default (Task 2) — an
 * extra entry on every NPC row's context menu in Foundry's own Combat
 * Tracker sidebar. Deliberately not dungeon-specific UI, since it needs to
 * cover the standalone "DOMMT: Generate Encounter" macro's combats too
 * (ITEM-6's original scope), not just dungeon rooms.
 */
Hooks.on('getCombatTrackerEntryContext', (html, menuItems) => {
  menuItems.push({
    name: 'DOMMT.Dungeon.Combat.ToggleAgentControlLabel',
    icon: '<i class="fa-solid fa-robot"></i>',
    condition: (li) => {
      const combatant = game.combat?.combatants.get(li.dataset.combatantId);
      return !!combatant && !game.actors?.party?.members?.some((m) => m.id === combatant.actor?.id);
    },
    callback: (li) => {
      const combatant = game.combat?.combatants.get(li.dataset.combatantId);
      if (combatant) toggleAgentControlled(combatant);
    }
  });
});
```

- [ ] **Step 4: Add the new i18n keys**

In `lang/en.json`, add near the other `DOMMT.Dungeon.Combat.*` keys:
```json
"DOMMT.Dungeon.Combat.ToggleAgentControlLabel": "Toggle Agent Control",
"DOMMT.Dungeon.Combat.AgentTimeoutWarning": "{name}'s agent-controlled turn timed out — falling back to the default AI.",
"DOMMT.Dungeon.Combat.AgentTimeoutChat": "<p><strong>{name}</strong>'s turn was agent-controlled, but nothing responded in time. Falling back to the default combat AI for this turn.</p>",
```

- [ ] **Step 5: Run the full test suite and validation**

Run: `npm test && npm run validate`
Expected: all tests pass; `validate` still reports card text/schema OK (new i18n keys don't affect card validation, just confirming nothing else broke)

- [ ] **Step 6: Commit**

```bash
git add scripts/module.mjs lang/en.json
git commit -m "Expose agent-controlled turn API and Combat Tracker toggle"
```

---

## Task 5: Live-verify the in-module flow

**Files:** none (verification only, via `foundry-rest`)

- [ ] **Step 1: Confirm the deployed module doesn't have this yet, so this test replicates the shipped functions faithfully**

Run (via `foundry-rest`):
```js
return game.modules.get('deck-of-many-more-things').version;
```
Expected: a version older than whatever gets bumped in Task 6 — confirms this is a from-scratch scratch-scene test, same precedent as every prior item in this codebase.

- [ ] **Step 2: Build a scratch scene, a scratch NPC actor, and a scratch combat with it flagged agent-controlled**

Run (via `foundry-rest`) — mirrors the exact logic Task 2/3 add, since the deployed module doesn't have it yet:
```js
const MODULE_ID = 'deck-of-many-more-things';
const scene = await Scene.create({ name: 'SCRATCH-agent-turn-test', width: 1000, height: 1000, grid: { size: 100, distance: 5 } });
const pack = game.packs.get('pf2e.pathfinder-monster-core');
const idx = await pack.getIndex({ fields: ['type'] });
const entry = Array.from(idx).find((e) => e.type === 'npc');
const source = await pack.getDocument(entry._id);
const [npcActor] = await Actor.createDocuments([source.toObject()]);
const npcTokenDoc = await npcActor.getTokenDocument({ x: 100, y: 100 });
const partyActor = (game.actors?.party?.members ?? []).find((m) => m.type === 'character');
const partyTokenDoc = await partyActor.getTokenDocument({ x: 500, y: 100 });
const [npcToken, partyToken] = await scene.createEmbeddedDocuments('Token', [npcTokenDoc.toObject(), partyTokenDoc.toObject()]);

const combat = await Combat.create({ scene: scene.id });
const [npcCombatant, partyCombatant] = await combat.createEmbeddedDocuments('Combatant', [
  { tokenId: npcToken.id, sceneId: scene.id, flags: { [MODULE_ID]: { agentControlled: true } } },
  { tokenId: partyToken.id, sceneId: scene.id }
]);
await combat.rollInitiative([npcCombatant.id, partyCombatant.id], { skipDialog: true });
await combat.startCombat();
// Force the NPC's turn to be current regardless of initiative order.
await combat.update({ turn: combat.turns.findIndex((c) => c.id === npcCombatant.id) });

return { combatId: combat.id, combatantId: npcCombatant.id, sceneId: scene.id, npcActorId: npcActor.id };
```
Note the returned ids for the following steps.

- [ ] **Step 3: Confirm `getPendingAgentTurn`-equivalent logic returns real candidates**

Run (via `foundry-rest`), pasting in the exact `getPendingAgentTurn`/helper function bodies from Task 3 (since the module isn't deployed yet) ending with:
```js
const combat = game.combats.get('<combatId from Step 2>');
return getPendingAgentTurn(combat);
```
Expected: `candidates` includes at least one `strike:...` entry (party token placed within reach after an approach, or adjust the scratch positions in Step 2 if not) and an `endTurn` entry; `context.roundNumber` is `1`.

- [ ] **Step 4: Confirm a full 3-action turn plays out via repeated `applyAgentDecision` calls**

Run (via `foundry-rest`), same pasted-in function bodies, then:
```js
const combat = game.combats.get('<combatId>');
const results = [];
let pending = getPendingAgentTurn(combat);
while (pending) {
  const chosen = pending.candidates.find((c) => c.type === 'strike') ?? pending.candidates.find((c) => c.type === 'stride') ?? pending.candidates.find((c) => c.id === 'endTurn');
  results.push({ chosen: chosen.id, actionsRemainingBefore: combat.getFlag('deck-of-many-more-things', 'agentTurnState')?.actionsRemaining });
  pending = await applyAgentDecision(combat, '<combatantId>', chosen.id);
}
return results;
```
Expected: exactly 3 entries (or fewer if `endTurn` was reachable and forced early by the fallback logic in Step 5), `actionsRemainingBefore` counting down `3, 2, 1`, and the turn has actually advanced (`combat.combatant?.id !== '<combatantId>'` afterward).

- [ ] **Step 5: Confirm the timeout fallback fires and notifies the GM**

Run (via `foundry-rest`) with a shortened timeout for the test (temporarily reassign `AGENT_TIMEOUT_MS` to `3000` in the pasted function bodies, or just wait past the real 45s if simpler): re-arm a fresh agent-controlled turn (repeat Step 2's combat setup or reset `turn` back to the NPC), call the equivalent of `autoPlayCombatantTurnIfDue(combat)` once, then wait past the timeout with **no** `applyAgentDecision` calls, and confirm:
- a chat message was created whispered to the GM
- `combat.combatant?.id` has moved past the NPC (the heuristic's `nextTurn()` ran)

- [ ] **Step 6: Clean up every scratch document created in this task**

Run (via `foundry-rest`):
```js
await Combat.deleteDocuments([game.combats.filter((c) => c.scene?.name === 'SCRATCH-agent-turn-test').map((c) => c.id)].flat());
await Actor.deleteDocuments(game.actors.filter((a) => a.name.startsWith('SCRATCH') || a.type === 'npc' && a.getActiveTokens(true, true).length === 0).map((a) => a.id));
const scratchScene = game.scenes.find((s) => s.name === 'SCRATCH-agent-turn-test');
if (scratchScene) await scratchScene.delete();
return { npcActorsRemaining: game.actors.filter((a) => a.type === 'npc').length };
```
Expected: `npcActorsRemaining` back to whatever it was before this task started (confirm against a pre-task count taken in Step 1's area) — no leftover scratch actors, same discipline as ITEM-8/#99's own cleanup verification.

---

## Task 6: `tools/agent-loop` transport + Claude provider

**Files:**
- Create: `tools/agent-loop/foundry-client.mjs`
- Create: `tools/agent-loop/providers/claude.mjs`
- Test: `tests/agent-loop-claude-provider.test.mjs`

**Interfaces:**
- Produces (consumed by Task 7): `runFoundryScript(script)` from `foundry-client.mjs`; `decide({ self, opponents, candidates, roundNumber })` from `providers/claude.mjs`, taking an injectable `fetchImpl` for testing.

- [ ] **Step 1: Write `foundry-client.mjs`**

```js
// tools/agent-loop/foundry-client.mjs
/**
 * Thin wrapper around the foundry-rest relay's own HTTP protocol
 * (POST {base}/execute-js?clientId=... — see .claude/skills/foundry-rest/
 * foundry-exec.sh for the reference implementation this mirrors). Talks to
 * a self-hosted foundryvtt-rest-api-relay instance by default (unlimited
 * requests, no third-party dependency — see the design doc's Alternatives
 * Considered section for why).
 */

import { readFileSync } from 'node:fs';

function readEnvOrDotenv(name) {
  if (process.env[name]) return process.env[name];
  try {
    const line = readFileSync('.env', 'utf8').split('\n').find((l) => l.startsWith(`${name}=`));
    return line ? line.slice(name.length + 1).trim() : undefined;
  } catch {
    return undefined;
  }
}

export async function findOnlineClientId({ baseUrl, apiKey, fetchImpl = fetch }) {
  const res = await fetchImpl(`${baseUrl}/clients`, { headers: { 'x-api-key': apiKey } });
  const body = await res.json();
  const clients = body.clients ?? [];
  const chosen = clients.find((c) => c.isOnline) ?? clients[0];
  if (!chosen) throw new Error('foundry-client: no Foundry client registered with the relay');
  return chosen.clientId;
}

/** Runs `script` inside the live Foundry world and returns its `result`.
 * Throws on a relay-level refusal or a script-level error, with the same
 * distinction foundry-exec.sh makes (banned pattern / no client / thrown). */
export async function runFoundryScript(script, {
  baseUrl = readEnvOrDotenv('FOUNDRY_BASE_URL') ?? 'https://foundryrestapi.com',
  apiKey = readEnvOrDotenv('FOUNDRY_REST_API_KEY'),
  clientId = readEnvOrDotenv('FOUNDRY_CLIENT_ID'),
  fetchImpl = fetch
} = {}) {
  if (!apiKey) throw new Error('foundry-client: FOUNDRY_REST_API_KEY not set');
  const client = clientId ?? await findOnlineClientId({ baseUrl, apiKey, fetchImpl });
  const res = await fetchImpl(`${baseUrl}/execute-js?clientId=${client}`, {
    method: 'POST',
    headers: { 'x-api-key': apiKey, 'Content-Type': 'application/json' },
    body: JSON.stringify({ script })
  });
  const body = await res.json();
  if (body.success === false) throw new Error(`foundry-client: script threw: ${body.error ?? 'unknown'}`);
  if (body.error) throw new Error(`foundry-client: ${body.error}`);
  return body.result;
}
```

- [ ] **Step 2: Write the failing test for the Claude provider**

```js
// tests/agent-loop-claude-provider.test.mjs
import { describe, it, expect, vi } from 'vitest';
import { decide } from '../tools/agent-loop/providers/claude.mjs';

const CONTEXT = {
  self: { name: 'Yamaraj', hp: 40, conditions: [] },
  opponents: [{ id: 'opp1', name: 'Fighter', distanceSquares: 1, hp: 30 }],
  candidates: [
    { id: 'strike:claw:opp1', summary: 'Claw vs Fighter (variant 0)' },
    { id: 'endTurn', summary: 'End turn' }
  ],
  roundNumber: 1
};

function fakeFetch(toolInputJson) {
  return vi.fn().mockResolvedValue({
    ok: true,
    json: async () => ({
      content: [{ type: 'tool_use', name: 'choose_action', input: JSON.parse(toolInputJson) }]
    })
  });
}

describe('claude provider decide()', () => {
  it('sends the context as prompt content and a candidate-id enum tool', async () => {
    const fetchImpl = fakeFetch('{"candidateId": "strike:claw:opp1", "rationale": "closest target"}');
    await decide(CONTEXT, { apiKey: 'test-key', fetchImpl });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, options] = fetchImpl.mock.calls[0];
    expect(url).toBe('https://api.anthropic.com/v1/messages');
    const body = JSON.parse(options.body);
    expect(body.tools[0].name).toBe('choose_action');
    expect(body.tools[0].input_schema.properties.candidateId.enum).toEqual(['strike:claw:opp1', 'endTurn']);
    expect(JSON.stringify(body.messages)).toContain('Yamaraj');
  });

  it('returns the chosen candidateId and rationale', async () => {
    const fetchImpl = fakeFetch('{"candidateId": "endTurn", "rationale": "no good options"}');
    const result = await decide(CONTEXT, { apiKey: 'test-key', fetchImpl });
    expect(result).toEqual({ candidateId: 'endTurn', rationale: 'no good options' });
  });

  it('throws if Claude picks a candidateId that was never offered', async () => {
    const fetchImpl = fakeFetch('{"candidateId": "not-a-real-candidate", "rationale": "oops"}');
    await expect(decide(CONTEXT, { apiKey: 'test-key', fetchImpl })).rejects.toThrow(/not offered/);
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `npx vitest run tests/agent-loop-claude-provider.test.mjs`
Expected: FAIL — `Cannot find module '../tools/agent-loop/providers/claude.mjs'`

- [ ] **Step 4: Write the Claude provider implementation**

```js
// tools/agent-loop/providers/claude.mjs
/**
 * Claude adapter for agent-controlled combat decisions — v1's only
 * provider (Laya tracked separately, #102, blocked on its own setup). Uses
 * tool-use with an enum of exactly the offered candidate ids, so a response
 * can't name something that was never on the list — no freeform-text
 * parsing to get wrong.
 */

const CLAUDE_MODEL = 'claude-sonnet-5';

export async function decide(context, { apiKey = process.env.ANTHROPIC_API_KEY, fetchImpl = fetch } = {}) {
  const candidateIds = context.candidates.map((c) => c.id);
  const body = {
    model: CLAUDE_MODEL,
    max_tokens: 512,
    tools: [{
      name: 'choose_action',
      description: 'Choose exactly one candidate action for this combatant\'s turn.',
      input_schema: {
        type: 'object',
        properties: {
          candidateId: { type: 'string', enum: candidateIds },
          rationale: { type: 'string', description: 'One short sentence explaining the choice.' }
        },
        required: ['candidateId', 'rationale']
      }
    }],
    tool_choice: { type: 'tool', name: 'choose_action' },
    messages: [{
      role: 'user',
      content: `You are controlling an NPC's turn in a Pathfinder 2e combat. Pick the best candidate action.\n\n${JSON.stringify(context, null, 2)}`
    }]
  };

  const res = await fetchImpl('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(body)
  });
  const payload = await res.json();
  const toolUse = payload.content?.find((c) => c.type === 'tool_use' && c.name === 'choose_action');
  if (!toolUse) throw new Error('claude provider: no choose_action tool call in response');

  const { candidateId, rationale } = toolUse.input;
  if (!candidateIds.includes(candidateId)) {
    throw new Error(`claude provider: candidateId "${candidateId}" was not offered`);
  }
  return { candidateId, rationale };
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx vitest run tests/agent-loop-claude-provider.test.mjs`
Expected: PASS, all 3 tests green

- [ ] **Step 6: Run the full suite**

Run: `npm test`
Expected: all tests pass, including the new file

- [ ] **Step 7: Commit**

```bash
git add tools/agent-loop/foundry-client.mjs tools/agent-loop/providers/claude.mjs tests/agent-loop-claude-provider.test.mjs
git commit -m "Add foundry-rest transport client and Claude decision provider for tools/agent-loop"
```

---

## Task 7: Provider selection, polling loop, README

**Files:**
- Create: `tools/agent-loop/providers/index.mjs`
- Create: `tools/agent-loop/poll.mjs`
- Create: `tools/agent-loop/README.md`
- Modify: `package.json`

**Interfaces:**
- Consumes: `runFoundryScript` from `foundry-client.mjs`, `decide` from `providers/claude.mjs` (Task 6).

- [ ] **Step 1: Write the provider selector**

```js
// tools/agent-loop/providers/index.mjs
import { decide as decideClaude } from './claude.mjs';

const PROVIDERS = { claude: decideClaude };

/** Picks the decide() function named by DOMMT_AGENT_PROVIDER (default
 * "claude") — restart the poller to switch providers, no runtime
 * switching in v1. Laya isn't wired in yet (#102, blocked). */
export function resolveProvider(name = process.env.DOMMT_AGENT_PROVIDER ?? 'claude') {
  const provider = PROVIDERS[name];
  if (!provider) throw new Error(`Unknown DOMMT_AGENT_PROVIDER "${name}" — options: ${Object.keys(PROVIDERS).join(', ')}`);
  return provider;
}
```

- [ ] **Step 2: Write the polling loop**

```js
#!/usr/bin/env node
// tools/agent-loop/poll.mjs
/**
 * Polls the live Foundry world (via the self-hosted foundry-rest relay) for
 * an agent-controlled combatant's due turn, asks the configured provider
 * which candidate to take, and applies it — repeating until that turn is
 * over, then waiting POLL_INTERVAL_MS before checking again. No Foundry
 * mutation happens anywhere in this file except through
 * module.api.applyAgentDecision.
 *
 * Run: node tools/agent-loop/poll.mjs
 * Requires: FOUNDRY_REST_API_KEY, FOUNDRY_BASE_URL (your self-hosted relay),
 * ANTHROPIC_API_KEY — see README.md.
 */
import { runFoundryScript } from './foundry-client.mjs';
import { resolveProvider } from './providers/index.mjs';

const POLL_INTERVAL_MS = Number(process.env.DOMMT_POLL_INTERVAL_MS ?? 3000);
const MODULE_ID = 'deck-of-many-more-things';

async function getPendingTurn() {
  return runFoundryScript(
    `return game.modules.get('${MODULE_ID}').api.getPendingAgentTurn();`
  );
}

async function applyDecision(combatId, combatantId, candidateId) {
  return runFoundryScript(
    `return game.modules.get('${MODULE_ID}').api.applyAgentDecision(${JSON.stringify(combatId)}, ${JSON.stringify(combatantId)}, ${JSON.stringify(candidateId)});`
  );
}

async function playOnePendingTurnToCompletion(decide) {
  let pending = await getPendingTurn();
  while (pending) {
    let decision;
    try {
      decision = await decide(pending.context, { fetchImpl: fetch });
    } catch (err) {
      console.error('agent-loop: provider error, skipping this cycle:', err.message);
      return; // let Foundry's own per-action timeout fallback handle it
    }
    console.log(`agent-loop: chose ${decision.candidateId} (${decision.rationale ?? 'no rationale'})`);
    try {
      pending = await applyDecision(pending.combatId, pending.combatantId, decision.candidateId);
    } catch (err) {
      console.error('agent-loop: applyAgentDecision failed, skipping this cycle:', err.message);
      return;
    }
  }
}

async function main() {
  const decide = resolveProvider();
  console.log(`agent-loop: polling every ${POLL_INTERVAL_MS}ms with provider "${process.env.DOMMT_AGENT_PROVIDER ?? 'claude'}"`);
  for (;;) {
    try {
      await playOnePendingTurnToCompletion(decide);
    } catch (err) {
      console.error('agent-loop: poll cycle failed, will retry:', err.message);
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }
}

main();
```

- [ ] **Step 3: Write the README**

```markdown
# tools/agent-loop

Polls a live Foundry world for agent-controlled combatants' turns and plays
them via an LLM, instead of ITEM-8's fixed "move toward nearest, strike
once" heuristic. See `docs/superpowers/specs/2026-09-20-agent-bridge-combat-ai-design.md`
for the full design.

## Setup

1. **Self-host the relay** (avoids the public `foundryrestapi.com` relay's
   100 requests/month free-tier limit — this polls every few seconds):
   ```bash
   git clone https://github.com/ThreeHats/foundryvtt-rest-api-relay
   cd foundryvtt-rest-api-relay
   docker compose up -d
   ```
   Point Foundry's own `foundryvtt-rest-api` module at this relay instead of
   the public one (module settings → Relay URL).

2. **Environment variables** (a `.env` in the repo root, or the shell
   environment):
   ```
   FOUNDRY_BASE_URL=http://localhost:<your relay port>
   FOUNDRY_REST_API_KEY=<your relay's key>
   ANTHROPIC_API_KEY=<your Claude API key>
   ```
   `FOUNDRY_CLIENT_ID` and `DOMMT_AGENT_PROVIDER` (default `claude`) and
   `DOMMT_POLL_INTERVAL_MS` (default `3000`) are optional overrides.

3. **Run it** alongside your Foundry session:
   ```bash
   node tools/agent-loop/poll.mjs
   ```

Leave it running for the length of a session. If it's not running (or
crashes), agent-controlled combatants still act — Foundry falls back to the
default heuristic after `AGENT_TIMEOUT_MS` (45s) and tells you so in chat.
```

- [ ] **Step 4: Add an npm script**

In `package.json`'s `"scripts"` block, add:
```json
    "agent-loop": "node tools/agent-loop/poll.mjs",
```

- [ ] **Step 5: Run the full suite and validation**

Run: `npm test && npm run validate && npm run validate:dungeon`
Expected: all pass, no regressions

- [ ] **Step 6: Commit**

```bash
git add tools/agent-loop/providers/index.mjs tools/agent-loop/poll.mjs tools/agent-loop/README.md package.json
git commit -m "Add tools/agent-loop polling entrypoint, provider selection, and setup docs"
```

---

## Task 8: End-to-end live verification with a real poller

**Files:** none (verification only)

- [ ] **Step 1: Set up a self-hosted relay locally, per `tools/agent-loop/README.md`**

Confirm `docker compose up -d` succeeds and Foundry's own relay module connects to it (its settings notification shows "Connected"), not the public `foundryrestapi.com`.

- [ ] **Step 2: Start `node tools/agent-loop/poll.mjs` with `ANTHROPIC_API_KEY` set**

Confirm it logs `agent-loop: polling every 3000ms with provider "claude"` and no immediate errors.

- [ ] **Step 3: Repeat Task 5's scratch-combat setup (Step 2), this time against the actually-deployed module** (requires this branch merged and the world updated first — see Task 9)

Create the same scratch scene/NPC/combat, with the NPC's turn current and `agentControlled: true`.

- [ ] **Step 4: Watch the poller's own log output**

Expected within one poll interval: `agent-loop: chose strike:...` (or a stride) log line, followed by the combatant's token actually moving/striking in the Foundry client, repeated up to 3 times for the turn, ending with the turn advancing past that combatant with no manual intervention.

- [ ] **Step 5: Kill the poller mid-turn and confirm the timeout fallback still works**

Start a fresh agent-controlled turn, let the poller apply one action, then `Ctrl-C` the poller before it applies the second. Confirm that after `AGENT_TIMEOUT_MS` (45s), a GM-whispered chat message appears and the turn finishes via the heuristic.

- [ ] **Step 6: Clean up every scratch document created in this task**

Same cleanup pattern as Task 5, Step 6 — confirm no leftover scratch actors/scenes/combats remain.

---

## Task 9: Ship it

**Files:**
- Modify: `module.json`

- [ ] **Step 1: Bump the version**

Read the current `"version"` in `module.json` (it may have moved since this plan was written — other work may have merged) and bump the patch component.

- [ ] **Step 2: Run the full verification suite**

Run: `npm test && npm run validate && npm run validate:dungeon`
Expected: all green

- [ ] **Step 3: Commit the version bump**

```bash
git add module.json
git commit -m "Bump version for agent-controlled combat AI (v1: Strikes + Stride only)"
```

- [ ] **Step 4: Push the feature branch (created in Task 1, Step 1), open a PR referencing issue #94, merge**

```bash
git push -u origin feat/agent-bridge-combat-ai
gh pr create --title "Agent-controlled combat AI (v1: Strikes + Stride)" --body "Implements the combat-AI half of #94. See docs/superpowers/specs/2026-09-20-agent-bridge-combat-ai-design.md for the design and docs/superpowers/plans/2026-09-20-agent-bridge-combat-ai.md for what shipped.

Closes #94 (combat-AI half — dynamic puzzle/trap generation split into its own follow-up issue, not yet filed)."
gh pr merge --merge --delete-branch
```

- [ ] **Step 5: Close #94, or leave it open with a note if the puzzle-generation half still needs its own issue**

If a separate puzzle/trap-generation issue hasn't been filed yet, file it now (mirroring #100–103's shape) before closing #94, so that scope isn't silently dropped.
