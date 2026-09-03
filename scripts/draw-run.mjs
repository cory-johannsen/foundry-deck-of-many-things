import { loadCards } from './data-loader.mjs';
import { freshPlayDeckState, drawFromPlay, makeCardsById } from './deck.mjs';
import { applyCardEffect } from './card-effects.mjs';
import { makeFoundryApi } from './foundry-api.mjs';
import { playCardSound } from './card-sound.mjs';
import { postDrawCard } from './ui/card-message.mjs';
import { drawTwoKeepOne } from './keep-one.mjs';
import { replayPlan } from './effect-plan.mjs';
import { pendingKind, resolvePendingDraw, markMessageResolved } from './gm-resolution.mjs';

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

  let budget = count;
  const applyAndPost = async (card) => {
    const result = await applyCardEffect({ card, actor, api, autoApplyEnabled: autoApply });
    // A card that has not landed yet stays quiet until it does.
    if (result.mode === 'auto') playCardSound(card, actor);
    const message = await postDrawCard({ card, actor, result });

    // A card that asks a question asks it now, of whoever should answer —
    // the player when the character is theirs, the GM otherwise. Waiting
    // behind an Apply button only added a click before the same prompt.
    //
    // A card with no actor bound is left pending on purpose: the GM picks who
    // it lands on when they are ready, rather than being interrupted partway
    // through a batch of draws.
    if (result.mode === 'gm' && actor && pendingKind(result.meta) !== 'acknowledge') {
      const outcome = await resolvePendingDraw(message);
      if (outcome) {
        await markMessageResolved(message, outcome);
        if (outcome.extraDraws > 0) budget += outcome.extraDraws;
      }
    }
    return result;
  };

  // Persist after every card, not once at the end. A card that blocks on a
  // dialog, or a handler that throws, would otherwise leave the deck believing
  // nothing had been drawn — and every card already turned over could come up
  // again.
  const persist = () => game.settings.set(MODULE_ID, 'playDeck', state);

  const drawn = [];
  for (let i = 0; i < budget; i += 1) {
    const step = drawFromPlay(state, { actorId: actor?.id ?? null });
    if (step.reason === 'empty') {
      if (notify) ui.notifications.warn(game.i18n.localize('DOMMT.Play.EmptyDeck'));
      break;
    }
    state = step.state;
    await persist();
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
      const outcome = await drawTwoKeepOne({
        state, byId, actor, api, applyAndPost,
        // The panel showed what this card would do; replaying that plan is
        // what makes the shown outcome the one that lands.
        applyPlanned: async (kept, plan) => {
          if (plan.calls.length) await replayPlan(plan.calls, api);
          playCardSound(kept, actor);
          await postDrawCard({ card: kept, actor, result: plan.result });
        }
      });
      state = outcome.state;
      await persist();
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

  await persist();
  return { drawn, state };
}
