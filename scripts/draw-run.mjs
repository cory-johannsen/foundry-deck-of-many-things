import { loadCards } from './data-loader.mjs';
import { freshPlayDeckState, drawFromPlay, makeCardsById } from './deck.mjs';
import { applyCardEffect } from './card-effects.mjs';
import { makeFoundryApi } from './foundry-api.mjs';
import { playCardSound } from './card-sound.mjs';
import { postDrawCard } from './ui/card-message.mjs';
import { drawTwoKeepOne } from './keep-one.mjs';

const MODULE_ID = 'deck-of-many-more-things';

/**
 * Turning cards over, in one place.
 *
 * This used to live inside the deck app's button handler, which meant nothing
 * else could draw. Jester needs to: its two extra draws are one side of a
 * choice the player makes after the card has already been posted, so they are
 * taken when the card resolves rather than when it lands.
 */

/**
 * Extra draws a card grants simply by being turned over.
 *
 * Jester and Tower are excluded and handled separately — Jester's draws depend
 * on a choice not yet made, and Tower turns its own two cards over so the
 * player can pick between them.
 */
export function extraDrawsFor(card) {
  if (['bonus_draws', 'draw_two_keep_one'].includes(card?.mechanics?.kind)) return 0;
  return card?.mechanics?.params?.additional_draws ?? 0;
}

/**
 * Draw `count` cards, applying and posting each.
 *
 * The budget grows as cards that grant further draws come up, so Fool's two
 * follow from it being drawn rather than waiting on the GM to confirm the
 * experience loss.
 */
export async function runDraws({ count = 1, actor = null, notify = true } = {}) {
  const cards = await loadCards();
  const byId = makeCardsById(cards);
  const api = makeFoundryApi();
  const autoApply = game.settings.get(MODULE_ID, 'autoApplyEffects');

  let state = game.settings.get(MODULE_ID, 'playDeck');
  if (!state.remaining?.length) {
    state = freshPlayDeckState(cards, game.settings.get(MODULE_ID, 'worldSeed') || String(Date.now()));
  }

  const applyAndPost = async (card) => {
    const result = await applyCardEffect({ card, actor, api, autoApplyEnabled: autoApply });
    // A card that still needs the GM has not landed yet, so it stays quiet
    // until they apply it.
    if (result.mode === 'auto') playCardSound(card);
    await postDrawCard({ card, actor, result });
    return result;
  };

  const drawn = [];
  let budget = count;
  for (let i = 0; i < budget; i += 1) {
    const step = drawFromPlay(state, { actorId: actor?.id ?? null });
    if (step.reason === 'empty') {
      if (notify) ui.notifications.warn(game.i18n.localize('DOMMT.Play.EmptyDeck'));
      break;
    }
    state = step.state;
    const card = byId.get(step.card);
    drawn.push(card.id);
    await applyAndPost(card);

    if (card.rules.draw_terminating) {
      if (notify) {
        ui.notifications.info(game.i18n.format('DOMMT.Play.TerminatorHit', { card: card.name }));
      }
      break;
    }

    if (card.mechanics.kind === 'draw_two_keep_one') {
      const outcome = await drawTwoKeepOne({ state, byId, actor, applyAndPost });
      state = outcome.state;
      if (outcome.kept) drawn.push(outcome.kept);
      continue;
    }

    const extra = extraDrawsFor(card);
    if (extra) {
      budget += extra;
      if (notify) {
        ui.notifications.info(game.i18n.format('DOMMT.Play.ExtraDraws',
          { card: card.name, count: extra }));
      }
    }
  }

  await game.settings.set(MODULE_ID, 'playDeck', state);
  return { drawn, state };
}
