import { loadCards } from './data-loader.mjs';
import { makeCardsById } from './deck.mjs';
import { playCardSound } from './card-sound.mjs';

const MODULE_ID = 'deck-of-many-more-things';

/**
 * Replay a card's sound when one of its charges is spent.
 *
 * Eight cards hand out uses rather than a single effect — a wish, an oracle's
 * answer, a free casting of Gate — and the player spends them later by
 * clicking the counter down. The card sounded once when it was applied and
 * then went quiet, which is backwards: the moment that matters at the table is
 * the moment the charge is used.
 *
 * The card is identified from a flag stamped on the effect when it was
 * created, since an effect on a sheet otherwise has no way back to its origin.
 */

/**
 * Is this update a charge being spent? Pure, so the interesting part is
 * testable without a live Foundry.
 *
 * Deliberately narrow: only a decrease counts. Setting a counter back up is a
 * GM correcting a mistake, and re-granting the effect already plays the sound
 * through the normal apply path.
 */
export function isChargeSpend(previousValue, changes) {
  const next = changes?.system?.badge?.value;
  if (typeof next !== 'number' || typeof previousValue !== 'number') return false;
  return next < previousValue;
}

/** The card an effect came from, or null if it was not one of ours. */
export function cardIdOf(item) {
  return item?.flags?.[MODULE_ID]?.cardId ?? null;
}

let cardsById = null;

async function soundFor(cardId) {
  cardsById ??= makeCardsById(await loadCards());
  return cardsById.get(cardId) ?? null;
}

/**
 * Bound to preUpdateItem, where the item still holds the old badge value.
 *
 * Only the client making the change reacts, because playCardSound broadcasts:
 * letting every client fire would play the sound once per connected player.
 */
export async function onChargeSpent(item, changes, _options, userId) {
  if (userId !== game.user.id) return;
  if (!isChargeSpend(item?.system?.badge?.value, changes)) return;

  const cardId = cardIdOf(item);
  if (!cardId) return;

  const card = await soundFor(cardId);
  // The effect knows whose sheet it sits on, so a card with voice variants
  // sounds right when its charge is spent too.
  if (card) playCardSound(card, item.actor ?? null);
}

export function registerChargeSound() {
  Hooks.on('preUpdateItem', onChargeSpent);
}
