const MODULE_ID = 'deck-of-many-more-things';

let CARDS_CACHE = null;
let POSITIONS_CACHE = null;
let SETPIECES_CACHE = null;
let CREATURE_ART_CACHE = null;

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

export async function loadDungeonSetpieces() {
  if (SETPIECES_CACHE) return SETPIECES_CACHE;
  const res = await fetch(`modules/${MODULE_ID}/data/dungeon-setpieces.json`);
  SETPIECES_CACHE = await res.json();
  return SETPIECES_CACHE;
}

export async function loadCreatureArt() {
  if (CREATURE_ART_CACHE) return CREATURE_ART_CACHE;
  const res = await fetch(`modules/${MODULE_ID}/data/creature-art.json`);
  CREATURE_ART_CACHE = await res.json();
  return CREATURE_ART_CACHE;
}

export function invalidateCaches() {
  CARDS_CACHE = null;
  POSITIONS_CACHE = null;
  SETPIECES_CACHE = null;
  CREATURE_ART_CACHE = null;
}
