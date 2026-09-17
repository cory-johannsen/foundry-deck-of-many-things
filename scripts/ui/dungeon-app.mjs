import { loadDungeonSetpieces } from '../data-loader.mjs';
import {
  getRunState, createRun, markRoomOutcome, abandonRun, canUndoRoomEntry
} from '../dungeon-runner.mjs';
import { depthBiasFor } from '../dungeon-deck.mjs';
import { makeFoundryApi } from '../foundry-api.mjs';
import { traitFieldHtml, wireTraitPickerButtons, readTraitField } from '../trait-picker.mjs';
import {
  createDungeonScene, buildRoomAtSlot, unlockDoorToSlot, populateSlotEncounter,
  isSlotPopulated, placePartyInSlot, undoRoomEntry, focusCameraOnSlot
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
  await buildRoomAtSlot(scene, nextPhysicalSlot, {
    isGoal: nextRoom.isGoal, locationTag: nextRoom.locationTag, artVariant: nextRoom.artVariant
  });

  if (nextRoom.kind === 'combat') {
    await populateSlotEncounter(scene, nextPhysicalSlot, {
      prefillTraits: state.traits, prefillExcludeTraits: state.excludeTraits,
      levelOffsetBias: depthBiasFor({ physicalSlot: nextPhysicalSlot, roomCount: state.rooms.length, isGoal: nextRoom.isGoal }),
      locationTag: nextRoom.locationTag
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

    let state = getRunState(sceneId);
    // A run created before physical scenes existed (Tier 1) has no
    // physicalSlotByRoomId at all — it predates the shape this app now
    // assumes, and there's no real geometry behind it to resume. Rather than
    // crash on every render, clear it and let the GM start fresh.
    if (state && !state.physicalSlotByRoomId) {
      await abandonRun({ sceneId });
      ui.notifications.info(game.i18n.localize('DOMMT.Dungeon.StaleRunCleared'));
      state = null;
    }
    if (!state) {
      const availableTraits = await makeFoundryApi().listCreatureTraits();
      return {
        hasScene: true, hasRun: false, defaultRoomCount: 6, availableTraits,
        traitsFieldHtml: traitFieldHtml({
          name: 'traits', label: game.i18n.localize('DOMMT.Encounter.ThemeLabel'),
          buttonLabel: game.i18n.localize('DOMMT.Encounter.ChooseTraitsButton')
        }),
        excludeTraitsFieldHtml: traitFieldHtml({
          name: 'excludeTraits', label: game.i18n.localize('DOMMT.Encounter.ExcludeTraitsLabel'),
          buttonLabel: game.i18n.localize('DOMMT.Encounter.ChooseTraitsButton')
        })
      };
    }

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
      sceneId,
      currentSlot: currentRoom ? state.physicalSlotByRoomId[currentRoom.id] : null,
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

  _onRender(context, options) {
    super._onRender(context, options);
    wireTraitPickerButtons(this.element, context.availableTraits ?? []);
    // Re-frame the current room on every render, not just on the one-shot
    // automatic room-entry trigger — see focusCameraOnSlot's own docs for why
    // that trigger alone isn't reliable with a five-token party.
    if (context.currentSlot != null && canvas?.scene?.id === context.sceneId) {
      focusCameraOnSlot(canvas.scene, context.currentSlot);
    }
  }

  static async #onStart() {
    const form = this.element.querySelector('form');
    const roomCount = Math.max(2, parseInt(form?.querySelector('[name="roomCount"]')?.value ?? '6', 10));
    const traits = readTraitField(this.element, 'traits');
    const excludeTraits = readTraitField(this.element, 'excludeTraits');

    const scene = await createDungeonScene();
    const setpieces = await loadDungeonSetpieces();
    const state = await createRun(
      { sceneId: scene.id, roomCount, traits, excludeTraits },
      { setpieceIds: setpieces.map((s) => s.id) }
    );

    const room0 = state.rooms[0];
    await buildRoomAtSlot(scene, 0, {
      isGoal: room0.isGoal, locationTag: room0.locationTag, artVariant: room0.artVariant
    });
    if (room0.kind === 'combat') {
      // Room 0 has no door to walk through to trigger a discovery reveal —
      // the party starts here, so its encounter (if any) spawns visible.
      await populateSlotEncounter(scene, 0, {
        prefillTraits: traits, prefillExcludeTraits: excludeTraits, hidden: false,
        levelOffsetBias: depthBiasFor({ physicalSlot: 0, roomCount: state.rooms.length, isGoal: room0.isGoal }),
        locationTag: room0.locationTag
      });
    }

    const partyMembers = (game.actors?.party?.members ?? []).filter((m) => m.type === 'character');
    await placePartyInSlot(scene, 0, partyMembers);
    await scene.activate();
    // The canvas doesn't finish switching to the new scene the instant
    // activate() resolves — animatePan needs a beat to land on it, same
    // settling delay scene-divination.mjs already relies on for its own
    // post-activate scene work.
    await new Promise((r) => setTimeout(r, 400));
    focusCameraOnSlot(scene, 0);

    this.render();
  }

  static async #onSucceed() { await resolveCurrentRoom(true); this.render(); }
  static async #onFail() { await resolveCurrentRoom(false); this.render(); }

  static async #onPopulateNext() {
    const scene = canvas?.scene;
    const sceneId = scene?.id;
    const state = sceneId ? getRunState(sceneId) : null;
    const nextRoom = state?.rooms[state.currentIndex + 1] ?? null;
    const slot = nextRoom ? state.physicalSlotByRoomId[nextRoom.id] : null;
    if (slot == null) return;

    await populateSlotEncounter(scene, slot, {
      prefillTraits: state.traits, prefillExcludeTraits: state.excludeTraits,
      levelOffsetBias: depthBiasFor({ physicalSlot: slot, roomCount: state.rooms.length, isGoal: nextRoom.isGoal }),
      locationTag: nextRoom.locationTag
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
