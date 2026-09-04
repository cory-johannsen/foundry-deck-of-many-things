import { rollFormula } from './dice.mjs';
import { t } from './i18n.mjs';
import {
  applyXpGain, applyXpLoss, applyXpGainWithItem, applySoloKillLevelUp,
  applyWealthGrant, applyPetrify, applyFall, applySoulTrap,
  applyElementImmunity, applyGrantTelepathy, applyUnarmoredDefense,
  applyItemGrant, applyDestroyMagicItems,
  applyBonusDraws, applyStopDrawing, applyDrawTwoKeepOne, applyBeastForm, applySpawnAlly, applySpawnHomunculus, applySpawnDragon, applySpawnOoze, applySpawnMonstrosity, applySummonAvatarOfDeath,
  applyRandomHostileNpc
} from './card-handlers-extra.mjs';
import {
  applyTrackedUses, applySpellGrant, applySkillProficiencies, applyThronePersuasion,
  applyExile, applyNamedAdversary, applyAgeShift, applyMoralInversion,
  applyRevenantHunter
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

/** PF2e's size ladder, and the word CreatureSize wants for each rung. */
const SIZE_UP = { tiny: 'sm', sm: 'med', med: 'lg', lg: 'huge', huge: 'grg', grg: 'grg' };
const SIZE_WORD = { tiny: 'tiny', sm: 'small', med: 'medium', lg: 'large', huge: 'huge', grg: 'gargantuan' };

/**
 * Add inches to a height written the way a player writes one.
 *
 * The field is free text — 5'10", 70, "5 ft 10 in" — so this reads what it can
 * and leaves anything it cannot parse alone rather than overwriting it with a
 * guess.
 */
export function growHeight(current, inches) {
  const text = String(current ?? '').trim();
  if (!text) return null;
  const feetInches = /^(\d+)\s*(?:'|ft\.?|feet)\s*(\d+)?\s*(?:"|in\.?|inches)?$/i.exec(text);
  const plain = /^(\d+)\s*(?:"|in\.?|inches)?$/i.exec(text);
  let total = null;
  if (feetInches) total = Number(feetInches[1]) * 12 + Number(feetInches[2] ?? 0);
  else if (plain) total = Number(plain[1]);
  if (total == null || !Number.isFinite(total)) return null;
  const grown = total + inches;
  return `${Math.floor(grown / 12)}'${grown % 12}"`;
}

/**
 * Giant: you get bigger.
 *
 * Size and maximum HP are both derived in PF2e — writing system.traits.size or
 * system.attributes.hp.max is discarded on the next preparation, which is why
 * this card changed nothing at all: not the sheet, not the actor's size, not
 * the token. A CreatureSize rule element does the size properly and the token
 * scales itself from it; a FlatModifier on hp raises the maximum.
 *
 * Current HP is stored rather than derived, so it is written directly — the
 * card raises both, and a bigger maximum on its own would leave the character
 * wounded by the difference.
 *
 * Height is free text on the sheet and nothing was touching it.
 */
async function autoApplySizeGrow({ actor, params, api, card, rng }) {
  const { grow_inches_formula, hp_bump = 0 } = params;
  const inches = rollFormula(grow_inches_formula, rng);
  const current = deepGet(actor, 'system.traits.size.value') ?? 'med';
  const bigger = SIZE_UP[current] ?? 'lg';

  await api.createEffect(actor.id, {
    type: 'effect',
    name: `Giant's Growth (${SIZE_WORD[bigger]})`,
    img: 'icons/magic/control/energy-stream-link-white.webp',
    system: {
      description: { value: `You have grown ${inches} inches, to ${SIZE_WORD[bigger]} size, `
        + `and your maximum Hit Points increase by ${hp_bump}.` },
      duration: { unit: 'unlimited' },
      rules: [
        { key: 'CreatureSize', value: SIZE_WORD[bigger] },
        ...(hp_bump ? [{ key: 'FlatModifier', selector: 'hp', type: 'untyped', value: hp_bump }] : [])
      ]
    }
  });

  // Current HP and height are stored, so they are written.
  const updates = {};
  if (hp_bump) {
    const cur = deepGet(actor, 'system.attributes.hp.value') ?? 0;
    updates['system.attributes.hp.value'] = cur + hp_bump;
  }
  const height = deepGet(actor, 'system.details.height.value');
  const taller = growHeight(height, inches);
  if (taller) updates['system.details.height.value'] = taller;
  if (Object.keys(updates).length) await api.updateActor(actor.id, updates);

  const heightNote = taller ? `, height ${height} → ${taller}`
    : (height ? '' : ', no height recorded on the sheet');
  return {
    mode: 'auto',
    log: `${card.name}: grew ${inches}" to ${SIZE_WORD[bigger]} size, `
      + `+${hp_bump} HP${heightNote}`
  };
}

/**
 * Movement in PF2e is derived, not stored.
 *
 * These three wrote to `system.attributes.speed`, which does not exist on a
 * character — the real data lives under `system.movement.speeds` and is
 * recomputed from ancestry and items every preparation, so a direct write is
 * discarded. Speeds are therefore granted the way the system grants them, with
 * rule elements on an effect.
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

/**
 * Celestial: luminescent wings.
 *
 * The card describes wings that give off light, and the token should show it —
 * a flying character who lights nothing is only half the picture. PF2e's
 * TokenLight rule element does this on the same effect as the speed, so
 * removing the effect takes the glow with it.
 */
async function autoApplyFlight({ actor, params, api, card }) {
  const { speed_ft = 30, bright_ft = 20, dim_ft = 40 } = params;
  await api.createEffect(actor.id, {
    type: 'effect',
    name: `Luminescent Wings (${speed_ft} ft fly)`,
    img: 'icons/magic/air/wind-swirl-gray-blue.webp',
    system: {
      description: { value: `Wings of light carry you. You gain a fly Speed of ${speed_ft} feet `
        + `and shed bright light in a ${bright_ft}-foot radius, and dim light for ${dim_ft} feet.` },
      duration: { unit: 'unlimited' },
      rules: [
        { key: 'BaseSpeed', selector: 'fly', value: speed_ft },
        { key: 'TokenLight', value: { bright: bright_ft, dim: dim_ft, color: '#ffeeaa', alpha: 0.4 } }
      ]
    }
  });
  return {
    mode: 'auto',
    log: `${card.name}: fly Speed ${speed_ft} ft, and your token sheds `
      + `${bright_ft} ft of bright light`
  };
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

/**
 * Book: 1d6+2 languages, chosen by whoever is getting them.
 *
 * It used to roll the number and then post a chat card telling the GM to sort
 * it out. The count is rolled once and carried in `persist`, so re-planning
 * after the choice does not roll a different number than the one the question
 * was asked about, and the languages are picked in a single dialog — which for
 * a player-owned character opens on the player's own screen.
 */
async function autoApplyLearnLanguages({ actor, params, api, card, rng }) {
  const count = params.count ?? rollFormula(params.count_formula ?? '1d6+2', rng);
  const picked = params.languages;

  if (!Array.isArray(picked) || !picked.length) {
    const available = await api.listLanguages(actor.id);
    if (!available.length) {
      return {
        mode: 'gm',
        log: `${card.name}: no languages left to learn.`,
        meta: { kind: 'gm_only' }
      };
    }
    return {
      mode: 'gm',
      log: `${card.name}: choose ${count} language${count === 1 ? '' : 's'} to learn.`,
      meta: {
        kind: 'choose_many',
        requires: 'choose_many',
        paramKey: 'languages',
        count: Math.min(count, available.length),
        options: available,
        persist: { count }
      }
    };
  }

  const known = deepGet(actor, 'system.details.languages.value') ?? [];
  const next = Array.from(new Set([...known, ...picked]));
  await api.updateActor(actor.id, { 'system.details.languages.value': next });
  return {
    mode: 'auto',
    log: `${card.name}: learned ${picked.length} language(s) — ${picked.join(', ')}`,
    meta: { languages: picked }
  };
}

async function autoApplyLongRest({ actor, api, card }) {
  const max = deepGet(actor, 'system.attributes.hp.max') ?? 0;
  await api.updateActor(actor.id, { 'system.attributes.hp.value': max });
  return { mode: 'auto', log: `${card.name}: HP restored to ${max}; daily preparations reset` };
}

/**
 * Ruin: mundane wealth vanishes.
 *
 * It used to stamp a timestamp on the actor and ask the GM to empty the
 * inventory by hand, which is to say it did nothing. Coins and non-magical
 * valuables are now actually taken.
 *
 * Deliberately limited to coin and treasure. "Non-magical wealth" could be
 * read to include a mundane sword, but stripping someone's gear on a card that
 * reads as losing your money would be a nasty surprise; deeds and titles stay
 * narrative because there is nothing on a sheet to remove.
 */
/**
 * Ruin: mundane wealth vanishes.
 *
 * It used to stamp a timestamp on the actor and ask the GM to empty the
 * inventory by hand, which is to say it did nothing. Coins and non-magical
 * valuables are now actually taken.
 *
 * The card also destroys "documents that establish your ownership", which is
 * not an inventory matter: Throne hands out a deed to a keep as an effect, and
 * a character who draws Throne and then Ruin should lose it. Effects the
 * module marked as ownership documents are removed alongside the coin. The
 * deed is recognised by that mark rather than by its name, so renaming it does
 * not quietly break this.
 *
 * Deliberately limited otherwise. "Non-magical wealth" could be read to
 * include a mundane sword, but stripping someone's gear on a card that reads
 * as losing your money would be a nasty surprise.
 */
async function autoApplyWealthWipe({ actor, api, card }) {
  const coins = await api.getCoins(actor.id);
  const valuables = await api.listItems(actor.id, { types: ['treasure'], magical: 'exclude' });
  const deeds = (await api.listItems(actor.id, { types: ['effect'] }))
    .filter((i) => i.dommt?.kind === 'deed');
  const coinTotal = Object.entries(coins ?? {})
    .map(([d, n]) => `${n} ${d}`).filter((s) => !s.startsWith('0 '));

  if (coinTotal.length) await api.removeCoins(actor.id, coins);
  const doomed = [...valuables, ...deeds];
  if (doomed.length) await api.removeItems(actor.id, doomed.map((i) => i.id));

  if (!coinTotal.length && !doomed.length) {
    return { mode: 'auto', log: `${card.name}: nothing mundane left to lose` };
  }
  const parts = [];
  if (coinTotal.length) parts.push(coinTotal.join(', '));
  if (valuables.length) parts.push(`${valuables.length} valuable(s): ${valuables.map((i) => i.name).join(', ')}`);
  for (const deed of deeds) parts.push(`${deed.name}, torn up`);
  return {
    mode: 'auto',
    log: `${card.name}: lost ${parts.join('; ')}.`
      + (deeds.length ? '' : ' Deeds and titles are gone too — those are yours to narrate.')
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
  moral_inversion: applyMoralInversion,
  beast_form: applyBeastForm,
  cast_time_stop_n: applyTrackedUses,
  cast_gate_n: applyTrackedUses,
  spawn_homunculus: applySpawnHomunculus,
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
  spawn_ally_npc: applySpawnAlly,
  spawn_wyrmling: applySpawnDragon,
  spawn_hostile:      applySpawnMonstrosity,
  spawn_ooze:         applySpawnOoze,
  fall: applyFall,
  spellcast_slotless: applySpellGrant,
  random_hostile_npc: applyRandomHostileNpc,
  sage_query: applyTrackedUses,
  map_query: applyTrackedUses,
  armor_grant: applyItemGrant,
  skill_proficiencies: applySkillProficiencies,
  avatar_of_death:    applySummonAvatarOfDeath,
  keep_grant: gmCard(),
  resurrection_grant: applyTrackedUses,
  draw_two_keep_one: applyDrawTwoKeepOne,
  unarmored_defense: applyUnarmoredDefense,
  revenant_hunter: applyRevenantHunter,
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
 * Cards held back from applying on the draw.
 *
 * Empty, by decision: every card applies as it is turned over. The gate was
 * added on the reasoning that a destructive card should be seen before it
 * lands, and then emptied one card at a time in play, which is the better
 * evidence — each of them does one definite thing, so the prompt only ever sat
 * between drawing a card and seeing it work.
 *
 * The mechanism is kept rather than deleted. Adding a kind here is all it
 * takes to hold one back again, and the rest of the resolution flow — binding
 * an actor, asking a question, confirming before writing — is unaffected and
 * still runs for the cards that need it.
 */
export const REQUIRES_CONFIRMATION = new Set([]);

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
