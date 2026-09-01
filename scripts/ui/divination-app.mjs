import { loadCards, loadCelticCross } from '../data-loader.mjs';
import {
  dealCelticCross,
  readingFromSpread,
  makeCardsById,
  DIVINATION_CATEGORIES
} from '../deck.mjs';

const MODULE_ID = 'deck-of-many-more-things';
const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;

export class DivinationApp extends HandlebarsApplicationMixin(ApplicationV2) {
  static DEFAULT_OPTIONS = {
    id: 'dommt-divination-app',
    tag: 'section',
    window: { title: 'DOMMT.Divination.Title', icon: 'fa-solid fa-eye' },
    position: { width: 960, height: 'auto' },
    actions: {
      deal: DivinationApp.#onDeal,
      broadcast: DivinationApp.#onBroadcast
    }
  };

  static PARTS = {
    main: { template: `modules/${MODULE_ID}/templates/divination-app.hbs` },
    cross: { template: `modules/${MODULE_ID}/templates/celtic-cross.hbs` }
  };

  #reading = null;
  #category = 'situation';

  async _prepareContext() {
    const cards = await loadCards();
    const positions = await loadCelticCross();
    return {
      categories: DIVINATION_CATEGORIES.map((c) => ({
        id: c,
        label: game.i18n.localize(`DOMMT.Divination.Category.${c}`),
        selected: c === this.#category
      })),
      reading: this.#reading,
      positions,
      hasReading: !!this.#reading,
      isGM: game.user.isGM
    };
  }

  static async #onDeal() {
    const form = this.element.querySelector('form');
    const category = form?.querySelector('[name="category"]')?.value ?? 'situation';
    const cards = await loadCards();
    const byId = makeCardsById(cards);
    const seed = String(Date.now()) + '-' + Math.random().toString(36).slice(2);
    const { spread } = dealCelticCross(cards, { seed, category });
    const reading = readingFromSpread(cards, byId, { category, spread });
    reading.positions = reading.positions.map((p) => {
      const label = game.i18n.localize(`DOMMT.Divination.Orientation.${p.orientation}`);
      const fallback = game.i18n.localize('DOMMT.Divination.EmptySlot');
      return { ...p, orientationLabel: label, displayText: p.empty ? fallback : p.text };
    });
    this.#reading = reading;
    this.#category = category;
    this.render();
  }

  static async #onBroadcast() {
    if (!this.#reading) return;
    const visibility = game.settings.get(MODULE_ID, 'divinationVisibility');
    const content = await renderTemplate(`modules/${MODULE_ID}/templates/celtic-cross.hbs`, {
      reading: this.#reading,
      broadcast: true
    });
    const payload = { content, flags: { [MODULE_ID]: { kind: 'divination', category: this.#category } } };
    if (visibility === 'gm_only') {
      payload.whisper = ChatMessage.getWhisperRecipients('GM').map((u) => u.id);
    } else if (visibility === 'whisper_player') {
      payload.whisper = ChatMessage.getWhisperRecipients('GM').map((u) => u.id).concat([game.user.id]);
    }
    return ChatMessage.create(payload);
  }
}
