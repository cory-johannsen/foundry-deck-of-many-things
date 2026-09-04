const MODULE_ID = 'deck-of-many-more-things';

/**
 * A warrior built to match the character who drew the card.
 *
 * Knight used to take an actor out of the world, which meant conscripting a
 * creature that already had a place and a purpose in the campaign, and it
 * summoned a fixed 4th-level fighter regardless of who drew it. Neither is
 * right: the summons should be a stranger, and it should match the character
 * it serves.
 *
 * The statblock is built rather than picked because it cannot be picked. The
 * generic NPC compendium holds only 25 martial creatures, with nothing above
 * level 13 and nothing at all at 20 — precisely the levels most likely to be
 * drawing.
 *
 * The benchmarks below were derived from roughly 160 of the system's own
 * humanoid NPCs, level by level, rather than transcribed from the building
 * tables. At level 7 they give AC 25 and +18, which is what the system's own
 * Knight has.
 */

export { BENCHMARK, MIN_LEVEL, MAX_LEVEL, damageBonus, benchmarkFor } from './npc-benchmark.mjs';
import { benchmarkFor, damageBonus } from './npc-benchmark.mjs';

/**
 * Base walking speed by ancestry, read off pf2e.ancestries.
 *
 * Kept here so the template stays a pure function that can be tested without a
 * live Foundry; the handler looks the value up from the compendium when it can
 * and falls back to this. Most ancestries walk 25 feet, so anything unlisted
 * takes that.
 */
export const ANCESTRY_SPEED = {
  anadi: 25, android: 25, athamaru: 20, automaton: 25, 'awakened animal': 5,
  azarketi: 20, catfolk: 25, centaur: 30, conrasu: 25, dragonet: 20, dwarf: 20,
  elf: 30, fetchling: 25, fleshwarp: 25, ghoran: 25, gnome: 25, goblin: 25,
  goloma: 30, halfling: 25, hobgoblin: 25, human: 25, jotunborn: 25,
  kashrishi: 25, kholo: 25, kitsune: 25, kobold: 25, leshy: 25, lizardfolk: 25,
  merfolk: 5, minotaur: 25, nagaji: 25, orc: 25, poppet: 25, ratfolk: 25,
  samsaran: 25, sarangay: 25, shisk: 25, shoony: 25, skeleton: 25, sprite: 20,
  strix: 25, surki: 25, tanuki: 25, tengu: 25, tripkee: 25, vanara: 25,
  vishkanya: 25, wayang: 25, yaksha: 25, yaoguai: 25
};

export const DEFAULT_SPEED = 25;
/** Plate is heavy: PF2e docks 5 feet for it. */
export const PLATE_PENALTY = 5;
/** Nobody is left unable to move — Merfolk and Awakened Animals walk 5 to begin with. */
export const MIN_SPEED = 5;

/**
 * The warrior's speed: their ancestry's stride, less the cost of plate.
 *
 * A dwarf in plate is genuinely slower than a human in plate, and an elf
 * faster, which is the point of matching the ancestry at all. `base` lets the
 * caller supply a speed looked up live, for an ancestry newer than this table.
 */
export function speedFor(ancestryName, base = null) {
  const known = base ?? ANCESTRY_SPEED[String(ancestryName ?? '').toLowerCase()] ?? DEFAULT_SPEED;
  return Math.max(MIN_SPEED, known - PLATE_PENALTY);
}

/**
 * The ancestry the warrior shares with whoever drew the card.
 *
 * The card says they share your ancestry. A character whose sheet does not say
 * gets a human knight in plate, which is the picture the card is drawing.
 */
export function ancestryOf(actor) {
  const name = actor?.system?.details?.ancestry?.name
    ?? actor?.itemTypes?.ancestry?.[0]?.name
    ?? null;
  const trait = actor?.system?.details?.ancestry?.trait
    ?? (name ? name.toLowerCase() : null);
  return name
    ? { name, trait, matched: true }
    : { name: 'Human', trait: 'human', matched: false };
}

/** Ancestries with their own token art; anyone else gets the helmed generic. */
export const TOKEN_ART = new Set([
  'dwarf', 'human', 'tengu',                                    // the party
  'elf', 'gnome', 'goblin', 'halfling', 'leshy', 'orc'          // Player Core common
]);

/**
 * The token image for an ancestry.
 *
 * The compendium offers none — not one sampled martial NPC has token art, the
 * system's own Knight included — so these are generated. An ancestry without
 * its own picture gets a warrior whose face is inside a closed helm, which is
 * a deliberate answer rather than a missing one.
 */
export function tokenArtFor(ancestryName) {
  const slug = String(ancestryName ?? '').toLowerCase();
  const file = TOKEN_ART.has(slug) ? slug : 'generic';
  return `modules/${MODULE_ID}/assets/tokens/warrior-${file}.webp`;
}

/**
 * Build the NPC. Returns document data ready to create. Art is chosen from the
 * ancestry unless the caller overrides it.
 */
export function buildWarrior({ actor, level, ancestry = null, img = null,
                              baseSpeed = null } = {}) {
  const b = benchmarkFor(level ?? actor?.system?.details?.level?.value ?? 1);
  const anc = ancestry ?? ancestryOf(actor);
  const dmg = damageBonus(b.level);
  const name = `${anc.name} Warrior`;
  const art = img ?? tokenArtFor(anc.name);

  // A local id generator: this module builds plain data and is tested without
  // a live Foundry, so it cannot reach for foundry.utils.
  let seq = 0;
  const rollId = () => `dmg${(seq += 1)}${b.level}`;

  const strike = (label, die, type, bonusOffset = 0) => ({
    name: label,
    type: 'melee',
    img: 'systems/pf2e/icons/default-icons/melee.svg',
    system: {
      bonus: { value: b.atk + bonusOffset },
      damageRolls: { [rollId()]: { damage: `${die}+${dmg}`, damageType: type } },
      traits: { value: [], otherTags: [] },
      attackEffects: { value: [] },
      description: { value: '' },
      action: 'strike',
      subjectToMAP: true
    }
  });

  return {
    name,
    type: 'npc',
    img: art,
    prototypeToken: {
      name,
      disposition: 1,                      // an ally, not a monster
      actorLink: false,
      sight: { enabled: true },
      texture: { src: art }
    },
    system: {
      details: {
        level: { value: b.level },
        languages: { value: ['common'], details: '' },
        publicNotes: `<p>A ${anc.name.toLowerCase()} warrior in plate, sworn to your service `
          + `until death. Summoned by the Knight.</p>`,
        blurb: 'Sworn to your service'
      },
      traits: {
        value: [anc.trait, 'humanoid'].filter(Boolean),
        rarity: 'common',
        size: { value: 'med' }
      },
      abilities: { str: { mod: 4 }, dex: { mod: 2 }, con: { mod: 3 },
                   int: { mod: 0 }, wis: { mod: 2 }, cha: { mod: 1 } },
      attributes: {
        ac: { value: b.ac, details: 'plate armor' },
        hp: { value: b.hp, max: b.hp, temp: 0, details: '' },
        speed: { value: speedFor(anc.name, baseSpeed), otherSpeeds: [], details: 'plate armor' }
      },
      perception: { mod: b.per, senses: [], vision: true, details: '' },
      saves: {
        fortitude: { value: b.fort, saveDetail: '' },
        reflex: { value: Math.max(0, b.fort - 3), saveDetail: '' },
        will: { value: Math.max(0, b.fort - 2), saveDetail: '' }
      }
    },
    items: [
      strike('Longsword', '1d8', 'slashing'),
      strike('Gauntlet', '1d4', 'bludgeoning', -1)
    ],
    flags: { [MODULE_ID]: { summonedBy: 'knight', level: b.level } },
    ownership: { default: 0 }
  };
}
