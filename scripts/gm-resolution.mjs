import { loadCards } from './data-loader.mjs';
import { makeCardsById } from './deck.mjs';
import { applyCardEffect } from './card-effects.mjs';
import { makeFoundryApi } from './foundry-api.mjs';

const MODULE_ID = 'deck-of-many-more-things';

/**
 * GM-side resolution of cards that could not be applied automatically.
 *
 * A draw that resolves to `mode: 'gm'` posts its chat card WITHOUT touching the
 * actor, carrying enough in flags to finish the job later. The card shows an
 * Apply button that only a GM sees; clicking it opens the right prompt, applies
 * what can be applied, and marks the message resolved.
 *
 * This is deliberately not a socket handshake. The chat message is already
 * replicated to every client and already carries permissions, so gating the
 * button on `game.user.isGM` puts the decision in front of the GM without
 * blocking the player who drew, and without a request that can be lost if the
 * GM happens to be offline.
 */

const ABILITIES = [
  ['str', 'Strength'], ['dex', 'Dexterity'], ['con', 'Constitution'],
  ['int', 'Intelligence'], ['wis', 'Wisdom'], ['cha', 'Charisma']
];

/** Which gm-mode results carry a decision this module can actually act on. */
export function pendingKind(meta) {
  if (meta?.requires === 'choose_ability') return 'choose_ability';
  return 'acknowledge';
}

/**
 * Asked when a card was drawn with no actor bound — a GM drawing with nothing
 * selected. Player-owned characters come first because that is nearly always
 * the answer; the full list is the fallback for a world with none.
 */
async function promptSelectActor(card) {
  const { DialogV2 } = foundry.applications.api;
  const owned = game.actors.filter((a) => a.hasPlayerOwner || a.type === 'character');
  const list = owned.length ? owned : Array.from(game.actors);
  if (!list.length) {
    ui.notifications.warn(game.i18n.localize('DOMMT.GM.NoActorsInWorld'));
    return null;
  }
  const options = list
    .map((a) => `<option value="${a.id}">${foundry.utils.escapeHTML?.(a.name) ?? a.name}</option>`)
    .join('');
  return DialogV2.wait({
    window: { title: card.name },
    content: `
      <form>
        <p>${game.i18n.localize('DOMMT.GM.SelectActor.Prompt')}</p>
        <div class="form-group">
          <label>${game.i18n.localize('DOMMT.GM.SelectActor.Label')}</label>
          <select name="actorId" style="width:100%;">${options}</select>
        </div>
      </form>`,
    buttons: [
      {
        action: 'pick',
        label: game.i18n.localize('DOMMT.GM.Apply'),
        default: true,
        callback: (_e, _b, dialog) => dialog.element.querySelector('[name="actorId"]').value
      },
      { action: 'skip', label: game.i18n.localize('DOMMT.GM.Skip') }
    ],
    rejectClose: false
  });
}

async function promptChooseAbility(card, delta) {
  const { DialogV2 } = foundry.applications.api;
  const options = ABILITIES
    .map(([k, label]) => `<option value="${k}">${label}</option>`).join('');
  return DialogV2.wait({
    window: { title: card.name },
    content: `
      <form>
        <p>${game.i18n.format('DOMMT.GM.ChooseAbility.Prompt', { delta })}</p>
        <div class="form-group">
          <label>${game.i18n.localize('DOMMT.GM.ChooseAbility.Label')}</label>
          <select name="ability" style="width:100%;">${options}</select>
        </div>
      </form>`,
    buttons: [
      {
        action: 'apply',
        label: game.i18n.localize('DOMMT.GM.Apply'),
        default: true,
        callback: (_e, _b, dialog) => dialog.element.querySelector('[name="ability"]').value
      },
      { action: 'skip', label: game.i18n.localize('DOMMT.GM.Skip') }
    ],
    rejectClose: false
  });
}

async function promptAcknowledge(card, log) {
  const { DialogV2 } = foundry.applications.api;
  return DialogV2.wait({
    window: { title: card.name },
    content: `
      <div>
        <p><strong>${game.i18n.localize('DOMMT.Chat.GMAction.Header')}</strong></p>
        <p>${foundry.utils.escapeHTML?.(log) ?? log}</p>
        <hr/>
        <p>${card.rules.full}</p>
        <p class="hint">${game.i18n.localize('DOMMT.GM.AcknowledgeHint')}</p>
      </div>`,
    buttons: [
      { action: 'apply', label: game.i18n.localize('DOMMT.GM.MarkResolved'), default: true },
      { action: 'skip', label: game.i18n.localize('DOMMT.GM.Skip') }
    ],
    rejectClose: false
  });
}

/**
 * Finish a pending draw. Returns the outcome so the caller can update the
 * message, or null when the GM dismissed the prompt without deciding.
 */
export async function resolvePendingDraw(message) {
  if (!game.user.isGM) return null;
  const flags = message.flags?.[MODULE_ID] ?? {};
  if (!flags.pending) return null;

  const cards = await loadCards();
  const card = makeCardsById(cards).get(flags.cardId);
  if (!card) {
    ui.notifications.error(`Unknown card in chat message: ${flags.cardId}`);
    return null;
  }

  // A draw with no actor never ran its handler — applyCardEffect short-circuits
  // to a manual result. Ask for the actor now, then run the effect for real.
  let actor = flags.actorId ? game.actors.get(flags.actorId) : null;
  if (!actor) {
    const chosen = await promptSelectActor(card);
    if (!chosen || chosen === 'skip') return null;
    actor = game.actors.get(chosen);
    if (!actor) return null;
  }

  const api = makeFoundryApi();
  const result = await applyCardEffect({ card, actor, api, autoApplyEnabled: true });

  // Now that an actor is bound the effect may simply apply itself.
  if (result.mode === 'auto') {
    return { applied: true, log: result.log, actorId: actor.id };
  }

  // Still needs a call the module cannot make on its own.
  if (pendingKind(result.meta) === 'choose_ability') {
    const choice = await promptChooseAbility(card, result.meta?.delta ?? 1);
    if (!choice || choice === 'skip') return null;
    const concrete = foundry.utils.deepClone(card);
    concrete.mechanics.params = { ...concrete.mechanics.params, ability: choice };
    const applied = await applyCardEffect({ card: concrete, actor, api, autoApplyEnabled: true });
    return { applied: true, log: applied.log, actorId: actor.id };
  }

  const answer = await promptAcknowledge(card, result.log);
  if (!answer || answer === 'skip') return null;
  return { applied: false, log: game.i18n.localize('DOMMT.GM.ResolvedByGM'), actorId: actor.id };
}

/** Rewrite a resolved message so the button is gone and the outcome is shown. */
export async function markMessageResolved(message, outcome) {
  const flags = message.flags?.[MODULE_ID] ?? {};
  const note = `<div class="dommt-chat__resolved"><em>${outcome.log}</em></div>`;
  const content = message.content
    .replace(/<div class="dommt-chat__gm-actions">[\s\S]*?<\/div>/, '')
    .replace(/<\/div>\s*$/, `${note}</div>`);
  return message.update({
    content,
    flags: {
      [MODULE_ID]: {
        ...flags,
        // The GM may have bound an actor at apply time that the draw never had.
        actorId: outcome.actorId ?? flags.actorId ?? null,
        pending: false,
        resolvedAt: Date.now()
      }
    }
  });
}
