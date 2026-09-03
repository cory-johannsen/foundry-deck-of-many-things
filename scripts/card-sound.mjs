import { playSound } from './audio.mjs';

const MODULE_ID = 'deck-of-many-more-things';
const SOUND_DIR = `modules/${MODULE_ID}/assets/sounds`;

/**
 * The sound a card makes when its effect lands.
 *
 * There are 59 distinct mechanics kinds across 66 cards, so keying sounds off
 * `mechanics.kind` would mean sourcing one file per card. Cards are grouped by
 * what the effect *feels* like instead — a boon, a curse, a summoning — which
 * is both far fewer files and the thing a listener actually reacts to. Two
 * cards that both hand you a magic item should sound alike.
 *
 * Any card can still have its own sound: set `sound` on the card in cards.json
 * (a path relative to the module root) and it wins over its group. Run
 * `node tools/sound-manifest.mjs` for what is needed and what is missing.
 */
export const SOUND_GROUPS = {
  boon: 'card-boon.ogg',
  treasure: 'card-treasure.ogg',
  item: 'card-item.ogg',
  restore: 'card-restore.ogg',
  transform: 'card-transform.ogg',
  arcane: 'card-arcane.ogg',
  query: 'card-query.ogg',
  meta: 'card-meta.ogg',
  summon_ally: 'card-summon-ally.ogg',
  summon_hostile: 'card-summon-hostile.ogg',
  teleport: 'card-teleport.ogg',
  curse: 'card-curse.ogg',
  loss: 'card-loss.ogg',
  calamity: 'card-calamity.ogg'
};

/** Every mechanics.kind belongs to exactly one group; a test enforces that. */
export const GROUP_BY_KIND = {
  // Gains that make a character straightforwardly better.
  stat_bump: 'boon',
  all_stats_bump: 'boon',
  hp_bump: 'boon',
  unarmored_defense: 'boon',
  skill_proficiencies: 'boon',
  xp_gain: 'boon',
  solo_kill_level_up: 'boon',
  learn_languages: 'boon',
  grant_telepathy: 'boon',
  three_cantrips: 'boon',
  spellcast_slotless: 'boon',
  element_immunity: 'boon',

  wealth_grant: 'treasure',

  magic_weapon_grant: 'item',
  armor_grant: 'item',
  ring_grant: 'item',
  rod_or_staff_grant: 'item',
  wondrous_grant: 'item',

  long_rest: 'restore',
  resurrection_grant: 'restore',

  // The body or its capabilities change.
  beast_form: 'transform',
  size_grow: 'transform',
  flight: 'transform',
  climb_speed: 'transform',
  speed_bonus: 'transform',
  age_shift: 'transform',
  alignment_flip: 'transform',

  wish: 'arcane',
  cast_time_stop_n: 'arcane',
  cast_gate_n: 'arcane',
  erase_event: 'arcane',

  map_query: 'query',
  sage_query: 'query',
  throne_persuasion: 'query',

  // Cards that act on the deck itself rather than the character.
  bonus_draws: 'meta',
  draw_two_keep_one: 'meta',
  stop_drawing_optional: 'meta',

  spawn_ally_npc: 'summon_ally',
  spawn_homunculus: 'summon_ally',
  spawn_wyrmling: 'summon_ally',

  spawn_hostile: 'summon_hostile',
  spawn_ooze: 'summon_hostile',
  random_hostile_npc: 'summon_hostile',
  revenant_hunter: 'summon_hostile',
  permanent_enemy: 'summon_hostile',
  avatar_of_death: 'summon_hostile',

  feywild_transport: 'teleport',
  trap_extraplanar: 'teleport',
  maze: 'teleport',

  // Something is inflicted and stays inflicted.
  stat_debuff: 'curse',
  save_penalty: 'curse',
  exhaustion: 'curse',
  restrain_no_spellcast: 'curse',
  petrify: 'curse',
  fiend_deal: 'curse',

  // Something is taken away.
  wealth_wipe: 'loss',
  xp_loss: 'loss',
  destroy_magic_items: 'loss',
  soul_trap: 'loss',

  drop_to_zero_hp: 'calamity',
  fall: 'calamity'
};

/** Used when a kind has no group — audible, so a gap is noticed, not silent. */
export const FALLBACK_GROUP = 'meta';

export function groupForCard(card) {
  return GROUP_BY_KIND[card?.mechanics?.kind] ?? FALLBACK_GROUP;
}

/**
 * The path to play for a card. A per-card `sound` wins; otherwise the group's
 * file. Paths already carrying a directory separator are taken as-is so a card
 * can point anywhere in the module.
 */
export function resolveCardSound(card) {
  const own = card?.sound;
  if (own) return own.includes('/') ? own : `${SOUND_DIR}/${own}`;
  return `${SOUND_DIR}/${SOUND_GROUPS[groupForCard(card)]}`;
}

/** Play a card's sound. Called only once an effect has actually been applied. */
export function playCardSound(card) {
  playSound(resolveCardSound(card));
}
