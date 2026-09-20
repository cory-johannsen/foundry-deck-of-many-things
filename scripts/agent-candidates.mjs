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
