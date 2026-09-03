import { rollFormula } from './dice.mjs';

/**
 * Handlers added when the deck's mechanics were automated.
 *
 * Kept beside the originals rather than inside them because these lean on the
 * wider api — compendium reads, coins, spawning — while the originals only
 * ever patched `actor.system`.
 *
 * Two conventions matter here:
 *
 *   Choices. A card that says "choose one" returns `mode: 'gm'` with
 *   `requires: 'choose_option'` and the options to pick from. The GM is asked,
 *   and the handler is re-run with the choice written into params. Nothing is
 *   applied on the first pass.
 *
 *   Picking at random. Handlers that select an item or creature do so while
 *   planning, and the pick is what gets recorded. Re-running would pick again
 *   and hand the GM something other than what they approved.
 */

const PF2E_MAX_LEVEL = 20;
const MODULE_ID = 'deck-of-many-more-things';

export function deepGet(obj, path) {
  return path.split('.').reduce((acc, key) => (acc == null ? undefined : acc[key]), obj);
}

/** Ask the GM to pick one of a fixed set, then re-run with it filled in. */
function needsChoice(card, key, options, prompt) {
  return {
    mode: 'gm',
    log: prompt,
    meta: { kind: 'choose_option', requires: 'choose_option', paramKey: key, options }
  };
}

const xpShape = (actor) => ({
  xp: deepGet(actor, 'system.details.xp.value') ?? 0,
  level: deepGet(actor, 'system.details.level.value') ?? 1,
  per: deepGet(actor, 'system.details.xp.max') || 1000
});

// ---------------------------------------------------------------------------
// Experience
// ---------------------------------------------------------------------------

/**
 * PF2e carries XP as progress toward the next level and resets it on level-up,
 * so a grant large enough to cross the threshold has to roll the level over
 * itself rather than leaving 2,000/1,000 sitting on the sheet.
 */
export async function applyXpGain({ actor, params, api, card }) {
  const gain = params.xp_pf2e ?? params.xp ?? 0;
  const { xp, level, per } = xpShape(actor);
  const total = xp + gain;
  const gained = Math.floor(total / per);
  const newLevel = Math.min(level + gained, PF2E_MAX_LEVEL);
  const remainder = newLevel === PF2E_MAX_LEVEL && level + gained > PF2E_MAX_LEVEL ? 0 : total % per;

  await api.updateActor(actor.id, {
    'system.details.xp.value': remainder,
    'system.details.level.value': newLevel
  });
  const levelNote = newLevel > level ? `, level ${level} → ${newLevel}` : '';
  return {
    mode: 'auto',
    log: `${card.name}: +${gain} XP (${xp} → ${remainder}/${per}${levelNote})`,
    mutations: [{ path: 'system.details.level.value', from: level, to: newLevel }]
  };
}

/** Losing XP drains levels downward, and cannot take a character below level 1. */
export async function applyXpLoss({ actor, params, api, card }) {
  const loss = params.xp_pf2e ?? params.xp ?? 0;
  const { xp, level, per } = xpShape(actor);
  let remaining = xp - loss;
  let newLevel = level;
  while (remaining < 0 && newLevel > 1) { newLevel -= 1; remaining += per; }
  if (remaining < 0) remaining = 0;   // level 1 floor: XP bottoms out, level does not

  await api.updateActor(actor.id, {
    'system.details.xp.value': remaining,
    'system.details.level.value': newLevel
  });
  const levelNote = newLevel < level ? `, level ${level} → ${newLevel}` : '';
  return {
    mode: 'auto',
    log: `${card.name}: −${loss} XP (${xp} → ${remaining}/${per}${levelNote})`,
    mutations: [{ path: 'system.details.level.value', from: level, to: newLevel }]
  };
}

/** Comet only pays out if its condition was met, which is the GM's call. */
export async function applySoloKillLevelUp({ actor, params, api, card }) {
  const levels = params.levels ?? 1;
  const { xp, level, per } = xpShape(actor);
  const newLevel = Math.min(level + levels, PF2E_MAX_LEVEL);
  await api.updateActor(actor.id, {
    'system.details.level.value': newLevel,
    'system.details.xp.value': xp
  });
  return {
    mode: 'auto',
    log: `${card.name}: level ${level} → ${newLevel} for defeating the next foe single-handedly`,
    mutations: [{ path: 'system.details.level.value', from: level, to: newLevel }]
  };
}

// ---------------------------------------------------------------------------
// Wealth
// ---------------------------------------------------------------------------

export async function applyWealthGrant({ actor, params, api, card, rng }) {
  // Gem offers a choice between two piles of identical total value.
  if (Array.isArray(params.choice)) {
    if (!params.chosen) {
      const options = params.choice.map((c, i) => ({
        value: String(i),
        label: `${c.count} ${c.kind} worth ${c.value_each_gp} gp each `
          + `(${(c.count * c.value_each_gp).toLocaleString()} gp)`
      }));
      return needsChoice(card, 'chosen', options, `${card.name}: choose which hoard appears.`);
    }
    const pick = params.choice[Number(params.chosen)] ?? params.choice[0];
    const gp = pick.count * pick.value_each_gp;
    await api.addCoins(actor.id, { gp });
    return { mode: 'auto', log: `${card.name}: ${pick.count} ${pick.kind} — ${gp.toLocaleString()} gp` };
  }

  // Mine rolls its hoard.
  const gems = rollFormula(params.gems_formula ?? '0', rng);
  const ore = rollFormula(params.ore_formula ?? '0', rng);
  const gp = gems * (params.gem_value_gp ?? 0) + ore * (params.ore_value_gp ?? 0);
  await api.addCoins(actor.id, { gp });
  return {
    mode: 'auto',
    log: `${card.name}: ${gems} gems + ${ore} ore — ${gp.toLocaleString()} gp`
  };
}

// ---------------------------------------------------------------------------
// Conditions and lasting effects
// ---------------------------------------------------------------------------

export async function applyPetrify({ api, actor, card }) {
  await api.increaseCondition(actor.id, 'petrified', 1);
  return {
    mode: 'auto',
    log: `${card.name}: petrified — removable only by remove petrification or a wish-tier ritual`
  };
}

/**
 * PF2e fall damage is half the distance fallen in bludgeoning, capped at 75,
 * and lands you prone. The card's 5e distance formula is kept as the source of
 * the distance, and only the damage conversion is PF2e's.
 */
export async function applyFall({ actor, params, api, card, rng }) {
  const feet = rollFormula(params.distance_ft_formula ?? '(3d6)*10', rng);
  const damage = Math.min(Math.floor(feet / 2), 75);
  const hp = deepGet(actor, 'system.attributes.hp.value') ?? 0;
  const next = Math.max(hp - damage, 0);
  await api.updateActor(actor.id, { 'system.attributes.hp.value': next });
  if (params.leaves_prone !== false) await api.increaseCondition(actor.id, 'prone', 1);
  return {
    mode: 'auto',
    log: `${card.name}: fell ${feet} ft — ${damage} bludgeoning (HP ${hp} → ${next}), prone`,
    mutations: [{ path: 'system.attributes.hp.value', from: hp, to: next }]
  };
}

export async function applySoulTrap({ actor, api, card }) {
  await api.createEffect(actor.id, {
    type: 'effect',
    name: 'Trapped Soul (Void)',
    img: 'icons/magic/unholy/orb-swirling-purple.webp',
    system: {
      description: { value: 'The body is soulless and inert. Only a wish reveals the gem\'s location.' },
      duration: { unit: 'unlimited' },
      rules: []
    }
  });
  await api.increaseCondition(actor.id, 'unconscious', 1);
  return {
    mode: 'auto',
    log: `${card.name}: soul trapped in a gem elsewhere; the body falls unconscious and soulless`
  };
}

export async function applyElementImmunity({ actor, params, api, card }) {
  const choices = params.choices ?? ['acid', 'cold', 'fire', 'electricity', 'sonic'];
  if (!params.element) {
    return needsChoice(card, 'element',
      choices.map((c) => ({ value: c, label: c })),
      `${card.name}: choose the element to become immune to.`);
  }
  await api.createEffect(actor.id, {
    type: 'effect',
    name: `Elemental Immunity (${params.element})`,
    img: 'icons/magic/defensive/shield-barrier-glowing-blue.webp',
    system: {
      description: { value: `Immune to ${params.element} damage.` },
      duration: { unit: 'unlimited' },
      rules: [{ key: 'Immunity', type: params.element }]
    }
  });
  return { mode: 'auto', log: `${card.name}: immune to ${params.element} damage` };
}

export async function applyGrantTelepathy({ actor, params, api, card }) {
  const range = params.range_ft ?? 90;
  await api.createEffect(actor.id, {
    type: 'effect',
    name: `Telepathy (${range} ft)`,
    img: 'icons/magic/control/hypnosis-mesmerism-eye.webp',
    system: {
      description: { value: `Communicate telepathically with any creature within ${range} feet.` },
      duration: { unit: 'unlimited' },
      rules: []
    }
  });
  return { mode: 'auto', log: `${card.name}: telepathy out to ${range} ft` };
}

/**
 * The 5e card sets unarmoured AC to 15+dex and adds fire vulnerability. PF2e
 * has no equivalent AC-setting, so this grants a +2 item-equivalent bonus while
 * unarmoured alongside the vulnerability, and says so plainly in the log.
 */
export async function applyUnarmoredDefense({ actor, params, api, card }) {
  await api.createEffect(actor.id, {
    type: 'effect',
    name: 'Barkskin (Tree)',
    img: 'icons/magic/nature/tree-oak-brown-green.webp',
    system: {
      description: { value: 'Bark-like skin toughens you, but burns readily.' },
      duration: { unit: 'unlimited' },
      rules: [
        { key: 'FlatModifier', selector: 'ac', type: 'item', value: 2,
          predicate: [{ not: 'self:armor' }] },
        { key: 'Weakness', type: 'fire', value: 5 }
      ]
    }
  });
  return {
    mode: 'auto',
    log: `${card.name}: +2 item bonus to AC while unarmoured, and weakness 5 to fire`
  };
}

// ---------------------------------------------------------------------------
// Item grants
// ---------------------------------------------------------------------------

const ITEM_TYPES = {
  magic_weapon_grant: ['weapon'],
  armor_grant: ['armor', 'shield'],
  ring_grant: ['equipment'],
  rod_or_staff_grant: ['weapon', 'equipment'],
  wondrous_grant: ['equipment', 'treasure']
};

const NAME_HINT = {
  ring_grant: 'ring',
  rod_or_staff_grant: '(rod|staff|wand)'
};

/**
 * Pick one item of the right shape out of the equipment compendium.
 *
 * PF2e has no "ring" or "rod" item type — they are all `equipment` — so those
 * cards fall back to matching the name, which is what actually distinguishes
 * them. If the filter finds nothing the card degrades to a GM decision rather
 * than granting something arbitrary.
 */
export async function applyItemGrant({ actor, params, api, card, rng }) {
  const kind = card.mechanics.kind;
  const types = ITEM_TYPES[kind] ?? ['equipment'];
  const minRarity = params.pf2e_rarity_min ?? 'uncommon';
  let pool = await api.findItems({ types, minRarity });

  const hint = NAME_HINT[kind];
  if (hint) {
    const re = new RegExp(hint, 'i');
    const narrowed = pool.filter((i) => re.test(i.name));
    if (narrowed.length) pool = narrowed;
  }

  if (!pool.length) {
    return {
      mode: 'gm',
      log: `${card.name}: no ${types.join('/')} of ${minRarity}+ rarity found in the compendium — grant one by hand.`,
      meta: { kind: 'gm_only' }
    };
  }

  const chosen = pool[Math.floor(rng() * pool.length)];
  await api.grantItems(actor.id, [{ pack: chosen.pack, id: chosen.id }]);
  return {
    mode: 'auto',
    log: `${card.name}: granted ${chosen.name} (level ${chosen.level} ${chosen.rarity})`,
    meta: { granted: chosen.name }
  };
}

/** Sun grants experience and an item, so it runs both halves. */
export async function applyXpGainWithItem(ctx) {
  const xp = await applyXpGain(ctx);
  if (!ctx.card.mechanics.params?.wondrous_item) return xp;
  const item = await applyItemGrant({
    ...ctx,
    card: { ...ctx.card, mechanics: { ...ctx.card.mechanics, kind: 'wondrous_grant' } }
  });
  return {
    mode: 'auto',
    log: `${xp.log}; ${item.log.replace(`${ctx.card.name}: `, '')}`,
    mutations: xp.mutations
  };
}

export async function applyDestroyMagicItems({ actor, api, card }) {
  const carried = await api.listItems(actor.id, {
    types: ['weapon', 'armor', 'shield', 'equipment', 'consumable', 'treasure'],
    magicalOnly: true
  });
  if (!carried.length) {
    return { mode: 'auto', log: `${card.name}: no magic items carried — nothing to destroy` };
  }
  await api.removeItems(actor.id, carried.map((i) => i.id));
  return {
    mode: 'auto',
    log: `${card.name}: destroyed ${carried.length} magic item(s) — ${carried.map((i) => i.name).join(', ')}`
  };
}

// ---------------------------------------------------------------------------
// Spawning
// ---------------------------------------------------------------------------

const SPAWN_SPECS = {
  spawn_ally_npc:     { name: '(fighter|warrior|guard|knight|mercenary)', level: [2, 6], friendly: true },
  spawn_homunculus:   { name: 'homunculus', level: [0, 3], friendly: true },
  spawn_wyrmling:     { name: 'dragon', level: [1, 6], friendly: true },
  spawn_ooze:         { name: '(ooze|cube|pudding|jelly)', level: [0, 12], friendly: false },
  spawn_hostile:      { name: null, level: [5, 12], friendly: false },
  random_hostile_npc: { name: null, level: [1, 8], friendly: false },
  revenant_hunter:    { name: '(revenant|undead|wraith|ghost)', level: [3, 10], friendly: false },
  avatar_of_death:    { name: '(death|reaper|wraith|spectre|specter)', level: [8, 16], friendly: false }
};

/**
 * Place a creature from the bestiary. The level band and name hint come from
 * the card; if nothing matches, the band is dropped before the card is given
 * up on, because an empty result is far more often a sparse compendium than a
 * card that should do nothing.
 */
export async function applySpawn({ actor, api, card, rng }) {
  const spec = SPAWN_SPECS[card.mechanics.kind] ?? { name: null, level: [1, 10], friendly: false };
  const [minLevel, maxLevel] = spec.level;
  let pool = await api.findCreatures({ minLevel, maxLevel, namePattern: spec.name });
  if (!pool.length && spec.name) pool = await api.findCreatures({ minLevel, maxLevel });
  if (!pool.length) pool = await api.findCreatures({});

  if (!pool.length) {
    return {
      mode: 'gm',
      log: `${card.name}: no bestiary creature available to place — add one by hand.`,
      meta: { kind: 'gm_only' }
    };
  }

  const chosen = pool[Math.floor(rng() * pool.length)];
  await api.spawnCreatures([{ pack: chosen.pack, id: chosen.id }], {
    nearActorId: actor.id,
    disposition: spec.friendly ? 1 : -1
  });
  return {
    mode: 'auto',
    log: `${card.name}: ${spec.friendly ? 'summoned' : 'unleashed'} ${chosen.name} `
      + `(level ${chosen.level}) onto the scene`,
    meta: { spawned: chosen.name }
  };
}

// ---------------------------------------------------------------------------
// Deck flow
// ---------------------------------------------------------------------------

/**
 * Jester offers XP or extra draws. The draws are the module's own business, so
 * they are recorded as a flag the draw loop reads rather than applied here.
 */
export async function applyBonusDraws({ actor, params, api, card }) {
  if (!params.chosen) {
    return needsChoice(card, 'chosen', [
      { value: 'xp', label: `Gain ${params.xp_alternative_pf2e ?? 1000} XP` },
      { value: 'draws', label: `Draw ${params.additional_draws ?? 2} additional cards` }
    ], `${card.name}: take the experience, or the extra draws?`);
  }
  if (params.chosen === 'xp') {
    return applyXpGain({
      actor, api, card,
      params: { xp_pf2e: params.xp_alternative_pf2e ?? 1000 }
    });
  }
  const extra = params.additional_draws ?? 2;
  await api.updateActor(actor.id, { [`flags.${MODULE_ID}.pendingExtraDraws`]: extra });
  return { mode: 'auto', log: `${card.name}: ${extra} additional draws granted` };
}

export async function applyStopDrawing({ actor, api, card }) {
  await api.updateActor(actor.id, { [`flags.${MODULE_ID}.mayStopDrawing`]: true });
  return {
    mode: 'auto',
    log: `${card.name}: you may stop drawing now, even with draws declared`
  };
}

export async function applyDrawTwoKeepOne({ actor, api, card }) {
  await api.updateActor(actor.id, { [`flags.${MODULE_ID}.drawTwoKeepOne`]: true });
  return {
    mode: 'auto',
    log: `${card.name}: draw two more cards and keep only one of them`
  };
}

// ---------------------------------------------------------------------------
// Battle form
// ---------------------------------------------------------------------------

const ANIMAL_FORM = /^Spell Effect: Animal Form \((.+)\)$/;

/**
 * Beast turns the character into a random beast for 2d12 days, replacing their
 * statistics with its own.
 *
 * PF2e already models exactly that. Its Animal Form spell effects carry a
 * BattleForm rule element that substitutes AC, attacks, senses and speeds, so
 * the transformation is a real mechanical change rather than a note asking the
 * GM to swap sheets. Borrowing one of those beats picking a creature out of the
 * bestiary, which would name an animal and change nothing — and the bestiary
 * only holds four animals at level 5 or below anyway, against thirteen forms.
 *
 * The effect's own duration is one minute, so the card's roll replaces it.
 */
export async function applyBeastForm({ actor, params, api, card, rng }) {
  const effects = await api.findItems({
    types: ['effect'], minRarity: 'common', packs: ['pf2e.spell-effects']
  });
  const forms = effects.filter((e) => ANIMAL_FORM.test(e.name));
  const days = rollFormula(params.duration_days_formula ?? '2d12', rng);

  if (!forms.length) {
    return {
      mode: 'gm',
      log: `${card.name}: no battle form available in the compendium — transform by hand `
        + `for ${days} days.`,
      meta: { kind: 'gm_only', days }
    };
  }

  const chosen = forms[Math.floor(rng() * forms.length)];
  const beast = ANIMAL_FORM.exec(chosen.name)?.[1] ?? chosen.name;
  await api.grantItems(actor.id, [{
    pack: chosen.pack,
    id: chosen.id,
    updates: {
      name: `Beast Form (${beast})`,
      'system.duration': { value: days, unit: 'days', expiry: 'turn-start', sustained: false }
    }
  }]);
  return {
    mode: 'auto',
    log: `${card.name}: transformed into a ${beast.toLowerCase()} for ${days} days `
      + `— statistics replaced by the battle form`,
    meta: { form: beast, days }
  };
}
