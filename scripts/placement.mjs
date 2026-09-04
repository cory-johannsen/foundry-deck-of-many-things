/**
 * Where a summoned creature stands.
 *
 * Everything summoned used to land one square east of the character, which is
 * fine until it happens twice. Drawing Monstrosity and then Skull put a Large
 * witchwarg and an avatar of death on the same square, because each draw
 * measured from the character and neither looked at what was already there.
 *
 * So the square is searched for rather than computed: outward from the
 * character in rings, taking the first place the creature actually fits. A
 * Huge creature needs a three-by-three hole and will pass over gaps a Medium
 * one would have taken.
 *
 * All of this works in grid squares rather than pixels. Foundry stores token
 * positions in pixels and sizes in squares, and mixing the two is how a Large
 * creature ends up half a square off the grid.
 */

/** Do two footprints share any square? */
export function overlaps(a, b) {
  return a.gx < b.gx + b.gw && a.gx + a.gw > b.gx
      && a.gy < b.gy + b.gh && a.gy + a.gh > b.gy;
}

/** The squares a token covers, from its pixel position and its size. */
export function footprint(token, grid) {
  return {
    gx: Math.round((token.x ?? 0) / grid),
    gy: Math.round((token.y ?? 0) / grid),
    gw: Math.max(1, Math.round(token.width ?? 1)),
    gh: Math.max(1, Math.round(token.height ?? 1))
  };
}

/**
 * The nearest empty place for a creature of this size, searched ring by ring.
 *
 * The rings are square rather than circular — Chebyshev distance — because
 * that is how a grid measures adjacency, and a creature that appears
 * diagonally adjacent is as close as one that appears orthogonally.
 *
 * Returns null when nothing within `maxRing` fits, which the caller should
 * treat as "put it where it was going to go anyway": a creature placed on top
 * of something is still better than a card that silently does nothing.
 */
export function freeSpot({ occupied = [], gx, gy, gw = 1, gh = 1, maxRing = 8 } = {}) {
  for (let r = 1; r <= maxRing; r += 1) {
    for (let dy = -r; dy <= r; dy += 1) {
      for (let dx = -r; dx <= r; dx += 1) {
        // The ring's edge only; its interior was covered by a smaller r.
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
        const spot = { gx: gx + dx, gy: gy + dy, gw, gh };
        if (!occupied.some((o) => overlaps(spot, o))) return spot;
      }
    }
  }
  return null;
}

/**
 * The party's level, for cards that threaten everyone rather than one person.
 *
 * PF2e keeps an actual party actor, which is the right source: it knows who is
 * adventuring and leaves out the GM's test dummies. Falling back to every
 * character in the world would have counted an eighth-level actor named Nobody
 * as a party member and quadrupled what Monstrosity summons.
 */
export function partyLevelFrom(members) {
  const levels = (members ?? [])
    .map((m) => m?.system?.details?.level?.value)
    .filter((l) => Number.isFinite(l));
  if (!levels.length) return null;
  return Math.round(levels.reduce((a, b) => a + b, 0) / levels.length);
}
