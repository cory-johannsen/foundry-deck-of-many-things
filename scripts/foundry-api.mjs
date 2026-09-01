export function makeFoundryApi() {
  return {
    async updateActor(actorId, updates) {
      const actor = game.actors.get(actorId);
      if (!actor) throw new Error(`No actor: ${actorId}`);
      return actor.update(updates);
    },
    async increaseCondition(actorId, condition, value) {
      const actor = game.actors.get(actorId);
      if (!actor) throw new Error(`No actor: ${actorId}`);
      if (typeof actor.increaseCondition === 'function') {
        return actor.increaseCondition(condition, { value });
      }
      // Fallback: create a condition item by slug. PF2e system has a conditions manager.
      const cond = game.pf2e?.ConditionManager?.getCondition(condition);
      if (cond) {
        const itemData = cond.toObject();
        if (value != null) itemData.system.value = { isValued: true, value };
        return actor.createEmbeddedDocuments('Item', [itemData]);
      }
      console.warn(`Cannot apply condition ${condition} to ${actorId} — PF2e ConditionManager unavailable`);
    },
    async createEffect(actorId, effectData) {
      const actor = game.actors.get(actorId);
      if (!actor) throw new Error(`No actor: ${actorId}`);
      return actor.createEmbeddedDocuments('Item', [effectData]);
    },
    async postChatCard(payload) {
      return ChatMessage.create(payload);
    }
  };
}
