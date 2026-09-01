import { rollFormula } from './dice.mjs';

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
  const { ability, delta_pf2e_mod = 1 } = params;
  if (ability === 'any') {
    return {
      mode: 'gm',
      log: `${card.name}: choose one ability score to boost (+${delta_pf2e_mod}).`,
      meta: { kind: 'stat_bump', requires: 'choose_ability', delta: delta_pf2e_mod }
    };
  }
  const path = `system.abilities.${ability}.mod`;
  const current = deepGet(actor, path) ?? 0;
  const next = Math.min(current + delta_pf2e_mod, PF2E_MOD_CAP);
  await api.updateActor(actor.id, { [path]: next });
  return {
    mode: 'auto',
    log: `${card.name}: ${ability.toUpperCase()} mod ${current} → ${next}`,
    mutations: [{ path, from: current, to: next }]
  };
}

async function autoApplyAllStatsBump({ actor, params, api, card }) {
  const { delta_pf2e_mod = 1 } = params;
  const updates = {};
  const mutations = [];
  for (const a of ['str', 'dex', 'con', 'int', 'wis', 'cha']) {
    const path = `system.abilities.${a}.mod`;
    const current = deepGet(actor, path) ?? 0;
    const next = Math.min(current + delta_pf2e_mod, PF2E_MOD_CAP);
    updates[path] = next;
    mutations.push({ path, from: current, to: next });
  }
  await api.updateActor(actor.id, updates);
  return { mode: 'auto', log: `${card.name}: +${delta_pf2e_mod} to every ability mod`, mutations };
}

async function autoApplyStatDebuff({ actor, params, api, card, rng }) {
  const { ability, delta_5e_formula } = params;
  const rolled = rollFormula(delta_5e_formula, rng);
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

async function autoApplySpeedBonus({ actor, params, api, card }) {
  const { walk_ft = 0 } = params;
  const path = 'system.attributes.speed.value';
  const cur = deepGet(actor, path) ?? 25;
  await api.updateActor(actor.id, { [path]: cur + walk_ft });
  return { mode: 'auto', log: `${card.name}: walk speed ${cur} → ${cur + walk_ft} ft` };
}

async function autoApplyClimbSpeed({ actor, params, api, card }) {
  const walk = deepGet(actor, 'system.attributes.speed.value') ?? 25;
  const others = deepGet(actor, 'system.attributes.speed.otherSpeeds') ?? [];
  const nextOthers = [...others.filter((o) => o.type !== 'climb'), { type: 'climb', value: walk }];
  await api.updateActor(actor.id, { 'system.attributes.speed.otherSpeeds': nextOthers });
  return { mode: 'auto', log: `${card.name}: climb speed ${walk} ft (matches walk)` };
}

async function autoApplyFlight({ actor, params, api, card }) {
  const { speed_ft = 30 } = params;
  const others = deepGet(actor, 'system.attributes.speed.otherSpeeds') ?? [];
  const nextOthers = [...others.filter((o) => o.type !== 'fly'), { type: 'fly', value: speed_ft }];
  await api.updateActor(actor.id, { 'system.attributes.speed.otherSpeeds': nextOthers });
  return { mode: 'auto', log: `${card.name}: fly speed ${speed_ft} ft` };
}

async function autoApplyExhaustion({ actor, params, api, card, rng }) {
  const levels = rollFormula(params.levels_formula ?? '1d3', rng);
  const conditions = params.pf2e_map?.[levels] ?? ['fatigued'];
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
    name: 'DOMMT.Effects.Prisoner.Label',
    system: { rules: [{ key: 'ActiveEffectLike', mode: 'override', path: 'system.attributes.spellcasting', value: false }] }
  });
  return { mode: 'auto', log: `${card.name}: Restrained; cannot cast spells` };
}

async function autoApplySavePenalty({ actor, params, api, card }) {
  const value = params.value ?? -2;
  await api.createEffect(actor.id, {
    type: 'effect',
    name: 'DOMMT.Effects.Euryale.Label',
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

  grant_telepathy: gmCard(),
  alignment_flip: gmCard(),
  beast_form: gmCard(),
  cast_time_stop_n: gmCard(),
  cast_gate_n: gmCard(),
  spawn_homunculus: gmCard(),
  age_shift: gmCard(),
  trap_extraplanar: gmCard(),
  element_immunity: gmCard(),
  erase_event: gmCard(),
  feywild_transport: gmCard(),
  fiend_deal: gmCard(),
  permanent_enemy: gmCard(),
  bonus_draws: gmCard(),
  xp_loss: gmCard(),
  xp_gain: gmCard(),
  wealth_grant: gmCard(),
  stop_drawing_optional: gmCard(),
  spawn_ally_npc: gmCard(),
  spawn_wyrmling: gmCard(),
  spawn_hostile: gmCard(),
  spawn_ooze: gmCard(),
  fall: gmCard(),
  spellcast_slotless: gmCard(),
  random_hostile_npc: gmCard(),
  sage_query: gmCard(),
  map_query: gmCard(),
  armor_grant: gmCard(),
  skill_proficiencies: gmCard(),
  avatar_of_death: gmCard(),
  keep_grant: gmCard(),
  resurrection_grant: gmCard(),
  draw_two_keep_one: gmCard(),
  unarmored_defense: gmCard(),
  revenant_hunter: gmCard(),
  soul_trap: gmCard(),
  three_cantrips: gmCard(),
  petrify: gmCard(),
  wondrous_grant: gmCard(),
  ring_grant: gmCard(),
  magic_weapon_grant: gmCard(),
  rod_or_staff_grant: gmCard(),
  throne_persuasion: gmCard(),
  destroy_magic_items: gmCard(),
  solo_kill_level_up: gmCard(),
  wish: gmCard(),
  moon: gmCard()
};

export async function applyCardEffect({ card, actor, api, rng = Math.random, autoApplyEnabled = true }) {
  const handler = HANDLERS[card.mechanics.kind];
  if (!handler) {
    throw new Error(`No handler for mechanics.kind=${card.mechanics.kind} (card=${card.id})`);
  }
  if (!actor || !autoApplyEnabled) {
    return { mode: 'gm', log: `${card.name}: manual resolution (no actor bound or auto-apply disabled).`, meta: { kind: 'manual' } };
  }
  return handler({ actor, params: card.mechanics.params ?? {}, api, rng, card });
}

export function hasHandler(kind) {
  return Object.prototype.hasOwnProperty.call(HANDLERS, kind);
}

function deepGet(obj, path) {
  return path.split('.').reduce((acc, key) => (acc == null ? undefined : acc[key]), obj);
}
