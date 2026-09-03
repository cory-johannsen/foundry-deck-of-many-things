import { loadCards } from '../data-loader.mjs';
import {
  freshPlayDeckState,
  drawFromPlay,
  makeCardsById
} from '../deck.mjs';
import { applyCardEffect } from '../card-effects.mjs';
import { makeFoundryApi } from '../foundry-api.mjs';
import { postDrawCard } from './card-message.mjs';
import { resolveDrawActor } from '../draw-target.mjs';

const MODULE_ID = 'deck-of-many-more-things';
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

  static async #onDraw(event) {
    const form = this.element.querySelector('form');
    const n = Math.max(1, parseInt(form?.querySelector('[name="n"]')?.value ?? '1', 10));
    const cards = await loadCards();
    const byId = makeCardsById(cards);
    let state = game.settings.get(MODULE_ID, 'playDeck');
    if (!state.remaining?.length) {
      state = freshPlayDeckState(cards, game.settings.get(MODULE_ID, 'worldSeed') || String(Date.now()));
      await game.settings.set(MODULE_ID, 'playDeck', state);
    }
    const api = makeFoundryApi();
    const autoApply = game.settings.get(MODULE_ID, 'autoApplyEffects');
    // Who the card lands on follows from who is drawing — see draw-target.mjs.
    // No actor here is not an error: the card posts pending and the GM is asked
    // to pick one when they apply it.
    const { actor, ambiguous } = resolveDrawActor();
    if (ambiguous) ui.notifications.warn(game.i18n.localize('DOMMT.Play.MultipleTokens'));
    if (actor) ui.notifications.info(game.i18n.format('DOMMT.Play.UsingActor', { actor: actor.name }));
    else if (game.user.isGM) ui.notifications.info(game.i18n.localize('DOMMT.Play.NoActorSelected'));

    for (let i = 0; i < n; i++) {
      const step = drawFromPlay(state, { actorId: actor?.id ?? null });
      if (step.reason === 'empty') {
        ui.notifications.warn(game.i18n.localize('DOMMT.Play.EmptyDeck'));
        break;
      }
      state = step.state;
      const card = byId.get(step.card);
      const result = await applyCardEffect({ card, actor, api, autoApplyEnabled: autoApply });
      await postDrawCard({ card, actor, result });
      if (card.rules.draw_terminating) {
        ui.notifications.info(game.i18n.format('DOMMT.Play.TerminatorHit', { card: card.name }));
        break;
      }
    }
    await game.settings.set(MODULE_ID, 'playDeck', state);
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
