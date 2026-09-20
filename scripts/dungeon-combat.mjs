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
import { makeFoundryApi } from "./foundry-api.mjs";
import {
  totalCombatXp,
  xpPerSurvivor,
  lootGpForXp,
} from "./combat-rewards.mjs";
import {
  initAgentTurnState,
  buildCandidateList,
  applyCandidateToTurnState,
  buildDecisionContext,
} from "./agent-candidates.mjs";
import { findPath, blockedEdgesFromWalls } from "./pathfinding.mjs";
import { coverBlocksLineOfFire, COVER_EFFECT_DATA } from "./cover-items.mjs";

const MODULE_ID = "deck-of-many-more-things";

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
  const monsterTokens = scene.tokens.filter(
    (t) => t.getFlag(MODULE_ID, flagKey) === flagValue,
  );
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
    "Combatant",
    tokens.map((t) => ({
      tokenId: t.id,
      sceneId: scene.id,
      ...(partyIds.has(t.actor?.id)
        ? {}
        : { flags: { [MODULE_ID]: { agentControlled: true } } }),
    })),
  );
  await combat.rollInitiative(
    combatants.map((c) => c.id),
    { skipDialog: true },
  );
  await combat.startCombat();
  return combat;
}

/** Flips a single combatant's agentControlled flag — the GM's per-combatant
 * override (module.mjs's Combat Tracker context-menu entry). A no-op guard
 * against toggling a real party member on by mistake, since one should
 * never have the flag in the first place. */
export async function toggleAgentControlled(combatant) {
  if (partyActorIds().has(combatant.actor?.id)) return;
  const current = combatant.getFlag(MODULE_ID, "agentControlled") ?? false;
  await combatant.setFlag(MODULE_ID, "agentControlled", !current);
}

export const startCombatForSlot = (scene, slot) =>
  startCombat(scene, "dungeonSlot", slot);
export const startCombatForEncounterId = (scene, encounterId) =>
  startCombat(scene, "encounterId", encounterId);

export function getCombatForSlot(scene, slot) {
  return (
    game.combats.find(
      (c) =>
        c.scene?.id === scene.id &&
        c.getFlag(MODULE_ID, "dungeonSlot") === slot,
    ) ?? null
  );
}

function isModuleCombat(c) {
  return (
    c.getFlag(MODULE_ID, "dungeonSlot") != null ||
    c.getFlag(MODULE_ID, "encounterId") != null
  );
}

/** `{ hostilesDefeated, partyDefeated }` — both false while the fight's still going. */
export function combatSideStatus(combat) {
  const groups = { hostile: [], party: [] };
  for (const c of combat.combatants)
    (c.token?.disposition === -1 ? groups.hostile : groups.party).push(c);
  return {
    hostilesDefeated:
      groups.hostile.length > 0 && groups.hostile.every((c) => c.isDefeated),
    partyDefeated:
      groups.party.length > 0 && groups.party.every((c) => c.isDefeated),
  };
}

/** Cover-item (#96) tokens belonging to this combat's own room/encounter —
 * scoped the same way combatantTokens scopes monster tokens, but read off
 * `combat`'s own flag instead of taking flagKey/flagValue as parameters,
 * since resolveCombat only ever has the Combat itself to go on. Cover items
 * are never Combatants (they don't act, so they never join initiative),
 * so they can't be found via `combat.combatants` the way NPCs are below —
 * this scans the scene's tokens directly instead. */
function coverItemTokensForCombat(combat) {
  const scene = combat.scene;
  const dungeonSlot = combat.getFlag(MODULE_ID, "dungeonSlot");
  const encounterId = combat.getFlag(MODULE_ID, "encounterId");
  if (!scene || (dungeonSlot == null && encounterId == null)) return [];
  return scene.tokens.filter((t) => {
    if (!t.getFlag(MODULE_ID, "coverItem")) return false;
    if (dungeonSlot != null)
      return t.getFlag(MODULE_ID, "dungeonSlot") === dungeonSlot;
    return t.getFlag(MODULE_ID, "encounterId") === encounterId;
  });
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
 *
 * Cover items (#96) get the exact same treatment for the exact same reason
 * — spawnCoverItems also creates real, permanent Actors, and tactical cover
 * for one specific fight has no reason to still be standing in the world
 * (or the room) once that fight is over.
 */
async function resolveCombat(combat, outcome, api) {
  const scene = combat.scene;
  const partyIds = partyActorIds();
  const npcCombatants = combat.combatants.filter(
    (c) => c.actor?.id && !partyIds.has(c.actor.id),
  );
  const npcTokenIds = npcCombatants.map((c) => c.tokenId).filter(Boolean);
  const npcActorIds = [...new Set(npcCombatants.map((c) => c.actor.id))];
  const coverTokens = coverItemTokensForCombat(combat);
  const coverTokenIds = coverTokens.map((t) => t.id);
  const coverActorIds = [
    ...new Set(coverTokens.map((t) => t.actor?.id).filter(Boolean)),
  ];

  if (outcome === "victory") {
    const hostileLevels = combat.combatants
      .filter((c) => c.token?.disposition === -1)
      .map((c) => c.actor?.system?.details?.level?.value ?? 0);
    const partyLevel = await api.partyLevel();
    const totalXp = totalCombatXp(hostileLevels, partyLevel);
    const party = (game.actors?.party?.members ?? []).filter(
      (m) => m.type === "character",
    );
    const share = xpPerSurvivor(totalXp, party.length);
    for (const member of party) {
      await member.update({
        "system.details.xp.value":
          (member.system.details.xp.value ?? 0) + share,
      });
    }
    if (game.actors.party)
      await api.addCoins(game.actors.party.id, { gp: lootGpForXp(totalXp) });
  }
  await combat.delete();
  if (npcTokenIds.length && scene)
    await scene.deleteEmbeddedDocuments("Token", npcTokenIds);
  if (npcActorIds.length) await Actor.deleteDocuments(npcActorIds);
  if (coverTokenIds.length && scene)
    await scene.deleteEmbeddedDocuments("Token", coverTokenIds);
  if (coverActorIds.length) await Actor.deleteDocuments(coverActorIds);
}

/** Shared by both the manual GM buttons and the automatic hooks below. */
export async function resolveSlotCombat(
  scene,
  slot,
  outcome,
  api = makeFoundryApi(),
) {
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
  const outcome = hostilesDefeated ? "victory" : "defeat";
  const dungeonSlot = combat.getFlag(MODULE_ID, "dungeonSlot") ?? null;
  const scene = combat.scene;
  await resolveCombat(combat, outcome, makeFoundryApi());
  return { outcome, dungeonSlot, scene };
}

/** Hook target for `updateActor` — module.mjs registers this. */
export function maybeResolveCombatForActor(actor) {
  const combat = game.combats.find(
    (c) =>
      isModuleCombat(c) && c.combatants.some((cb) => cb.actorId === actor.id),
  );
  return combat ? autoResolveIfDecided(combat) : null;
}

/** Hook target for `updateCombatant` — module.mjs registers this. */
export function maybeResolveCombatForCombatant(combatant, changes) {
  if (!("defeated" in changes)) return null;
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

/**
 * Waits AGENT_TIMEOUT_MS, then fires the heuristic fallback for `combatant`
 * — but only if this exact timer is still the freshest thing watching this
 * exact turn. It is NOT a guarantee that nothing else happened in the
 * meantime: `applyAgentDecision` arms a fresh timer after every action, so a
 * multi-action turn can have several of these outstanding at once. What it
 * does guarantee is that a superseded timer bails out silently instead of
 * firing on top of a turn something else already advanced — it captures the
 * combat's `round`/`turn` and the per-turn write counter at arm time, and on
 * fire, re-checks the combatant is still current, the round/turn haven't
 * moved on (catches the same combatant's *next* turn, not just a different
 * one), and the counter is unchanged (catches a decision already applied by
 * this same turn's more-recently-armed timer or the external poller).
 */
export async function armAgentTimeout(combat, combatant) {
  const armedRound = combat.round;
  const armedTurn = combat.turn;
  const armedCounter =
    currentStoredAgentTurnState(combat, combatant.id)?.counter ?? 0;
  await new Promise((resolve) => setTimeout(resolve, AGENT_TIMEOUT_MS));
  if (!game.combats.has(combat.id) || combat.combatant?.id !== combatant.id)
    return;
  if (combat.round !== armedRound || combat.turn !== armedTurn) return;
  const currentCounter =
    currentStoredAgentTurnState(combat, combatant.id)?.counter ?? 0;
  if (currentCounter !== armedCounter) return;
  ui.notifications.warn(
    game.i18n.format("DOMMT.Dungeon.Combat.AgentTimeoutWarning", {
      name: combatant.name,
    }),
  );
  const gmIds = ChatMessage.getWhisperRecipients("GM").map((u) => u.id);
  await ChatMessage.create({
    content: game.i18n.format("DOMMT.Dungeon.Combat.AgentTimeoutChat", {
      name: combatant.name,
    }),
    whisper: gmIds,
  });
  await playHeuristicTurn(combat, combatant);
}

/** Every other still-alive combatant on the opposing side (token disposition
 * differs from `combatant`'s own) — "opposing side" here is just disposition,
 * the same two-bucket split combatSideStatus already uses. */
function combatantOpponents(combat, combatant) {
  const mySide = combatant.token?.disposition;
  return combat.combatants.filter(
    (c) =>
      c.id !== combatant.id &&
      !c.isDefeated &&
      c.token &&
      c.token.disposition !== mySide,
  );
}

/** Chebyshev (8-directional) grid distance between two tokens' positions, in
 * squares — matches how this module already measures everything else
 * (dungeon-layout.mjs's grid-unit geometry), not true PF2e diagonal-cost
 * movement rules. */
function chebyshevSquares(a, b, gridSize) {
  return Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y)) / gridSize;
}

/** Reach for one ready action, in squares — a `reach-N` trait (N in feet)
 * takes priority; otherwise a ranged action's own range increment (feet);
 * otherwise plain melee reach. Confirmed live during planning: a PF2e
 * strike's own `.traits` array carries entries like `{name: 'reach-20', ...}`,
 * and `.item.system.range` is `{increment, max}` in feet for a ranged
 * attack, `null` for melee. */
function actionReachSquares(action, gridDistanceFt) {
  const reachTrait = (action.traits ?? []).find((t) =>
    /^reach-\d+$/.test(t.name ?? ""),
  );
  if (reachTrait) return Number(reachTrait.name.split("-")[1]) / gridDistanceFt;
  const rangeIncrement = action.item?.system?.range?.increment;
  if (rangeIncrement) return rangeIncrement / gridDistanceFt;
  return MELEE_REACH_SQUARES;
}

/**
 * True for a spell squarely inside #118's scope: single-target (no `area`,
 * and `target.value` names exactly one creature — not "plus any number of
 * additional creatures", Chain Lightning's multi-target shape, explicitly
 * deferred to a follow-up issue), save-based damage (a `defense.save`
 * statistic and at least one damage instance), and a fixed 1/2/3-action
 * cost (excludes a variable range like "1 to 3" and a ritual-style
 * duration like "1 hour"). Confirmed live against the real bestiary
 * (Spirit Blast, Void Warp, Vitality Lash all match; Chain Lightning,
 * Harm/Heal's variable cost, and no-save utility spells don't).
 */
function isSpellInScope(spell) {
  const system = spell.system ?? {};
  if (system.area != null) return false;
  const targetValue = system.target?.value ?? "";
  if (!/^1\b/.test(targetValue) || /plus|additional/i.test(targetValue))
    return false;
  if (!system.defense?.save?.statistic) return false;
  if (!Object.keys(system.damage ?? {}).length) return false;
  return /^[123]$/.test(system.time?.value ?? "");
}

/** Squares a single-target spell reaches, from its free-text `range.value`
 * ("30 feet", confirmed live) — `null` when unparseable, since a spell we
 * can't validate as reachable is safer to leave off the candidate list
 * than to guess a range for. */
function spellRangeSquares(spell, gridDistanceFt) {
  const match = /^(\d+)\s*feet$/i.exec(
    (spell.system?.range?.value ?? "").trim(),
  );
  return match ? Number(match[1]) / gridDistanceFt : null;
}

/**
 * True for an area spell squarely inside #119's scope: a `burst` or
 * `emanation` (both simple "radius from a point" shapes — confirmed live
 * against the real bestiary that cone/line/cylinder/square/cube exist too,
 * but need directional geometry this module doesn't compute, so they're
 * deferred to a follow-up issue), save-based damage (a `defense.save`
 * statistic and at least one damage instance), and a fixed 1/2/3-action
 * cost — the same damage/save/cost shape as #118's isSpellInScope, just
 * without the single-target requirement.
 */
function isAreaSpellInScope(spell) {
  const system = spell.system ?? {};
  const areaType = system.area?.type;
  if (areaType !== "burst" && areaType !== "emanation") return false;
  if (!system.defense?.save?.statistic) return false;
  if (!Object.keys(system.damage ?? {}).length) return false;
  return /^[123]$/.test(system.time?.value ?? "");
}

/**
 * The raw stored `agentTurnState` flag, but only when it actually belongs to
 * this exact turn — same `combatantId` *and* the same `round`/`turn` the
 * Combat is on right now. `combatantId` alone isn't enough: the same
 * combatant returns to this same check on every one of its future turns, so
 * comparing only `combatantId` can't tell "still mid-turn" from "this
 * combatant's turn again, next round" — which is exactly what left a lone
 * agent-controlled NPC permanently passive from round 2 onward (its
 * exhausted `actionsRemaining: 0` from the previous round kept matching).
 * Returns `null` whenever the stored flag doesn't match, so callers fall
 * back to a fresh state.
 */
function currentStoredAgentTurnState(combat, combatantId) {
  const stored = combat.getFlag(MODULE_ID, "agentTurnState");
  if (
    stored?.combatantId === combatantId &&
    stored.round === combat.round &&
    stored.turn === combat.turn
  )
    return stored;
  return null;
}

/** Reads back Combat's own per-turn agent bookkeeping, or a fresh one
 * (`initAgentTurnState()`) if this is the first decision seen for this exact
 * combatant/round/turn — see `currentStoredAgentTurnState` above. */
function getAgentTurnState(combat, combatantId) {
  const stored = currentStoredAgentTurnState(combat, combatantId);
  return stored
    ? {
        actionsRemaining: stored.actionsRemaining,
        mapIncrement: stored.mapIncrement,
      }
    : initAgentTurnState();
}

/** Writes the per-turn state back, tagged with the combat's current
 * `round`/`turn` (so a later turn can never mistake this for "still
 * current," see `currentStoredAgentTurnState`) and a `counter` that
 * increments on every write for this same turn. `armAgentTimeout` captures
 * that counter at arm time and re-checks it before firing its fallback, so
 * a timer superseded by a real decision already applied can tell it's stale
 * instead of firing on top of a turn that's still being played. */
async function setAgentTurnState(combat, combatantId, turnState) {
  const counter =
    (currentStoredAgentTurnState(combat, combatantId)?.counter ?? 0) + 1;
  await combat.setFlag(MODULE_ID, "agentTurnState", {
    combatantId,
    round: combat.round,
    turn: combat.turn,
    actionsRemaining: turnState.actionsRemaining,
    mapIncrement: turnState.mapIncrement,
    counter,
  });
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

/** Grid-square {gx, gy} for a token's position. Tokens here are always
 * exactly grid-aligned (one square), same "pixel / gridSize, no center
 * offset" convention chebyshevSquares already uses. */
function tokenCell(token, gridSize) {
  return {
    gx: Math.round(token.x / gridSize),
    gy: Math.round(token.y / gridSize),
  };
}

/** {gx0, gy0, gx1, gy1} bounding every grid square the scene actually
 * covers, so findPath's search space stays finite even on this generator's
 * deliberately over-provisioned canvas (ITEM-20). Null (unbounded search) if
 * the scene has no usable dimensions yet. */
function sceneBounds(combat, gridSize) {
  const width = combat.scene?.width;
  const height = combat.scene?.height;
  if (!width || !height) return null;
  return {
    gx0: 0,
    gy0: 0,
    gx1: Math.ceil(width / gridSize) - 1,
    gy1: Math.ceil(height / gridSize) - 1,
  };
}

/** A wall blocks movement if its own `move` sense says so, unless it's a
 * door currently standing open — Foundry's own collision rules ignore an
 * open door's sense properties, and this generator's doors do transition
 * CLOSED/LOCKED -> OPEN when a player opens one (handleDungeonDoorOpened,
 * dungeon-scene.mjs), so a party that's already opened a door shouldn't
 * find it treated as a wall by pathfinding. */
function wallBlocksMovement(wall) {
  if (wall.move === CONST.WALL_MOVEMENT_TYPES.NONE) return false;
  if (
    wall.door !== CONST.WALL_DOOR_TYPES.NONE &&
    wall.ds === CONST.WALL_DOOR_STATES.OPEN
  )
    return false;
  return true;
}

/** The isBlocked(a, b) predicate pathfinding.mjs's findPath expects, built
 * from this combat's real scene walls — the one piece of Foundry glue
 * pathfinding.mjs is deliberately kept free of (see that file's own
 * docblock for the pure/glue split and why). */
function movementBlockedEdges(combat) {
  const gridSize = combat.scene?.grid?.size ?? 100;
  const walls = (combat.scene?.walls?.contents ?? [])
    .filter(wallBlocksMovement)
    .map((w) => ({ x1: w.c[0], y1: w.c[1], x2: w.c[2], y2: w.c[3] }));
  return blockedEdgesFromWalls(walls, gridSize);
}

/**
 * A real, wall-aware path from `start` toward `targetCell` (#100) — straight
 * to it for an approach, or toward a point projected directly away from it
 * for a retreat, trying progressively shorter retreat distances if the
 * farthest one isn't reachable (a wall directly behind the retreater
 * shouldn't cancel the retreat outright, just shorten it). `speedSquares`
 * bounds how far a retreat goal is projected; how much of the returned path
 * is actually walked is still the caller's own speed clamp. Returns `null`
 * if no path exists at all.
 */
function posturePath(
  start,
  targetCell,
  posture,
  speedSquares,
  isBlocked,
  bounds,
) {
  if (posture !== "retreat")
    return findPath(start, targetCell, isBlocked, bounds);

  const dx = Math.sign(start.gx - targetCell.gx) || 1;
  const dy = Math.sign(start.gy - targetCell.gy) || 1;
  for (let dist = Math.max(1, speedSquares); dist >= 1; dist -= 1) {
    let gx = start.gx + dx * dist;
    let gy = start.gy + dy * dist;
    if (bounds) {
      gx = Math.min(Math.max(gx, bounds.gx0), bounds.gx1);
      gy = Math.min(Math.max(gy, bounds.gy0), bounds.gy1);
    }
    const path = findPath(start, { gx, gy }, isBlocked, bounds);
    if (path && path.length > 1) return path;
  }
  return null;
}

/**
 * Walks up to `speedSquares` steps of `path` (a findPath result, `path[0]`
 * === the mover's own current cell), stopping early once within
 * `stopWithinSquares` (Chebyshev) of `targetCell` — the same "don't
 * overshoot into melee range" clamp this module has always applied, now
 * checked per-waypoint against a possibly-curved route instead of computed
 * once for a straight line. `stopWithinSquares` of `0` (retreat's case)
 * never stops early; only the speed budget and the path's own length do.
 * Returns the destination {gx, gy} actually reached, or `null` if the mover
 * shouldn't move at all (no path, or every waypoint is within the stop
 * distance already).
 */
function walkPath(path, targetCell, speedSquares, stopWithinSquares) {
  let stepIndex = 0;
  for (let i = 1; i < path.length && i <= speedSquares; i += 1) {
    if (stopWithinSquares > 0) {
      const remaining = Math.max(
        Math.abs(path[i].gx - targetCell.gx),
        Math.abs(path[i].gy - targetCell.gy),
      );
      if (remaining < stopWithinSquares) break;
    }
    stepIndex = i;
  }
  return stepIndex > 0 ? path[stepIndex] : null;
}

/**
 * Moves `combatant`'s token toward `target`'s token along a real,
 * wall-aware path (#100), up to its own speed, stopping once adjacent
 * (MELEE_REACH_SQUARES). A no-op if already adjacent, if the combatant has
 * no speed to move with, or if no path to the target exists at all.
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
  if (speedSquares <= 0) return;

  const me = combatant.token;
  const dest = target.token;
  const start = tokenCell(me, gridSize);
  const goal = tokenCell(dest, gridSize);
  const bounds = sceneBounds(combat, gridSize);
  const path = findPath(start, goal, movementBlockedEdges(combat), bounds);
  if (!path) return;

  const waypoint = walkPath(path, goal, speedSquares, MELEE_REACH_SQUARES);
  if (!waypoint) return;
  await me.update({ x: waypoint.gx * gridSize, y: waypoint.gy * gridSize });
}

/**
 * PF2e's own `applyDamage` never applies any condition on its own — confirmed
 * live (#107): a real critical hit took a scratch NPC from 1 HP to 0 with
 * zero condition change. `Combatant#isDefeated` (which `combatSideStatus`
 * needs to auto-resolve a fight) only needs the raw `defeated` flag or the
 * actor having PF2e's 'dead' status — neither happens on its own, so without
 * this, combat can never auto-resolve once a strike (heuristic or
 * agent-controlled) reduces someone to 0 HP.
 *
 * For an NPC, setting `defeated` directly is sufficient — confirmed live to
 * be identical to what the GM's own Combat Tracker skull-toggle does, no
 * actor condition required, simpler and safer than fabricating a 'dead'
 * status ourselves. For a party member, PF2e's own `actor.increaseCondition
 * ('dying')` is the correct call: it's the system's real API and correctly
 * cascades Unconscious/Blinded/Prone/Off-Guard automatically (confirmed
 * live) — hand-rolling that cascade ourselves would risk getting real PF2e
 * rules wrong against an actual player's character. Called on every hit that
 * leaves HP at or below 0, not just the first — a party member already
 * dying who's hit again should have their dying value increase further, per
 * PF2e's own rules, not be skipped as "already handled."
 */
async function applyDefeatIfReducedToZero(target) {
  if ((target.actor?.system?.attributes?.hp?.value ?? 1) > 0) return;
  if (target.actor?.type === "character") {
    await target.actor.increaseCondition("dying");
  } else if (!target.isDefeated) {
    await target.update({ defeated: true });
  }
}

/** Grid cells currently occupied by an undestroyed cover item (#96) on this
 * combat's scene — a hazard actor cover-items.mjs's spawnCoverItems flagged
 * `flags.dommt.coverItem` at spawn time, filtered to ones that still have HP
 * (a destroyed cover item no longer blocks a line of fire, whatever state
 * its token/actor happen to still be in on the scene). */
function activeCoverCells(combat) {
  const gridSize = combat.scene?.grid?.size ?? 100;
  return (combat.scene?.tokens ?? [])
    .filter(
      (t) =>
        t.getFlag(MODULE_ID, "coverItem") &&
        (t.actor?.system?.attributes?.hp?.value ?? 0) > 0,
    )
    .map((t) => tokenCell(t, gridSize));
}

/**
 * Runs `roll` with a temporary +2 circumstance AC effect (#96,
 * COVER_EFFECT_DATA) applied to `target`'s actor if a cover item stands
 * between `attacker` and `target` — removed again immediately after, in a
 * `finally`, so the bonus applies to exactly this one roll and never
 * lingers on the actor afterward. PF2e's own FlatModifier rule element does
 * the real work of folding it into the attack roll's DC comparison; this
 * only decides whether it applies for this specific attacker/target pair
 * and cleans up after itself.
 */
async function withCoverBonus(combat, attacker, target, roll) {
  const gridSize = combat.scene?.grid?.size ?? 100;
  const coverCells = activeCoverCells(combat);
  const covered =
    coverCells.length > 0 &&
    coverBlocksLineOfFire(
      tokenCell(attacker.token, gridSize),
      tokenCell(target.token, gridSize),
      coverCells,
    );
  let effect = null;
  if (covered) {
    [effect] = await target.actor.createEmbeddedDocuments("Item", [
      COVER_EFFECT_DATA,
    ]);
  }
  try {
    return await roll();
  } finally {
    if (effect) await effect.delete();
  }
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
async function rollAndApplyStrike(combat, combatant, target) {
  const strike = combatant.actor?.system?.actions?.find(
    (a) => a.type === "strike" && a.ready !== false,
  );
  if (!strike) return null;

  const prevShowCheck = game.user.flags?.pf2e?.settings?.showCheckDialogs;
  const prevShowDamage = game.user.flags?.pf2e?.settings?.showDamageDialogs;
  await game.user.update({
    "flags.pf2e.settings.showCheckDialogs": false,
    "flags.pf2e.settings.showDamageDialogs": false,
  });

  try {
    return await withCoverBonus(combat, combatant, target, async () => {
      const targetRef = { document: target.token };
      await strike.variants[0].roll({ target: targetRef, createMessage: true });
      const outcome =
        game.messages.contents.at(-1)?.flags?.pf2e?.context?.outcome ?? null;
      if (outcome === "success" || outcome === "criticalSuccess") {
        const damageRoll = await strike.damage({
          target: targetRef,
          outcome,
          createMessage: true,
        });
        if (damageRoll) {
          await target.actor.applyDamage({
            damage: damageRoll,
            token: target.token,
            outcome,
          });
          await applyDefeatIfReducedToZero(target);
        }
      }
      return outcome;
    });
  } finally {
    await game.user.update({
      "flags.pf2e.settings.showCheckDialogs": prevShowCheck,
      "flags.pf2e.settings.showDamageDialogs": prevShowDamage,
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
  if (
    !combatant ||
    partyActorIds().has(combatant.actor?.id) ||
    combatant.actor?.hasPlayerOwner
  )
    return;

  if (combatant.isDefeated) {
    await combat.nextTurn();
    return;
  }

  if (combatant.getFlag(MODULE_ID, "agentControlled")) {
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
  if (!game.combats.has(combat.id) || combat.combatant?.id !== combatant.id)
    return;
  await playHeuristicTurn(combat, combatant);
}

/** ITEM-8's original heuristic turn: move adjacent to the nearest opponent
 * if not already, strike once, apply the result, advance the turn — shared
 * by the non-agent-controlled path above and the agent-timeout fallback
 * below, so both use exactly the same behavior. */
export async function playHeuristicTurn(combat, combatant) {
  const target = nearestOpponent(combat, combatant);
  if (target) {
    await stepToward(
      combat,
      combatant,
      target.combatant,
      target.distanceSquares,
    );
    await rollAndApplyStrike(combat, combatant, target.combatant);
  }
  if (game.combats.has(combat.id) && combat.combatant?.id === combatant.id) {
    await combat.nextTurn();
  }
}

// --- Task 3: external agent-controlled turn decisions --------------------

/**
 * The current decision point for the due combatant, or `null` if there's
 * nothing for an external agent to decide right now (no combat due, the
 * current combatant isn't agent-controlled, or it's already defeated). The
 * *only* read surface `tools/agent-loop`'s poller uses — see module.mjs's
 * api.getPendingAgentTurn.
 */
export function getPendingAgentTurn(combat) {
  if (!isModuleCombat(combat)) return null;
  const combatant = combat.combatant;
  if (
    !combatant ||
    combatant.isDefeated ||
    !combatant.getFlag(MODULE_ID, "agentControlled")
  )
    return null;

  const turnState = getAgentTurnState(combat, combatant.id);
  const gridSize = combat.scene?.grid?.size ?? 100;
  const gridDistanceFt = combat.scene?.grid?.distance ?? 5;

  const rawOpponents = combatantOpponents(combat, combatant);
  const opponents = rawOpponents.map((c) => ({
    id: c.id,
    name: c.name,
    distanceSquares: chebyshevSquares(combatant.token, c.token, gridSize),
    hp: c.actor?.system?.attributes?.hp?.value ?? null,
  }));

  const readyActions = (combatant.actor?.system?.actions ?? [])
    .filter((a) => a.type === "strike" && a.ready !== false)
    .map((a) => ({
      slug: a.item?.slug ?? a.slug ?? a.label,
      label: a.label,
      variantCount: a.variants?.length ?? 1,
      reachSquares: actionReachSquares(a, gridDistanceFt),
    }));
  const hasRangedOrReach = readyActions.some(
    (a) => a.reachSquares > MELEE_REACH_SQUARES,
  );

  const readySpells = (combatant.actor?.spellcasting?.contents ?? [])
    .flatMap((entry) =>
      (entry.spells?.contents ?? []).filter(isSpellInScope).map((spell) => {
        const rangeSquares = spellRangeSquares(spell, gridDistanceFt);
        if (rangeSquares == null) return null;
        return {
          id: spell.id,
          slug: spell.slug,
          label: spell.name,
          cost: Number(spell.system.time.value),
          rangeSquares,
          save: spell.system.defense.save.statistic,
          basic: spell.system.defense.save.basic,
          entryId: entry.id,
        };
      }),
    )
    .filter(Boolean);

  const readyAreaSpells = (combatant.actor?.spellcasting?.contents ?? [])
    .flatMap((entry) =>
      (entry.spells?.contents ?? []).filter(isAreaSpellInScope).map((spell) => {
        const radiusSquares = (spell.system.area.value ?? 0) / gridDistanceFt;
        const withinRadius = (centerToken) =>
          rawOpponents
            .filter(
              (o) => chebyshevSquares(centerToken, o.token, gridSize) <= radiusSquares,
            )
            .map((o) => ({ id: o.id, name: o.name }));
        const placements =
          spell.system.area.type === "emanation"
            ? [{ centerType: "self", centerId: null, affected: withinRadius(combatant.token) }]
            : rawOpponents.map((center) => ({
                centerType: "opponent",
                centerId: center.id,
                affected: withinRadius(center.token),
              }));
        return {
          id: spell.id,
          slug: spell.slug,
          label: spell.name,
          cost: Number(spell.system.time.value),
          save: spell.system.defense.save.statistic,
          basic: spell.system.defense.save.basic,
          entryId: entry.id,
          placements,
        };
      }),
    );

  const self = {
    name: combatant.name,
    hp: combatant.actor?.system?.attributes?.hp?.value ?? null,
    conditions: Array.from(combatant.actor?.conditions ?? []).map(
      (c) => c.slug,
    ),
  };

  const candidates = buildCandidateList({
    opponents,
    readyActions,
    readySpells,
    readyAreaSpells,
    turnState,
    hazard: null,
    hasRangedOrReach,
  });
  return {
    combatId: combat.id,
    combatantId: combatant.id,
    context: buildDecisionContext({
      self,
      opponents,
      candidates,
      roundNumber: combat.round,
    }),
    candidates,
  };
}

/** Moves `combatant`'s token up to its own speed, along a real, wall-aware
 * path (#100) toward or away from `target`'s token depending on `posture`.
 * For `approach`, stops adjacent to the target rather than overshooting past
 * it — the same clamp stepToward uses. `retreat` has no "don't overshoot"
 * concept, so it's unclamped, bounded only by speed and posturePath's own
 * progressively-shorter-distance fallback. A no-op if already at the desired
 * distance, with no speed to move, or if no usable path exists. */
async function strideByPosture(combat, combatant, posture, target) {
  const gridSize = combat.scene?.grid?.size ?? 100;
  const gridDistanceFt = combat.scene?.grid?.distance ?? 5;
  const speedFt = combatant.actor?.system?.movement?.speeds?.land?.value ?? 0;
  const speedSquares = Math.floor(speedFt / gridDistanceFt);
  if (speedSquares <= 0 || !target) return;

  const me = combatant.token;
  const dest = target.token;
  const start = tokenCell(me, gridSize);
  const targetCell = tokenCell(dest, gridSize);
  const bounds = sceneBounds(combat, gridSize);
  const isBlocked = movementBlockedEdges(combat);
  const path = posturePath(
    start,
    targetCell,
    posture,
    speedSquares,
    isBlocked,
    bounds,
  );
  if (!path) return;

  const stopWithin = posture === "approach" ? MELEE_REACH_SQUARES : 0;
  const waypoint = walkPath(path, targetCell, speedSquares, stopWithin);
  if (!waypoint) return;
  await me.update({ x: waypoint.gx * gridSize, y: waypoint.gy * gridSize });
}

/** Rolls one strike at a specific MAP `variantIndex` against `target` and
 * applies damage on a hit — the same dialog-suppression/roll/damage/
 * applyDamage sequence rollAndApplyStrike already uses, generalized to a
 * caller-chosen variant instead of always variants[0]. */
async function rollAndApplyStrikeAtVariant(
  combat,
  combatant,
  target,
  actionSlug,
  variantIndex,
) {
  const strike = (combatant.actor?.system?.actions ?? []).find(
    (a) =>
      a.type === "strike" &&
      a.ready !== false &&
      (a.item?.slug ?? a.slug ?? a.label) === actionSlug,
  );
  if (!strike) return null;

  const prevShowCheck = game.user.flags?.pf2e?.settings?.showCheckDialogs;
  const prevShowDamage = game.user.flags?.pf2e?.settings?.showDamageDialogs;
  await game.user.update({
    "flags.pf2e.settings.showCheckDialogs": false,
    "flags.pf2e.settings.showDamageDialogs": false,
  });
  try {
    return await withCoverBonus(combat, combatant, target, async () => {
      const targetRef = { document: target.token };
      const variant =
        strike.variants[Math.min(variantIndex, strike.variants.length - 1)];
      await variant.roll({ target: targetRef, createMessage: true });
      const outcome =
        game.messages.contents.at(-1)?.flags?.pf2e?.context?.outcome ?? null;
      if (outcome === "success" || outcome === "criticalSuccess") {
        const damageRoll = await strike.damage({
          target: targetRef,
          outcome,
          createMessage: true,
        });
        if (damageRoll) {
          await target.actor.applyDamage({
            damage: damageRoll,
            token: target.token,
            outcome,
          });
          await applyDefeatIfReducedToZero(target);
        }
      }
      return outcome;
    });
  } finally {
    await game.user.update({
      "flags.pf2e.settings.showCheckDialogs": prevShowCheck,
      "flags.pf2e.settings.showDamageDialogs": prevShowDamage,
    });
  }
}

/**
 * Casts `spellId` (from spellcasting entry `entryId`) at `target`, rolls the
 * target's own save against the spell's DC, then rolls and applies damage —
 * confirmed live this is a 4-step chain, not the single `cast()` call a
 * strike's `.roll()` might suggest by analogy: `entryDoc.cast()` alone
 * announces the spell (posts its chat card) but rolls no save and applies no
 * damage. The target's own `actor.saves[save].roll({dc})` produces the real
 * outcome; `spell.rollDamage({target, outcome})` then handles basic-save
 * doubling/halving internally, the same way `strike.damage()` handles
 * crit doubling for a Strike. Same dialog-suppression convention as
 * rollAndApplyStrikeAtVariant, since neither the save roll nor the damage
 * roll forwards a skipDialog option of its own.
 */
async function castSpellAndApplySave(
  combatant,
  target,
  spellId,
  entryId,
  save,
) {
  const entry = combatant.actor?.spellcasting?.contents?.find(
    (e) => e.id === entryId,
  );
  const spell = entry?.spells?.contents?.find((s) => s.id === spellId);
  if (!entry || !spell) return null;

  const saveStat = target.actor?.saves?.[save];
  if (!saveStat) return null;

  const prevShowCheck = game.user.flags?.pf2e?.settings?.showCheckDialogs;
  const prevShowDamage = game.user.flags?.pf2e?.settings?.showDamageDialogs;
  await game.user.update({
    "flags.pf2e.settings.showCheckDialogs": false,
    "flags.pf2e.settings.showDamageDialogs": false,
  });
  try {
    const targetRef = { document: target.token };
    await entry.cast(spell, { target: targetRef, createMessage: true });
    const dc = entry.statistic?.dc?.value ?? 10;
    await saveStat.roll({ dc: { value: dc }, createMessage: true });
    const outcome =
      game.messages.contents.at(-1)?.flags?.pf2e?.context?.outcome ?? null;
    const damageRoll = await spell.rollDamage?.({
      target: targetRef,
      outcome,
      createMessage: true,
    });
    if (damageRoll) {
      await target.actor.applyDamage({
        damage: damageRoll,
        token: target.token,
        outcome,
      });
      await applyDefeatIfReducedToZero(target);
    }
    return outcome;
  } finally {
    await game.user.update({
      "flags.pf2e.settings.showCheckDialogs": prevShowCheck,
      "flags.pf2e.settings.showDamageDialogs": prevShowDamage,
    });
  }
}

/**
 * Casts `spellId` (from spellcasting entry `entryId`) once, then rolls each
 * of `targets`' own saves against the spell's DC and applies damage to each
 * independently — confirmed live this is the correct way to resolve a
 * burst/emanation against the affected set `getPendingAgentTurn` already
 * precomputed: PF2e's own area-spell chat card offers an interactive
 * `placeTemplate()` flow for the GM to draw the AoE on the canvas and
 * target tokens by hand, but since this module always knows in advance
 * which opponents a candidate's placement catches (that's how the
 * candidate was built), it bypasses that UI entirely and drives the same
 * per-target save/damage/apply sequence #118's castSpellAndApplySave uses
 * for a single target, just once per affected creature.
 */
async function castAreaSpellAndApplySaves(combatant, targets, spellId, entryId, save) {
  const entry = combatant.actor?.spellcasting?.contents?.find(
    (e) => e.id === entryId,
  );
  const spell = entry?.spells?.contents?.find((s) => s.id === spellId);
  if (!entry || !spell) return null;

  const prevShowCheck = game.user.flags?.pf2e?.settings?.showCheckDialogs;
  const prevShowDamage = game.user.flags?.pf2e?.settings?.showDamageDialogs;
  await game.user.update({
    "flags.pf2e.settings.showCheckDialogs": false,
    "flags.pf2e.settings.showDamageDialogs": false,
  });
  try {
    await entry.cast(spell, { createMessage: true });
    const dc = entry.statistic?.dc?.value ?? 10;
    const outcomes = [];
    for (const target of targets) {
      const saveStat = target.actor?.saves?.[save];
      if (!saveStat) continue;
      const targetRef = { document: target.token };
      await saveStat.roll({ dc: { value: dc }, createMessage: true });
      const outcome =
        game.messages.contents.at(-1)?.flags?.pf2e?.context?.outcome ?? null;
      const damageRoll = await spell.rollDamage?.({
        target: targetRef,
        outcome,
        createMessage: true,
      });
      if (damageRoll) {
        await target.actor.applyDamage({
          damage: damageRoll,
          token: target.token,
          outcome,
        });
        await applyDefeatIfReducedToZero(target);
      }
      outcomes.push({ targetId: target.id, outcome });
    }
    return outcomes;
  } finally {
    await game.user.update({
      "flags.pf2e.settings.showCheckDialogs": prevShowCheck,
      "flags.pf2e.settings.showDamageDialogs": prevShowDamage,
    });
  }
}

/**
 * Executes exactly one chosen candidate for `combatantId`'s current turn in
 * `combat`, updates the per-turn state, and advances the turn once actions
 * run out or `endTurn` was chosen. Returns the pending-turn shape for the
 * *next* iteration (same shape getPendingAgentTurn returns), or `null` once
 * the turn has actually ended. The only mutation path an external process
 * ever reaches — see module.mjs's api.applyAgentDecision.
 */
export async function applyAgentDecision(combat, combatantId, candidateId) {
  const pending = getPendingAgentTurn(combat);
  if (!pending || pending.combatantId !== combatantId) return null;
  const candidate = pending.candidates.find((c) => c.id === candidateId);
  if (!candidate) return null;

  const combatant = combat.combatant;
  if (candidate.type === "stride") {
    const target = candidate.targetId
      ? combatantOpponents(combat, combatant).find(
          (c) => c.id === candidate.targetId,
        )
      : null;
    await strideByPosture(combat, combatant, candidate.posture, target);
  } else if (candidate.type === "strike") {
    const target = combatantOpponents(combat, combatant).find(
      (c) => c.id === candidate.targetId,
    );
    if (target)
      await rollAndApplyStrikeAtVariant(
        combat,
        combatant,
        target,
        candidate.actionSlug,
        candidate.variantIndex,
      );
  } else if (candidate.type === "cast") {
    const target = combatantOpponents(combat, combatant).find(
      (c) => c.id === candidate.targetId,
    );
    if (target)
      await castSpellAndApplySave(
        combatant,
        target,
        candidate.spellId,
        candidate.entryId,
        candidate.save,
      );
  } else if (candidate.type === "castArea") {
    const targets = combatantOpponents(combat, combatant).filter((c) =>
      candidate.affectedIds.includes(c.id),
    );
    if (targets.length)
      await castAreaSpellAndApplySaves(
        combatant,
        targets,
        candidate.spellId,
        candidate.entryId,
        candidate.save,
      );
  }

  const turnState = getAgentTurnState(combat, combatantId);
  const nextTurnState = applyCandidateToTurnState(turnState, candidate);
  await setAgentTurnState(combat, combatantId, nextTurnState);

  if (nextTurnState.actionsRemaining <= 0) {
    if (game.combats.has(combat.id) && combat.combatant?.id === combatantId)
      await combat.nextTurn();
    return null;
  }
  // Actions remain — re-arm the timeout for the next decision rather than
  // leaving this turn permanently unwatched after one action.
  armAgentTimeout(combat, combatant);
  return getPendingAgentTurn(combat);
}
