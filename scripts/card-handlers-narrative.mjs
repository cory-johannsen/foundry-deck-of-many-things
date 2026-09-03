import { rollFormula } from './dice.mjs';
import { deepGet } from './card-handlers-extra.mjs';

/**
 * The cards that were left to the GM longest.
 *
 * Most of them turned out to share one shape: "you may do X, N times, within
 * a year". PF2e models that directly — an effect carrying a counter badge and
 * a duration — so a wish, an oracle's answer and a deity's favour are all the
 * same mechanism with different words. What the module cannot do is adjudicate
 * the wish itself, and it does not pretend to: it puts a tracked, decrementable
 * use on the sheet so the table can see what is owed and spend it.
 *
 * Where PF2e genuinely has no equivalent — alignment, most obviously, which
 * the Remaster removed outright — the card leaves a marker and says so, rather
 * than inventing a field to write to.
 */

const MODULE_ID = 'deck-of-many-more-things';
const TRADITIONS = ['arcane', 'divine', 'occult', 'primal'];
const YEAR = 365;

/**
 * An effect with a counter badge: the sheet shows "3" and the player clicks it
 * down as they spend uses. This is the whole trick behind most of these cards.
 */
function usesEffect({ name, uses, days = null, description, cardId = null,
                      img = 'icons/magic/light/explosion-star-glow-blue.webp' }) {
  return {
    type: 'effect',
    name,
    img,
    // The card is recorded so spending a charge can replay that card's sound;
    // an effect on a sheet otherwise has no way back to where it came from.
    flags: cardId ? { [MODULE_ID]: { cardId } } : {},
    system: {
      description: { value: description },
      duration: days
        ? { value: days, unit: 'days', expiry: 'turn-start', sustained: false }
        : { unit: 'unlimited' },
      badge: uses > 0 ? { type: 'counter', value: uses } : undefined,
      rules: []
    }
  };
}

const grantUses = async (api, actor, spec) => api.createEffect(actor.id, usesEffect(spec));

// ---------------------------------------------------------------------------
// "N uses of a thing" — Bridge, Door, Fates, Map, Moon, Sage, Temple, Tomb
// ---------------------------------------------------------------------------

const USE_CARDS = {
  cast_time_stop_n: {
    formula: 'count_dice', label: (n) => `Time Freeze (${n} free castings)`,
    text: (n) => `Cast Time Freeze ${n} time(s) without expending a spell slot.`,
    img: 'icons/magic/time/clock-stopwatch-white-blue.webp'
  },
  cast_gate_n: {
    formula: 'count_dice', label: (n) => `Gate (${n} free castings)`,
    text: (n) => `Cast Gate ${n} time(s) without a spell slot or material components.`,
    img: 'icons/magic/symbols/runes-star-blue.webp'
  },
  wish: {
    formula: 'count_dice', label: (n) => `Wish (${n} remaining)`,
    text: (n) => `Call on a divine miracle ${n} time(s). The GM adjudicates each.`,
    img: 'icons/magic/light/explosion-star-glow-silhouette.webp'
  },
  erase_event: {
    fixed: 'uses', label: () => 'Erase an Event',
    text: () => 'Avoid or erase one event as if it never happened. Usable any time before death.',
    img: 'icons/magic/time/clock-spinning-gold-pink.webp'
  },
  map_query: {
    fixed: 'uses', days: 'validity_days', label: () => 'Unerring Location',
    text: () => 'Name an object or person you have seen and learn its location, distance and condition.',
    img: 'icons/tools/navigation/map-marked-blue.webp'
  },
  sage_query: {
    fixed: 'uses', days: 'validity_days', label: () => 'One True Answer',
    text: () => 'Meditate an hour and ask one question. You receive a truthful answer.',
    img: 'icons/sundries/books/book-open-turquoise.webp'
  },
  resurrection_grant: {
    fixed: 'count', days: 'validity_days', label: () => 'A Debt Owed',
    text: () => 'A deity is bound to aid you once — divine intervention, or a resurrection on your behalf.',
    img: 'icons/magic/holy/angel-wings-gray.webp'
  }
};

export async function applyTrackedUses({ actor, params, api, card, rng }) {
  const spec = USE_CARDS[card.mechanics.kind];
  const uses = spec.formula
    ? rollFormula(params[spec.formula] ?? '1', rng)
    : (params[spec.fixed] ?? 1);
  const days = spec.days ? (params[spec.days] ?? null) : null;

  await grantUses(api, actor, {
    name: spec.label(uses), uses, days, description: spec.text(uses), img: spec.img,
    cardId: card.id
  });
  const window = days ? ` for ${days} days` : '';
  return {
    mode: 'auto',
    log: `${card.name}: ${spec.label(uses)}${window} — tracked on the sheet as a counter`,
    meta: { uses, days }
  };
}

// ---------------------------------------------------------------------------
// Spell grants — Plant, Well
// ---------------------------------------------------------------------------

export async function applySpellGrant({ actor, params, api, card, rng }) {
  const isCantrips = card.mechanics.kind === 'three_cantrips';
  const wanted = isCantrips ? (params.count ?? 3) : 1;

  const allCantrips = isCantrips
    ? await api.findItems({ types: ['spell'], traits: ['cantrip'], packs: ['pf2e.spells-srd'] })
    : [];
  const pool = isCantrips
    // The card says "from any tradition", so cantrips belonging to none —
    // focus spells and the like — are not what it is offering.
    ? (allCantrips.filter((c) => (c.traditions ?? []).length).length
        ? allCantrips.filter((c) => (c.traditions ?? []).length)
        : allCantrips)
    : await api.findItems({
        types: ['spell'], packs: ['pf2e.spells-srd'],
        namePattern: `^${(params.spell ?? '').replace(/-/g, '[ -]')}$`
      });

  if (!pool.length) {
    return {
      mode: 'gm',
      log: `${card.name}: could not find the spell(s) in the compendium — add them by hand.`,
      meta: { kind: 'gm_only' }
    };
  }

  // Draw without replacement so three cantrips are three different cantrips.
  const remaining = [...pool];
  const picked = [];
  for (let i = 0; i < wanted && remaining.length; i += 1) {
    picked.push(...remaining.splice(Math.floor(rng() * remaining.length), 1));
  }

  // Into an innate spellcasting entry, not loose on the sheet. A spell that
  // belongs to no entry cannot be cast, and a separate counter effect only
  // described the allowance rather than enforcing it — the daily use now lives
  // on the spell, where PF2e tracks and refreshes it.
  //
  // An entry carries one tradition, so spells are grouped by their own rather
  // than filed under a single guess: Well draws cantrips from any tradition and
  // could easily return an arcane one and a primal one together.
  const perDay = isCantrips ? null : (params.per_long_rest ?? 1);
  const byTradition = new Map();
  for (const spell of picked) {
    // Traditions are their own array, not traits: Speak with Plants lists
    // concentrate/manipulate/plant/wood as traits and divine/occult/primal
    // as traditions. Reading traits alone filed it as arcane.
    const tradition = (spell.traditions ?? []).find((t) => TRADITIONS.includes(t))
      ?? TRADITIONS.find((t) => (spell.traits ?? []).includes(t))
      ?? 'arcane';
    if (!byTradition.has(tradition)) byTradition.set(tradition, []);
    byTradition.get(tradition).push({ pack: spell.pack, id: spell.id });
  }
  for (const [tradition, entries] of byTradition) {
    await api.grantInnateSpells(actor.id, entries, {
      uses: perDay,
      tradition,
      entryName: `Deck of Many More Things (${titleCase(tradition)})`
    });
  }

  const allowance = perDay ? ` (${perDay}/day)` : '';
  return {
    mode: 'auto',
    log: `${card.name}: learned ${picked.map((p) => p.name).join(', ')}${allowance}`,
    meta: { spells: picked.map((p) => p.name) }
  };
}

// ---------------------------------------------------------------------------
// Skills — Ship, Throne
// ---------------------------------------------------------------------------

const RANK_NAMES = ['Untrained', 'Trained', 'Expert', 'Master', 'Legendary'];

/**
 * Ship trains three skills "of the GM's choice". Rather than asking three
 * times, the least-trained skills are chosen and named in the plan — the
 * confirmation dialog is where the GM approves or cancels, so the choice still
 * passes in front of them.
 */
export async function applySkillProficiencies({ actor, params, api, card }) {
  const skills = deepGet(actor, 'system.skills') ?? {};
  const ranked = Object.entries(skills)
    .map(([slug, s]) => ({ slug, rank: s?.rank ?? 0 }))
    .sort((a, b) => a.rank - b.rank || a.slug.localeCompare(b.slug));
  const chosen = ranked.slice(0, params.count ?? 3);

  if (!chosen.length) {
    return { mode: 'gm', log: `${card.name}: no skills found on this actor.`, meta: { kind: 'gm_only' } };
  }

  const updates = {};
  const notes = [];
  for (const { slug, rank } of chosen) {
    const next = Math.min(rank + 1, 4);
    updates[`system.skills.${slug}.rank`] = next;
    notes.push(`${slug} ${RANK_NAMES[rank]}→${RANK_NAMES[next]}`);
  }
  await api.updateActor(actor.id, updates);
  return { mode: 'auto', log: `${card.name}: ${notes.join(', ')}` };
}

/**
 * Throne doubles a 5e proficiency bonus, which PF2e has no analogue for; one
 * rank step is the closest equivalent, and Expert is the floor since the card
 * grants proficiency outright to someone who may have none.
 */
export async function applyThronePersuasion({ actor, params, api, card }) {
  const slug = params.skill ?? 'diplomacy';
  const rank = deepGet(actor, `system.skills.${slug}.rank`) ?? 0;
  const next = Math.max(Math.min(rank + 1, 4), 2);
  await api.updateActor(actor.id, { [`system.skills.${slug}.rank`]: next });
  await api.createEffect(actor.id, usesEffect({
    name: 'Deed to a Keep',
    uses: 0,
    description: 'You are the rightful owner of a small keep in a distant land — '
      + 'currently held by monsters you must clear out before you can claim it.',
    img: 'icons/environment/settlement/watchtower-cliff.webp',
    cardId: card.id
  }));
  return {
    mode: 'auto',
    log: `${card.name}: ${slug} ${RANK_NAMES[rank]}→${RANK_NAMES[next]}, and the deed to an occupied keep`
  };
}

// ---------------------------------------------------------------------------
// Removed from play — Donjon, Fey
// ---------------------------------------------------------------------------

const EXILE = {
  trap_extraplanar: {
    name: 'Entombed (Donjon)',
    text: 'Suspended in an extradimensional sphere. Everything you carried stayed behind. '
      + 'You remain until found and removed.',
    img: 'icons/magic/unholy/orb-glowing-purple.webp',
    unconscious: true
  },
  feywild_transport: {
    name: 'Lost in the Feywild (Fey)',
    text: 'Pulled through a fey crossing and deposited in the Feywild. You must find your own way back.',
    img: 'icons/magic/nature/tree-spirit-blue.webp',
    unconscious: false
  }
};

export async function applyExile({ actor, api, card }) {
  const spec = EXILE[card.mechanics.kind];
  await api.createEffect(actor.id, usesEffect({
    name: spec.name, uses: 0, description: spec.text, img: spec.img, cardId: card.id
  }));
  if (spec.unconscious) await api.increaseCondition(actor.id, 'unconscious', 1);
  // Both cards end the draw, which is the module's own business.
  await api.updateActor(actor.id, { [`flags.${MODULE_ID}.drawsEnded`]: true });
  return { mode: 'auto', log: `${card.name}: ${spec.name} — no further cards are drawn` };
}

/**
 * Undead: a revenant takes up the hunt.
 *
 * It used to place the creature on the current scene, which put a monster in
 * front of the party the instant the card was drawn — wherever they happened
 * to be, and whether or not the GM was ready for it. The card describes a
 * pursuit lasting a year, not an encounter starting now.
 *
 * So the character is marked instead. The effect carries the year as its
 * duration, so the sheet counts it down, and the GM brings the revenant when
 * the story wants it.
 */
export async function applyRevenantHunter({ actor, params, api, card }) {
  const days = params.duration_days ?? 365;
  await api.createEffect(actor.id, usesEffect({
    name: 'Hunted by a Revenant',
    uses: 0,
    days,
    cardId: card.id,
    description: 'An undead revenant has risen with the singular purpose of destroying you. '
      + 'It hunts you until you are dead, until the year is out, or until a wish-tier miracle '
      + 'ends the pursuit. You will not see it coming.',
    img: 'icons/magic/death/undead-ghost-strike-white.webp'
  }));
  return {
    mode: 'auto',
    log: `${card.name}: a revenant is hunting you — ${days} days, or until one of you is dead. `
      + `The effect is on your sheet; it will arrive when it arrives.`
  };
}

// ---------------------------------------------------------------------------
// Named adversaries — Fiend, Flames
// ---------------------------------------------------------------------------

/**
 * Both cards turn on a specific creature the GM would otherwise have to pick.
 * Naming it from the bestiary is the automatable half; the bargain Fiend
 * offers, and the campaign Flames sets in motion, remain the GM's.
 *
 * Flames names its devil without placing it — the enmity is a plot thread, not
 * an encounter. Fiend's appears, because the card says it does.
 */
export async function applyNamedAdversary({ actor, params, api, card, rng }) {
  const wantsDevil = card.mechanics.kind === 'permanent_enemy';
  const trait = wantsDevil ? (params.creature_type ?? 'devil') : 'fiend';
  let pool = await api.findCreatures({ traits: [trait] });
  if (!pool.length) pool = await api.findCreatures({ traits: ['fiend'] });

  if (!pool.length) {
    return {
      mode: 'gm',
      log: `${card.name}: no ${trait} in the bestiary — choose one yourself.`,
      meta: { kind: 'gm_only' }
    };
  }

  const chosen = pool[Math.floor(rng() * pool.length)];
  if (wantsDevil) {
    await api.createEffect(actor.id, usesEffect({
      name: `Sworn Enemy: ${chosen.name}`,
      uses: 0,
      cardId: card.id,
      description: `${chosen.name} (level ${chosen.level}) seeks your ruin and savours your `
        + 'suffering. The enmity lasts until one of you is dead.',
      img: 'icons/magic/fire/flame-burning-skull-orange.webp'
    }));
    return { mode: 'auto', log: `${card.name}: ${chosen.name} (level ${chosen.level}) is now your sworn enemy` };
  }

  await api.spawnCreatures([{ pack: chosen.pack, id: chosen.id }], {
    nearActorId: actor.id, disposition: 0
  });
  return {
    mode: 'auto',
    log: `${card.name}: ${chosen.name} (level ${chosen.level}) appears, indifferent, with a bargain to offer`
  };
}

// ---------------------------------------------------------------------------
// Body and mind — Crossroads, Balance
// ---------------------------------------------------------------------------

export async function applyAgeShift({ actor, params, api, card, rng }) {
  const parity = rollFormula('1d20', rng);
  const years = rollFormula(params.years_formula ?? '1d10', rng);
  const older = parity % 2 === 0;
  const current = Number.parseInt(deepGet(actor, 'system.details.age.value'), 10);
  const known = Number.isFinite(current);
  const next = known ? Math.max(current + (older ? years : -years), 1) : null;

  // No effect is left behind. The change is instantaneous and permanent, so
  // there is nothing for an icon to track — it would sit on the sheet forever
  // describing something already written into the age.
  if (known) await api.updateActor(actor.id, { 'system.details.age.value': String(next) });

  return {
    mode: 'auto',
    log: `${card.name}: d20 ${parity} — ${older ? '+' : '−'}${years} years`
      + (known
        ? ` (age ${current} → ${next})`
        : `; no age is recorded on this sheet, so set it by hand`)
  };
}

/**
 * Balance: convictions invert.
 *
 * The card originally flipped alignment, which PF2e's Remaster removed — there
 * is no field to write, so this recorded a note and changed nothing. The
 * wrenching is now mechanical instead: a permanent penalty to Will, paid back
 * as a bonus to the three skills a person with loosened scruples would find
 * easier. Selectors verified on a live sheet, where the breakdown reads
 * "Wisdom +0, Untrained +0, Wrenched Morals -2".
 */
export async function applyMoralInversion({ actor, params, api, card }) {
  const willPenalty = params.will_penalty ?? 2;
  const socialBonus = params.social_bonus ?? 2;
  const skills = params.skills ?? ['deception', 'diplomacy', 'intimidation'];

  // One effect carries both halves, so removing it undoes the whole card.
  const effect = usesEffect({
    name: 'Wrenched Morals (Balance)',
    uses: 0,
    cardId: card.id,
    description: 'Your convictions have inverted. Your resolve is weaker, but lying, charming '
      + 'and threatening come more readily than they did.',
    img: 'icons/magic/control/energy-stream-link-white.webp'
  });
  effect.system.rules = [
    { key: 'FlatModifier', selector: 'will', type: 'status', value: -willPenalty },
    ...skills.map((slug) => ({
      key: 'FlatModifier', selector: slug, type: 'status', value: socialBonus
    }))
  ];
  await api.createEffect(actor.id, effect);

  return {
    mode: 'auto',
    log: `${card.name}: -${willPenalty} status to Will, +${socialBonus} status to `
      + `${skills.map(titleCase).join(', ')}`
  };
}

const titleCase = (s) => s.charAt(0).toUpperCase() + s.slice(1);
