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

/** Ids of the actual party characters — this module's own definition of
 * "a real party member," used instead of Foundry's `hasPlayerOwner` wherever
 * a combatant needs to be told apart from an automated one. A solo-GM world
 * with no separate player-role users (confirmed live on the real deployed
 * world: one `Gamemaster`-role user owns every party actor directly) makes
 * `hasPlayerOwner` false for actual party characters too, since that getter
 * only counts non-GM users — this membership check doesn't depend on how
 * the world's users/ownership happen to be set up. */
function partyActorIds() {
  return new Set((game.actors?.party?.members ?? []).map((m) => m.id));
}

/** Every token on `scene` carrying `flagKey === flagValue`, plus every current party token. */
function combatantTokens(scene, flagKey, flagValue) {
  const monsterTokens = scene.tokens.filter((t) => t.getFlag(MODULE_ID, flagKey) === flagValue);
  const partyIds = partyActorIds();
  const partyTokens = scene.tokens.filter((t) => partyIds.has(t.actor?.id));
  return [...monsterTokens, ...partyTokens];
}

/**
 * Every non-party combatant defaults to agent-controlled (flags.dommt.
 * agentControlled) the instant it's added to a Combat — a GM can disable it
 * per-combatant via the Combat Tracker's own context menu (module.mjs's
 * getCombatTrackerEntryContext hook). Party combatants never get the flag,
 * matching the partyActorIds() split ITEM-8's own reopening already uses.
 */
async function startCombat(scene, flagKey, flagValue) {
  const tokens = combatantTokens(scene, flagKey, flagValue);
  if (!tokens.length) return null;
  const combat = await Combat.create({ scene: scene.id });
  await combat.setFlag(MODULE_ID, flagKey, flagValue);
  const partyIds = partyActorIds();
  const combatants = await combat.createEmbeddedDocuments(
    'Combatant', tokens.map((t) => ({
      tokenId: t.id, sceneId: scene.id,
      ...(partyIds.has(t.actor?.id) ? {} : { flags: { [MODULE_ID]: { agentControlled: true } } })
    }))
  );
  await combat.rollInitiative(combatants.map((c) => c.id), { skipDialog: true });
  await combat.startCombat();
  return combat;
}

/** Flips a single combatant's agentControlled flag — the GM's per-combatant
 * override (module.mjs's Combat Tracker context-menu entry). A no-op guard
 * against toggling a real party member on by mistake, since one should
 * never have the flag in the first place. */
export async function toggleAgentControlled(combatant) {
  if (partyActorIds().has(combatant.actor?.id)) return;
  const current = combatant.getFlag(MODULE_ID, 'agentControlled') ?? false;
  await combatant.setFlag(MODULE_ID, 'agentControlled', !current);
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

/**
 * Grants XP/loot on victory, then deletes the Combat either way — and, since
 * this fight is now genuinely over regardless of outcome, deletes every
 * non-party combatant's token and its underlying Actor too. `spawnCreatures`/
 * `spawnBuiltCreature` (foundry-api.mjs) always create a real, permanent
 * world Actor for an encounter's monsters; before this, the only place that
 * ever got cleaned up was `teardownDungeonRun` at Abandon time, so a
 * normally-*won* dungeon (never abandoned) left every defeated monster's
 * Actor sitting in the world forever — confirmed live: 8 had piled up in the
 * real world from ordinary completed play before this existed.
 */
async function resolveCombat(combat, outcome, api) {
  const scene = combat.scene;
  const partyIds = partyActorIds();
  const npcCombatants = combat.combatants.filter((c) => c.actor?.id && !partyIds.has(c.actor.id));
  const npcTokenIds = npcCombatants.map((c) => c.tokenId).filter(Boolean);
  const npcActorIds = [...new Set(npcCombatants.map((c) => c.actor.id))];

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
  if (npcTokenIds.length && scene) await scene.deleteEmbeddedDocuments('Token', npcTokenIds);
  if (npcActorIds.length) await Actor.deleteDocuments(npcActorIds);
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

// --- ITEM-8: automating a non-player combatant's own turn ---------------

const AUTO_PLAY_DELAY_MS = 700;

// How long an agent-controlled combatant's turn waits for an external
// decision (via getPendingAgentTurn/applyAgentDecision, Task 3) before
// falling back to the heuristic for the rest of that turn — re-armed after
// every applied action, not just once per turn, so a poller that stalls
// mid-turn (rather than never starting at all) still recovers.
export const AGENT_TIMEOUT_MS = 45000;

/** Waits AGENT_TIMEOUT_MS, then — if nothing external acted on this exact
 * turn in the meantime — notifies the GM and finishes the turn with the
 * heuristic instead of leaving it stalled forever. */
export async function armAgentTimeout(combat, combatant) {
  await new Promise((resolve) => setTimeout(resolve, AGENT_TIMEOUT_MS));
  if (!game.combats.has(combat.id) || combat.combatant?.id !== combatant.id) return;
  ui.notifications.warn(
    game.i18n.format('DOMMT.Dungeon.Combat.AgentTimeoutWarning', { name: combatant.name })
  );
  const gmIds = ChatMessage.getWhisperRecipients('GM').map((u) => u.id);
  await ChatMessage.create({
    content: game.i18n.format('DOMMT.Dungeon.Combat.AgentTimeoutChat', { name: combatant.name }),
    whisper: gmIds
  });
  await playHeuristicTurn(combat, combatant);
}

/** Every other still-alive combatant on the opposing side (token disposition
 * differs from `combatant`'s own) — "opposing side" here is just disposition,
 * the same two-bucket split combatSideStatus already uses. */
function combatantOpponents(combat, combatant) {
  const mySide = combatant.token?.disposition;
  return combat.combatants.filter(
    (c) => c.id !== combatant.id && !c.isDefeated && c.token && c.token.disposition !== mySide
  );
}

/** Chebyshev (8-directional) grid distance between two tokens' positions, in
 * squares — matches how this module already measures everything else
 * (dungeon-layout.mjs's grid-unit geometry), not true PF2e diagonal-cost
 * movement rules. */
function chebyshevSquares(a, b, gridSize) {
  return Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y)) / gridSize;
}

/** The closest opposing combatant, or null if none remain. */
function nearestOpponent(combat, combatant) {
  const gridSize = combat.scene?.grid?.size ?? 100;
  const me = combatant.token;
  let best = null;
  let bestDistance = Infinity;
  for (const opponent of combatantOpponents(combat, combatant)) {
    const distance = chebyshevSquares(me, opponent.token, gridSize);
    if (distance < bestDistance) {
      bestDistance = distance;
      best = opponent;
    }
  }
  return best ? { combatant: best, distanceSquares: bestDistance } : null;
}

const MELEE_REACH_SQUARES = 1;

/**
 * Moves `combatant`'s token in a straight 8-directional line toward
 * `target`'s token, up to its own speed, stopping once adjacent
 * (MELEE_REACH_SQUARES) — no wall-avoidance, no real pathfinding, an
 * explicitly accepted simplification (ITEM-8's own Non-goals). A no-op if
 * already adjacent or if the combatant has no speed to move with.
 */
async function stepToward(combat, combatant, target, distanceSquares) {
  if (distanceSquares <= MELEE_REACH_SQUARES) return;
  const gridSize = combat.scene?.grid?.size ?? 100;
  const gridDistanceFt = combat.scene?.grid?.distance ?? 5;
  // Confirmed live: an NPC's land speed lives at system.movement.speeds.land,
  // not system.attributes.speed (which doesn't exist) — the wrong path
  // silently gave 0 in an earlier version of this function, so nothing ever
  // moved.
  const speedFt = combatant.actor?.system?.movement?.speeds?.land?.value ?? 0;
  const speedSquares = Math.floor(speedFt / gridDistanceFt);
  const steps = Math.min(speedSquares, Math.floor(distanceSquares - MELEE_REACH_SQUARES));
  if (steps <= 0) return;

  const me = combatant.token;
  const dest = target.token;
  const dx = Math.sign(dest.x - me.x);
  const dy = Math.sign(dest.y - me.y);
  await me.update({ x: me.x + dx * gridSize * steps, y: me.y + dy * gridSize * steps });
}

/**
 * Rolls `combatant`'s first ready strike against `target` and, on a hit,
 * rolls and applies damage — confirmed live (see ITEM-8 in docs/backlog.md):
 * a strike's own roll()/damage() never forwards a skipDialog option, so the
 * *user's* own showCheckDialogs/showDamageDialogs flags are toggled off for
 * the duration and always restored in the finally, even on error. `{document:
 * target.token}` as the roll target works with no dependency on which scene
 * is currently rendered on this client's canvas.
 */
async function rollAndApplyStrike(combatant, target) {
  const strike = combatant.actor?.system?.actions?.find((a) => a.type === 'strike' && a.ready !== false);
  if (!strike) return null;

  const prevShowCheck = game.user.flags?.pf2e?.settings?.showCheckDialogs;
  const prevShowDamage = game.user.flags?.pf2e?.settings?.showDamageDialogs;
  await game.user.update({
    'flags.pf2e.settings.showCheckDialogs': false,
    'flags.pf2e.settings.showDamageDialogs': false
  });

  try {
    const targetRef = { document: target.token };
    await strike.variants[0].roll({ target: targetRef, createMessage: true });
    const outcome = game.messages.contents.at(-1)?.flags?.pf2e?.context?.outcome ?? null;
    if (outcome === 'success' || outcome === 'criticalSuccess') {
      const damageRoll = await strike.damage({ target: targetRef, outcome, createMessage: true });
      if (damageRoll) await target.actor.applyDamage({ damage: damageRoll, token: target.token, outcome });
    }
    return outcome;
  } finally {
    await game.user.update({
      'flags.pf2e.settings.showCheckDialogs': prevShowCheck,
      'flags.pf2e.settings.showDamageDialogs': prevShowDamage
    });
  }
}

/**
 * Hook target for `updateCombat` — module.mjs registers this whenever the
 * turn or round changes. Plays the current combatant's turn automatically if
 * it isn't a real party member: move adjacent to the nearest opponent if not
 * already, strike once, apply the result, advance the turn. A real party
 * character's own combatant is left entirely alone — checked by membership
 * in `game.actors.party.members` (`partyActorIds`), not Foundry's
 * `hasPlayerOwner`, which came back false for actual party actors on the
 * real deployed world (a solo-GM world with no separate player-role users)
 * and let their turns get auto-played right alongside the NPCs. If the next
 * combatant is also non-party, this fires again naturally off that same
 * `nextTurn()` call — no explicit recursion needed here.
 */
export async function autoPlayCombatantTurnIfDue(combat) {
  if (!game.user.isGM || !isModuleCombat(combat)) return;
  const combatant = combat.combatant;
  if (!combatant || partyActorIds().has(combatant.actor?.id) || combatant.actor?.hasPlayerOwner) return;

  if (combatant.isDefeated) {
    await combat.nextTurn();
    return;
  }

  if (combatant.getFlag(MODULE_ID, 'agentControlled')) {
    // Not awaited — arms a background timeout and returns immediately, same
    // fire-and-forget style module.mjs's own updateCombat hook already uses
    // to call this function. getPendingAgentTurn/applyAgentDecision (Task 3)
    // are the only things that act on this turn in the meantime.
    armAgentTimeout(combat, combatant);
    return;
  }

  await new Promise((resolve) => setTimeout(resolve, AUTO_PLAY_DELAY_MS));
  // Another client (or the combat auto-resolving mid-wait) may have already
  // moved things on — don't act on a stale turn.
  if (!game.combats.has(combat.id) || combat.combatant?.id !== combatant.id) return;
  await playHeuristicTurn(combat, combatant);
}

/** ITEM-8's original heuristic turn: move adjacent to the nearest opponent
 * if not already, strike once, apply the result, advance the turn — shared
 * by the non-agent-controlled path above and the agent-timeout fallback
 * below, so both use exactly the same behavior. */
export async function playHeuristicTurn(combat, combatant) {
  const target = nearestOpponent(combat, combatant);
  if (target) {
    await stepToward(combat, combatant, target.combatant, target.distanceSquares);
    await rollAndApplyStrike(combatant, target.combatant);
  }
  if (game.combats.has(combat.id) && combat.combatant?.id === combatant.id) {
    await combat.nextTurn();
  }
}
