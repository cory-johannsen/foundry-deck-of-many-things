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
  'addCoins', 'grantItems', 'removeItems', 'spawnCreatures', 'grantInnateSpells',
  'removeCoins'
];

export const READ_METHODS = ['findItems', 'findCreatures', 'listItems', 'findWorldActors',
                             'listLanguages', 'getCoins'];

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
          // A spell's tradition is not among its traits — it lives in its own
          // array, so it has to be asked for explicitly or spells arrive
          // looking traditionless.
          fields: ['type', 'system.level.value', 'system.traits.rarity',
                   'system.traits.value', 'system.traits.traditions']
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
          found.push({ pack: id, id: e._id, name: e.name, type: e.type, level, rarity,
                       traits: has, traditions: e.system?.traits?.traditions ?? [] });
        }
      }
      return found;
    },

    /**
     * Bestiary index entries matching a filter, same shape as findItems.
     *
     * Every installed bestiary is searched by default, not just the core one.
     * Restricting to pathfinder-bestiary meant 166 creatures to choose from
     * when the world has several times that — and for a narrow trait like
     * `ooze` the difference is between a handful of candidates and none.
     */
    async findCreatures({ minLevel = null, maxLevel = null, traits = [], namePattern = null,
                          packs = null } = {}) {
      packs ??= game.packs
        .filter((p) => p.documentName === 'Actor' && /bestiary/i.test(p.collection))
        .map((p) => p.collection);
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

    /**
     * NPCs that already exist in this world, as opposed to compendium entries.
     * Rogue turns "a non-player character" against you — someone the party may
     * already know — which is a different thing from summoning a stranger out
     * of a bestiary.
     */
    async findWorldActors({ types = ['npc'], traits = [], minLevel = null, maxLevel = null,
                            excludeIds = [], withArtOnly = false } = {}) {
      const skip = new Set(excludeIds);
      const isDefaultArt = (src) => !src || /mystery-man|default-icons|\.svg$/i.test(src);
      return game.actors
        .filter((a) => types.includes(a.type) && !skip.has(a.id) && a.name?.trim())
        .filter((a) => !traits.length
          || traits.some((t) => (a.system?.traits?.value ?? []).includes(t)))
        .filter((a) => {
          const lvl = a.system?.details?.level?.value ?? 0;
          return (minLevel == null || lvl >= minLevel) && (maxLevel == null || lvl <= maxLevel);
        })
        .filter((a) => !withArtOnly || !isDefaultArt(a.prototypeToken?.texture?.src))
        .map((a) => ({
          id: a.id, name: a.name,
          level: a.system?.details?.level?.value ?? 0,
          folder: a.folder?.name ?? null,
          hasArt: !isDefaultArt(a.prototypeToken?.texture?.src)
        }));
    },

    /**
     * Languages the actor could still learn, labelled for a dialog.
     * Kept behind the api because CONFIG is a live-Foundry global, and a
     * handler that reaches for it directly cannot be tested.
     */
    async listLanguages(actorId) {
      const actor = actorId ? game.actors.get(actorId) : null;
      const known = new Set(actor?.system?.details?.languages?.value ?? []);
      return Object.entries(CONFIG.PF2E?.languages ?? {})
        .filter(([slug]) => !known.has(slug))
        .map(([slug, label]) => ({ value: slug, label: game.i18n.localize(label) }))
        .sort((a, b) => a.label.localeCompare(b.label));
    },

    /** What the actor is carrying in coin. */
    async getCoins(actorId) {
      const coins = getActor(actorId).inventory?.coins;
      return coins?.toObject?.() ?? { ...(coins ?? {}) };
    },

    /**
     * An actor's carried items, for cards that take things away.
     *
     * `magical` selects which side of the line: 'only' for the enchanted ones,
     * 'exclude' for mundane wealth, and null for everything.
     */
    async listItems(actorId, { types = null, magical = null, magicalOnly = false,
                               includeCoinage = false } = {}) {
      const actor = getActor(actorId);
      const mode = magicalOnly ? 'only' : magical;
      const isMagical = (i) => (i.system?.traits?.value ?? []).includes('magical')
        || (i.system?.traits?.rarity ?? 'common') !== 'common';
      // Coins are treasure items in PF2e — "Gold Pieces" sits in the same list
      // as a gemstone. They are excluded by default because coin is handled
      // through the inventory's own coin api, and listing them here would mean
      // taking the same money twice.
      const isCoinage = (i) => i.isCoinage ?? i.system?.stackGroup === 'coins';
      return actor.items
        .filter((i) => (!types || types.includes(i.type)))
        .filter((i) => includeCoinage || !isCoinage(i))
        .filter((i) => mode === null
          || (mode === 'only' ? isMagical(i) : !isMagical(i)))
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

    /**
     * Grant spells the character can actually cast.
     *
     * A spell item dropped on a sheet on its own belongs to no spellcasting
     * entry, so it sits there uncastable. PF2e's model for "you may cast this
     * without a slot" is an innate entry that owns the spell, with the daily
     * allowance recorded on the spell's location.
     *
     * Entry creation and spell linking have to happen together, in one call:
     * the spell references the entry by id, and a handler planning its writes
     * ahead of time cannot know an id for a document that does not exist yet.
     * The module keeps a single entry per actor and adds to it.
     */
    async grantInnateSpells(actorId, entries, { tradition = 'primal', ability = 'cha',
                                                uses = null, entryName = 'Deck of Many More Things' } = {}) {
      const actor = getActor(actorId);
      let entry = actor.itemTypes.spellcastingEntry?.find((e) => e.name === entryName);
      if (!entry) {
        [entry] = await actor.createEmbeddedDocuments('Item', [{
          name: entryName,
          type: 'spellcastingEntry',
          system: {
            prepared: { value: 'innate' },
            tradition: { value: tradition },
            ability: { value: ability }
          }
        }]);
      }

      const sources = [];
      for (const { pack, id } of entries) {
        const doc = await game.packs.get(pack)?.getDocument(id);
        if (!doc) continue;
        const obj = doc.toObject();
        obj.system.location = {
          value: entry.id,
          // A cantrip is at-will; anything else carries a daily allowance.
          ...(uses ? { uses: { value: uses, max: uses } } : {})
        };
        sources.push(obj);
      }
      if (!sources.length) return null;
      return actor.createEmbeddedDocuments('Item', sources);
    },

    async removeCoins(actorId, coins) {
      const actor = getActor(actorId);
      if (typeof actor.inventory?.removeCoins === 'function') {
        return actor.inventory.removeCoins(coins);
      }
      throw new Error(`Actor ${actorId} has no inventory to take coins from`);
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

      // PF2e derives a token's disposition from the actor's alliance and wins
      // over anything set on the token — a summoned ally created straight from
      // a bestiary entry came out hostile, because every bestiary NPC is
      // `opposition`. So the alliance is set on the actor first.
      const alliance = disposition > 0 ? 'party' : disposition < 0 ? 'opposition' : null;

      const created = [];
      for (const [i, entry] of entries.entries()) {
        // An entry is either a compendium reference or a world actor to copy.
        // World actors are preferred by callers because the SRD bestiaries ship
        // no token art, while a world's own NPCs almost always have it.
        const doc = entry.actorId
          ? game.actors.get(entry.actorId)
          : await game.packs.get(entry.pack)?.getDocument(entry.id);
        if (!doc) continue;
        const [actor] = await Actor.createDocuments([
          foundry.utils.mergeObject(doc.toObject(), {
            'ownership.default': 0,
            'system.details.alliance': alliance,
            'prototypeToken.disposition': disposition
          })
        ]);
        const td = await actor.getTokenDocument({
          x: originX + grid * (i + 1),
          y: originY,
          disposition
        });
        const obj = td.toObject();
        obj.disposition = disposition;
        await scene.createEmbeddedDocuments('Token', [obj]);
        created.push(actor.name);
      }
      return created;
    },

    async postChatCard(payload) {
      // whisperGM lets a handler tell the GM something the players must not
      // read — Rogue's new enemy is secret until someone reveals them.
      const { whisperGM, ...rest } = payload;
      if (whisperGM) rest.whisper = ChatMessage.getWhisperRecipients('GM').map((u) => u.id);
      return ChatMessage.create(rest);
    }
  };
}
