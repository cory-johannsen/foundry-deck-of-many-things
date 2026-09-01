const MODULE_ID = 'deck-of-many-more-things';

export async function postDrawCard({ card, actor, result }) {
  const template = `modules/${MODULE_ID}/templates/card-chat.hbs`;
  const content = await renderTemplate(template, {
    card,
    actor: actor ? { id: actor.id, name: actor.name } : null,
    result,
    isGmCard: result.mode === 'gm'
  });
  return ChatMessage.create({
    content,
    speaker: actor ? ChatMessage.getSpeaker({ actor }) : ChatMessage.getSpeaker(),
    flags: { [MODULE_ID]: { kind: 'draw', cardId: card.id, resultMode: result.mode } }
  });
}
