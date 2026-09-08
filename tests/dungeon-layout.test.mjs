import { describe, it, expect } from 'vitest';
import {
  ROOM_SIZE, ROOMS_PER_ROW, CORRIDOR_LEN,
  slotRowCol, slotRect, connectionDirection, roomEnclosureWalls, buildConnectionGeometry
} from '../scripts/dungeon-layout.mjs';

describe('slotRowCol / slotRect', () => {
  it('lays out a row west-to-east on even rows', () => {
    expect(slotRowCol(0)).toEqual({ row: 0, col: 0 });
    expect(slotRowCol(1)).toEqual({ row: 0, col: 1 });
    expect(slotRowCol(ROOMS_PER_ROW - 1)).toEqual({ row: 0, col: ROOMS_PER_ROW - 1 });
  });

  it('lays out the next row east-to-west (boustrophedon)', () => {
    expect(slotRowCol(ROOMS_PER_ROW)).toEqual({ row: 1, col: ROOMS_PER_ROW - 1 });
    expect(slotRowCol(ROOMS_PER_ROW + 1)).toEqual({ row: 1, col: ROOMS_PER_ROW - 2 });
    expect(slotRowCol(2 * ROOMS_PER_ROW - 1)).toEqual({ row: 1, col: 0 });
  });

  it('keeps every room the same fixed size', () => {
    for (const slot of [0, 3, 7, 12]) {
      const r = slotRect(slot);
      expect(r.gw).toBe(ROOM_SIZE);
      expect(r.gh).toBe(ROOM_SIZE);
    }
  });

  it('aligns a row wrap in the same column on both sides', () => {
    // The last room of row 0 and the first room of row 1 must share gx, so
    // the wrap connector is a straight vertical corridor, never a jog.
    const lastOfRow0 = slotRect(ROOMS_PER_ROW - 1);
    const firstOfRow1 = slotRect(ROOMS_PER_ROW);
    expect(firstOfRow1.gx).toBe(lastOfRow0.gx);

    const lastOfRow1 = slotRect(2 * ROOMS_PER_ROW - 1);
    const firstOfRow2 = slotRect(2 * ROOMS_PER_ROW);
    expect(firstOfRow2.gx).toBe(lastOfRow1.gx);
  });
});

describe('connectionDirection', () => {
  it('goes east across an even row, except the last room in the row', () => {
    for (let i = 0; i < ROOMS_PER_ROW - 1; i += 1) expect(connectionDirection(i)).toBe('east');
    expect(connectionDirection(ROOMS_PER_ROW - 1)).toBe('south');
  });

  it('goes west across an odd row, except the last room in the row', () => {
    for (let i = ROOMS_PER_ROW; i < 2 * ROOMS_PER_ROW - 1; i += 1) {
      expect(connectionDirection(i)).toBe('west');
    }
    expect(connectionDirection(2 * ROOMS_PER_ROW - 1)).toBe('south');
  });
});

describe('roomEnclosureWalls', () => {
  it('slot 0 has all four sides walled when it has an outgoing connection', () => {
    const walls = roomEnclosureWalls(0, { hasOutgoing: true });
    // hasOutgoing excludes the outgoing side; slot 0 has no incoming side to exclude.
    expect(walls).toHaveLength(3);
    expect(walls.map((w) => w.dir).sort()).toEqual(['north', 'south', 'west'].sort());
  });

  it('an interior slot excludes both its incoming and outgoing sides', () => {
    // Slot 1 (row 0): incoming from slot 0 is 'east' arriving, so slot 1's
    // incoming side is 'west'; outgoing to slot 2 is 'east'.
    const walls = roomEnclosureWalls(1, { hasOutgoing: true });
    const dirs = walls.map((w) => w.dir);
    expect(dirs).not.toContain('west');
    expect(dirs).not.toContain('east');
    expect(dirs.sort()).toEqual(['north', 'south']);
  });

  it('the final (goal) slot has no outgoing exclusion', () => {
    const lastOfRow0 = ROOMS_PER_ROW - 1;
    const walls = roomEnclosureWalls(lastOfRow0, { hasOutgoing: false });
    // Incoming side is 'west' (arriving eastward across the row).
    const dirs = walls.map((w) => w.dir);
    expect(dirs).not.toContain('west');
    expect(dirs.sort()).toEqual(['east', 'north', 'south'].sort());
  });
});

describe('buildConnectionGeometry', () => {
  it('places an east-facing door on the room\'s east edge, centered', () => {
    const { doorWall } = buildConnectionGeometry(0);
    const rect = slotRect(0);
    expect(doorWall.x1).toBe(rect.gx + rect.gw);
    expect(doorWall.x2).toBe(rect.gx + rect.gw);
    const midY = rect.gy + rect.gh / 2;
    expect((doorWall.y1 + doorWall.y2) / 2).toBeCloseTo(midY);
  });

  it('extends the corridor beyond the door by CORRIDOR_LEN', () => {
    const { plainWalls } = buildConnectionGeometry(0);
    const rect = slotRect(0);
    const closureXs = plainWalls.map((w) => Math.max(w.x1, w.x2));
    expect(Math.max(...closureXs)).toBe(rect.gx + rect.gw + CORRIDOR_LEN);
  });

  it('places a south-facing door for a row-wrap connection', () => {
    const wrapSlot = ROOMS_PER_ROW - 1;
    const { doorWall } = buildConnectionGeometry(wrapSlot);
    const rect = slotRect(wrapSlot);
    expect(doorWall.y1).toBe(rect.gy + rect.gh);
    expect(doorWall.y2).toBe(rect.gy + rect.gh);
  });

  it('never produces a door and a plain wall at the same coordinates', () => {
    for (const slot of [0, 1, ROOMS_PER_ROW - 1, ROOMS_PER_ROW]) {
      const { doorWall, plainWalls } = buildConnectionGeometry(slot);
      for (const w of plainWalls) {
        const same = w.x1 === doorWall.x1 && w.y1 === doorWall.y1
          && w.x2 === doorWall.x2 && w.y2 === doorWall.y2;
        expect(same).toBe(false);
      }
    }
  });
});
