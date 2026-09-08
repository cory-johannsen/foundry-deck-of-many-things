/**
 * Pure grid-unit geometry for a physical dungeon room layout — no Foundry
 * dependency, same split as dungeon-deck.mjs. A caller multiplies by the
 * scene's grid size to get pixels; this file only ever deals in grid
 * squares, the same separation scene-divination.mjs keeps between its
 * LAYOUT design space and layoutTransform()'s canvas space.
 *
 * Rooms are laid out boustrophedon (even rows run east, odd rows run west)
 * so a row's last room and the next row's first room always share a grid
 * column — the wrap between rows is a plain straight corridor, never a jog.
 * Physical slots are assigned lazily, one at a time, as the party actually
 * approaches each room (see dungeon-scene.mjs) — this file only answers
 * "given a slot number, where is it and how does it connect," with no idea
 * of when a slot gets built.
 *
 * A connection's door lives on exactly ONE wall: the earlier room's
 * forward-facing side. The later room's facing side gets no wall at all —
 * it opens straight into the connecting corridor. That keeps "a room has at
 * most one outgoing door and never an incoming one" literally true and
 * means every connection is purely additive: nothing is ever replaced.
 */

export const ROOM_SIZE = 6;
export const ROOMS_PER_ROW = 5;
export const CORRIDOR_LEN = 1;
export const DOOR_WIDTH = 1;

const OPPOSITE = { north: 'south', south: 'north', east: 'west', west: 'east' };

/** Row/column of a physical slot, boustrophedon. */
export function slotRowCol(slot) {
  const row = Math.floor(slot / ROOMS_PER_ROW);
  const posInRow = slot % ROOMS_PER_ROW;
  const col = row % 2 === 0 ? posInRow : ROOMS_PER_ROW - 1 - posInRow;
  return { row, col };
}

/** The room's footprint in grid units (top-left + size). */
export function slotRect(slot) {
  const { row, col } = slotRowCol(slot);
  const stride = ROOM_SIZE + CORRIDOR_LEN;
  return { gx: col * stride, gy: row * stride, gw: ROOM_SIZE, gh: ROOM_SIZE };
}

/** Compass direction from `slot` to `slot + 1`: 'east' | 'west' | 'south'. */
export function connectionDirection(slot) {
  const { row } = slotRowCol(slot);
  const posInRow = slot % ROOMS_PER_ROW;
  if (posInRow === ROOMS_PER_ROW - 1) return 'south';
  return row % 2 === 0 ? 'east' : 'west';
}

/**
 * The room's own enclosing walls, as compass-labelled grid-unit segments,
 * excluding whichever side(s) face a connection. The incoming side (shared
 * with slot - 1) is derived and excluded automatically — its wall was
 * already drawn as slot - 1's outgoing connection geometry, so drawing it
 * again here would duplicate (and wrongly solidify) that boundary.
 */
export function roomEnclosureWalls(slot, { hasOutgoing }) {
  const excluded = new Set();
  if (slot > 0) excluded.add(OPPOSITE[connectionDirection(slot - 1)]);
  if (hasOutgoing) excluded.add(connectionDirection(slot));

  const { gx, gy, gw, gh } = slotRect(slot);
  const sides = {
    north: { x1: gx, y1: gy, x2: gx + gw, y2: gy },
    south: { x1: gx, y1: gy + gh, x2: gx + gw, y2: gy + gh },
    west: { x1: gx, y1: gy, x2: gx, y2: gy + gh },
    east: { x1: gx + gw, y1: gy, x2: gx + gw, y2: gy + gh }
  };
  return Object.entries(sides)
    .filter(([dir]) => !excluded.has(dir))
    .map(([dir, c]) => ({ dir, ...c }));
}

/**
 * Door + corridor geometry connecting `slot` to `slot + 1`. Returns the
 * single door segment (on slot's forward face) and every other plain solid
 * segment needed (the wall flanking the door on either side, and the two
 * segments closing the long edges of the connecting corridor). `slot + 1`'s
 * facing side gets nothing — it's left open into the corridor.
 */
export function buildConnectionGeometry(slot) {
  const dir = connectionDirection(slot);
  const { gx, gy, gw, gh } = slotRect(slot);
  const plainWalls = [];
  let doorWall;

  if (dir === 'east' || dir === 'west') {
    const faceX = dir === 'east' ? gx + gw : gx;
    const corridorEndX = dir === 'east' ? faceX + CORRIDOR_LEN : faceX - CORRIDOR_LEN;
    const doorY0 = gy + (gh - DOOR_WIDTH) / 2;
    const doorY1 = doorY0 + DOOR_WIDTH;
    doorWall = { x1: faceX, y1: doorY0, x2: faceX, y2: doorY1 };
    plainWalls.push(
      { x1: faceX, y1: gy, x2: faceX, y2: doorY0 },
      { x1: faceX, y1: doorY1, x2: faceX, y2: gy + gh },
      { x1: faceX, y1: doorY0, x2: corridorEndX, y2: doorY0 },
      { x1: faceX, y1: doorY1, x2: corridorEndX, y2: doorY1 }
    );
  } else {
    // 'south'
    const faceY = gy + gh;
    const corridorEndY = faceY + CORRIDOR_LEN;
    const doorX0 = gx + (gw - DOOR_WIDTH) / 2;
    const doorX1 = doorX0 + DOOR_WIDTH;
    doorWall = { x1: doorX0, y1: faceY, x2: doorX1, y2: faceY };
    plainWalls.push(
      { x1: gx, y1: faceY, x2: doorX0, y2: faceY },
      { x1: doorX1, y1: faceY, x2: gx + gw, y2: faceY },
      { x1: doorX0, y1: faceY, x2: doorX0, y2: corridorEndY },
      { x1: doorX1, y1: faceY, x2: doorX1, y2: corridorEndY }
    );
  }

  return { doorWall, plainWalls };
}
