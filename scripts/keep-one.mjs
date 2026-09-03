import { drawFromPlay } from './deck.mjs';
import { promptChooseOption } from './choice-prompts.mjs';
import { askPlayer } from './player-choice.mjs';
import { whoDecides } from './choice-routing.mjs';

/**
 * Tower: draw two more cards and keep only one.
 *
 * This cannot live in a card handler. Handlers see an actor and an api; they
 * have no access to the play deck, and their writes are recorded and replayed
 * rather than performed, so drawing during one would be meaningless. Turning
 * two cards over and putting one back is deck work, and it happens here.
 *
 * The kept card is applied and posted as any drawn card is. The discarded one
 * is returned to the deck rather than burned: the player never received it, so
 * removing it from play would quietly shrink the deck for everyone else.
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

/** Put a card back where it can be drawn again. */
export function returnCard(state, cardId) {
  if (!cardId || state.remaining?.includes(cardId)) return state;
  return {
    ...state,
    remaining: [...(state.remaining ?? []), cardId],
    drawn: (state.drawn ?? []).filter((d) => (d.cardId ?? d) !== cardId)
  };
}

/**
 * Ask whoever the cards landed on which to keep, falling back to the GM.
 * Returns the id of the kept card, or null if nobody answered.
 */
export async function askWhichToKeep({ card, actor, options }) {
  const prompt = `${card.name}: two cards are turned over. Keep one.`;
  const { user } = whoDecides({ actor, users: Array.from(game.users) });

  const answer = user
    ? await askPlayer({ user, card, kind: 'choose_option', prompt, options })
    : null;
  if (answer && answer !== 'cancel') return answer;

  const fallback = await promptChooseOption(card, prompt, options);
  return !fallback || fallback === 'cancel' ? null : fallback;
}

/**
 * Run the whole exchange. `applyAndPost` handles a kept card exactly as the
 * draw loop handles any other, so a kept card behaves like a drawn one.
 */
export async function drawTwoKeepOne({ state, byId, actor, count = 2, applyAndPost }) {
  const peeled = peelCards(state, count, actor?.id ?? null);
  let next = peeled.state;
  if (!peeled.drawn.length) return { state: next, kept: null };

  // Only one card left in the deck: nothing to choose between.
  if (peeled.drawn.length === 1) {
    await applyAndPost(byId.get(peeled.drawn[0]));
    return { state: next, kept: peeled.drawn[0] };
  }

  const options = peeled.drawn.map((id) => ({ value: id, label: byId.get(id)?.name ?? id }));
  const keptId = await askWhichToKeep({ card: byId.get('tower') ?? { name: 'Tower' }, actor, options })
    ?? peeled.drawn[0];

  for (const id of peeled.drawn) {
    if (id !== keptId) next = returnCard(next, id);
  }
  await applyAndPost(byId.get(keptId));
  return { state: next, kept: keptId, discarded: peeled.drawn.filter((id) => id !== keptId) };
}
