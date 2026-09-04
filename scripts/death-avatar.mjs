import { benchmarkFor, damageBonus } from './npc-benchmark.mjs';

const MODULE_ID = 'deck-of-many-more-things';

/**
 * The avatar of death Skull summons.
 *
 * Built rather than found, for the same reason Knight's warrior is: there is
 * nothing to find. PF2e has no avatar of death. The card went to the shared
 * spawner for any undead of level 8 to 16, which in the installed bestiaries
 * answers with a Skeletal Horse, a Wolf Skeleton or a Tyrannosaurus Skeleton —
 * all undead, none of them death itself. The card describes one specific
 * thing, "a ghostly humanoid skeleton clad in a tattered black robe", and that
 * is what should arrive.
 *
 * There are creatures with the right idea — Lesser Death at 16, Grim Reaper at
 * 21 — and they are the reason this is built instead of laddered to them. The
 * card says the avatar comes for the character who drew it and that the others
 * must stand aside. A Grim Reaper against a level 3 character is not a duel,
 * it is a formality. The avatar therefore arrives at the drawer's own level,
 * which for a single character fighting alone is already a severe fight.
 *
 * The statblock is the ordinary NPC benchmark for that level with the numbers
 * pushed toward offence: it hits like a creature of its level and is a little
 * easier to put down than one, because the card is a fight to be won rather
 * than a sentence to be served.
 */

/** Death is not fought at a disadvantage of levels; it meets you at your own. */
export const DEATH_ART = `modules/${MODULE_ID}/assets/tokens/avatar-of-death.webp`;

/** How the avatar differs from a plain NPC of its level. */
export const AC_RELIEF = 2;         // easier to hit than its level suggests
export const HP_SHARE = 0.8;        // and rather easier to put down
export const ATTACK_EDGE = 1;       // but it does not miss

export function buildAvatarOfDeath({ actor, level = null } = {}) {
  const b = benchmarkFor(level ?? actor?.system?.details?.level?.value ?? 1);
  const dmg = damageBonus(b.level);

  let seq = 0;
  const rollId = () => `dmg${(seq += 1)}${b.level}`;

  const strike = (name, die, type, offset = 0) => ({
    name,
    type: 'melee',
    img: 'systems/pf2e/icons/default-icons/melee.svg',
    system: {
      bonus: { value: b.atk + ATTACK_EDGE + offset },
      damageRolls: { [rollId()]: { damage: `${die}+${dmg}`, damageType: type } },
      traits: { value: ['death', 'magical'], otherTags: [] },
      attackEffects: { value: [] },
      description: { value: '' },
      action: 'strike',
      subjectToMAP: true
    }
  });

  const hp = Math.max(10, Math.round(b.hp * HP_SHARE));

  return {
    name: 'Avatar of Death',
    type: 'npc',
    img: DEATH_ART,
    prototypeToken: {
      name: 'Avatar of Death',
      disposition: -1,
      actorLink: false,
      sight: { enabled: true },
      texture: { src: DEATH_ART }
    },
    system: {
      details: {
        level: { value: b.level },
        languages: { value: ['common'], details: 'understands all languages' },
        // The no-resurrection clause is written here rather than mechanised.
        // PF2e has no flag for it and raising the dead is a GM ruling in any
        // case; what the table needs is for it to be said plainly, on the
        // creature, where it will be read during the fight rather than after.
        publicNotes: '<p>A ghostly humanoid skeleton in a tattered black robe. It has come for '
          + 'the one who drew the card and warns the others to stand aside.</p>'
          + '<p><strong>Anyone it slays cannot be restored to life by any means short of a '
          + 'wish.</strong></p>',
        blurb: 'It has come for you alone'
      },
      traits: {
        value: ['undead', 'incorporeal', 'death'],
        rarity: 'unique',
        size: { value: 'med' }
      },
      abilities: { str: { mod: 5 }, dex: { mod: 4 }, con: { mod: 0 },
                   int: { mod: 2 }, wis: { mod: 4 }, cha: { mod: 5 } },
      attributes: {
        ac: { value: Math.max(10, b.ac - AC_RELIEF), details: '' },
        hp: { value: hp, max: hp, temp: 0, details: '' },
        speed: { value: 25, otherSpeeds: [{ type: 'fly', value: 25 }], details: '' },
        // Standard undead immunities. Incorporeal is in the traits above, so
        // the system's own rules for it apply without restating them here.
        immunities: [{ type: 'death-effects' }, { type: 'disease' }, { type: 'paralyzed' },
                     { type: 'poison' }, { type: 'unconscious' }]
      },
      perception: { mod: b.per, senses: [{ type: 'darkvision' }], vision: true, details: '' },
      saves: {
        fortitude: { value: b.fort, saveDetail: '' },
        reflex: { value: b.fort, saveDetail: '' },
        will: { value: b.fort + 2, saveDetail: '' }
      }
    },
    items: [
      strike('Scythe', '1d10', 'slashing'),
      strike('Reaping Touch', '1d6', 'void', -1)
    ],
    flags: { [MODULE_ID]: { summonedBy: 'skull', level: b.level } },
    ownership: { default: 0 }
  };
}
