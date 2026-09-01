import { DeckApp } from './ui/deck-app.mjs';
import { DivinationApp } from './ui/divination-app.mjs';
import { loadCards } from './data-loader.mjs';
import { drawFromPlay, freshPlayDeckState, makeCardsById } from './deck.mjs';
import { applyCardEffect } from './card-effects.mjs';
import { makeFoundryApi } from './foundry-api.mjs';
import { postDrawCard } from './ui/card-message.mjs';
import {
  ensureDivinationScene,
  performDivinationOnTable,
  clearDivinationTable
} from './scene-divination.mjs';

const MODULE_ID = 'deck-of-many-more-things';

Hooks.once('init', () => {
  game.settings.register(MODULE_ID, 'autoApplyEffects', {
    name: 'DOMMT.Settings.AutoApplyEffects.Name',
    hint: 'DOMMT.Settings.AutoApplyEffects.Hint',
    scope: 'world', config: true, type: Boolean, default: true
  });
  game.settings.register(MODULE_ID, 'divinationVisibility', {
    name: 'DOMMT.Settings.DivinationVisibility.Name',
    hint: 'DOMMT.Settings.DivinationVisibility.Hint',
    scope: 'world', config: true, type: String,
    choices: {
      gm_only: 'DOMMT.Settings.DivinationVisibility.gm_only',
      whisper_player: 'DOMMT.Settings.DivinationVisibility.whisper_player',
      public: 'DOMMT.Settings.DivinationVisibility.public'
    },
    default: 'gm_only'
  });
  game.settings.register(MODULE_ID, 'worldSeed', { scope: 'world', config: false, type: String, default: '' });
  game.settings.register(MODULE_ID, 'playDeck', {
    scope: 'world', config: false, type: Object,
    default: { remaining: [], drawn: [], seed: '' }
  });
});

Hooks.once('ready', async () => {
  const module = game.modules.get(MODULE_ID);
  module.api = {
    openDeck: () => new DeckApp().render(true),
    openDivinationPanel: () => new DivinationApp().render(true),
    openDivination: () => performDivinationOnTable(),
    divineOnTable: () => performDivinationOnTable(),
    clearTable: () => clearDivinationTable(),
    drawForced: drawForced,
    resetDeck: async () => {
      const cards = await loadCards();
      const seed = String(Date.now());
      const state = freshPlayDeckState(cards, seed);
      await game.settings.set(MODULE_ID, 'worldSeed', seed);
      await game.settings.set(MODULE_ID, 'playDeck', state);
    },
    installMacros: () => ensureWorldMacros({ force: true }),
    installDivinationScene: () => ensureDivinationScene()
  };
  if (game.user.isGM) {
    try { await ensureWorldMacros(); } catch (e) { console.error(`${MODULE_ID} | ensureWorldMacros failed`, e); }
    try { await ensureDivinationScene(); } catch (e) { console.error(`${MODULE_ID} | ensureDivinationScene failed`, e); }
  }
  console.log(`${MODULE_ID} | ready — api attached to game.modules.get('${MODULE_ID}').api`);
});

const MACRO_DEFS = [
  {
    name: 'DOMMT: Play the Deck',
    img: 'icons/svg/card-hand.svg',
    command: `game.modules.get('${MODULE_ID}').api.openDeck();`
  },
  {
    name: 'DOMMT: Divine — Celtic Cross',
    img: 'icons/svg/eye.svg',
    command: `game.modules.get('${MODULE_ID}').api.openDivination();`
  },
  {
    name: 'DOMMT: Reset Play Deck (GM)',
    img: 'icons/svg/regen.svg',
    command: `if (!game.user.isGM) return ui.notifications.warn('GM only');\nawait game.modules.get('${MODULE_ID}').api.resetDeck();\nui.notifications.info('Deck reset');`
  }
];

async function ensureWorldMacros({ force = false } = {}) {
  const toCreate = [];
  const toUpdate = [];
  for (const def of MACRO_DEFS) {
    const existing = game.macros.find((m) => m.name === def.name);
    if (existing) {
      if (force || existing.command !== def.command) {
        toUpdate.push({ _id: existing.id, command: def.command, img: def.img });
      }
    } else {
      toCreate.push({
        name: def.name,
        type: 'script',
        img: def.img,
        command: def.command,
        scope: 'global',
        flags: { [MODULE_ID]: { generated: true } }
      });
    }
  }
  if (toCreate.length) await Macro.createDocuments(toCreate);
  if (toUpdate.length) await Macro.updateDocuments(toUpdate);
  const msg = `Deck of Many More Things: ${toCreate.length} macro(s) created, ${toUpdate.length} updated.`;
  ui.notifications?.info(msg);
  console.log(`${MODULE_ID} | ${msg}`);
  return { created: toCreate.length, updated: toUpdate.length };
}

Hooks.on('getSceneControlButtons', (controls) => {
  const tokenControl = controls.find?.((c) => c.name === 'token') ?? controls.token;
  if (!tokenControl) return;
  const button = {
    name: 'dommt-deck',
    title: game.i18n.localize('DOMMT.SceneControl.Label'),
    icon: 'fa-solid fa-cards',
    visible: true,
    button: true,
    onClick: () => new DeckApp().render(true)
  };
  if (Array.isArray(tokenControl.tools)) {
    tokenControl.tools.push(button);
  } else if (tokenControl.tools && typeof tokenControl.tools === 'object') {
    tokenControl.tools['dommt-deck'] = button;
  }
});

async function drawForced(cardId, { actorId = null } = {}) {
  const cards = await loadCards();
  const byId = makeCardsById(cards);
  const card = byId.get(cardId);
  if (!card) throw new Error(`Unknown card: ${cardId}`);
  let state = game.settings.get(MODULE_ID, 'playDeck');
  if (!state.remaining?.length) {
    state = freshPlayDeckState(cards, String(Date.now()));
  }
  const remaining = state.remaining.filter((id) => id !== cardId);
  const drawn = state.drawn.concat([{ cardId, actorId, at: Date.now() }]);
  await game.settings.set(MODULE_ID, 'playDeck', { ...state, remaining, drawn });
  const actor = actorId ? game.actors.get(actorId) : null;
  const api = makeFoundryApi();
  const autoApply = game.settings.get(MODULE_ID, 'autoApplyEffects');
  const result = await applyCardEffect({ card, actor, api, autoApplyEnabled: autoApply });
  await postDrawCard({ card, actor, result });
  return result;
}
