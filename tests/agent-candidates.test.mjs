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
