import { loadDungeonSetpieces } from '../data-loader.mjs';
import { getRunState, createRun, markRoomOutcome, abandonRun } from '../dungeon-runner.mjs';
import { parseTraitList } from '../encounter-generator.mjs';

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
      runEncounter: DungeonApp.#onRunEncounter,
      abandon: DungeonApp.#onAbandon
    }
  };

  static PARTS = {
    main: { template: `modules/${MODULE_ID}/templates/dungeon-tracker.hbs` }
  };

  async _prepareContext() {
    const sceneId = canvas?.scene?.id ?? null;
    if (!sceneId) return { hasScene: false };

    const state = getRunState(sceneId);
    if (!state) return { hasScene: true, hasRun: false, defaultRoomCount: 6 };

    const setpieces = await loadDungeonSetpieces();
    const setpiecesById = new Map(setpieces.map((s) => [s.id, s]));
    const currentRoom = state.rooms[state.currentIndex] ?? null;
    const setpiece = currentRoom?.setpieceId ? setpiecesById.get(currentRoom.setpieceId) : null;

    return {
      hasScene: true,
      hasRun: true,
      completed: state.completed,
      roomNumber: state.currentIndex + 1,
      roomTotal: state.rooms.length,
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
    const sceneId = canvas?.scene?.id;
    if (!sceneId) return;
    const form = this.element.querySelector('form');
    const roomCount = Math.max(2, parseInt(form?.querySelector('[name="roomCount"]')?.value ?? '6', 10));
    const traits = parseTraitList(form?.querySelector('[name="traits"]')?.value);
    const excludeTraits = parseTraitList(form?.querySelector('[name="excludeTraits"]')?.value);
    const setpieces = await loadDungeonSetpieces();
    await createRun(
      { sceneId, roomCount, traits, excludeTraits },
      { setpieceIds: setpieces.map((s) => s.id) }
    );
    this.render();
  }

  static async #onSucceed() {
    const sceneId = canvas?.scene?.id;
    if (!sceneId) return;
    const setpieces = await loadDungeonSetpieces();
    const { mutation } = await markRoomOutcome(
      { sceneId, succeeded: true },
      { setpieceIds: setpieces.map((s) => s.id) }
    );
    if (mutation === 'rerun_encounter') ui.notifications.warn(game.i18n.localize('DOMMT.Dungeon.RerunEncounterHint'));
    this.render();
  }

  static async #onFail() {
    const sceneId = canvas?.scene?.id;
    if (!sceneId) return;
    const setpieces = await loadDungeonSetpieces();
    const { mutation } = await markRoomOutcome(
      { sceneId, succeeded: false },
      { setpieceIds: setpieces.map((s) => s.id) }
    );
    if (mutation === 'rerun_encounter') ui.notifications.warn(game.i18n.localize('DOMMT.Dungeon.RerunEncounterHint'));
    this.render();
  }

  static async #onRunEncounter() {
    const sceneId = canvas?.scene?.id;
    const state = sceneId ? getRunState(sceneId) : null;
    if (!state) return;
    await game.modules.get(MODULE_ID).api.generateEncounter({
      prefillTraits: state.traits,
      prefillExcludeTraits: state.excludeTraits
    });
  }

  static async #onAbandon() {
    const sceneId = canvas?.scene?.id;
    if (!sceneId) return;
    await abandonRun({ sceneId });
    this.render();
  }
}
