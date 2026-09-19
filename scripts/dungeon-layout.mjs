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
 * forward-facing side, at its own independently-randomized offset. The
 * later room's facing side isn't wall-less any more (ITEM-9) — it gets a
 * plain opening (no door object, always passable) at its *own* independently
 * random offset, so the two ends of a connection often don't line up. The
 * shared 1-square-wide gap between them is enclosed by each room's own
 * gapped wall plus two fixed caps — see buildConnectionGeometry's docblock.
 */
import { splitmix32, seedFromString } from './prng.mjs';

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

const MAX_DOOR_OFFSET = ROOM_SIZE - DOOR_WIDTH;

/**
 * Deterministic offset (integer grid units, `[0, ROOM_SIZE - DOOR_WIDTH]`)
 * for one room's own door/opening along a connecting face. `role` is
 * `'outgoing'` (a room's own lockable door, into its connection to the next
 * slot) or `'incoming'` (a room's own plain opening, on the face receiving
 * the connection from the previous slot) — a room's incoming and outgoing
 * faces are almost always different sides, so these are two independent
 * seeded picks, same per-index convention as dungeon-deck.mjs's
 * `locationTagAt` — not two reads of the same value.
 */
export function doorOffsetAt(seed, slot, role) {
  const r = splitmix32(seedFromString(`${seed}-door-${role}-${slot}`))();
  return Math.floor(r * (MAX_DOOR_OFFSET + 1));
}

/**
 * Door geometry connecting `slot` to `slot + 1`, each end at its own
 * independent offset (`doorOffsetAt`) so the two doors often don't line up.
 *
 * Both ends are real Foundry doors. `slot`'s side (`doorWall`) is the
 * progress gate — locked/unlocked by the GM as today. `slot + 1`'s side
 * (`revealDoorWall`) starts merely closed, never locked — players can always
 * open it once they're through the first door — and *opening* it is what
 * reveals the next room and advances the tracker (see
 * dungeon-scene.mjs's handleDungeonDoorOpened), replacing the earlier
 * walk-into-the-room-boundary trigger with a real "open the door and see
 * what's inside" beat.
 *
 * Both rooms' own *wall* segments (the room's actual perimeter, minus that
 * room's own one-square gap) still span their entire connecting face,
 * regardless of where the other side's gap sits — a room's wall is a room's
 * wall. But the shared 1-square-wide gap *column* between the two faces is
 * only as tall (east/west) or wide (south) as it needs to be to connect the
 * two doors: two capping segments close it off at `min(doorY0, gapY0)` and
 * `max(doorY1, gapY1)` (transposed for south), not at the room's own
 * top/bottom or left/right edges (ITEM-13) — so two closely-offset doors get
 * a short connecting hallway and two far-apart doors get a longer one,
 * instead of every connection rendering as a fixed full-face gallery.
 * `corridorRect` matches that same trimmed span, tiled once per grid square
 * by dungeon-scene.mjs (corridor.webp is a small self-contained "box"
 * texture that looks wrong stretched, so repeating it beats scaling it).
 */
export function buildConnectionGeometry(slot, seed) {
  const dir = connectionDirection(slot);
  const { gx, gy, gw, gh } = slotRect(slot);
  const outgoingOffset = doorOffsetAt(seed, slot, 'outgoing');
  const incomingOffset = doorOffsetAt(seed, slot + 1, 'incoming');
  const plainWalls = [];
  let doorWall;
  let revealDoorWall;
  let corridorRect;

  if (dir === 'east' || dir === 'west') {
    const faceX = dir === 'east' ? gx + gw : gx;
    const corridorEndX = dir === 'east' ? faceX + CORRIDOR_LEN : faceX - CORRIDOR_LEN;
    const doorY0 = gy + outgoingOffset;
    const doorY1 = doorY0 + DOOR_WIDTH;
    const gapY0 = gy + incomingOffset;
    const gapY1 = gapY0 + DOOR_WIDTH;
    // The gap column only needs to span between the two doors, not the
    // room's full height (ITEM-13) — always within [gy, gy + gh] since both
    // offsets are already clamped to the room's face.
    const spanY0 = Math.min(doorY0, gapY0);
    const spanY1 = Math.max(doorY1, gapY1);
    doorWall = { x1: faceX, y1: doorY0, x2: faceX, y2: doorY1 };
    revealDoorWall = { x1: corridorEndX, y1: gapY0, x2: corridorEndX, y2: gapY1 };
    plainWalls.push(
      { x1: faceX, y1: gy, x2: faceX, y2: doorY0 },
      { x1: faceX, y1: doorY1, x2: faceX, y2: gy + gh },
      { x1: corridorEndX, y1: gy, x2: corridorEndX, y2: gapY0 },
      { x1: corridorEndX, y1: gapY1, x2: corridorEndX, y2: gy + gh },
      { x1: Math.min(faceX, corridorEndX), y1: spanY0, x2: Math.max(faceX, corridorEndX), y2: spanY0 },
      { x1: Math.min(faceX, corridorEndX), y1: spanY1, x2: Math.max(faceX, corridorEndX), y2: spanY1 }
    );
    corridorRect = { gx: Math.min(faceX, corridorEndX), gy: spanY0, gw: CORRIDOR_LEN, gh: spanY1 - spanY0 };
  } else {
    // 'south'
    const faceY = gy + gh;
    const corridorEndY = faceY + CORRIDOR_LEN;
    const doorX0 = gx + outgoingOffset;
    const doorX1 = doorX0 + DOOR_WIDTH;
    const gapX0 = gx + incomingOffset;
    const gapX1 = gapX0 + DOOR_WIDTH;
    // Same trim as the east/west branch, along x instead of y (ITEM-13).
    const spanX0 = Math.min(doorX0, gapX0);
    const spanX1 = Math.max(doorX1, gapX1);
    doorWall = { x1: doorX0, y1: faceY, x2: doorX1, y2: faceY };
    revealDoorWall = { x1: gapX0, y1: corridorEndY, x2: gapX1, y2: corridorEndY };
    plainWalls.push(
      { x1: gx, y1: faceY, x2: doorX0, y2: faceY },
      { x1: doorX1, y1: faceY, x2: gx + gw, y2: faceY },
      { x1: gx, y1: corridorEndY, x2: gapX0, y2: corridorEndY },
      { x1: gapX1, y1: corridorEndY, x2: gx + gw, y2: corridorEndY },
      { x1: spanX0, y1: Math.min(faceY, corridorEndY), x2: spanX0, y2: Math.max(faceY, corridorEndY) },
      { x1: spanX1, y1: Math.min(faceY, corridorEndY), x2: spanX1, y2: Math.max(faceY, corridorEndY) }
    );
    corridorRect = { gx: spanX0, gy: Math.min(faceY, corridorEndY), gw: spanX1 - spanX0, gh: CORRIDOR_LEN };
  }

  // A door/opening offset landing at either extreme (0 or MAX_DOOR_OFFSET)
  // leaves no room for the flanking segment on that side — drop the
  // resulting zero-length segment rather than create a degenerate Wall.
  const nonDegenerate = plainWalls.filter((w) => w.x1 !== w.x2 || w.y1 !== w.y2);
  return { doorWall, revealDoorWall, plainWalls: nonDegenerate, corridorRect };
}
