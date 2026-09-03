/**
 * The Foundry/PF2e side of applying a card, kept behind one seam.
 *
 * Split into reads and writes on purpose. A card effect is *planned* before it
 * is applied (see effect-plan.mjs): the handler runs against an api that
 * performs no writes but must still be able to look things up, because a
 * handler that grants "a random magic weapon" has to pick the weapon while
 * planning so the GM can be shown its name before agreeing to it.
 *
 * READ_METHODS are passed through during planning; WRITE_METHODS are recorded
 * and replayed only once the GM confirms.
 */
export const WRITE_METHODS = [
  'updateActor', 'increaseCondition', 'createEffect', 'postChatCard',
  'addCoins', 'grantItems', 'removeItems', 'spawnCreatures'
];

export const READ_METHODS = ['findItems', 'findCreatures', 'listItems'];

/** PF2e rarities in ascending order, for "uncommon or better" style filters. */
const RARITY_ORDER = ['common', 'uncommon', 'rare', 'unique'];

export function rarityAtLeast(rarity, min) {
  return RARITY_ORDER.indexOf(rarity ?? 'common') >= RARITY_ORDER.indexOf(min ?? 'common');
}

export function makeFoundryApi() {
  const getActor = (actorId) => {
    const actor = game.actors.get(actorId);
    if (!actor) throw new Error(`No actor: ${actorId}`);
    return actor;
  };

  return {
    // ---- reads -------------------------------------------------------------

    /**
     * Index entries from the equipment compendia matching a filter.
     * Returns plain objects ({pack, id, name, type, level, rarity}) rather than
     * documents, so a plan can be described, logged and replayed cheaply.
     */
    async findItems({ types = [], minRarity = 'common', maxLevel = null, traits = [],
                      namePattern = null, packs = ['pf2e.equipment-srd'] } = {}) {
      const found = [];
      const re = namePattern ? new RegExp(namePattern, 'i') : null;
      for (const id of packs) {
        const pack = game.packs.get(id);
        if (!pack) continue;
        const index = await pack.getIndex({
          fields: ['type', 'system.level.value', 'system.traits.rarity', 'system.traits.value']
        });
        for (const e of index) {
          if (types.length && !types.includes(e.type)) continue;
          const rarity = e.system?.traits?.rarity ?? 'common';
          if (!rarityAtLeast(rarity, minRarity)) continue;
          const level = e.system?.level?.value ?? 0;
          if (maxLevel != null && level > maxLevel) continue;
          const has = e.system?.traits?.value ?? [];
          if (traits.length && !traits.every((t) => has.includes(t))) continue;
          if (re && !re.test(e.name)) continue;
          found.push({ pack: id, id: e._id, name: e.name, type: e.type, level, rarity, traits: has });
        }
      }
      return found;
    },

    /** Bestiary index entries matching a filter, same shape as findItems. */
    async findCreatures({ minLevel = null, maxLevel = null, traits = [], namePattern = null,
                          packs = ['pf2e.pathfinder-bestiary'] } = {}) {
      const found = [];
      const re = namePattern ? new RegExp(namePattern, 'i') : null;
      for (const id of packs) {
        const pack = game.packs.get(id);
        if (!pack) continue;
        const index = await pack.getIndex({
          fields: ['type', 'system.details.level.value', 'system.traits.value']
        });
        for (const e of index) {
          if (e.type !== 'npc') continue;
          const level = e.system?.details?.level?.value ?? 0;
          if (minLevel != null && level < minLevel) continue;
          if (maxLevel != null && level > maxLevel) continue;
          const has = e.system?.traits?.value ?? [];
          if (traits.length && !traits.some((t) => has.includes(t))) continue;
          if (re && !re.test(e.name)) continue;
          found.push({ pack: id, id: e._id, name: e.name, level, traits: has });
        }
      }
      return found;
    },

    /** An actor's carried items, for cards that take things away. */
    async listItems(actorId, { types = null, magicalOnly = false } = {}) {
      const actor = getActor(actorId);
      return actor.items
        .filter((i) => (!types || types.includes(i.type)))
        .filter((i) => !magicalOnly || (i.system?.traits?.value ?? []).includes('magical')
          || (i.system?.traits?.rarity ?? 'common') !== 'common')
        .map((i) => ({ id: i.id, name: i.name, type: i.type }));
    },

    // ---- writes ------------------------------------------------------------

    async updateActor(actorId, updates) {
      return getActor(actorId).update(updates);
    },

    async increaseCondition(actorId, condition, value) {
      const actor = getActor(actorId);
      if (typeof actor.increaseCondition === 'function') {
        return actor.increaseCondition(condition, { value });
      }
      const cond = game.pf2e?.ConditionManager?.getCondition(condition);
      if (cond) {
        const itemData = cond.toObject();
        if (value != null) itemData.system.value = { isValued: true, value };
        return actor.createEmbeddedDocuments('Item', [itemData]);
      }
      console.warn(`Cannot apply condition ${condition} to ${actorId} — PF2e ConditionManager unavailable`);
    },

    async createEffect(actorId, effectData) {
      return getActor(actorId).createEmbeddedDocuments('Item', [effectData]);
    },

    async addCoins(actorId, coins) {
      const actor = getActor(actorId);
      if (typeof actor.inventory?.addCoins === 'function') return actor.inventory.addCoins(coins);
      throw new Error(`Actor ${actorId} has no inventory to add coins to`);
    },

    /**
     * Copy compendium items onto an actor. Entries are {pack, id}, optionally
     * with `updates` merged into the copy — a battle form borrowed from a
     * spell effect keeps its rule elements but needs the card's duration, not
     * the spell's one minute.
     */
    async grantItems(actorId, entries) {
      const actor = getActor(actorId);
      const sources = [];
      for (const { pack, id, updates } of entries) {
        const doc = await game.packs.get(pack)?.getDocument(id);
        if (!doc) continue;
        const obj = doc.toObject();
        sources.push(updates ? foundry.utils.mergeObject(obj, updates) : obj);
      }
      if (!sources.length) return null;
      return actor.createEmbeddedDocuments('Item', sources);
    },

    async removeItems(actorId, itemIds) {
      const actor = getActor(actorId);
      const present = itemIds.filter((id) => actor.items.get(id));
      if (!present.length) return null;
      return actor.deleteEmbeddedDocuments('Item', present);
    },

    /**
     * Place creatures on the active scene near a focal token when there is one,
     * so a summons lands next to whoever drew rather than at the origin.
     */
    async spawnCreatures(entries, { nearActorId = null, disposition = -1 } = {}) {
      const scene = canvas?.scene;
      if (!scene) throw new Error('No active scene to place creatures on');
      const grid = scene.grid?.size ?? 100;
      const focus = nearActorId
        ? canvas.tokens?.placeables?.find((t) => t.actor?.id === nearActorId)
        : null;
      const originX = focus?.document?.x ?? (scene.width ?? grid * 10) / 2;
      const originY = focus?.document?.y ?? (scene.height ?? grid * 10) / 2;

      const created = [];
      for (const [i, { pack, id }] of entries.entries()) {
        const doc = await game.packs.get(pack)?.getDocument(id);
        if (!doc) continue;
        const [actor] = await Actor.createDocuments([
          foundry.utils.mergeObject(doc.toObject(), { 'ownership.default': 0 })
        ]);
        const td = await actor.getTokenDocument({
          x: originX + grid * (i + 1),
          y: originY,
          disposition
        });
        await scene.createEmbeddedDocuments('Token', [td.toObject()]);
        created.push(actor.name);
      }
      return created;
    },

    async postChatCard(payload) {
      return ChatMessage.create(payload);
    }
  };
}
