/**
 * Pure XP/loot math for a resolved combat room — no Foundry deps, kept
 * separate from dungeon-combat.mjs the same way dungeon-deck.mjs stays
 * separate from dungeon-scene.mjs.
 */
import { xpFor } from './encounter-roster.mjs';

export function totalCombatXp(defeatedHostileLevels, partyLevel) {
  return defeatedHostileLevels.reduce((sum, level) => sum + xpFor(level - partyLevel), 0);
}

export function xpPerSurvivor(totalXp, partySize) {
  return partySize > 0 ? Math.floor(totalXp / partySize) : 0;
}
