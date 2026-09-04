/**
 * What a competent NPC looks like at each level.
 *
 * Derived from roughly 160 of the system's own humanoid NPCs, level by level,
 * rather than transcribed from the building tables. At level 7 they give AC 25
 * and +18, which is what the system's own Knight has.
 *
 * This lived in warrior-template.mjs while Knight was the only card building a
 * creature from nothing. Skull's avatar of death is the second, and it needs
 * the same numbers for the same reason — the compendium has no creature to
 * pick — so they sit on their own rather than inside either card's template.
 */

/** Median AC, HP, attack bonus, Perception and Fortitude by level. */
export const BENCHMARK = {
  1:  { ac: 16, hp: 21,  atk: 9,  per: 6,  fort: 7 },
  2:  { ac: 17, hp: 38,  atk: 11, per: 9,  fort: 9 },
  3:  { ac: 20, hp: 45,  atk: 10, per: 9,  fort: 8 },
  4:  { ac: 21, hp: 60,  atk: 13, per: 11, fort: 10 },
  5:  { ac: 22, hp: 75,  atk: 13, per: 13, fort: 11 },
  6:  { ac: 24, hp: 95,  atk: 17, per: 15, fort: 13 },
  7:  { ac: 25, hp: 120, atk: 18, per: 16, fort: 17 },
  8:  { ac: 27, hp: 135, atk: 20, per: 16, fort: 17 },
  9:  { ac: 28, hp: 155, atk: 20, per: 18, fort: 18 },
  10: { ac: 30, hp: 180, atk: 22, per: 20, fort: 20 },
  11: { ac: 31, hp: 195, atk: 24, per: 21, fort: 18 },
  12: { ac: 32, hp: 230, atk: 25, per: 23, fort: 23 },
  13: { ac: 34, hp: 240, atk: 27, per: 25, fort: 23 },
  14: { ac: 36, hp: 255, atk: 28, per: 25, fort: 26 },
  15: { ac: 36, hp: 280, atk: 30, per: 29, fort: 27 },
  16: { ac: 39, hp: 300, atk: 32, per: 29, fort: 30 },
  17: { ac: 41, hp: 330, atk: 34, per: 31, fort: 30 },
  18: { ac: 42, hp: 350, atk: 35, per: 33, fort: 30 },
  19: { ac: 43, hp: 355, atk: 36, per: 35, fort: 33 },
  20: { ac: 45, hp: 375, atk: 38, per: 36, fort: 36 }
};

export const MIN_LEVEL = 1;
export const MAX_LEVEL = 20;

/**
 * Damage is the one figure not taken from the data. The medians jumped about —
 * 1d4 at level 9, 7d8 at 17 — because creatures carry different weapons, so
 * the dice say more about the weapon than the level. Fixing the weapon and
 * scaling the flat bonus is how PF2e builds these, and at level 7 it lands on
 * 1d8+8 against the system Knight's 1d8+10.
 */
export const damageBonus = (level) => Math.round(level * 0.95 + 1.5);

export function benchmarkFor(level) {
  const clamped = Math.min(Math.max(Math.round(level ?? 1), MIN_LEVEL), MAX_LEVEL);
  return { level: clamped, ...BENCHMARK[clamped] };
}
