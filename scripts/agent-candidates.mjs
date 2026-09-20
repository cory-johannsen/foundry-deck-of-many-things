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

/**
 * One candidate per ready single-target, save-based spell x each opponent
 * within that spell's range, provided the spell's own action cost fits the
 * actions still remaining this turn (unlike a strike, a spell's cost isn't
 * always 1, so this check can't wait for `buildCandidateList`'s exhausted
 * short-circuit).
 */
export function buildSpellCandidates({ readySpells, opponents, actionsRemaining }) {
  const candidates = [];
  for (const spell of readySpells) {
    if (spell.cost > actionsRemaining) continue;
    for (const opponent of opponents) {
      if (opponent.distanceSquares > spell.rangeSquares) continue;
      candidates.push({
        id: `cast:${spell.slug}:${opponent.id}`, type: 'cast',
        spellId: spell.id, entryId: spell.entryId, targetId: opponent.id, cost: spell.cost,
        save: spell.save, basic: spell.basic,
        summary: `${spell.label} vs ${opponent.name}`
      });
    }
  }
  return candidates;
}

/**
 * One candidate per ready area spell (burst/emanation, save-based damage —
 * see dungeon-combat.mjs's isAreaSpellInScope), centered at whichever of the
 * caller's precomputed `placements` catches the most opponents. A spell with
 * no placement catching at least one opponent is never offered at all — the
 * simplest form of friendly-fire avoidance (an ally-only or empty blast
 * simply isn't a candidate); a fuller ally-aware placement search that also
 * tries to minimize allies caught alongside enemies is deferred to a
 * follow-up issue. Real token geometry (which opponents actually fall
 * within a given radius of a given point) is computed by the caller —
 * this function only ever picks among already-computed options.
 */
export function buildAreaSpellCandidates({ readyAreaSpells, actionsRemaining }) {
  const candidates = [];
  for (const spell of readyAreaSpells) {
    if (spell.cost > actionsRemaining) continue;
    const best = spell.placements
      .filter((p) => p.affected.length > 0)
      .reduce((a, b) => (!a || b.affected.length > a.affected.length ? b : a), null);
    if (!best) continue;
    const idSuffix = best.centerId ? `:${best.centerId}` : '';
    candidates.push({
      id: `castArea:${spell.slug}:${best.centerType}${idSuffix}`, type: 'castArea',
      spellId: spell.id, entryId: spell.entryId, cost: spell.cost,
      save: spell.save, basic: spell.basic,
      centerType: best.centerType, centerId: best.centerId,
      affectedIds: best.affected.map((o) => o.id),
      summary: `${spell.label} (hits ${best.affected.map((o) => o.name).join(', ')})`
    });
  }
  return candidates;
}

/**
 * One candidate per ready single-target, attack-roll spell x each opponent
 * within that spell's range — same shape as buildSpellCandidates (#118's
 * save-based spells), minus `save`/`basic` (an attack-roll spell resolves
 * against AC via dungeon-combat.mjs's castAttackSpellAndApplyRoll, not a
 * target's own saving throw), and a distinct `castAttack` type so
 * applyAgentDecision's dispatch never conflates the two execution paths.
 */
export function buildAttackSpellCandidates({ readyAttackSpells, opponents, actionsRemaining }) {
  const candidates = [];
  for (const spell of readyAttackSpells) {
    if (spell.cost > actionsRemaining) continue;
    for (const opponent of opponents) {
      if (opponent.distanceSquares > spell.rangeSquares) continue;
      candidates.push({
        id: `castAttack:${spell.slug}:${opponent.id}`, type: 'castAttack',
        spellId: spell.id, entryId: spell.entryId, targetId: opponent.id, cost: spell.cost,
        summary: `${spell.label} vs ${opponent.name}`
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
export function buildCandidateList({ opponents, readyActions, readySpells = [], readyAreaSpells = [], readyAttackSpells = [], turnState, hazard = null, hasRangedOrReach = false }) {
  if (turnState.actionsRemaining <= 0) return [endTurnCandidate()];
  return [
    ...buildMovementCandidates({ opponents, hazard, hasRangedOrReach }),
    ...buildStrikeCandidates({ readyActions, opponents, mapIncrement: turnState.mapIncrement }),
    ...buildSpellCandidates({ readySpells, opponents, actionsRemaining: turnState.actionsRemaining }),
    ...buildAreaSpellCandidates({ readyAreaSpells, actionsRemaining: turnState.actionsRemaining }),
    ...buildAttackSpellCandidates({ readyAttackSpells, opponents, actionsRemaining: turnState.actionsRemaining }),
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
