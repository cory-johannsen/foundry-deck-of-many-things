const MODULE_ID = 'deck-of-many-more-things';

let CARDS_CACHE = null;
let POSITIONS_CACHE = null;

export async function loadCards() {
  if (CARDS_CACHE) return CARDS_CACHE;
  const res = await fetch(`modules/${MODULE_ID}/data/cards.json`);
  CARDS_CACHE = await res.json();
  return CARDS_CACHE;
}

export async function loadCelticCross() {
  if (POSITIONS_CACHE) return POSITIONS_CACHE;
  const res = await fetch(`modules/${MODULE_ID}/data/celtic-cross.json`);
  POSITIONS_CACHE = await res.json();
  return POSITIONS_CACHE;
}

export function invalidateCaches() {
  CARDS_CACHE = null;
  POSITIONS_CACHE = null;
}
