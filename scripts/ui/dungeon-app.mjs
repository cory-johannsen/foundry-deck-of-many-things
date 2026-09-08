import { loadDungeonSetpieces } from '../data-loader.mjs';
import {
  getRunState, createRun, markRoomOutcome, abandonRun, canUndoRoomEntry
} from '../dungeon-runner.mjs';
import { parseTraitList } from '../encounter-generator.mjs';
import {
  createDungeonScene, buildRoomAtSlot, unlockDoorToSlot, populateSlotEncounter,
  isSlotPopulated, placePartyInSlot, undoRoomEntry
} from '../dungeon-scene.mjs';

const MODULE_ID = 'deck-of-many-more-things';
const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;

const ROOM_KIND_KEYS = {
  combat: 'DOMMT.Dungeon.Kind.combat',
  skill_challenge: 'DOMMT.Dungeon.Kind.skill_challenge',
  puzzle_or_trap: 'DOMMT.Dungeon.Kind.puzzle_or_trap',
  narrative: 'DOMMT.Dungeon.Kind.narrative'
};

const EFFECT_KEYS = {
  friendly_aid: 'DOMMT.Dungeon.Effect.friendly_aid',
  encounter: 'DOMMT.Dungeon.Effect.encounter',
  ready_foraging: 'DOMMT.Dungeon.Effect.ready_foraging',
  restless_night: 'DOMMT.Dungeon.Effect.restless_night',
  reduced_travel_time: 'DOMMT.Dungeon.Effect.reduced_travel_time',
  extra_travel_time: 'DOMMT.Dungeon.Effect.extra_travel_time',
  treasure: 'DOMMT.Dungeon.Effect.treasure',
  lost_gear: 'DOMMT.Dungeon.Effect.lost_gear',
  exhaustion: 'DOMMT.Dungeon.Effect.exhaustion',
  goal_cleared: 'DOMMT.Dungeon.Effect.goal_cleared',
  goal_failed: 'DOMMT.Dungeon.Effect.goal_failed'
};

/**
 * Build+populate+unlock whatever room follows the one just resolved. Not a
 * class method — it only touches globals and the dungeon-scene/runner
 * modules, so the two action handlers below can call it directly rather than
 * needing `this` threaded through a shared private static method.
 */
async function resolveCurrentRoom(succeeded) {
  const scene = canvas?.scene;
  if (!scene) return;
  const setpieces = await loadDungeonSetpieces();
  const { state, mutation, nextRoomId, nextPhysicalSlot } = await markRoomOutcome(
    { sceneId: scene.id, succeeded },
    { setpieceIds: setpieces.map((s) => s.id) }
  );
  if (mutation === 'rerun_encounter') ui.notifications.warn(game.i18n.localize('DOMMT.Dungeon.RerunEncounterHint'));
  if (!nextRoomId) return; // the goal room was just resolved — nothing more to build

  const nextRoom = state.rooms.find((r) => r.id === nextRoomId);
  await buildRoomAtSlot(scene, nextPhysicalSlot, { isGoal: nextRoom.isGoal });

  if (nextRoom.kind === 'combat') {
    await populateSlotEncounter(scene, nextPhysicalSlot, {
      prefillTraits: state.traits, prefillExcludeTraits: state.excludeTraits
    });
    // Only unlock once monsters are actually in place — a cancelled theme
    // dialog leaves the door locked rather than opening onto an empty room;
    // the GM retries via the "Populate Next Room" button.
    if (isSlotPopulated(scene, nextPhysicalSlot)) await unlockDoorToSlot(scene, nextPhysicalSlot);
  } else {
    await unlockDoorToSlot(scene, nextPhysicalSlot);
  }
}

export class DungeonApp extends HandlebarsApplicationMixin(ApplicationV2) {
  static DEFAULT_OPTIONS = {
    id: 'dommt-dungeon-app',
    tag: 'section',
    window: { title: 'DOMMT.Dungeon.Title', icon: 'fa-solid fa-dungeon' },
    position: { width: 480, height: 'auto' },
    actions: {
      start: DungeonApp.#onStart,
      succeed: DungeonApp.#onSucceed,
      fail: DungeonApp.#onFail,
      populateNext: DungeonApp.#onPopulateNext,
      undo: DungeonApp.#onUndo,
      abandon: DungeonApp.#onAbandon
    }
  };

  static PARTS = {
    main: { template: `modules/${MODULE_ID}/templates/dungeon-tracker.hbs` }
  };

  async _prepareContext() {
    const scene = canvas?.scene ?? null;
    const sceneId = scene?.id ?? null;
    if (!sceneId) return { hasScene: false };

    const state = getRunState(sceneId);
    if (!state) return { hasScene: true, hasRun: false, defaultRoomCount: 6 };

    const setpieces = await loadDungeonSetpieces();
    const setpiecesById = new Map(setpieces.map((s) => [s.id, s]));
    const currentRoom = state.rooms[state.currentIndex] ?? null;
    const setpiece = currentRoom?.setpieceId ? setpiecesById.get(currentRoom.setpieceId) : null;
    const currentRoomResolved = !!currentRoom && state.history.some((h) => h.roomId === currentRoom.id);

    const nextRoom = state.rooms[state.currentIndex + 1] ?? null;
    const nextSlot = nextRoom ? state.physicalSlotByRoomId[nextRoom.id] : null;
    const nextRoomPending = !!(nextRoom && nextRoom.kind === 'combat'
      && nextSlot != null && !isSlotPopulated(scene, nextSlot));

    return {
      hasScene: true,
      hasRun: true,
      completed: state.completed,
      roomNumber: state.currentIndex + 1,
      roomTotal: state.rooms.length,
      currentRoomResolved,
      nextRoomPending,
      canUndo: canUndoRoomEntry(state),
      currentRoom: currentRoom && {
        isGoal: currentRoom.isGoal,
        kindLabel: game.i18n.localize(ROOM_KIND_KEYS[currentRoom.kind] ?? currentRoom.kind),
        setpiece: setpiece && { name: setpiece.name, summary: setpiece.summary, complete: setpiece.complete }
      },
      traits: state.traits.join(', '),
      excludeTraits: state.excludeTraits.join(', '),
      history: state.history.slice().reverse().map((h) => ({
        ...h,
        effectLabel: game.i18n.localize(EFFECT_KEYS[h.effectKey] ?? h.effectKey),
        outcomeLabel: game.i18n.localize(`DOMMT.Dungeon.Outcome.${h.outcome}`)
      }))
    };
  }

  static async #onStart() {
    const form = this.element.querySelector('form');
    const roomCount = Math.max(2, parseInt(form?.querySelector('[name="roomCount"]')?.value ?? '6', 10));
    const traits = parseTraitList(form?.querySelector('[name="traits"]')?.value);
    const excludeTraits = parseTraitList(form?.querySelector('[name="excludeTraits"]')?.value);

    const scene = await createDungeonScene();
    const setpieces = await loadDungeonSetpieces();
    const state = await createRun(
      { sceneId: scene.id, roomCount, traits, excludeTraits },
      { setpieceIds: setpieces.map((s) => s.id) }
    );

    const room0 = state.rooms[0];
    await buildRoomAtSlot(scene, 0, { isGoal: room0.isGoal });
    if (room0.kind === 'combat') {
      // Room 0 has no door to walk through to trigger a discovery reveal —
      // the party starts here, so its encounter (if any) spawns visible.
      await populateSlotEncounter(scene, 0, { prefillTraits: traits, prefillExcludeTraits: excludeTraits, hidden: false });
    }

    const partyMembers = (game.actors?.party?.members ?? []).filter((m) => m.type === 'character');
    await placePartyInSlot(scene, 0, partyMembers);
    await scene.activate();

    this.render();
  }

  static async #onSucceed() { await resolveCurrentRoom(true); this.render(); }
  static async #onFail() { await resolveCurrentRoom(false); this.render(); }

  static async #onPopulateNext() {
    const scene = canvas?.scene;
    const sceneId = scene?.id;
    const state = sceneId ? getRunState(sceneId) : null;
    const nextRoomId = state?.rooms[state.currentIndex + 1]?.id;
    const slot = nextRoomId ? state.physicalSlotByRoomId[nextRoomId] : null;
    if (slot == null) return;

    await populateSlotEncounter(scene, slot, {
      prefillTraits: state.traits, prefillExcludeTraits: state.excludeTraits
    });
    if (isSlotPopulated(scene, slot)) await unlockDoorToSlot(scene, slot);
    this.render();
  }

  static async #onUndo() {
    const sceneId = canvas?.scene?.id;
    if (!sceneId) return;
    await undoRoomEntry(sceneId);
    this.render();
  }

  static async #onAbandon() {
    const sceneId = canvas?.scene?.id;
    if (!sceneId) return;
    await abandonRun({ sceneId });
    this.render();
  }
}
