/**
 * The Foundry side of a physical dungeon: creates the run's own Scene,
 * builds one room at a time (walls + a Region carrying the automatic
 * room-entry trigger), and wires that trigger back into dungeon-runner.mjs.
 *
 * Rooms are built lazily — see dungeon-runner.mjs's docblock for why a
 * pre-built-everything approach would need reindexing logic this design
 * avoids entirely. dungeon-layout.mjs supplies all the grid-unit geometry;
 * this file only ever converts that to pixels and talks to Foundry.
 *
 * Modelled on scene-divination.mjs's Scene.create / activate-vs-view
 * precedent, but for a real explorable scene (tokenVision:true, real walls)
 * rather than a flat card-display one.
 */
import {
  ROOM_SIZE, ROOMS_PER_ROW, CORRIDOR_LEN,
  slotRect, slotRowCol, roomEnclosureWalls, buildConnectionGeometry
} from './dungeon-layout.mjs';
import { freeSpotInRect } from './placement.mjs';
import { generateEncounter } from './encounter-generator.mjs';
import { getRunState, advanceToRoom, undoLastRoomEntry, canUndoRoomEntry } from './dungeon-runner.mjs';

const MODULE_ID = 'deck-of-many-more-things';
const GRID_SIZE = 100;
const MARGIN_ROOMS = 1;

const toPixels = (gridVal) => gridVal * GRID_SIZE;

const REGION_ENTRY_SCRIPT =
  `const slot = region.getFlag('${MODULE_ID}', 'physicalSlot');\n` +
  `await game.modules.get('${MODULE_ID}').api.onDungeonRoomEnter(scene.id, event.data.token.id, slot);`;

function wallDoc({ x1, y1, x2, y2 }, { door = CONST.WALL_DOOR_TYPES.NONE, ds = CONST.WALL_DOOR_STATES.CLOSED, flags = null } = {}) {
  return {
    c: [toPixels(x1), toPixels(y1), toPixels(x2), toPixels(y2)],
    door, ds,
    sight: CONST.WALL_SENSE_TYPES.NORMAL,
    move: CONST.WALL_MOVEMENT_TYPES.NORMAL,
    ...(flags ? { flags } : {})
  };
}

function requiredDimensions(maxSlot) {
  const { row } = slotRowCol(maxSlot);
  const stride = ROOM_SIZE + CORRIDOR_LEN;
  return {
    width: toPixels(ROOMS_PER_ROW * stride + MARGIN_ROOMS),
    height: toPixels((row + 1) * stride + MARGIN_ROOMS)
  };
}

async function ensureSceneCovers(scene, slot) {
  const { width, height } = requiredDimensions(slot);
  const nextWidth = Math.max(scene.width ?? 0, width);
  const nextHeight = Math.max(scene.height ?? 0, height);
  if (nextWidth > (scene.width ?? 0) || nextHeight > (scene.height ?? 0)) {
    await scene.update({ width: nextWidth, height: nextHeight });
  }
}

export async function createDungeonScene() {
  return Scene.create({
    name: 'Dungeon Crawl',
    tokenVision: true,
    fogExploration: true,
    backgroundColor: '#2b2620',
    grid: { type: 1, size: GRID_SIZE, distance: 5, units: 'ft' },
    ...requiredDimensions(ROOMS_PER_ROW), // headroom for the first two rows
    flags: { [MODULE_ID]: { role: 'dungeon-run' } }
  });
}

/**
 * Build ONE physical room at `slot`. Connects it to `slot - 1` (door starts
 * LOCKED) unless `slot === 0`. `isGoal` suppresses the outgoing side — the
 * goal room has nowhere further to lead.
 */
export async function buildRoomAtSlot(scene, slot, { isGoal = false } = {}) {
  await ensureSceneCovers(scene, slot);

  const walls = roomEnclosureWalls(slot, { hasOutgoing: !isGoal }).map((side) => wallDoc(side));

  if (slot > 0) {
    const { doorWall, plainWalls } = buildConnectionGeometry(slot - 1);
    walls.push(wallDoc(doorWall, {
      door: CONST.WALL_DOOR_TYPES.DOOR,
      ds: CONST.WALL_DOOR_STATES.LOCKED,
      flags: { [MODULE_ID]: { dungeonDoorToSlot: slot } }
    }));
    walls.push(...plainWalls.map((w) => wallDoc(w)));
  }

  if (walls.length) await scene.createEmbeddedDocuments('Wall', walls);

  const rect = slotRect(slot);
  await scene.createEmbeddedDocuments('Region', [{
    name: `Room ${slot}`,
    shapes: [{
      type: 'rectangle',
      x: toPixels(rect.gx), y: toPixels(rect.gy),
      width: toPixels(rect.gw), height: toPixels(rect.gh)
    }],
    flags: { [MODULE_ID]: { physicalSlot: slot } },
    behaviors: [{
      name: 'Room Entry',
      type: 'executeScript',
      system: { events: ['tokenEnter'], source: REGION_ENTRY_SCRIPT }
    }]
  }]);
}

export async function unlockDoorToSlot(scene, slot) {
  const wall = scene.walls.find((w) => w.getFlag(MODULE_ID, 'dungeonDoorToSlot') === slot);
  if (wall) await wall.update({ ds: CONST.WALL_DOOR_STATES.CLOSED });
}

export async function relockDoorToSlot(scene, slot) {
  const wall = scene.walls.find((w) => w.getFlag(MODULE_ID, 'dungeonDoorToSlot') === slot);
  if (wall) await wall.update({ ds: CONST.WALL_DOOR_STATES.LOCKED });
}

/** Whether a combat room's monsters have already been placed. */
export function isSlotPopulated(scene, slot) {
  return scene.tokens.some((t) => t.getFlag(MODULE_ID, 'dungeonSlot') === slot);
}

/**
 * Generate a combat room's encounter inside slot's own footprint. Hidden by
 * default (the discovery beat) — room 0 is the one exception, since the
 * party starts there with no door to walk through, so Start calls this with
 * `hidden:false`. The GM still gets the existing theme dialog + Accept/Reroll
 * preview — nothing about that flow changes, it's just handed a target room
 * instead of "near a focus token."
 */
export async function populateSlotEncounter(scene, slot, {
  prefillTraits = [], prefillExcludeTraits = [], hidden = true, levelOffsetBias = 0, locationTag = null
} = {}) {
  const rect = slotRect(slot);
  await generateEncounter({
    prefillTraits,
    prefillExcludeTraits,
    levelOffsetBias,
    locationTag,
    originArea: {
      x: toPixels(rect.gx), y: toPixels(rect.gy),
      width: toPixels(rect.gw), height: toPixels(rect.gh)
    },
    forceHidden: hidden,
    extraFlags: { [MODULE_ID]: { dungeonSlot: slot } }
  });
}

/** Un-hides slot's tagged tokens (discovery). Returns the ids revealed. */
export async function revealSlotTokens(scene, slot) {
  const tokens = scene.tokens.filter((t) => t.getFlag(MODULE_ID, 'dungeonSlot') === slot && t.hidden);
  const ids = tokens.map((t) => t.id);
  if (ids.length) await scene.updateEmbeddedDocuments('Token', ids.map((id) => ({ _id: id, hidden: false })));
  return ids;
}

/** Inverse of revealSlotTokens, for undo. */
export async function hideTokens(scene, tokenIds) {
  if (tokenIds?.length) {
    await scene.updateEmbeddedDocuments('Token', tokenIds.map((id) => ({ _id: id, hidden: true })));
  }
}

function partyActorIds() {
  return new Set((game.actors?.party?.members ?? []).map((m) => m.id));
}

/** Start-of-run: place the party's tokens inside slot, removing any of their
 * tokens elsewhere in the world first. */
export async function placePartyInSlot(scene, slot, partyMembers) {
  const rect = slotRect(slot);
  const occupied = [];
  const createdIds = [];
  for (const actor of partyMembers) {
    for (const s of game.scenes) {
      const existing = s.tokens.filter((t) => t.actor?.id === actor.id);
      if (existing.length) await s.deleteEmbeddedDocuments('Token', existing.map((t) => t.id));
    }
    const spot = freeSpotInRect({ occupied, rect, gw: 1, gh: 1 }) ?? { gx: rect.gx, gy: rect.gy, gw: 1, gh: 1 };
    occupied.push(spot);
    const td = await actor.getTokenDocument({ x: toPixels(spot.gx), y: toPixels(spot.gy) });
    const [created] = await scene.createEmbeddedDocuments('Token', [td.toObject()]);
    createdIds.push(created.id);
  }
  return createdIds;
}

/** Move already-placed tokens into slot — for undo, stepping the party back. */
export async function moveTokensToSlot(scene, tokenIds, slot) {
  if (!tokenIds?.length) return;
  const rect = slotRect(slot);
  const updates = tokenIds.map((id, i) => ({
    _id: id,
    x: toPixels(rect.gx + (i % rect.gw)),
    y: toPixels(rect.gy + Math.floor(i / rect.gw))
  }));
  await scene.updateEmbeddedDocuments('Token', updates);
}

/**
 * The stable module.api entry point the Region's dispatcher script calls.
 * Ignores anything that isn't a genuine party token entering the true
 * frontier room — a monster's own token, a familiar, or a GM drag-move past
 * a still-locked wall shouldn't be able to desync the tracker.
 */
export async function handleDungeonRoomEnter(sceneId, tokenId, slot) {
  // The Region's dispatcher script only ever runs on a GM client (executeScript
  // is gmOnly), but this function is also reachable directly through
  // module.api — guard it the same way rather than trusting only the caller.
  if (!game.user.isGM) return;
  const scene = game.scenes.get(sceneId);
  const token = scene?.tokens.get(tokenId);
  if (!token?.actor || !partyActorIds().has(token.actor.id)) return;

  const state = getRunState(sceneId);
  if (!state) return;
  const nextRoomId = state.rooms[state.currentIndex + 1]?.id;
  if (!nextRoomId || state.physicalSlotByRoomId[nextRoomId] !== slot) return;

  const revealedTokenIds = await revealSlotTokens(scene, slot);
  await advanceToRoom({ sceneId, roomId: nextRoomId, revealedTokenIds });
}

/** Reverses the most recent automatic entry: re-hides what was revealed,
 * re-locks the door, and steps the party's tokens back a room. */
export async function undoRoomEntry(sceneId) {
  const scene = game.scenes.get(sceneId);
  const state = getRunState(sceneId);
  if (!scene || !canUndoRoomEntry(state)) {
    ui.notifications.warn(game.i18n.localize('DOMMT.Dungeon.AlreadyResolvedUndoWarning'));
    return;
  }

  const entry = state.lastAutoEntry;
  await hideTokens(scene, entry.revealedTokenIds);
  await relockDoorToSlot(scene, state.physicalSlotByRoomId[entry.roomId]);

  const previousRoomId = state.rooms[entry.fromIndex].id;
  const previousSlot = state.physicalSlotByRoomId[previousRoomId];
  const partyIds = partyActorIds();
  const partyTokenIds = scene.tokens.filter((t) => partyIds.has(t.actor?.id)).map((t) => t.id);
  await moveTokensToSlot(scene, partyTokenIds, previousSlot);

  await undoLastRoomEntry({ sceneId });
}
