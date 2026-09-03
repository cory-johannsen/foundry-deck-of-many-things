import { loadCards } from './data-loader.mjs';
import { makeCardsById } from './deck.mjs';
import { planCardEffect, replayPlan } from './effect-plan.mjs';
import { makeFoundryApi } from './foundry-api.mjs';
import { playCardSound } from './card-sound.mjs';

const MODULE_ID = 'deck-of-many-more-things';

/**
 * GM-side resolution of cards that could not be applied automatically.
 *
 * A draw that resolves to `mode: 'gm'` posts its chat card WITHOUT touching the
 * actor, carrying enough in flags to finish the job later. The card shows an
 * Apply button that only a GM sees; clicking it walks the GM through the
 * decisions the card needs and writes nothing until they confirm the outcome.
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
      { action: 'cancel', label: game.i18n.localize('DOMMT.GM.Cancel') }
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
      { action: 'cancel', label: game.i18n.localize('DOMMT.GM.Cancel') }
    ],
    rejectClose: false
  });
}

/**
 * The last stage before anything is written. Shows the actor, exactly what the
 * card will do to them, and the rules text — so the GM confirms a concrete
 * outcome rather than a card name.
 */
async function promptConfirm(card, actor, plan) {
  const { DialogV2 } = foundry.applications.api;
  const esc = (s) => foundry.utils.escapeHTML?.(String(s)) ?? String(s);
  const writes = plan.calls.length;
  const detail = writes
    ? `<p>${esc(plan.result.log)}</p>`
    : `<p>${esc(plan.result.log)}</p><p class="hint">${game.i18n.localize('DOMMT.GM.AcknowledgeHint')}</p>`;
  return DialogV2.wait({
    window: { title: card.name },
    content: `
      <div>
        <p>${game.i18n.format('DOMMT.GM.Confirm.Prompt', { actor: esc(actor.name) })}</p>
        ${detail}
        <hr/>
        <p>${card.rules.full}</p>
      </div>`,
    buttons: [
      {
        action: 'apply',
        label: game.i18n.localize(writes ? 'DOMMT.GM.Apply' : 'DOMMT.GM.MarkResolved'),
        default: true
      },
      { action: 'cancel', label: game.i18n.localize('DOMMT.GM.Cancel') }
    ],
    rejectClose: false
  });
}

/**
 * Finish a pending draw.
 *
 * Every stage is a cancellation point and nothing is written until the last
 * one: the actor is chosen, the effect is *planned* against a recording api,
 * an ability is chosen if the card needs it, and only after the GM confirms
 * the concrete outcome are the planned writes replayed. Dismissing any dialog
 * — button or window close — returns null and leaves the actor untouched and
 * the message still pending.
 *
 * Returns the outcome so the caller can update the message, or null when the
 * GM backed out.
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

  // Stage 1 — who does this apply to? A draw with no actor never ran its
  // handler, because applyCardEffect short-circuits without one.
  let actor = flags.actorId ? game.actors.get(flags.actorId) : null;
  if (!actor) {
    const chosen = await promptSelectActor(card);
    if (!chosen || chosen === 'cancel') return null;
    actor = game.actors.get(chosen);
    if (!actor) return null;
  }

  // Stage 2 — work out what would happen, writing nothing.
  let plan = await planCardEffect({ card, actor });

  // Stage 3 — a decision the module cannot make on its own.
  if (pendingKind(plan.result.meta) === 'choose_ability') {
    const choice = await promptChooseAbility(card, plan.result.meta?.delta ?? 1);
    if (!choice || choice === 'cancel') return null;
    const concrete = foundry.utils.deepClone(card);
    concrete.mechanics.params = { ...concrete.mechanics.params, ability: choice };
    plan = await planCardEffect({ card: concrete, actor });
  }

  // Stage 4 — confirm, and only now write.
  const confirmed = await promptConfirm(card, actor, plan);
  if (!confirmed || confirmed === 'cancel') return null;

  if (plan.calls.length) {
    await replayPlan(plan.calls, makeFoundryApi());
    playCardSound(card);
  }
  return {
    applied: plan.calls.length > 0,
    log: plan.calls.length
      ? plan.result.log
      : game.i18n.localize('DOMMT.GM.ResolvedByGM'),
    actorId: actor.id
  };
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
