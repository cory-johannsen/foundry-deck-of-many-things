import { loadCards } from './data-loader.mjs';
import { makeCardsById } from './deck.mjs';
import { planCardEffect, replayPlan } from './effect-plan.mjs';
import { requiresConfirmation } from './card-effects.mjs';
import { makeFoundryApi } from './foundry-api.mjs';
import { playCardSound } from './card-sound.mjs';
import { promptChooseAbility, promptChooseOption, promptChooseMany } from './choice-prompts.mjs';
import { askPlayer } from './player-choice.mjs';
import { whoDecides } from './choice-routing.mjs';

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


/** Which gm-mode results carry a decision this module can actually act on. */
export function pendingKind(meta) {
  if (meta?.requires === 'choose_ability') return 'choose_ability';
  if (meta?.requires === 'choose_option') return 'choose_option';
  if (meta?.requires === 'choose_many') return 'choose_many';
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
  // Shown to the GM at the moment of deciding, and deliberately not carried
  // into the chat card: Rogue's new enemy is a secret from the players.
  const gmOnly = plan.result.gmNote
    ? `<p class="hint"><strong>GM:</strong> ${esc(plan.result.gmNote)}</p>` : '';
  return DialogV2.wait({
    window: { title: card.name },
    content: `
      <div>
        <p>${game.i18n.format('DOMMT.GM.Confirm.Prompt', { actor: esc(actor.name) })}</p>
        ${detail}
        ${gmOnly}
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

  // Stage 2 — work out what would happen, writing nothing. The real api is
  // passed so the planner can still read compendia while its writes are held.
  const api = makeFoundryApi();
  let plan = await planCardEffect({ card, actor, api });

  // Stage 3 — decisions the module cannot make on its own. A handler may ask
  // for one, so this loops rather than asking exactly once: choosing "extra
  // draws" on one card can surface a further choice on the next pass.
  for (let guard = 0; guard < 4; guard += 1) {
    const kind = pendingKind(plan.result.meta);
    if (kind === 'acknowledge') break;

    const concrete = foundry.utils.deepClone(card);
    const meta = plan.result.meta;
    const paramKey = kind === 'choose_ability' ? 'ability' : meta.paramKey;

    // The question belongs to whoever's character this is. It only comes back
    // to the GM for an actor no player owns, or an owner who is not connected.
    const { user } = whoDecides({ actor, users: Array.from(game.users) });
    let choice = user
      ? await askPlayer({
          user, card, kind,
          prompt: plan.result.log,
          options: meta.options ?? [],
          delta: meta.delta ?? 1,
          count: meta.count ?? 1
        })
      : null;

    // No player, or they let it lapse: the GM answers, as before.
    if (!choice) {
      if (kind === 'choose_ability') choice = await promptChooseAbility(card, meta.delta ?? 1);
      else if (kind === 'choose_many') {
        choice = await promptChooseMany(card, plan.result.log, meta.options ?? [], meta.count ?? 1);
      } else choice = await promptChooseOption(card, plan.result.log, meta.options ?? []);
    }
    if (!choice || choice === 'cancel') return null;
    if (Array.isArray(choice) && !choice.length) return null;

    concrete.mechanics.params = {
      ...concrete.mechanics.params,
      // Anything the handler rolled on the first pass is carried forward, or
      // re-planning would roll it again and answer a different question than
      // the one that was asked.
      ...(meta.persist ?? {}),
      [paramKey]: choice
    };
    plan = await planCardEffect({ card: concrete, actor, api });
  }

  // Stage 4 — confirm, for the cards that are held back for one.
  //
  // A card that asked a question has already had its answer, and one that
  // simply needed an actor has just been given one; a further "are you sure"
  // is a click for its own sake. Only a kind in REQUIRES_CONFIRMATION stops
  // here, which is what that set is for.
  if (requiresConfirmation(card.mechanics.kind)) {
    const confirmed = await promptConfirm(card, actor, plan);
    if (!confirmed || confirmed === 'cancel') return null;
  }

  if (plan.calls.length) await replayPlan(plan.calls, api);

  // Outside the write check on purpose. A narrative card — a wish, a fiend's
  // bargain, Beast's transformation — resolves with nothing to write, but it
  // still happened at the table and should still be heard. Tying the sound to
  // whether the actor was touched left all nineteen GM-only cards silent.
  playCardSound(card, actor);
  return {
    applied: plan.calls.length > 0,
    log: plan.calls.length
      ? plan.result.log
      : game.i18n.localize('DOMMT.GM.ResolvedByGM'),
    actorId: actor.id,
    // Jester's extra draws hang on a choice made here, after the card was
    // posted, so they are taken by the caller once this returns.
    extraDraws: plan.result.meta?.extraDraws ?? 0
  };
}

/** Rewrite a resolved message so the button is gone and the outcome is shown. */
export async function markMessageResolved(message, outcome) {
  const flags = message.flags?.[MODULE_ID] ?? {};
  // The waiting line becomes the outcome, rather than the card growing a
  // second paragraph underneath saying much the same thing.
  const esc = foundry.utils.escapeHTML?.(outcome.log) ?? outcome.log;
  let content = message.content
    .replace(/<div class="dommt-chat__gm-actions">[\s\S]*?<\/div>/, '')
    .replace(/(<div class="dommt-chat__outcome" data-outcome>)[\s\S]*?(<\/div>)/,
      `$1\n      ${esc}\n    $2`);
  // A card posted before this layout has no outcome block; append instead.
  if (!content.includes('data-outcome')) {
    content = content.replace(/<\/div>\s*$/,
      `<div class="dommt-chat__resolved"><em>${esc}</em></div></div>`);
  }
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
