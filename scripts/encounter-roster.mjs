/**
 * Turns a resolved abstract encounter (from encounter-deck.mjs) into actual
 * PF2e creatures, via the live bestiary. Kept separate from encounter-deck.mjs
 * so the rules-heavy shuffle/special-card logic stays testable with no
 * Foundry globals, while this half takes `api` as a parameter — same
 * injectable-dependency shape as `draw-target.mjs` — so it can be tested with
 * a stub `findCreatures` instead of a live world.
 */

// Monster Core is tried first, same reasoning as the Dragon/Monstrosity card
// handlers: adventure bestiaries are full of named plot characters, and a
// randomly-generated encounter should not hand the party someone's villain.
const MONSTER_CORE_PACKS = ['pf2e.pathfinder-monster-core', 'pf2e.pathfinder-monster-core-2'];

// Troops and swarms are large by virtue of being many, which breaks "one
// slot = one creature/group" — excluded unconditionally, per the pf2e-data
// skill's guidance, regardless of what the GM's theme traits ask for.
const MANDATORY_EXCLUDE = ['troop', 'swarm'];

// How far above/below the exact partyLevel + levelOffset target a match may
// fall. PF2e bestiaries are sparse at any single level, so an exact-level-only
// query often comes back empty.
const LEVEL_TOLERANCE = 1;

// GM Core's "Building Creature Encounters": XP awarded for a creature at a
// given level relative to the party's. Advisory only — used to report an
// approximate severity, nothing is gated on it.
const RELATIVE_XP = { '-4': 10, '-3': 15, '-2': 20, '-1': 30, 0: 40, 1: 60, 2: 80, 3: 120, 4: 160 };

function xpFor(levelOffset) {
  const clamped = Math.max(-4, Math.min(4, levelOffset ?? 0));
  return RELATIVE_XP[clamped] ?? 40;
}

/**
 * `levelOffsetBias` shifts the target level band — a dungeon room's
 * depth-based difficulty ramp (see dungeon-deck.mjs's depthBiasFor).
 * `requireTrait` is a single ANDed restriction — a dungeon room's own
 * location flavor (dungeon-deck.mjs's locationTagAt) — layered on top of the
 * broader any-of `traits` list. When both a theme and a location restriction
 * are set and neither loosened attempt finds anything, the location tag is
 * the one kept: it's the room's own specific identity, so the broader
 * dungeon-wide theme yields first rather than starving the room to empty.
 */
async function pickCreature({
  api, partyLevel, levelOffset, traits, excludeTraits, rng, levelOffsetBias = 0, requireTrait = null
}) {
  const minLevel = partyLevel + levelOffset + levelOffsetBias - LEVEL_TOLERANCE;
  const maxLevel = partyLevel + levelOffset + levelOffsetBias + LEVEL_TOLERANCE;
  const excludeAll = [...new Set([...(excludeTraits ?? []), ...MANDATORY_EXCLUDE])];
  const look = (packs, useTraits) => api.findCreatures({
    minLevel, maxLevel, traits: useTraits ? traits : [], excludeTraits: excludeAll, packs, requireTrait
  });

  let pool = await look(MONSTER_CORE_PACKS, true);
  if (!pool.length) pool = await look(null, true);
  if (!pool.length && requireTrait) pool = await look(null, false);
  if (!pool.length) return null;
  return pool[Math.floor(rng() * pool.length)];
}

/**
 * Resolve every creature-track slot in `resolved` (from `dealEncounter`) into
 * a concrete bestiary entry.
 *
 * `group`: slots sharing a group id resolve to the *same* chosen creature,
 * repeated — a simplification of the book's more general "creatures that
 * work together" for phase 1 (good enough for "an encounter in this room";
 * revisit only if it reads wrong in play). Twins are treated the same way:
 * the book allows different creatures per twin, but one shared pick keeps
 * this phase simple.
 *
 * A slot with no bestiary match does not fail the whole encounter — it adds
 * a warning and is left out of the roster, matching the "place one yourself"
 * fallback the Dragon/Ooze/Monstrosity card handlers use.
 */
export async function resolveEncounterRoster({
  resolved, api, partyLevel, traits = [], excludeTraits = [], rng = Math.random,
  levelOffsetBias = 0, requireTrait = null
}) {
  const warnings = [];
  const groupChoice = new Map();
  let approxXp = 0;

  const pick = (levelOffset) => pickCreature({
    api, partyLevel, levelOffset, traits, excludeTraits, rng, levelOffsetBias, requireTrait
  });

  async function choiceFor(slot) {
    if (slot.group) {
      if (groupChoice.has(slot.group)) return groupChoice.get(slot.group);
      const chosen = await pick(slot.levelOffset);
      groupChoice.set(slot.group, chosen);
      return chosen;
    }
    return pick(slot.levelOffset);
  }

  const foes = [];
  for (const slot of resolved.foes ?? []) {
    const chosen = await choiceFor(slot);
    if (!chosen) {
      warnings.push(`No creature found for a level ${partyLevel + slot.levelOffset + levelOffsetBias} slot — place one yourself.`);
      continue;
    }
    const count = slot.countsAs ?? 1;
    foes.push({ pack: chosen.pack, id: chosen.id, name: chosen.name, level: chosen.level, count, group: slot.group ?? null });
    approxXp += xpFor(slot.levelOffset + levelOffsetBias) * count;
  }

  let friend = null;
  if (resolved.friend) {
    const chosen = await pick(resolved.friend.levelOffset);
    if (chosen) friend = { pack: chosen.pack, id: chosen.id, name: chosen.name, level: chosen.level };
    else warnings.push('No friendly creature found for the Friend card — place one yourself.');
  }

  let lurker = null;
  if (resolved.lurker) {
    const chosen = await pick(resolved.lurker.levelOffset);
    if (chosen) {
      lurker = { pack: chosen.pack, id: chosen.id, name: chosen.name, level: chosen.level };
      approxXp += xpFor(resolved.lurker.levelOffset + levelOffsetBias);
    } else warnings.push('No lurking creature found for the Lurker card — place one yourself.');
  }

  let twins = null;
  if (resolved.twins) {
    const [first] = resolved.twins;
    const chosen = await pick(first.levelOffset);
    if (chosen) {
      twins = resolved.twins.map(() => ({ pack: chosen.pack, id: chosen.id, name: chosen.name, level: chosen.level }));
      approxXp += xpFor(first.levelOffset + levelOffsetBias) * resolved.twins.length;
    } else warnings.push('No creature found for the Twin cards — place one yourself.');
  }

  return {
    foes, friend, lurker, twins,
    noncombat: resolved.noncombat ?? null,
    goal: resolved.goal ?? null,
    warnings,
    approxXp
  };
}
