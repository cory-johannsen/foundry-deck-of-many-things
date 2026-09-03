/**
 * Does a card's prose agree with the numbers the handler will actually use?
 *
 * Tavern claimed a +1 in its summary and a +2 in its full text while granting
 * +1, and nothing caught it: the schema checks shapes, the tests check
 * handlers, and neither reads the sentence the player is shown. This closes
 * that gap from both directions — text against params, and summary against
 * full text.
 *
 * The checks are deliberately conservative. A card is only faulted when a
 * number is found and disagrees; prose that simply does not state a figure is
 * left alone, because forcing every card to restate its params in prose would
 * make the deck read like a spreadsheet.
 */

const WORDS = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6,
  seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12
};

/** "1,000" -> 1000, "three" -> 3, "+7" -> 7. */
export function toNumber(raw) {
  if (raw == null) return null;
  const s = String(raw).trim().toLowerCase().replace(/[+,]/g, '');
  // Number('') is 0, which is finite — an empty capture would otherwise become
  // a real zero and invent a mismatch that is not in the text.
  if (!s) return null;
  if (s in WORDS) return WORDS[s];
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

/** Every number a pattern finds in a string, normalised. */
function findAll(text, re) {
  const out = [];
  for (const m of String(text ?? '').matchAll(re)) {
    const n = toNumber(m[1]);
    if (n != null) out.push(n);
  }
  return out;
}

const NUM = '([\\d,]+|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)';

/**
 * What each kind of card is expected to state, and how to find it in prose.
 * `expect` returning null means "this card does not pin the number down", and
 * the check is skipped.
 */
export const CLAIMS = {
  stat_bump: {
    label: 'modifier increase',
    expect: (p) => p.delta_mod ?? 1,
    pattern: new RegExp(`(?:increases?|raise[sd]?|boost(?:s|ed)?) by ${NUM}`, 'gi')
  },
  all_stats_bump: {
    label: 'modifier increase',
    expect: (p) => p.delta_mod ?? 1,
    pattern: new RegExp(`(?:increases?|raise[sd]?|boost(?:s|ed)?) by ${NUM}`, 'gi')
  },
  xp_gain: {
    label: 'XP granted',
    expect: (p) => p.xp ?? null,
    pattern: new RegExp(`${NUM}\\s*XP`, 'gi')
  },
  xp_loss: {
    label: 'XP lost',
    expect: (p) => p.xp ?? null,
    pattern: new RegExp(`${NUM}\\s*XP`, 'gi')
  },
  bonus_draws: {
    label: 'XP alternative',
    expect: (p) => p.xp_alternative ?? null,
    pattern: new RegExp(`${NUM}\\s*XP`, 'gi')
  },
  speed_bonus: {
    label: 'speed increase',
    expect: (p) => p.walk_ft ?? null,
    pattern: new RegExp(`${NUM}\\s*(?:ft|feet)`, 'gi')
  },
  grant_telepathy: {
    label: 'telepathy range',
    expect: (p) => p.range_ft ?? null,
    pattern: new RegExp(`${NUM}\\s*(?:ft|feet)`, 'gi')
  },
  skill_proficiencies: {
    label: 'skills trained',
    expect: (p) => p.count ?? null,
    pattern: new RegExp(`${NUM}\\s+skills?`, 'gi')
  },
  three_cantrips: {
    label: 'cantrips learned',
    expect: (p) => p.count ?? null,
    pattern: new RegExp(`${NUM}\\s+cantrips?`, 'gi')
  },
  spawn_ally_npc: {
    label: 'ally level',
    expect: (p) => p.level ?? null,
    pattern: new RegExp(`${NUM}(?:st|nd|rd|th)[- ]level`, 'gi')
  }
};

/** Numbers a card states about itself, keyed by the unit they are attached to. */
const SELF_CONSISTENCY = [
  { unit: 'XP', pattern: new RegExp(`${NUM}\\s*XP`, 'gi') },
  { unit: 'modifier increase', pattern: new RegExp(`(?:increases?|raise[sd]?|boost(?:s|ed)?) by ${NUM}`, 'gi') },
  { unit: 'maximum modifier', pattern: new RegExp(`maximum of \\+${NUM}`, 'gi') },
  { unit: 'feet', pattern: new RegExp(`${NUM}\\s*(?:ft|feet)`, 'gi') },
  { unit: 'skills', pattern: new RegExp(`${NUM}\\s+skills?`, 'gi') },
  { unit: 'cantrips', pattern: new RegExp(`${NUM}\\s+cantrips?`, 'gi') },
  { unit: 'additional draws', pattern: new RegExp(`${NUM}\\s+additional`, 'gi') }
];

/**
 * Returns a list of problems, each {card, kind, detail}. Empty means the deck
 * says what it does.
 */
export function checkCards(cards) {
  const problems = [];

  for (const card of cards) {
    const { summary = '', full = '' } = card.rules ?? {};
    const params = card.mechanics?.params ?? {};
    const claim = CLAIMS[card.mechanics?.kind];

    // 1. Does the prose match the params the handler reads?
    if (claim) {
      const expected = claim.expect(params);
      if (expected != null) {
        for (const [field, text] of [['summary', summary], ['full', full]]) {
          const stated = findAll(text, claim.pattern);
          const wrong = stated.filter((n) => n !== expected);
          if (stated.length && wrong.length === stated.length) {
            problems.push({
              card: card.name,
              kind: 'params-mismatch',
              detail: `${field} says ${claim.label} of ${wrong.join('/')}, params say ${expected}`
            });
          }
        }
      }
    }

    // 2. Does the card agree with itself? This is what Tavern failed.
    for (const { unit, pattern } of SELF_CONSISTENCY) {
      const inSummary = findAll(summary, pattern);
      const inFull = findAll(full, pattern);
      if (!inSummary.length || !inFull.length) continue;
      const shared = new Set([...inSummary, ...inFull]);
      if (shared.size > 1 && !inSummary.some((n) => inFull.includes(n))) {
        problems.push({
          card: card.name,
          kind: 'self-contradiction',
          detail: `summary says ${unit} ${inSummary.join('/')}, full text says ${inFull.join('/')}`
        });
      }
    }
  }

  return problems;
}
