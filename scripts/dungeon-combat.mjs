/**
 * Wires a combat room's spawned encounter into a real PF2e Combat — see
 * ITEM-6 in docs/backlog.md for the full design and the live-research
 * findings behind the specific API calls below (rollAll/rollInitiative and
 * endCombat both hang on an interactive dialog when called from a script;
 * `rollInitiative(ids, {skipDialog:true})` and `combat.delete()` are the
 * confirmed-working equivalents).
 *
 * Deliberately takes no dependency on dungeon-scene.mjs or ui/dungeon-app.mjs
 * — both of those need things from here (dungeon-scene.mjs starts combat on
 * room entry; dungeon-app.mjs's manual GM buttons resolve it), so this file
 * only ever hands back plain data (`{outcome, dungeonSlot, scene}`) from its
 * auto-resolution checks rather than calling back into either of them.
 * module.mjs — the composition root that already imports from every one of
 * these files — is what stitches "combat resolved" to "advance the room."
 */
import { makeFoundryApi } from './foundry-api.mjs';
import { totalCombatXp, xpPerSurvivor, lootGpForXp } from './combat-rewards.mjs';

const MODULE_ID = 'deck-of-many-more-things';

/** Every token on `scene` carrying `flagKey === flagValue`, plus every current party token. */
function combatantTokens(scene, flagKey, flagValue) {
  const monsterTokens = scene.tokens.filter((t) => t.getFlag(MODULE_ID, flagKey) === flagValue);
  const partyIds = new Set((game.actors?.party?.members ?? []).map((m) => m.id));
  const partyTokens = scene.tokens.filter((t) => partyIds.has(t.actor?.id));
  return [...monsterTokens, ...partyTokens];
}

async function startCombat(scene, flagKey, flagValue) {
  const tokens = combatantTokens(scene, flagKey, flagValue);
  if (!tokens.length) return null;
  const combat = await Combat.create({ scene: scene.id });
  await combat.setFlag(MODULE_ID, flagKey, flagValue);
  const combatants = await combat.createEmbeddedDocuments(
    'Combatant', tokens.map((t) => ({ tokenId: t.id, sceneId: scene.id }))
  );
  await combat.rollInitiative(combatants.map((c) => c.id), { skipDialog: true });
  await combat.startCombat();
  return combat;
}

export const startCombatForSlot = (scene, slot) => startCombat(scene, 'dungeonSlot', slot);
export const startCombatForEncounterId = (scene, encounterId) => startCombat(scene, 'encounterId', encounterId);

export function getCombatForSlot(scene, slot) {
  return game.combats.find((c) => c.scene?.id === scene.id && c.getFlag(MODULE_ID, 'dungeonSlot') === slot) ?? null;
}

function isModuleCombat(c) {
  return c.getFlag(MODULE_ID, 'dungeonSlot') != null || c.getFlag(MODULE_ID, 'encounterId') != null;
}

/** `{ hostilesDefeated, partyDefeated }` — both false while the fight's still going. */
export function combatSideStatus(combat) {
  const groups = { hostile: [], party: [] };
  for (const c of combat.combatants) (c.token?.disposition === -1 ? groups.hostile : groups.party).push(c);
  return {
    hostilesDefeated: groups.hostile.length > 0 && groups.hostile.every((c) => c.isDefeated),
    partyDefeated: groups.party.length > 0 && groups.party.every((c) => c.isDefeated)
  };
}

/** Grants XP/loot on victory, then deletes the Combat either way. */
async function resolveCombat(combat, outcome, api) {
  if (outcome === 'victory') {
    const hostileLevels = combat.combatants
      .filter((c) => c.token?.disposition === -1)
      .map((c) => c.actor?.system?.details?.level?.value ?? 0);
    const partyLevel = await api.partyLevel();
    const totalXp = totalCombatXp(hostileLevels, partyLevel);
    const party = (game.actors?.party?.members ?? []).filter((m) => m.type === 'character');
    const share = xpPerSurvivor(totalXp, party.length);
    for (const member of party) {
      await member.update({ 'system.details.xp.value': (member.system.details.xp.value ?? 0) + share });
    }
    if (game.actors.party) await api.addCoins(game.actors.party.id, { gp: lootGpForXp(totalXp) });
  }
  await combat.delete();
}

/** Shared by both the manual GM buttons and the automatic hooks below. */
export async function resolveSlotCombat(scene, slot, outcome, api = makeFoundryApi()) {
  const combat = getCombatForSlot(scene, slot);
  if (!combat) return;
  await resolveCombat(combat, outcome, api);
}

/**
 * If `combat` has just been decided (one side wholly defeated), grants
 * rewards and deletes it, returning `{ outcome, dungeonSlot, scene }` for the
 * caller to advance the room with (`dungeonSlot` is null for a standalone
 * `encounterId`-flagged combat, which has no room to advance). Returns null
 * while the fight's still undecided, or if another update already resolved
 * it first (`game.combats` no longer has it).
 */
async function autoResolveIfDecided(combat) {
  if (!game.user.isGM || !game.combats.has(combat.id)) return null;
  const { hostilesDefeated, partyDefeated } = combatSideStatus(combat);
  if (!hostilesDefeated && !partyDefeated) return null;
  const outcome = hostilesDefeated ? 'victory' : 'defeat';
  const dungeonSlot = combat.getFlag(MODULE_ID, 'dungeonSlot') ?? null;
  const scene = combat.scene;
  await resolveCombat(combat, outcome, makeFoundryApi());
  return { outcome, dungeonSlot, scene };
}

/** Hook target for `updateActor` — module.mjs registers this. */
export function maybeResolveCombatForActor(actor) {
  const combat = game.combats.find((c) => isModuleCombat(c) && c.combatants.some((cb) => cb.actorId === actor.id));
  return combat ? autoResolveIfDecided(combat) : null;
}

/** Hook target for `updateCombatant` — module.mjs registers this. */
export function maybeResolveCombatForCombatant(combatant, changes) {
  if (!('defeated' in changes)) return null;
  const combat = combatant.parent;
  return combat && isModuleCombat(combat) ? autoResolveIfDecided(combat) : null;
}
