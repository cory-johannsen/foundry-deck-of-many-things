// tests/agent-candidates.test.mjs
import { describe, it, expect } from 'vitest';
import {
  initAgentTurnState, buildMovementCandidates, buildStrikeCandidates, buildSpellCandidates,
  buildAreaSpellCandidates, buildAttackSpellCandidates, endTurnCandidate,
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

describe('buildSpellCandidates', () => {
  const spiritBlast = { id: 'sp1', slug: 'spirit-blast', label: 'Spirit Blast', cost: 2, rangeSquares: 6, save: 'fortitude', basic: true, entryId: 'entry1' };
  const opponentInRange = { id: 'opp1', name: 'Fighter', distanceSquares: 5 };
  const opponentOutOfRange = { id: 'opp2', name: 'Cleric', distanceSquares: 10 };

  it('offers a cast against every opponent within range when enough actions remain', () => {
    const candidates = buildSpellCandidates({ readySpells: [spiritBlast], opponents: [opponentInRange, opponentOutOfRange], actionsRemaining: 3 });
    expect(candidates).toEqual([
      { id: 'cast:spirit-blast:opp1', type: 'cast', spellId: 'sp1', entryId: 'entry1', targetId: 'opp1', cost: 2, save: 'fortitude', basic: true, summary: 'Spirit Blast vs Fighter' }
    ]);
  });

  it('omits a spell whose cost exceeds the actions remaining', () => {
    const candidates = buildSpellCandidates({ readySpells: [spiritBlast], opponents: [opponentInRange], actionsRemaining: 1 });
    expect(candidates).toEqual([]);
  });

  it('omits an opponent outside the spell\'s range', () => {
    const candidates = buildSpellCandidates({ readySpells: [spiritBlast], opponents: [opponentOutOfRange], actionsRemaining: 3 });
    expect(candidates).toEqual([]);
  });
});

describe('buildAreaSpellCandidates', () => {
  const opp1 = { id: 'opp1', name: 'Fighter' };
  const opp2 = { id: 'opp2', name: 'Cleric' };
  const opp3 = { id: 'opp3', name: 'Rogue' };

  const quench = {
    id: 'sp1', slug: 'quench', label: 'Quench', cost: 2, save: 'fortitude', basic: true, entryId: 'entry1',
    placements: [
      { centerType: 'opponent', centerId: 'opp1', affected: [opp1, opp2] },
      { centerType: 'opponent', centerId: 'opp3', affected: [opp3] }
    ]
  };

  it('offers one candidate per spell, centered on whichever placement catches the most opponents', () => {
    const candidates = buildAreaSpellCandidates({ readyAreaSpells: [quench], actionsRemaining: 3 });
    expect(candidates).toEqual([
      {
        id: 'castArea:quench:opponent:opp1', type: 'castArea',
        spellId: 'sp1', entryId: 'entry1', cost: 2, save: 'fortitude', basic: true,
        centerType: 'opponent', centerId: 'opp1', affectedIds: ['opp1', 'opp2'],
        summary: 'Quench (hits Fighter, Cleric)'
      }
    ]);
  });

  it('omits a spell whose cost exceeds the actions remaining', () => {
    const candidates = buildAreaSpellCandidates({ readyAreaSpells: [quench], actionsRemaining: 1 });
    expect(candidates).toEqual([]);
  });

  it('omits a spell where every placement catches zero opponents', () => {
    const allyOnly = { ...quench, placements: [{ centerType: 'self', centerId: null, affected: [] }] };
    const candidates = buildAreaSpellCandidates({ readyAreaSpells: [allyOnly], actionsRemaining: 3 });
    expect(candidates).toEqual([]);
  });

  it('offers a self-centered candidate for an emanation, with no centerId', () => {
    const wails = {
      id: 'sp2', slug: 'wails-of-the-damned', label: 'Wails of the Damned', cost: 2, save: 'fortitude', basic: false, entryId: 'entry1',
      placements: [{ centerType: 'self', centerId: null, affected: [opp1] }]
    };
    const candidates = buildAreaSpellCandidates({ readyAreaSpells: [wails], actionsRemaining: 3 });
    expect(candidates).toEqual([
      {
        id: 'castArea:wails-of-the-damned:self', type: 'castArea',
        spellId: 'sp2', entryId: 'entry1', cost: 2, save: 'fortitude', basic: false,
        centerType: 'self', centerId: null, affectedIds: ['opp1'],
        summary: 'Wails of the Damned (hits Fighter)'
      }
    ]);
  });
});

describe('buildAttackSpellCandidates', () => {
  const rayOfFrost = { id: 'sp4', slug: 'ray-of-frost', label: 'Ray of Frost', cost: 2, rangeSquares: 6, entryId: 'entry1' };
  const opponentInRange = { id: 'opp1', name: 'Fighter', distanceSquares: 5 };
  const opponentOutOfRange = { id: 'opp2', name: 'Cleric', distanceSquares: 10 };

  it('offers a castAttack against every opponent within range when enough actions remain', () => {
    const candidates = buildAttackSpellCandidates({ readyAttackSpells: [rayOfFrost], opponents: [opponentInRange, opponentOutOfRange], actionsRemaining: 3 });
    expect(candidates).toEqual([
      { id: 'castAttack:ray-of-frost:opp1', type: 'castAttack', spellId: 'sp4', entryId: 'entry1', targetId: 'opp1', cost: 2, summary: 'Ray of Frost vs Fighter' }
    ]);
  });

  it('omits a spell whose cost exceeds the actions remaining', () => {
    const candidates = buildAttackSpellCandidates({ readyAttackSpells: [rayOfFrost], opponents: [opponentInRange], actionsRemaining: 1 });
    expect(candidates).toEqual([]);
  });

  it('omits an opponent outside the spell\'s range', () => {
    const candidates = buildAttackSpellCandidates({ readyAttackSpells: [rayOfFrost], opponents: [opponentOutOfRange], actionsRemaining: 3 });
    expect(candidates).toEqual([]);
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

  it('includes affordable spell candidates alongside strikes', () => {
    const spiritBlast = { id: 'sp1', slug: 'spirit-blast', label: 'Spirit Blast', cost: 2, rangeSquares: 6, save: 'fortitude', basic: true };
    const turnState = { actionsRemaining: 3, mapIncrement: 0 };
    const candidates = buildCandidateList({ opponents: [opponent], readyActions: [claw], readySpells: [spiritBlast], turnState, hazard: null, hasRangedOrReach: false });
    expect(candidates.map((c) => c.id)).toEqual(['strike:claw:opp1', 'cast:spirit-blast:opp1', 'endTurn']);
  });

  it('omits a spell that the remaining action budget cannot afford', () => {
    const spiritBlast = { id: 'sp1', slug: 'spirit-blast', label: 'Spirit Blast', cost: 2, rangeSquares: 6, save: 'fortitude', basic: true };
    const turnState = { actionsRemaining: 1, mapIncrement: 0 };
    const candidates = buildCandidateList({ opponents: [opponent], readyActions: [claw], readySpells: [spiritBlast], turnState, hazard: null, hasRangedOrReach: false });
    expect(candidates.map((c) => c.id)).toEqual(['strike:claw:opp1', 'endTurn']);
  });

  it('includes an affordable area-spell candidate alongside strikes', () => {
    const quench = {
      id: 'sp3', slug: 'quench', label: 'Quench', cost: 2, save: 'fortitude', basic: true, entryId: 'entry1',
      placements: [{ centerType: 'self', centerId: null, affected: [{ id: 'opp1', name: 'Fighter' }] }]
    };
    const turnState = { actionsRemaining: 3, mapIncrement: 0 };
    const candidates = buildCandidateList({ opponents: [opponent], readyActions: [claw], readyAreaSpells: [quench], turnState, hazard: null, hasRangedOrReach: false });
    expect(candidates.map((c) => c.id)).toEqual(['strike:claw:opp1', 'castArea:quench:self', 'endTurn']);
  });

  it('includes an affordable attack-roll spell candidate alongside strikes', () => {
    const rayOfFrost = { id: 'sp4', slug: 'ray-of-frost', label: 'Ray of Frost', cost: 1, rangeSquares: 6, entryId: 'entry1' };
    const turnState = { actionsRemaining: 3, mapIncrement: 0 };
    const candidates = buildCandidateList({ opponents: [opponent], readyActions: [claw], readyAttackSpells: [rayOfFrost], turnState, hazard: null, hasRangedOrReach: false });
    expect(candidates.map((c) => c.id)).toEqual(['strike:claw:opp1', 'castAttack:ray-of-frost:opp1', 'endTurn']);
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

  it('decrements actionsRemaining by a spell\'s own cost and never touches mapIncrement', () => {
    const next = applyCandidateToTurnState({ actionsRemaining: 3, mapIncrement: 1 }, { type: 'cast', cost: 2 });
    expect(next).toEqual({ actionsRemaining: 1, mapIncrement: 1 });
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
