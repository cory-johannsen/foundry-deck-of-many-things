import { drawFromPlay } from './deck.mjs';
import { promptKeepOne } from './choice-prompts.mjs';
import { askPlayer } from './player-choice.mjs';
import { whoDecides } from './choice-routing.mjs';
import { planCardEffect, replayPlan } from './effect-plan.mjs';

const MODULE_ID = 'deck-of-many-more-things';

/**
 * Tower: draw two more cards and keep only one.
 *
 * This cannot live in a card handler. Handlers see an actor and an api; they
 * have no access to the play deck, and their writes are recorded and replayed
 * rather than performed, so drawing during one would be meaningless. Turning
 * two cards over and putting one back is deck work, and it happens here.
 *
 * Both cards are turned face-up before the choice is made, each showing what
 * it would actually do — the planner works that out without writing anything,
 * which is exactly what it exists for. Choosing between two names tells you
 * almost nothing; choosing between two outcomes is the card's whole point.
 *
 * The kept card's plan is then replayed rather than the handler re-run, so
 * what was shown is what happens. A card that rolls would otherwise roll again
 * and hand over a different result than the one on the panel.
 */

/** Pull `count` cards off the deck without applying anything. */
export function peelCards(state, count, actorId = null) {
  const drawn = [];
  let next = state;
  for (let i = 0; i < count; i += 1) {
    const step = drawFromPlay(next, { actorId });
    if (step.reason === 'empty') break;
    next = step.state;
    drawn.push(step.card);
  }
  return { state: next, drawn };
}

/**
 * Put a card back where it can be drawn again, at a random position.
 *
 * Appending it would leave the discarded card at the bottom of the deck, which
 * is a promise about when it comes up next. The player never received it, so
 * it should simply go back among the others.
 */
export function returnCard(state, cardId, rng = Math.random) {
  if (!cardId || state.remaining?.includes(cardId)) return state;
  const remaining = [...(state.remaining ?? [])];
  remaining.splice(Math.floor(rng() * (remaining.length + 1)), 0, cardId);
  return {
    ...state,
    remaining,
    drawn: (state.drawn ?? []).filter((d) => (d.cardId ?? d) !== cardId)
  };
}

/** Ask whoever the cards landed on, falling back to the GM. */
export async function askWhichToKeep({ card, actor, options }) {
  const prompt = `${card.name}: two cards are turned over. Keep one.`;
  const { user } = whoDecides({ actor, users: Array.from(game.users) });

  const answer = user
    ? await askPlayer({ user, card, kind: 'keep_one', prompt, options })
    : null;
  if (answer && answer !== 'cancel') return answer;

  const fallback = await promptKeepOne(card, prompt, options);
  return !fallback || fallback === 'cancel' ? null : fallback;
}

/**
 * Run the whole exchange.
 *
 * `applyAndPost` handles a card the ordinary way, and is used when there is no
 * choice to make. `applyPlanned` writes a plan that was already worked out, so
 * the outcome shown on the panel is the one that lands.
 */
export async function drawTwoKeepOne({ state, byId, actor, api, count = 2, rng = Math.random,
                                      applyAndPost, applyPlanned, ask = askWhichToKeep }) {
  const peeled = peelCards(state, count, actor?.id ?? null);
  let next = peeled.state;
  if (!peeled.drawn.length) return { state: next, kept: null };

  // Only one card left in the deck: nothing to choose between.
  if (peeled.drawn.length === 1) {
    await applyAndPost(byId.get(peeled.drawn[0]));
    return { state: next, kept: peeled.drawn[0] };
  }

  // Work out what each would do, writing nothing.
  const plans = new Map();
  for (const id of peeled.drawn) {
    const card = byId.get(id);
    try {
      plans.set(id, await planCardEffect({ card, actor, api }));
    } catch {
      plans.set(id, null);          // a card that cannot be planned still shows its name
    }
  }

  const options = peeled.drawn.map((id) => {
    const card = byId.get(id);
    const plan = plans.get(id);
    return {
      value: id,
      label: card?.name ?? id,
      img: card?.art?.front ? `modules/${MODULE_ID}/${card.art.front}` : null,
      detail: plan?.result?.log ?? card?.rules?.summary ?? ''
    };
  });

  // `ask` is injectable so the exchange can be tested without a live dialog.
  const keptId = await ask({
    card: byId.get('tower') ?? { name: 'Tower' }, actor, options
  }) ?? peeled.drawn[0];

  for (const id of peeled.drawn) {
    if (id !== keptId) next = returnCard(next, id, rng);
  }

  const keptCard = byId.get(keptId);
  const keptPlan = plans.get(keptId);
  if (keptPlan && applyPlanned) await applyPlanned(keptCard, keptPlan);
  else await applyAndPost(keptCard);

  return { state: next, kept: keptId, discarded: peeled.drawn.filter((id) => id !== keptId) };
}
