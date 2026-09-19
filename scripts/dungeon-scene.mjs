/**
 * The Foundry side of a physical dungeon: creates the run's own Scene and
 * builds one room at a time (walls, floor art, and a real reveal door).
 *
 * Rooms are built lazily — see dungeon-runner.mjs's docblock for why a
 * pre-built-everything approach would need reindexing logic this design
 * avoids entirely. dungeon-layout.mjs supplies all the grid-unit geometry;
 * this file only ever converts that to pixels and talks to Foundry.
 *
 * Modelled on scene-divination.mjs's Scene.create / activate-vs-view
 * precedent, but for a real explorable scene (tokenVision:true, real walls)
 * rather than a flat card-display one.
 *
 * Room discovery is triggered by opening a real door (the "reveal door" on
 * each room's own incoming face, flagged `dungeonRevealDoorForSlot`) rather
 * than a token merely walking into the room's footprint — module.mjs's own
 * `updateWall` hook calls `handleDungeonDoorOpened` directly (no Region or
 * `module.api` indirection needed for that, unlike the walk-in trigger this
 * replaced, which needed `module.api` because a Region's `executeScript`
 * behavior runs in a more sandboxed context).
 */
import {
  ROOM_SIZE, ROOMS_PER_ROW, CORRIDOR_LEN,
  slotRect, slotRowCol, roomEnclosureWalls, buildConnectionGeometry, corridorTileVariant
} from './dungeon-layout.mjs';
import { freeSpotInRect } from './placement.mjs';
import { generateEncounter } from './encounter-generator.mjs';
import { getRunState, advanceToRoom, undoLastRoomEntry, canUndoRoomEntry } from './dungeon-runner.mjs';
import { startCombatForSlot } from './dungeon-combat.mjs';

const MODULE_ID = 'deck-of-many-more-things';
const GRID_SIZE = 100;
const MARGIN_ROOMS = 1;

const toPixels = (gridVal) => gridVal * GRID_SIZE;

const ROOM_ART_DIR = `modules/${MODULE_ID}/assets/dungeon-rooms`;
const CORRIDOR_ART_PATH = `${ROOM_ART_DIR}/corridor.webp`;
const CORRIDOR_ART_BY_VARIANT = {
  single: CORRIDOR_ART_PATH,
  end: `${ROOM_ART_DIR}/corridor-end.webp`,
  mid: `${ROOM_ART_DIR}/corridor-mid.webp`
};

/** The path to a room's background art — a dedicated image per locationTag
 * for the goal room (there's only ever one), or one of its regular pool of
 * pregenerated variants otherwise. */
function roomArtPath({ locationTag, isGoal, artVariant }) {
  return isGoal ? `${ROOM_ART_DIR}/${locationTag}-goal.webp` : `${ROOM_ART_DIR}/${locationTag}-${artVariant}.webp`;
}

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
 * goal room has nowhere further to lead. `locationTag`/`artVariant` (from the
 * room's own data — see dungeon-deck.mjs) pick its background Tile. `seed`
 * (the run's own seed) drives the connecting door/opening's independently
 * random placement on each side (ITEM-9) — deterministic per run, so it
 * needs threading through from the caller like `locationTag`/`artVariant`.
 */
export async function buildRoomAtSlot(scene, slot, { isGoal = false, locationTag = null, artVariant = 0, seed = '' } = {}) {
  await ensureSceneCovers(scene, slot);

  const walls = roomEnclosureWalls(slot, { hasOutgoing: !isGoal }).map((side) => wallDoc(side));
  const tiles = [];

  if (slot > 0) {
    const { doorWall, revealDoorWall, plainWalls, corridorRect } = buildConnectionGeometry(slot - 1, seed);
    walls.push(wallDoc(doorWall, {
      door: CONST.WALL_DOOR_TYPES.DOOR,
      ds: CONST.WALL_DOOR_STATES.LOCKED,
      flags: { [MODULE_ID]: { dungeonDoorToSlot: slot } }
    }));
    // Never locked — the first door is the progress gate. This one is just
    // the "open it and see what's inside" trigger (handleDungeonDoorOpened),
    // freely operable by players the moment they're through the first door.
    walls.push(wallDoc(revealDoorWall, {
      door: CONST.WALL_DOOR_TYPES.DOOR,
      ds: CONST.WALL_DOOR_STATES.CLOSED,
      flags: { [MODULE_ID]: { dungeonRevealDoorForSlot: slot } }
    }));
    walls.push(...plainWalls.map((w) => wallDoc(w)));
    // corridorRect is tiled once per grid square rather than stretching one
    // image across it — corridor.webp is a small self-contained "box"
    // texture that looks wrong scaled. A gallery longer than one tile
    // (ITEM-9/13) uses the open-sided corridor-end/-mid variants instead of
    // repeating the fully-walled box, so it reads as one continuous hallway
    // rather than a stack of separate boxed alcoves (ITEM-12) — see
    // corridorTileVariant's docblock for which tile/rotation goes where.
    // Unlike the room-art Tile below, these can be rotated (ITEM-12), so
    // they must NOT use anchorX/Y:0 — rotation pivots around the texture
    // anchor, and an anchor pinned to the top-left corner spins a rotated
    // tile out of its own grid cell into a neighboring one (confirmed live:
    // a 180°-rotated tile with anchorX/Y:0 rendered one cell up-and-left of
    // its declared position). Leaving anchorX/Y at Foundry's own default
    // (center) and passing the cell's center, not its corner, matches how
    // scene-divination.mjs already places its own rotated card Tiles.
    const vertical = corridorRect.gh >= corridorRect.gw;
    const length = vertical ? corridorRect.gh : corridorRect.gw;
    for (let i = 0; i < length; i += 1) {
      const dx = vertical ? 0 : i;
      const dy = vertical ? i : 0;
      const { variant, rotation } = corridorTileVariant(i, length, vertical);
      tiles.push({
        texture: { src: CORRIDOR_ART_BY_VARIANT[variant] },
        x: toPixels(corridorRect.gx + dx) + toPixels(1) / 2,
        y: toPixels(corridorRect.gy + dy) + toPixels(1) / 2,
        width: toPixels(1), height: toPixels(1),
        rotation
      });
    }
  }

  if (walls.length) await scene.createEmbeddedDocuments('Wall', walls);

  const rect = slotRect(slot);
  tiles.push({
    texture: { src: roomArtPath({ locationTag, isGoal, artVariant }), anchorX: 0, anchorY: 0 },
    x: toPixels(rect.gx), y: toPixels(rect.gy),
    width: toPixels(rect.gw), height: toPixels(rect.gh)
  });
  await scene.createEmbeddedDocuments('Tile', tiles);
}

/**
 * Centers this client's camera on slot's room, zoomed to actually fit it.
 * `createDungeonScene` pre-sizes the scene with headroom for the first two
 * rows of rooms so `buildRoomAtSlot` isn't resizing the canvas on every
 * single room — but that leaves the one room actually built looking tiny and
 * stuck in a corner of a mostly-empty canvas until something pans there,
 * since Foundry's default view on activation just centers on the whole
 * (oversized) scene.
 *
 * The scale is fit to the actual viewport rather than a fixed 1 — a fixed
 * zoom can leave the room's far edge past the visible area on a smaller
 * browser window, which looks exactly like the room's art doesn't reach the
 * walls and tokens are standing outside it, when really the camera just
 * isn't framing the whole room.
 *
 * Called both by the automatic room-entry trigger (which only fires once,
 * for whichever single party token happens to trip it first — with five
 * party tokens crossing one door, the other four's own tokenEnter events
 * find `currentIndex` already advanced and bail out before ever reaching a
 * camera pan) and by the tracker UI's own render, so simply having the
 * tracker window open keeps the view honest regardless of whether that
 * one-shot trigger happened to fire this time.
 */
export function focusCameraOnSlot(scene, slot) {
  if (canvas?.scene?.id !== scene.id) return;
  const rect = slotRect(slot);
  const roomPixelSize = Math.max(toPixels(rect.gw), toPixels(rect.gh));
  const [screenWidth, screenHeight] = canvas.screenDimensions ?? [1000, 1000];
  // Fit the room's footprint plus a 30% margin into whichever screen
  // dimension is tighter, clamped so a huge or tiny monitor doesn't zoom to
  // an unreasonable extreme.
  const fitScale = Math.min(screenWidth, screenHeight) / (roomPixelSize * 1.3);
  const scale = Math.min(1.5, Math.max(0.3, fitScale));
  canvas.animatePan({
    x: toPixels(rect.gx + rect.gw / 2),
    y: toPixels(rect.gy + rect.gh / 2),
    scale,
    duration: 250
  });
}

export async function unlockDoorToSlot(scene, slot) {
  const wall = scene.walls.find((w) => w.getFlag(MODULE_ID, 'dungeonDoorToSlot') === slot);
  if (wall) await wall.update({ ds: CONST.WALL_DOOR_STATES.CLOSED });
}

/** Re-locks the progress-gate door AND re-closes the reveal door beyond it —
 * a full undo of both doors' state, not just the one a GM would think to
 * check, in case a player had already opened the second one too. */
export async function relockDoorToSlot(scene, slot) {
  const wall = scene.walls.find((w) => w.getFlag(MODULE_ID, 'dungeonDoorToSlot') === slot);
  if (wall) await wall.update({ ds: CONST.WALL_DOOR_STATES.LOCKED });
  const revealWall = scene.walls.find((w) => w.getFlag(MODULE_ID, 'dungeonRevealDoorForSlot') === slot);
  if (revealWall) await revealWall.update({ ds: CONST.WALL_DOOR_STATES.CLOSED });
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
 * Called from module.mjs's `updateWall` hook whenever any door's state
 * changes to OPEN — ignores anything that isn't the true frontier room's own
 * reveal door (`dungeonRevealDoorForSlot`), so a plain scenery door, an
 * already-passed room's door being reopened, or a GM idly clicking a wall
 * can't desync the tracker.
 */
export async function handleDungeonDoorOpened(sceneId, wallId) {
  // Called directly from a global hook, which fires on every connected
  // client — only the GM's own client should act on it.
  if (!game.user.isGM) return;
  const scene = game.scenes.get(sceneId);
  const wall = scene?.walls.get(wallId);
  const slot = wall?.getFlag(MODULE_ID, 'dungeonRevealDoorForSlot');
  if (slot == null) return;

  const state = getRunState(sceneId);
  if (!state) return;
  const nextRoomId = state.rooms[state.currentIndex + 1]?.id;
  if (!nextRoomId || state.physicalSlotByRoomId[nextRoomId] !== slot) return;

  const revealedTokenIds = await revealSlotTokens(scene, slot);
  const nextRoom = state.rooms.find((r) => r.id === nextRoomId);
  // Started here, not at populateSlotEncounter/build time — the room's
  // monsters spawn hidden, and starting Combat before the door is actually
  // opened would give away that a fight is coming.
  if (nextRoom?.kind === 'combat') await startCombatForSlot(scene, slot);
  await advanceToRoom({ sceneId, roomId: nextRoomId, revealedTokenIds });
  focusCameraOnSlot(scene, slot);
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
