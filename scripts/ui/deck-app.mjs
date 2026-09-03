import { loadCards } from '../data-loader.mjs';
import { freshPlayDeckState } from '../deck.mjs';
import { resolveDrawActor } from '../draw-target.mjs';
import { runDraws } from '../draw-run.mjs';

const MODULE_ID = 'deck-of-many-more-things';

/**
 * Extra draws a card grants simply by being drawn.
 *
 * Jester is excluded: its two draws are one side of a choice the player has
 * not made yet when the card lands, so they are granted at resolution instead.
 */
export function extraDrawsFor(card) {
  // Jester's two draws are one side of a choice not yet made, and Tower turns
  // its cards over itself so the player can pick between them — neither is a
  // plain addition to the budget.
  if (['bonus_draws', 'draw_two_keep_one'].includes(card?.mechanics?.kind)) return 0;
  return card?.mechanics?.params?.additional_draws ?? 0;
}
const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;

export class DeckApp extends HandlebarsApplicationMixin(ApplicationV2) {
  static DEFAULT_OPTIONS = {
    id: 'dommt-deck-app',
    tag: 'section',
    window: { title: 'DOMMT.Play.Title', icon: 'fa-solid fa-cards' },
    position: { width: 440, height: 'auto' },
    actions: {
      draw: DeckApp.#onDraw,
      reset: DeckApp.#onReset
    }
  };

  static PARTS = {
    main: { template: `modules/${MODULE_ID}/templates/deck-app.hbs` }
  };

  async _prepareContext() {
    const cards = await loadCards();
    const state = game.settings.get(MODULE_ID, 'playDeck');
    return {
      remaining: state.remaining?.length ?? 0,
      total: cards.length,
      isGM: game.user.isGM,
      declaredDefault: 1
    };
  }

  static async #onDraw() {
    const form = this.element.querySelector('form');
    const n = Math.max(1, parseInt(form?.querySelector('[name="n"]')?.value ?? '1', 10));

    // Who the card lands on follows from who is drawing — see draw-target.mjs.
    // No actor here is not an error: the card posts pending and the GM is asked
    // to pick one when they apply it.
    const { actor, ambiguous } = resolveDrawActor();
    if (ambiguous) ui.notifications.warn(game.i18n.localize('DOMMT.Play.MultipleTokens'));
    if (actor) ui.notifications.info(game.i18n.format('DOMMT.Play.UsingActor', { actor: actor.name }));
    else if (game.user.isGM) ui.notifications.info(game.i18n.localize('DOMMT.Play.NoActorSelected'));

    await runDraws({ count: n, actor });
    this.render();
  }

  static async #onReset() {
    if (!game.user.isGM) return;
    const cards = await loadCards();
    const seed = String(Date.now());
    const state = freshPlayDeckState(cards, seed);
    await game.settings.set(MODULE_ID, 'worldSeed', seed);
    await game.settings.set(MODULE_ID, 'playDeck', state);
    this.render();
    ui.notifications.info(game.i18n.localize('DOMMT.Play.ResetButton'));
  }
}
