import { DeckApp } from './ui/deck-app.mjs';
import { DivinationApp } from './ui/divination-app.mjs';
import { loadCards } from './data-loader.mjs';
import { drawFromPlay, freshPlayDeckState, makeCardsById } from './deck.mjs';
import { applyCardEffect } from './card-effects.mjs';
import { playCardSound } from './card-sound.mjs';
import { registerChoiceSocket } from './player-choice.mjs';
import { registerChargeSound } from './charge-sound.mjs';
import { runDraws } from './draw-run.mjs';
import { makeFoundryApi } from './foundry-api.mjs';
import { resolveDrawActor } from './draw-target.mjs';
import { resolvePendingDraw, markMessageResolved } from './gm-resolution.mjs';
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
    /**
     * Draw from the play deck as the deck app does — budget growth, extra
     * draws, terminators and Tower's keep-one included. Exposed because the
     * loop was reachable only by clicking a button, which is what left the
     * deck-flow cards untestable and, for a while, unimplemented.
     */
    draw: (count = 1, { actorId = null } = {}) =>
      runDraws({ count, actor: actorId ? game.actors.get(actorId) : resolveDrawActor().actor }),
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

/**
 * The macros the module puts on the hotbar.
 *
 * The icons were Foundry's own card-hand, eye and regen SVGs: flat grey line
 * drawings that look like nothing to do with this deck, and which a GM has to
 * tell apart by hovering. A hotbar slot is about fifty pixels, so these are
 * drawn as icons rather than as pictures — one shape each, and one colour
 * each, so the three read apart at a glance without being read at all.
 */
const MACRO_DEFS = [
  {
    name: 'DOMMT: Play the Deck',
    img: `modules/${MODULE_ID}/assets/icons/macro-deck.webp`,
    command: `game.modules.get('${MODULE_ID}').api.openDeck();`
  },
  {
    name: 'DOMMT: Divine — Celtic Cross',
    img: `modules/${MODULE_ID}/assets/icons/macro-divine.webp`,
    command: `game.modules.get('${MODULE_ID}').api.openDivination();`
  },
  {
    name: 'DOMMT: Reset Play Deck (GM)',
    img: `modules/${MODULE_ID}/assets/icons/macro-reset.webp`,
    command: `if (!game.user.isGM) return ui.notifications.warn('GM only');\nawait game.modules.get('${MODULE_ID}').api.resetDeck();\nui.notifications.info('Deck reset');`
  }
];

async function ensureWorldMacros({ force = false } = {}) {
  const toCreate = [];
  const toUpdate = [];
  for (const def of MACRO_DEFS) {
    const existing = game.macros.find((m) => m.name === def.name);
    if (existing) {
      // The picture counts as a change. This compared commands only, so a
      // macro already on someone's hotbar kept its old icon for ever unless
      // the code behind it happened to change too.
      if (force || existing.command !== def.command || existing.img !== def.img) {
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

/**
 * Bind the GM-only Apply button on pending draw cards.
 *
 * Only renderChatMessageHTML is registered. Foundry 13+ always fires it, and
 * v14 still fires the deprecated renderChatMessage alongside it — listening to
 * both bound this handler twice, so one click opened two prompts and could
 * apply an effect twice. The dataset guard below is belt-and-braces: disabling
 * the button on click is too late, because both listeners are already
 * dispatched before the first one awaits.
 */
function bindPendingDrawButton(message, html) {
  const root = html?.[0] ?? html;
  const button = root?.querySelector?.('[data-action="dommt-resolve"]');
  if (!button || button.dataset.dommtBound) return;
  button.dataset.dommtBound = '1';
  // The button ships in every client's copy of the message; only a GM may use
  // it, and nobody else should even see it.
  if (!game.user.isGM) {
    button.closest('.dommt-chat__gm-actions')?.remove();
    return;
  }
  button.addEventListener('click', async () => {
    button.disabled = true;
    try {
      const outcome = await resolvePendingDraw(message);
      if (outcome) {
        await markMessageResolved(message, outcome);
        // A card whose resolution grants draws takes them now.
        if (outcome.extraDraws > 0) {
          await runDraws({ count: outcome.extraDraws, actor: game.actors.get(outcome.actorId) });
        }
      }
      else button.disabled = false;   // dismissed — leave it actionable
    } catch (e) {
      console.error(`${MODULE_ID} | resolving pending draw failed`, e);
      ui.notifications.error(game.i18n.localize('DOMMT.GM.ResolveFailed'));
      button.disabled = false;
    }
  });
}

Hooks.once('ready', registerChoiceSocket);
Hooks.once('ready', registerChargeSound);

Hooks.on('renderChatMessageHTML', bindPendingDrawButton);

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
  const { actor } = resolveDrawActor({ actorId });
  const api = makeFoundryApi();
  const autoApply = game.settings.get(MODULE_ID, 'autoApplyEffects');
  const result = await applyCardEffect({ card, actor, api, autoApplyEnabled: autoApply });
  if (result.mode === 'auto') playCardSound(card, actor);
  await postDrawCard({ card, actor, result });
  return result;
}
