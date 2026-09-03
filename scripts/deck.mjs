import { splitmix32, seedFromString, shuffle } from './prng.mjs';

export const DRAW_WINDOW_MS = 3600 * 1000;

// Traditional Celtic Cross dealing order, strictly 1..10: Crown is 3 (what is
// conscious, the goal, what sits above the situation), Foundation is 4 (the
// unconscious root beneath it), Past is 5. These three were previously dealt in
// the wrong sequence — 3=foundation, 4=past, 5=crown.
export const CELTIC_CROSS_ORDER = [
  'heart',
  'challenge',
  'crown',
  'foundation',
  'recent_past',
  'near_future',
  'self',
  'environment',
  'hopes_fears',
  'outcome'
];

export const DIVINATION_CATEGORIES = [
  'person',
  'creature_or_trap',
  'place',
  'treasure',
  'situation'
];

export function freshPlayDeckState(cards, seed) {
  const ids = cards.map((c) => c.id);
  const rand = typeof seed === 'string' ? splitmix32(seedFromString(seed)) : splitmix32(seed >>> 0);
  return {
    remaining: shuffle(ids, rand),
    drawn: [],
    seed: typeof seed === 'string' ? seed : String(seed >>> 0)
  };
}

export function drawFromPlay(state, { actorId = null, at = Date.now() } = {}) {
  if (state.remaining.length === 0) {
    return { card: null, state, reason: 'empty' };
  }
  const remaining = state.remaining.slice();
  const card = remaining.shift();
  const drawn = state.drawn.concat([{ cardId: card, actorId, at }]);
  return { card, state: { ...state, remaining, drawn }, reason: null };
}

export function drawMany(cardsById, state, { n, actorId = null, now = Date.now() } = {}) {
  const results = [];
  let s = state;
  let stopped = null;
  let counted = 0;
  const declaredAt = now;

  while (counted < n) {
    if (now - declaredAt > DRAW_WINDOW_MS) {
      stopped = 'timeout';
      break;
    }
    const step = drawFromPlay(s, { actorId, at: now });
    if (step.reason === 'empty') {
      stopped = 'empty';
      break;
    }
    s = step.state;
    const card = cardsById.get(step.card);
    if (!card) throw new Error(`Unknown card id in deck: ${step.card}`);
    results.push({ cardId: step.card, at: now });

    const isFool = step.card === 'fool';
    const counts_as_one = card.mechanics?.params?.counts_as_one === true;
    if (!(isFool && counts_as_one)) {
      counted += 1;
    } else {
      counted += 1;
    }

    if (card.rules.draw_terminating) {
      stopped = 'terminator';
      break;
    }
  }
  return { results, state: s, stopped };
}

export function resetPlayDeck(cards, seed) {
  return freshPlayDeckState(cards, seed);
}

export function dealCelticCross(cards, { seed, category } = {}) {
  if (!DIVINATION_CATEGORIES.includes(category)) {
    throw new Error(`Unknown divination category: ${category}`);
  }
  const rand = seed == null
    ? Math.random
    : (typeof seed === 'string' ? splitmix32(seedFromString(seed)) : splitmix32(seed >>> 0));
  const ids = cards.map((c) => c.id);
  const deck = shuffle(ids, rand);
  const spread = [];
  for (let i = 0; i < CELTIC_CROSS_ORDER.length; i++) {
    const cardId = deck[i];
    const orientation = rand() < 0.5 ? 'upright' : 'reversed';
    spread.push({
      cardId,
      orientation,
      position: CELTIC_CROSS_ORDER[i],
      order: i + 1
    });
  }
  return { category, spread };
}

export function readingFromSpread(cards, cardsById, { category, spread }) {
  const positions = spread.map((slot) => {
    const card = cardsById.get(slot.cardId);
    const effectiveOrientation = slot.position === 'challenge' ? 'upright' : slot.orientation;
    const text = card.divination[category][effectiveOrientation] || '';
    return {
      ...slot,
      card: { id: card.id, name: card.name, art: card.art.front },
      text,
      empty: text.trim().length === 0
    };
  });
  return { category, positions };
}

export function makeCardsById(cards) {
  return new Map(cards.map((c) => [c.id, c]));
}
