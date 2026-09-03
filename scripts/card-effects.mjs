import { rollFormula } from './dice.mjs';
import { t } from './i18n.mjs';
import {
  applyXpGain, applyXpLoss, applyXpGainWithItem, applySoloKillLevelUp,
  applyWealthGrant, applyPetrify, applyFall, applySoulTrap,
  applyElementImmunity, applyGrantTelepathy, applyUnarmoredDefense,
  applyItemGrant, applyDestroyMagicItems, applySpawn,
  applyBonusDraws, applyStopDrawing, applyDrawTwoKeepOne, applyBeastForm,
  applyRandomHostileNpc
} from './card-handlers-extra.mjs';
import {
  applyTrackedUses, applySpellGrant, applySkillProficiencies, applyThronePersuasion,
  applyExile, applyNamedAdversary, applyAgeShift, applyAlignmentFlip
} from './card-handlers-narrative.mjs';

/**
 * Every mechanics.kind maps to a handler here.
 * Handler contract:
 *   ({ actor, params, card, rng, api }) => Promise<{ mode: 'auto'|'gm', log: string, mutations?: object[], meta?: object }>
 *
 * `mode: 'auto'` means the actor was mutated in place.
 * `mode: 'gm'` means we returned a description for a GM adjudication chat card.
 *
 * `api` provides thin Foundry-side hooks that are stubbable in tests:
 *   - api.updateActor(actorId, updates)                    -> patch actor.system
 *   - api.increaseCondition(actorId, condition, value)     -> PF2e condition helper
 *   - api.createEffect(actorId, effectData)                -> embed an effect item
 *   - api.postChatCard(payload)                            -> post a rich chat message
 */

const PF2E_MOD_CAP = 7;

async function autoApplyStatBump({ actor, params, api, card }) {
  const { ability, delta_mod = 1 } = params;
  if (ability === 'any') {
    return {
      mode: 'gm',
      log: `${card.name}: choose one ability score to boost (+${delta_mod}).`,
      meta: { kind: 'stat_bump', requires: 'choose_ability', delta: delta_mod }
    };
  }
  const path = `system.abilities.${ability}.mod`;
  const current = deepGet(actor, path) ?? 0;
  const next = Math.min(current + delta_mod, PF2E_MOD_CAP);
  await api.updateActor(actor.id, { [path]: next });
  return {
    mode: 'auto',
    log: `${card.name}: ${ability.toUpperCase()} mod ${current} → ${next}`,
    mutations: [{ path, from: current, to: next }]
  };
}

async function autoApplyAllStatsBump({ actor, params, api, card }) {
  const { delta_mod = 1 } = params;
  const updates = {};
  const mutations = [];
  for (const a of ['str', 'dex', 'con', 'int', 'wis', 'cha']) {
    const path = `system.abilities.${a}.mod`;
    const current = deepGet(actor, path) ?? 0;
    const next = Math.min(current + delta_mod, PF2E_MOD_CAP);
    updates[path] = next;
    mutations.push({ path, from: current, to: next });
  }
  await api.updateActor(actor.id, updates);
  return { mode: 'auto', log: `${card.name}: +${delta_mod} to every ability mod`, mutations };
}

async function autoApplyStatDebuff({ actor, params, api, card, rng }) {
  const { ability, delta_formula } = params;
  const rolled = rollFormula(delta_formula, rng);
  const deltaMod = Math.max(-PF2E_MOD_CAP, Math.floor(rolled / 2));
  const path = `system.abilities.${ability}.mod`;
  const current = deepGet(actor, path) ?? 0;
  const next = Math.max(current + deltaMod, -PF2E_MOD_CAP);
  await api.updateActor(actor.id, { [path]: next });
  return {
    mode: 'auto',
    log: `${card.name}: ${ability.toUpperCase()} mod ${current} → ${next} (rolled ${rolled}, translated to ${deltaMod})`,
    mutations: [{ path, from: current, to: next }]
  };
}

async function autoApplyHpBump({ actor, params, api, card }) {
  const { hp_bump = 0 } = params;
  const cur = deepGet(actor, 'system.attributes.hp.value') ?? 0;
  const max = deepGet(actor, 'system.attributes.hp.max') ?? 0;
  await api.updateActor(actor.id, {
    'system.attributes.hp.value': cur + hp_bump,
    'system.attributes.hp.max': max + hp_bump
  });
  return { mode: 'auto', log: `${card.name}: HP max ${max} → ${max + hp_bump}` };
}

async function autoApplySizeGrow({ actor, params, api, card, rng }) {
  const { grow_inches_formula, hp_bump = 0 } = params;
  const inches = rollFormula(grow_inches_formula, rng);
  const sizePath = 'system.traits.size.value';
  const current = deepGet(actor, sizePath) ?? 'med';
  const bigger = { tiny: 'sm', sm: 'med', med: 'lg', lg: 'huge', huge: 'grg', grg: 'grg' }[current] ?? 'lg';
  const updates = { [sizePath]: bigger };
  if (hp_bump) {
    const cur = deepGet(actor, 'system.attributes.hp.value') ?? 0;
    const max = deepGet(actor, 'system.attributes.hp.max') ?? 0;
    updates['system.attributes.hp.value'] = cur + hp_bump;
    updates['system.attributes.hp.max'] = max + hp_bump;
  }
  await api.updateActor(actor.id, updates);
  return { mode: 'auto', log: `${card.name}: grew ${inches}", size ${current} → ${bigger}, HP +${hp_bump}` };
}

/**
 * Movement in PF2e is derived, not stored.
 *
 * These three wrote to `system.attributes.speed`, which does not exist on a
 * character — the real data lives under `system.movement.speeds` and is
 * recomputed from ancestry and items every preparation, so a direct write is
 * discarded. Path reported "walk speed 25 → 35" on a character with a 30-foot
 * stride: the 25 was a fallback for the missing field, and the sheet never
 * moved.
 *
 * Speeds are therefore granted the way the system grants them, with rule
 * elements on an effect: FlatModifier against the land-speed selector for a
 * bonus, BaseSpeed for a movement type the character did not have. Both were
 * confirmed against a live sheet, including that BaseSpeed takes `selector`
 * rather than `type`.
 */
const landSpeedOf = (actor) => deepGet(actor, 'system.movement.speeds.land.value') ?? 25;

async function autoApplySpeedBonus({ actor, params, api, card }) {
  const { walk_ft = 0 } = params;
  const before = landSpeedOf(actor);
  await api.createEffect(actor.id, {
    type: 'effect',
    name: `Quickened Stride (+${walk_ft} ft)`,
    img: 'icons/magic/movement/trail-streak-zigzag-yellow.webp',
    system: {
      description: { value: `Your land Speed increases by ${walk_ft} feet.` },
      duration: { unit: 'unlimited' },
      rules: [{ key: 'FlatModifier', selector: 'land-speed', type: 'status', value: walk_ft }]
    }
  });
  return {
    mode: 'auto',
    log: `${card.name}: land Speed ${before} → ${before + walk_ft} ft`
  };
}

async function autoApplyClimbSpeed({ actor, api, card }) {
  const land = landSpeedOf(actor);
  await api.createEffect(actor.id, {
    type: 'effect',
    name: `Climb Speed (${land} ft)`,
    img: 'icons/magic/control/buff-flight-wings-runes-blue-white.webp',
    system: {
      description: { value: `You gain a climb Speed equal to your land Speed.` },
      duration: { unit: 'unlimited' },
      rules: [{ key: 'BaseSpeed', selector: 'climb', value: land }]
    }
  });
  return { mode: 'auto', log: `${card.name}: climb Speed ${land} ft, matching your land Speed` };
}

async function autoApplyFlight({ actor, params, api, card }) {
  const { speed_ft = 30 } = params;
  await api.createEffect(actor.id, {
    type: 'effect',
    name: `Fly Speed (${speed_ft} ft)`,
    img: 'icons/magic/air/wind-swirl-gray-blue.webp',
    system: {
      description: { value: `You gain a fly Speed of ${speed_ft} feet.` },
      duration: { unit: 'unlimited' },
      rules: [{ key: 'BaseSpeed', selector: 'fly', value: speed_ft }]
    }
  });
  return { mode: 'auto', log: `${card.name}: fly Speed ${speed_ft} ft` };
}

async function autoApplyExhaustion({ actor, params, api, card, rng }) {
  const levels = rollFormula(params.levels_formula ?? '1d3', rng);
  const conditions = params.condition_map?.[levels] ?? ['fatigued'];
  for (const cond of conditions) {
    if (cond.startsWith('drained_')) {
      const n = parseInt(cond.split('_')[1], 10);
      await api.increaseCondition(actor.id, 'drained', n);
    } else {
      await api.increaseCondition(actor.id, cond, 1);
    }
  }
  return { mode: 'auto', log: `${card.name}: rolled ${levels} exhaustion → ${conditions.join(', ')}` };
}

async function autoApplyDropToZeroHp({ actor, api, card }) {
  await api.updateActor(actor.id, { 'system.attributes.hp.value': 0 });
  await api.increaseCondition(actor.id, 'dying', 1);
  return { mode: 'auto', log: `${card.name}: dropped to 0 HP, Dying 1` };
}

async function autoApplyRestrainNoSpellcast({ actor, api, card }) {
  await api.increaseCondition(actor.id, 'restrained', 1);
  await api.createEffect(actor.id, {
    type: 'effect',
    name: t('DOMMT.Effects.Prisoner.Label', 'Restrained (Prisoner)'),
    img: 'icons/magic/control/energy-stream-link-white.webp',
    system: {
      description: { value: 'Bound by unseen forces. You are Restrained and cannot cast spells '
        + 'until you are freed.' },
      duration: { unit: 'unlimited' },
      // No rule element. The previous one overrode system.attributes.spellcasting,
      // which does not exist on a PF2e character, so it did nothing. PF2e has no
      // flag for "cannot cast", so the restriction is stated for the table to
      // enforce rather than faked with a write that goes nowhere.
      rules: []
    }
  });
  return { mode: 'auto', log: `${card.name}: Restrained; cannot cast spells` };
}

async function autoApplySavePenalty({ actor, params, api, card }) {
  const value = params.value ?? -2;
  await api.createEffect(actor.id, {
    type: 'effect',
    name: t('DOMMT.Effects.Euryale.Label', 'Curse of Euryale (−2 to saves)'),
    system: {
      rules: [
        { key: 'FlatModifier', selector: 'saving-throw', type: 'status', value }
      ]
    }
  });
  return { mode: 'auto', log: `${card.name}: −${Math.abs(value)} status penalty to all saves (Curse of Euryale)` };
}

async function autoApplyLearnLanguages({ actor, params, api, card, rng }) {
  const count = rollFormula(params.count_formula ?? '1d6+2', rng);
  return {
    mode: 'gm',
    log: `${card.name}: learn ${count} languages of the player's choice.`,
    meta: { kind: 'learn_languages', count }
  };
}

async function autoApplyLongRest({ actor, api, card }) {
  const max = deepGet(actor, 'system.attributes.hp.max') ?? 0;
  await api.updateActor(actor.id, { 'system.attributes.hp.value': max });
  return { mode: 'auto', log: `${card.name}: HP restored to ${max}; daily preparations reset` };
}

async function autoApplyWealthWipe({ actor, api, card }) {
  await api.updateActor(actor.id, {
    'flags.deck-of-many-more-things.wealth_wiped_at': Date.now()
  });
  return {
    mode: 'gm',
    log: `${card.name}: all non-magical wealth, portable property, and ownership documents disappear. GM should remove valuables from the inventory manually.`,
    meta: { kind: 'wealth_wipe' }
  };
}

function gmCard({ card, extra = {} } = {}) {
  return async ({ card: c }) => ({
    mode: 'gm',
    log: `${(c ?? card).name}: GM adjudication required — see chat card.`,
    meta: { kind: 'gm_only', ...extra }
  });
}

const HANDLERS = {
  stat_bump: autoApplyStatBump,
  all_stats_bump: autoApplyAllStatsBump,
  stat_debuff: autoApplyStatDebuff,
  hp_bump: autoApplyHpBump,
  size_grow: autoApplySizeGrow,
  speed_bonus: autoApplySpeedBonus,
  climb_speed: autoApplyClimbSpeed,
  flight: autoApplyFlight,
  exhaustion: autoApplyExhaustion,
  drop_to_zero_hp: autoApplyDropToZeroHp,
  restrain_no_spellcast: autoApplyRestrainNoSpellcast,
  save_penalty: autoApplySavePenalty,
  learn_languages: autoApplyLearnLanguages,
  long_rest: autoApplyLongRest,
  wealth_wipe: autoApplyWealthWipe,

  grant_telepathy: applyGrantTelepathy,
  alignment_flip: applyAlignmentFlip,
  beast_form: applyBeastForm,
  cast_time_stop_n: applyTrackedUses,
  cast_gate_n: applyTrackedUses,
  spawn_homunculus: applySpawn,
  age_shift: applyAgeShift,
  trap_extraplanar: applyExile,
  element_immunity: applyElementImmunity,
  erase_event: applyTrackedUses,
  feywild_transport: applyExile,
  fiend_deal: applyNamedAdversary,
  permanent_enemy: applyNamedAdversary,
  bonus_draws: applyBonusDraws,
  xp_loss: applyXpLoss,
  xp_gain: applyXpGainWithItem,
  wealth_grant: applyWealthGrant,
  stop_drawing_optional: applyStopDrawing,
  spawn_ally_npc: applySpawn,
  spawn_wyrmling: applySpawn,
  spawn_hostile: applySpawn,
  spawn_ooze: applySpawn,
  fall: applyFall,
  spellcast_slotless: applySpellGrant,
  random_hostile_npc: applyRandomHostileNpc,
  sage_query: applyTrackedUses,
  map_query: applyTrackedUses,
  armor_grant: applyItemGrant,
  skill_proficiencies: applySkillProficiencies,
  avatar_of_death: applySpawn,
  keep_grant: gmCard(),
  resurrection_grant: applyTrackedUses,
  draw_two_keep_one: applyDrawTwoKeepOne,
  unarmored_defense: applyUnarmoredDefense,
  revenant_hunter: applySpawn,
  soul_trap: applySoulTrap,
  three_cantrips: applySpellGrant,
  petrify: applyPetrify,
  wondrous_grant: applyItemGrant,
  ring_grant: applyItemGrant,
  magic_weapon_grant: applyItemGrant,
  rod_or_staff_grant: applyItemGrant,
  throne_persuasion: applyThronePersuasion,
  destroy_magic_items: applyDestroyMagicItems,
  solo_kill_level_up: applySoloKillLevelUp,
  wish: applyTrackedUses,
  moon: gmCard()
};

/**
 * Cards that take something away, or put something hostile on the table.
 *
 * These never apply on the draw itself. They post pending, and the GM sees the
 * concrete outcome — the damage rolled, the items about to burn, the creature
 * about to appear — before anything is written. Gains apply silently, because
 * nobody needs protecting from being handed a magic sword.
 *
 * The six that were already automated (drop_to_zero_hp and friends) are in
 * here too. They were applying silently before this list existed, which was an
 * oversight rather than a decision: a card that drops a character to 0 HP with
 * no prompt is exactly what this gate is for.
 */
export const REQUIRES_CONFIRMATION = new Set([
  'xp_loss', 'fall', 'petrify', 'soul_trap', 'destroy_magic_items', 'beast_form',
  'drop_to_zero_hp', 'stat_debuff', 'save_penalty', 'exhaustion',
  'restrain_no_spellcast', 'wealth_wipe',
  'trap_extraplanar', 'feywild_transport', 'age_shift', 'alignment_flip', 'permanent_enemy',
  'fiend_deal',   // indifferent, but it still puts a creature on the map
  'spawn_hostile', 'spawn_ooze', 'random_hostile_npc',
  'revenant_hunter', 'avatar_of_death'
]);

export function requiresConfirmation(kind) {
  return REQUIRES_CONFIRMATION.has(kind);
}

/**
 * `confirmGate` is what separates drawing from resolving. The draw path leaves
 * it on, so a destructive card stops at "pending" without its handler ever
 * running. The planner turns it off, because by then the GM has clicked Apply
 * and is being shown what the handler would do.
 */
export async function applyCardEffect({
  card, actor, api, rng = Math.random, autoApplyEnabled = true, confirmGate = true
}) {
  const handler = HANDLERS[card.mechanics.kind];
  if (!handler) {
    throw new Error(`No handler for mechanics.kind=${card.mechanics.kind} (card=${card.id})`);
  }
  if (!actor || !autoApplyEnabled) {
    return { mode: 'gm', log: `${card.name}: manual resolution (no actor bound or auto-apply disabled).`, meta: { kind: 'manual' } };
  }
  if (confirmGate && requiresConfirmation(card.mechanics.kind)) {
    return {
      mode: 'gm',
      log: `${card.name}: needs GM confirmation before it is applied.`,
      meta: { kind: 'needs_confirm' }
    };
  }
  return handler({ actor, params: card.mechanics.params ?? {}, api, rng, card });
}

export function hasHandler(kind) {
  return Object.prototype.hasOwnProperty.call(HANDLERS, kind);
}

function deepGet(obj, path) {
  return path.split('.').reduce((acc, key) => (acc == null ? undefined : acc[key]), obj);
}
