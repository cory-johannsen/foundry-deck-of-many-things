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

  const pool = isCantrips
    ? await api.findItems({ types: ['spell'], traits: ['cantrip'], packs: ['pf2e.spells-srd'] })
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

  await api.grantItems(actor.id, picked.map((p) => ({ pack: p.pack, id: p.id })));
  if (!isCantrips) {
    await grantUses(api, actor, {
      name: `${picked[0].name} (1/day)`,
      uses: params.per_long_rest ?? 1,
      cardId: card.id,
      description: `Cast ${picked[0].name} once per day without expending a spell slot.`,
      img: 'icons/magic/nature/leaf-glow-green.webp'
    });
  }
  return {
    mode: 'auto',
    log: `${card.name}: learned ${picked.map((p) => p.name).join(', ')}`,
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

  if (known) await api.updateActor(actor.id, { 'system.details.age.value': String(next) });
  await api.createEffect(actor.id, usesEffect({
    name: older ? `Aged ${years} Years` : `Made ${years} Years Younger`,
    uses: 0,
    cardId: card.id,
    description: `Rolled ${parity} on the d20 — ${older ? 'aged' : 'made younger by'} ${years} years. `
      + 'The change is instantaneous and permanent.',
    img: 'icons/magic/time/hourglass-yellow-green.webp'
  }));
  return {
    mode: 'auto',
    log: `${card.name}: d20 ${parity} — ${older ? '+' : '−'}${years} years`
      + (known ? ` (age ${current} → ${next})` : ' (no age recorded on the sheet)')
  };
}

/**
 * PF2e's Remaster removed alignment; there is no field on the sheet to invert,
 * which the live system confirms. Rather than write to something that does not
 * exist, the wrenching is recorded as an effect the table can play from.
 */
export async function applyAlignmentFlip({ actor, api, card }) {
  await api.createEffect(actor.id, usesEffect({
    name: 'Wrenched Morals (Balance)',
    uses: 0,
    description: 'Your mind suffers a wrenching alteration: lawful becomes chaotic, good becomes '
      + 'evil, and the reverse. PF2e has no alignment to change, so this stands as a marker for '
      + 'the reversal of whatever your character held to.',
    img: 'icons/magic/control/energy-stream-link-white.webp',
    cardId: card.id
  }));
  return {
    mode: 'auto',
    log: `${card.name}: morals wrenched into their opposite `
      + '(recorded as an effect — PF2e has no alignment field to flip)'
  };
}
