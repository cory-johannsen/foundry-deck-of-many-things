const MODULE_ID = 'deck-of-many-more-things';

/**
 * Post the chat card for a draw.
 *
 * A `gm`-mode result is posted *pending*: the effect has not been applied, and
 * the card carries an Apply button that only a GM sees. Everything needed to
 * finish the job later lives in flags, so resolution survives a reload and does
 * not depend on the drawing client still being connected.
 */
export async function postDrawCard({ card, actor, result }) {
  const pending = result.mode === 'gm';
  const template = `modules/${MODULE_ID}/templates/card-chat.hbs`;
  const content = await renderTemplate(template, {
    card,
    actor: actor ? { id: actor.id, name: actor.name } : null,
    result,
    isGmCard: pending,
    pending
  });
  return ChatMessage.create({
    content,
    speaker: actor ? ChatMessage.getSpeaker({ actor }) : ChatMessage.getSpeaker(),
    flags: {
      [MODULE_ID]: {
        kind: 'draw',
        cardId: card.id,
        actorId: actor?.id ?? null,
        resultMode: result.mode,
        pending,
        log: result.log,
        meta: result.meta ?? null
      }
    }
  });
}
