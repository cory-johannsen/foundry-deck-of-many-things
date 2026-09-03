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

/**
 * Pick one item of the right shape out of the equipment compendium.
 *
 * Rarity alone does not mean magic. Of 644 uncommon-or-better weapons in the
 * SRD, only 258 carry the `magical` trait; the rest are mundane exotics —
 * which is how Key, asked for a magic weapon, granted a level 0 Thundermace.
 * The magical trait is therefore required, never traded away.
 *
 * Level is scaled to the recipient. Without it the pool runs from level 0 to
 * 20 and a 5th-level character is as likely to be handed a 19th-level staff as
 * anything they could use. The band widens before the card gives up, but the
 * magical requirement does not.
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

  // Items the character could plausibly use, then anything of the right kind.
  let pool = magicalOnly(narrow(await api.findItems({ types, minRarity, maxLevel: level + 3 })));
  let widened = false;
  if (!pool.length) {
    pool = magicalOnly(narrow(await api.findItems({ types, minRarity })));
    widened = pool.length > 0;
  }

  if (!pool.length) {
    return {
      mode: 'gm',
      log: `${card.name}: no magical ${types.join('/')} of ${minRarity}+ rarity in the compendium `
        + `— grant one by hand.`,
      meta: { kind: 'gm_only' }
    };
  }

  const chosen = pool[Math.floor(rng() * pool.length)];
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

/**
 * What each spawning card should put on the table, keyed by PF2e creature
 * traits rather than by name.
 *
 * Names were the original approach and they were wrong: Undead looked for
 * /revenant|undead|wraith|ghost/ and PF2e calls its undead "Wight", "Ghoul"
 * and "Zombie Shambler", so the filter matched nothing. Traits are what the
 * system actually classifies creatures by — 192 undead across the installed
 * bestiaries, against zero by that name pattern.
 */
const SPAWN_SPECS = {
  spawn_ally_npc:     { traits: ['humanoid'], level: [2, 6],  friendly: true },
  spawn_homunculus:   { traits: ['construct'], level: [0, 4], friendly: true },
  spawn_wyrmling:     { traits: ['dragon'], level: [1, 6],    friendly: true },
  spawn_ooze:         { traits: ['ooze'], level: [0, 12],     friendly: false },
  spawn_hostile:      { traits: ['beast', 'aberration'], level: [5, 12], friendly: false },
  revenant_hunter:    { traits: ['undead'], level: [3, 10],   friendly: false },
  avatar_of_death:    { traits: ['undead'], level: [8, 16],   friendly: false }
};

/**
 * Place a creature.
 *
 * The world's own NPCs come first, and the compendium is the fallback — the
 * reverse of the obvious order, for a practical reason: the SRD bestiaries
 * ship no token art at all, so a creature summoned from one arrives as the
 * default mystery-man silhouette. A world populated by an adventure module has
 * art on essentially every NPC. Fiend summoned a Hellwasp Swarm with no
 * artwork, which is what prompted the change.
 *
 * The level band is negotiable and is dropped if nothing of the right kind sits
 * inside it. The traits never are: an earlier version fell back to "anything in
 * the level range" and answered Undead's revenant hunter with a giant mantis.
 * A card that cannot find its creature says so and leaves it to the GM.
 */
export async function applySpawn({ actor, api, card, rng }) {
  const spec = SPAWN_SPECS[card.mechanics.kind];
  if (!spec) {
    return { mode: 'gm', log: `${card.name}: no spawn rule for this card.`, meta: { kind: 'gm_only' } };
  }
  const [minLevel, maxLevel] = spec.level;
  const traits = spec.traits;
  const exclude = [actor.id];

  // In order of preference: a world NPC in band, any world NPC of the kind,
  // then the compendium on the same two terms.
  const attempts = [
    () => api.findWorldActors({ types: ['npc'], traits, minLevel, maxLevel, excludeIds: exclude, withArtOnly: true }),
    () => api.findWorldActors({ types: ['npc'], traits, excludeIds: exclude, withArtOnly: true }),
    () => api.findWorldActors({ types: ['npc'], traits, excludeIds: exclude }),
    () => api.findCreatures({ minLevel, maxLevel, traits }),
    () => api.findCreatures({ traits })
  ];

  let pool = [];
  let attempt = 0;
  for (; attempt < attempts.length && !pool.length; attempt += 1) pool = await attempts[attempt]();

  if (!pool.length) {
    return {
      mode: 'gm',
      log: `${card.name}: no ${traits.join(' or ')} creature in this world or the installed `
        + `bestiaries — place one yourself.`,
      meta: { kind: 'gm_only', traits }
    };
  }

  const chosen = pool[Math.floor(rng() * pool.length)];
  const fromWorld = chosen.id != null && chosen.pack == null;
  await api.spawnCreatures(
    [fromWorld ? { actorId: chosen.id } : { pack: chosen.pack, id: chosen.id }],
    { nearActorId: actor.id, disposition: spec.friendly ? 1 : -1 }
  );

  const outOfBand = attempt === 3 || attempt === 5;
  const note = outOfBand ? ' (outside the usual level band)' : '';
  return {
    mode: 'auto',
    log: `${card.name}: ${spec.friendly ? 'summoned' : 'unleashed'} ${chosen.name} `
      + `(level ${chosen.level})${note} onto the scene`,
    meta: { spawned: chosen.name, traits, source: fromWorld ? 'world' : 'compendium' }
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
