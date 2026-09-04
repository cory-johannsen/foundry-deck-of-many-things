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
 * XP is banked, not spent on levels.
 *
 * An earlier version rolled a grant into levels itself and wrote back the
 * remainder. That was wrong twice over. Levelling in PF2e is not a number
 * going up: it carries feats, attribute boosts and skill increases the player
 * chooses, and setting `level.value` skips all of them — so a character became
 * level 6 with a level 5 build. It was also invisible, because grants are
 * whole multiples of 1,000: adding 1,000 to 200 left 200 on the sheet with
 * only the level moving, which reads as "no XP was awarded".
 *
 * PF2e accepts XP above the threshold, so 2,200/1,000 simply sits there and
 * the sheet offers its own level-up. That is the flow that builds the
 * character properly.
 */
export async function applyXpGain({ actor, params, api, card }) {
  const gain = params.xp ?? 0;
  const { xp, level, per } = xpShape(actor);
  const total = xp + gain;
  const pending = Math.floor(total / per);

  await api.updateActor(actor.id, { 'system.details.xp.value': total });
  const ready = pending > 0 && level < PF2E_MAX_LEVEL
    ? ` — enough to level up ${pending > 1 ? `${pending} times` : 'once'}`
    : '';
  return {
    mode: 'auto',
    log: `${card.name}: +${gain} XP (${xp} → ${total}/${per})${ready}`,
    mutations: [{ path: 'system.details.xp.value', from: xp, to: total }]
  };
}

/** Losing XP drains levels downward, and cannot take a character below level 1. */
export async function applyXpLoss({ actor, params, api, card }) {
  const loss = params.xp ?? 0;
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
  // Gem offers two piles of identical total value, so which one appears is
  // flavour rather than a decision — the hoard is rolled instead of asked
  // about. An explicit `chosen` still wins, for a GM who wants to pick.
  if (Array.isArray(params.choice)) {
    const index = params.chosen != null
      ? Number(params.chosen)
      : Math.floor(rng() * params.choice.length);
    const pick = params.choice[index] ?? params.choice[0];
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
 * Fall damage is half the distance fallen, as bludgeoning, capped at 75, and
 * lands you prone. The card supplies the distance; the rest is the system's.
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
    img: 'icons/magic/unholy/strike-body-life-soul-purple.webp',
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
 * Bark-like skin: a +2 item bonus to AC while unarmoured, paid for with a
 * weakness to fire. There is no way to *set* an unarmoured AC outright, so the
 * bonus is the closest equivalent, and the log says exactly what was applied.
 */
export async function applyUnarmoredDefense({ actor, params, api, card }) {
  await api.createEffect(actor.id, {
    type: 'effect',
    name: 'Barkskin (Tree)',
    img: 'icons/magic/nature/leaf-armor-scale-green.webp',
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

/** What a rune is etched onto, by the usage PF2e records on it. */
const ETCH_TARGET = {
  'etched-onto-a-weapon': 'weapon',
  'etched-onto-a-melee-weapon': 'weapon',
  'etched-onto-a-thrown-weapon': 'weapon',
  'etched-onto-armor': 'armor',
  'etched-onto-a-shield': 'shield'
};

export const runeTargetOf = (item) => ETCH_TARGET[item?.usage] ?? null;

/**
 * Potency, striking and resilient are fundamental runes: they live in their own
 * fields, not in the property list, so etching one as a property does nothing.
 * They are also not wondrous items by any reading, so they leave the pool.
 */
const FUNDAMENTAL_RUNE = /potency|striking|resilient/i;
export const isFundamentalRune = (item) =>
  !!runeTargetOf(item) && FUNDAMENTAL_RUNE.test(item?.slug ?? '');

/**
 * Pick one item of the right shape out of the equipment compendium.
 *
 * Rarity alone does not mean magic. Of 644 uncommon-or-better weapons in the
 * SRD, only 258 carry the `magical` trait; the rest are mundane exotics —
 * which is how Key, asked for a magic weapon, granted a level 0 Thundermace.
 * The magical trait is therefore required, never traded away.
 *
 * Runes are the other trap. Giant-Killing is a property rune, but PF2e models
 * it as plain `equipment` with no trait to tell it apart — only its usage,
 * "etched-onto-a-weapon", gives it away. Granted as an object it is inert,
 * because it is not a thing you carry; it is a property of a weapon. So a rune
 * is etched onto what the character is actually wielding, and if they are
 * wielding nothing it can go on, the card picks something else instead.
 *
 * Level is scaled to the recipient. Without it the pool runs from level 0 to
 * 20 and a 5th-level character is as likely to be handed a 19th-level staff as
 * anything they could use.
 *
 * PF2e has no "ring" or "rod" item type — they are all `equipment` — so those
 * cards match on name as well, which is what actually distinguishes them.
 */
export async function applyItemGrant({ actor, params, api, card, rng }) {
  const kind = card.mechanics.kind;
  const types = ITEM_TYPES[kind] ?? ['equipment'];
  const minRarity = params.rarity_min ?? 'uncommon';
  const level = deepGet(actor, 'system.details.level.value') ?? 1;
  const hint = NAME_HINT[kind];
  const re = hint ? new RegExp(hint, 'i') : null;

  const narrow = (pool) => {
    if (!re) return pool;
    const hit = pool.filter((i) => re.test(i.name));
    return hit.length ? hit : pool;
  };
  const magicalOnly = (pool) => pool.filter((i) => (i.traits ?? []).includes('magical'));

  let pool = magicalOnly(narrow(await api.findItems({ types, minRarity, maxLevel: level + 3 })));
  let widened = false;
  if (!pool.length) {
    pool = magicalOnly(narrow(await api.findItems({ types, minRarity })));
    widened = pool.length > 0;
  }

  // A rune is only worth granting if there is something to put it on, and a
  // fundamental rune cannot be a property rune at all.
  const gear = await api.listGear(actor.id);
  const canEtch = (item) => {
    const target = runeTargetOf(item);
    if (!target) return true;                       // not a rune: always fine
    if (isFundamentalRune(item)) return false;
    return gear.some((g) => g.type === (target === 'shield' ? 'armor' : target));
  };
  const usable = pool.filter(canEtch);
  if (usable.length) pool = usable;

  if (!pool.length) {
    return {
      mode: 'gm',
      log: `${card.name}: no magical ${types.join('/')} of ${minRarity}+ rarity in the compendium `
        + `— grant one by hand.`,
      meta: { kind: 'gm_only' }
    };
  }

  const chosen = pool[Math.floor(rng() * pool.length)];
  const target = runeTargetOf(chosen);

  if (target) {
    const wanted = target === 'shield' ? 'armor' : target;
    const candidates = gear.filter((g) => g.type === wanted);
    const onto = candidates.find((g) => g.wielded) ?? candidates[0];
    if (onto) {
      await api.etchRune(actor.id, onto.id, chosen.slug ?? chosen.name);
      return {
        mode: 'auto',
        log: `${card.name}: ${chosen.name} etched onto your ${onto.name}`,
        meta: { granted: chosen.name, etchedOnto: onto.name }
      };
    }
  }

  await api.grantItems(actor.id, [{ pack: chosen.pack, id: chosen.id }]);
  const note = widened ? ', above your level' : '';
  return {
    mode: 'auto',
    log: `${card.name}: granted ${chosen.name} (level ${chosen.level} ${chosen.rarity}${note})`,
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
      { value: 'xp', label: `Gain ${params.xp_alternative ?? 1000} XP` },
      { value: 'draws', label: `Draw ${params.additional_draws ?? 2} additional cards` }
    ], `${card.name}: take the experience, or the extra draws?`);
  }
  if (params.chosen === 'xp') {
    return applyXpGain({
      actor, api, card,
      params: { xp: params.xp_alternative ?? 1000 }
    });
  }
  const extra = params.additional_draws ?? 2;
  // Nothing is written to the actor: the draws are the deck's business, and
  // the caller takes them once this resolves.
  return {
    mode: 'auto',
    log: `${card.name}: ${extra} additional draws`,
    meta: { extraDraws: extra }
  };
}

export async function applyStopDrawing({ card }) {
  // Nothing to write. Whether the player stops is theirs to say, and the deck
  // app cannot un-declare draws already in flight — the old flag recorded an
  // intention that nothing ever read.
  return {
    mode: 'auto',
    log: `${card.name}: you may stop drawing now, even with draws still declared`
  };
}

export async function applyDrawTwoKeepOne({ card }) {
  // Two draws are granted; which one is kept is a decision made at the table,
  // and the module has no way to un-draw the other.
  return {
    mode: 'auto',
    log: `${card.name}: draw two more cards and keep only one of them`,
    meta: { extraDraws: 2 }
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

/**
 * Rogue: an existing NPC turns against you.
 *
 * Routed through the spawner at first, which was wrong twice. It drew from a
 * bestiary compendium, so the new enemy was a stranger rather than someone the
 * party might know, and it dropped a token on the map — announcing an enemy
 * whose "identity is not known until they or someone else reveals it".
 *
 * So it picks from the NPCs already in the world, places nothing, and keeps
 * the name away from the players: the effect on the character says only that
 * someone wishes them harm, and the GM is told who in a whisper.
 */
export async function applyRandomHostileNpc({ actor, api, card, rng }) {
  // "Non-player character" means a person, so humanoids first; a world with
  // only monsters still gets an answer rather than nothing.
  let pool = await api.findWorldActors({ types: ['npc'], traits: ['humanoid'], excludeIds: [actor.id] });
  if (!pool.length) pool = await api.findWorldActors({ types: ['npc'], excludeIds: [actor.id] });

  if (!pool.length) {
    return {
      mode: 'gm',
      log: `${card.name}: this world has no NPCs to turn against you — choose one yourself.`,
      meta: { kind: 'gm_only' }
    };
  }

  const enemy = pool[Math.floor(rng() * pool.length)];
  await api.createEffect(actor.id, {
    type: 'effect',
    name: 'Someone Wishes You Harm',
    img: 'icons/skills/social/intimidation-impressing.webp',
    system: {
      description: { value: 'Someone you may already know has become your enemy. Their identity '
        + 'is unknown to you until they or someone else reveals it. Nothing short of a wish-tier '
        + 'divine miracle will end their hostility.' },
      duration: { unit: 'unlimited' },
      rules: []
    }
  });
  await api.postChatCard({
    whisperGM: true,
    content: `<p><strong>${card.name}</strong> — <em>${enemy.name}</em>`
      + `${enemy.level ? ` (level ${enemy.level})` : ''} is now hostile toward `
      + `${actor.name}, and they do not know it.</p>`
  });

  return {
    mode: 'auto',
    // Public. Naming the enemy here would defeat the card.
    log: `${card.name}: someone has become your enemy — you do not know who`,
    gmNote: `${enemy.name}${enemy.level ? ` (level ${enemy.level})` : ''}`
      + `${enemy.folder ? ` from ${enemy.folder}` : ''} now hates ${actor.name}.`,
    meta: { enemyId: enemy.id }
  };
}

/**
 * Knight: a warrior sworn to your service, matched to you.
 *
 * It used to lift an actor out of the world — conscripting a creature that
 * already had a place in the campaign — and always a 4th-level one, whoever
 * drew it. The warrior is built now, at the drawing character's level and in
 * their ancestry, so it is a stranger who matches them.
 */
export async function applySpawnAlly({ actor, api, card }) {
  const { buildWarrior, benchmarkFor, ancestryOf } = await import('./warrior-template.mjs');
  const level = actor?.system?.details?.level?.value ?? 1;
  const anc = ancestryOf(actor);
  // The live compendium wins over the embedded table, so an ancestry added
  // after this was written still gets its own stride.
  const baseSpeed = await api.ancestrySpeed?.(anc.name) ?? null;
  const npc = buildWarrior({ actor, level, ancestry: anc, baseSpeed });

  await api.spawnBuiltCreature(npc, { nearActorId: actor.id, disposition: 1 });
  const b = benchmarkFor(level);
  return {
    mode: 'auto',
    log: `${card.name}: a level ${b.level} ${anc.name.toLowerCase()} warrior appears — `
      + `AC ${b.ac}, ${b.hp} HP, Speed ${npc.system.attributes.speed.value} ft — `
      + `and serves you until death`
      + (anc.matched ? '' : ' (no ancestry on your sheet, so a human knight in plate)'),
    meta: { level: b.level, ancestry: anc.name }
  };
}

/**
 * Construct: a homunculus, specifically.
 *
 * It used to ask the spawner for any construct between levels 0 and 4, and
 * take one out of the world by preference — which in this campaign meant
 * Dreshkan or Mister Beak, named NPCs with their own place in the story, and
 * never a homunculus at all.
 *
 * The card names its creature, so the creature is looked up by name. PF2e has
 * a canonical Homunculus in Monster Core: level 0, tiny, and unlike Knight's
 * warrior it does not scale, because the card does not ask it to.
 */
const HOMUNCULUS_NAMES = ['^Homunculus$', '^Soulbound Homunculus$', 'Homunculus'];
/** Monster Core ships no token art for it, so the module brings its own. */
const HOMUNCULUS_ART = `modules/${MODULE_ID}/assets/tokens/homunculus.webp`;

export async function applySpawnHomunculus({ actor, api, card }) {
  let chosen = null;
  for (const namePattern of HOMUNCULUS_NAMES) {
    const found = await api.findCreatures({ namePattern, excludeTraits: ['troop'] });
    if (found.length) { chosen = found[0]; break; }
  }

  if (!chosen) {
    return {
      mode: 'gm',
      log: `${card.name}: no homunculus in the installed bestiaries — place one yourself.`,
      meta: { kind: 'gm_only' }
    };
  }

  await api.spawnCreatures([{ pack: chosen.pack, id: chosen.id }], {
    nearActorId: actor.id,
    disposition: 1,
    img: HOMUNCULUS_ART
  });
  return {
    mode: 'auto',
    log: `${card.name}: a ${chosen.name.toLowerCase()} (level ${chosen.level}) blinks awake `
      + `and takes you for its maker`,
    meta: { spawned: chosen.name }
  };
}

/**
 * Dragon: a dragon that grows with you.
 *
 * The card says "wyrmling", which is 5e's youngest of four age categories.
 * PF2e has three and starts at Young, whose cheapest example is level 7 — so
 * taken literally this card hands a level 1 party a permanent, loyal level 7
 * dragon, which is the end of the campaign rather than a card in it.
 *
 * The dragon is matched to the drawing character instead, the same principle
 * as Knight's warrior: the best dragon-family creature at or just below their
 * level. That is faithful to "a dragon of a type chosen by the GM" at every
 * level, and Monster Core happens to supply a clean ladder — House Drake at 1,
 * dragonets and drakes through 6, Young dragons from 7, Adult from 11.
 *
 * Monster Core is preferred over the adventure bestiaries, so the dragon is a
 * dragon rather than somebody's named villain.
 */
const DRAGON_BAND = 4;                    // how far below the drawer to look
const DRAGON_ART = {
  drake: `modules/${MODULE_ID}/assets/tokens/dragon-drake.webp`,
  young: `modules/${MODULE_ID}/assets/tokens/dragon-young.webp`,
  elder: `modules/${MODULE_ID}/assets/tokens/dragon-elder.webp`
};

/** Which picture suits the thing that turned up. */
export function dragonArtFor(name, level) {
  if (/\((Adult|Ancient)/i.test(name ?? '') || level >= 11) return DRAGON_ART.elder;
  if (/\(Young/i.test(name ?? '') || level >= 7) return DRAGON_ART.young;
  return DRAGON_ART.drake;
}

export async function applySpawnDragon({ actor, api, card, rng }) {
  const level = actor?.system?.details?.level?.value ?? 1;
  const minLevel = Math.max(-1, level - DRAGON_BAND);

  const pick = async (packs) => api.findCreatures({
    traits: ['dragon'], minLevel, maxLevel: level, excludeTraits: ['troop'], packs
  });

  // Monster Core first: its dragons are dragons, not named villains from an
  // adventure path with a place in someone's plot.
  let pool = await pick(['pf2e.pathfinder-monster-core', 'pf2e.pathfinder-monster-core-2']);
  if (!pool.length) pool = await pick(null);
  if (!pool.length) {
    pool = await api.findCreatures({ traits: ['dragon'], maxLevel: level, excludeTraits: ['troop'] });
  }

  if (!pool.length) {
    return {
      mode: 'gm',
      log: `${card.name}: no dragon of level ${level} or below in the installed bestiaries `
        + `— place one yourself.`,
      meta: { kind: 'gm_only' }
    };
  }

  const chosen = pool[Math.floor(rng() * pool.length)];
  await api.spawnCreatures([{ pack: chosen.pack, id: chosen.id }], {
    nearActorId: actor.id,
    disposition: 1,
    img: dragonArtFor(chosen.name, chosen.level)
  });
  return {
    mode: 'auto',
    log: `${card.name}: a ${chosen.name} (level ${chosen.level}) takes you for its parent`,
    meta: { spawned: chosen.name, level: chosen.level }
  };
}

/**
 * Ooze: the thing arrives in your space, and it is always worth fearing.
 *
 * The card named a gelatinous cube, and the shared spawner honoured that by
 * asking for any ooze between levels 0 and 12 — which is 79 creatures in the
 * installed bestiaries, most of them puddles. A Gutter Ooze is level -1 and
 * tiny. Drawing this card and receiving a Gutter Ooze is not the card.
 *
 * Only three oozes in the whole set actually engulf a creature, which is what
 * the card describes, and they happen to sit at levels 3, 7 and 13 — a ladder,
 * already built. So the card climbs it:
 *
 *   levels 1-6    Gelatinous Cube (3, large)
 *   levels 7-12   Living Tar (7, huge)
 *   levels 13+    Carnivorous Blob (13, gargantuan)
 *
 * The cube is the floor rather than the match. Unlike Knight and Dragon, this
 * summons an enemy, so arriving above the drawer's level is the point of the
 * card and not a fault in it — a level 1 character meets a level 3 cube, and
 * that is a bad afternoon by design. What the ladder prevents is the opposite:
 * a level 15 character meeting the same cube and walking away.
 *
 * The cube is not in Monster Core. It survives only in the legacy Bestiary, so
 * this cannot go through the Monster Core preference the other cards use, and
 * each rung falls back down the ladder if a world lacks that pack.
 */
const OOZE_LADDER = [
  { from: 13, pattern: '^Carnivorous Blob$', art: 'blob' },
  { from: 7,  pattern: '^Living Tar$',       art: 'tar' },
  { from: 0,  pattern: '^Gelatinous Cube$',  art: 'cube' }
];

export const oozeArt = (rung) => `modules/${MODULE_ID}/assets/tokens/ooze-${rung}.webp`;

/** The rungs a character of this level may receive, best first. */
export function oozeLadderFor(level) {
  const start = OOZE_LADDER.findIndex((r) => level >= r.from);
  return OOZE_LADDER.slice(start === -1 ? OOZE_LADDER.length - 1 : start);
}

export async function applySpawnOoze({ actor, api, card }) {
  const level = actor?.system?.details?.level?.value ?? 1;

  let chosen = null;
  let rung = null;
  for (const step of oozeLadderFor(level)) {
    const [found] = await api.findCreatures({
      namePattern: step.pattern, traits: ['ooze'], excludeTraits: ['troop']
    });
    if (found) { chosen = found; rung = step; break; }
  }

  // No named ooze at all: take the biggest thing that is still an ooze rather
  // than give up, since the card's whole promise is that something arrives.
  if (!chosen) {
    const pool = await api.findCreatures({
      traits: ['ooze'], minSize: 'large', maxLevel: Math.max(3, level), excludeTraits: ['troop']
    });
    chosen = pool.sort((a, b) => b.level - a.level)[0] ?? null;
    rung = OOZE_LADDER[OOZE_LADDER.length - 1];
  }

  if (!chosen) {
    return {
      mode: 'gm',
      log: `${card.name}: no ooze in the installed bestiaries — place one yourself.`,
      meta: { kind: 'gm_only' }
    };
  }

  await api.spawnCreatures([{ pack: chosen.pack, id: chosen.id }], {
    nearActorId: actor.id,
    disposition: -1,
    img: oozeArt(rung.art),
    place: 'on'                      // in your space, as the card says
  });
  return {
    mode: 'auto',
    log: `${card.name}: a ${chosen.name.toLowerCase()} (level ${chosen.level}) closes over you `
      + `— it is hostile, and it means to engulf you`,
    meta: { spawned: chosen.name, level: chosen.level }
  };
}

/**
 * Monstrosity: something big, and it is here for you.
 *
 * The card asked the shared spawner for a beast or aberration of level 5 to
 * 12. Two things were wrong with that. The band is fixed, so a level 1
 * character met a creature up to eleven levels above them and a level 20
 * character met one eight levels below — the first is not a fight and neither
 * is the second. And it preferred the world's own NPCs, which meant the
 * monstrosity that turned up was liable to be a creature with a name, a
 * location and a part in somebody's plot.
 *
 * It now scales like Dragon, with the band the other way up: at or just below
 * the drawer, because this one is hostile and a card that is meant to be
 * frightening should not be answered with something the party outclasses.
 *
 * Size is the card's own word and is never negotiated. Swarms are excluded
 * along with troops: both are large by virtue of being many, and "a Large
 * creature appears" means one thing arrives, not a cloud of rats.
 */
const MONSTROSITY_BAND = 3;
const MONSTROUS = ['beast', 'aberration'];
const MONSTROSITY_ART = `modules/${MODULE_ID}/assets/tokens/monstrosity.webp`;
const MONSTER_CORE = ['pf2e.pathfinder-monster-core', 'pf2e.pathfinder-monster-core-2'];

export async function applySpawnMonstrosity({ actor, api, card, rng }) {
  // Sized to the party, not to whoever turned the card over. Scaling to the
  // drawer gave a party of five first-level characters a single level 1
  // creature — and only one exists in every installed bestiary, so every draw
  // produced the same graveshell. It also meant a card meant to threaten the
  // table was answered with something one character could handle.
  const drawer = actor?.system?.details?.level?.value ?? 1;
  const party = (await api.partyLevel?.()) ?? drawer;
  const maxLevel = party + MONSTROSITY_BAND;
  const look = (traits, packs) => api.findCreatures({
    minLevel: party, maxLevel, traits, minSize: 'large',
    excludeTraits: ['troop', 'swarm'], packs
  });

  // Monster Core first for the same reason Dragon prefers it, then the wider
  // bestiaries. Only then is "monstrous" given up — a Large creature of any
  // kind still answers the card, where nothing at all does not.
  let pool = await look(MONSTROUS, MONSTER_CORE);
  if (!pool.length) pool = await look(MONSTROUS, null);
  if (!pool.length) pool = await look([], MONSTER_CORE);
  if (!pool.length) pool = await look([], null);

  if (!pool.length) {
    return {
      mode: 'gm',
      log: `${card.name}: no Large or larger creature of level ${party} to ${maxLevel} in the `
        + `installed bestiaries — place one yourself.`,
      meta: { kind: 'gm_only' }
    };
  }

  const chosen = pool[Math.floor(rng() * pool.length)];
  // Whatever turns up keeps its own picture if it has one. The fallback is a
  // fallback: the creature is drawn at random and could be anything, so one
  // picture over all of them would be a lie about most.
  await api.spawnCreatures([{ pack: chosen.pack, id: chosen.id }], {
    nearActorId: actor.id,
    disposition: -1,
    imgFallback: MONSTROSITY_ART
  });
  return {
    mode: 'auto',
    log: `${card.name}: a ${chosen.name} (level ${chosen.level}) rears up and attacks`,
    meta: { spawned: chosen.name, level: chosen.level }
  };
}

/**
 * Skull: the avatar of death arrives, and it wants only you.
 *
 * The card went to the shared spawner for any undead of level 8 to 16, which
 * in the installed bestiaries answers with a Skeletal Horse or a Wolf
 * Skeleton — undead, certainly, but not death. PF2e has no avatar of death to
 * find, so it is built, the way Knight's warrior is. See death-avatar.mjs for
 * why it arrives at the drawer's level rather than as one of the creatures
 * that share its idea.
 */
export async function applySummonAvatarOfDeath({ actor, api, card }) {
  const { buildAvatarOfDeath } = await import('./death-avatar.mjs');
  const level = actor?.system?.details?.level?.value ?? 1;
  const npc = buildAvatarOfDeath({ actor, level });

  // Beside the character, not on them: the card gives it a space of its own
  // within ten feet and has it announce itself before it strikes.
  await api.spawnBuiltCreature(npc, { nearActorId: actor.id, disposition: -1 });

  return {
    mode: 'auto',
    log: `${card.name}: an avatar of death (level ${npc.system.details.level.value}) — `
      + `AC ${npc.system.attributes.ac.value}, ${npc.system.attributes.hp.max} HP — `
      + `comes for you alone; anyone it slays cannot be raised`,
    meta: { level: npc.system.details.level.value }
  };
}
