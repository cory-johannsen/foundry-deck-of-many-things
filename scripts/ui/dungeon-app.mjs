import { loadDungeonSetpieces } from "../data-loader.mjs";
import {
  getRunState,
  createRun,
  markRoomOutcome,
  abandonRun,
  canUndoRoomEntry,
  recordSkillChallengeAttempt,
  setObjective,
} from "../dungeon-runner.mjs";
import { canActOnDungeon } from "../dungeon-permissions.mjs";
import { requestDungeonAction } from "../dungeon-remote.mjs";
import { depthBiasFor } from "../dungeon-deck.mjs";
import { makeFoundryApi } from "../foundry-api.mjs";
import { rollSkillChallengeAttempt } from "../skill-challenge.mjs";
import { ALL_SKILLS, dcForAttempt } from "../skill-challenge-mechanics.mjs";
import {
  traitFieldHtml,
  wireTraitPickerButtons,
  readTraitField,
} from "../trait-picker.mjs";
import {
  createDungeonScene,
  buildRoomAtSlot,
  unlockDoorToSlot,
  populateSlotEncounter,
  isSlotPopulated,
  isSlotBuilt,
  placePartyInSlot,
  undoRoomEntry,
  focusCameraOnSlot,
  teardownDungeonRun,
  buildPopulateAndUnlockRoom,
} from "../dungeon-scene.mjs";
import {
  startCombatForSlot,
  getCombatForSlot,
  resolveSlotCombat,
} from "../dungeon-combat.mjs";

const MODULE_ID = "deck-of-many-more-things";
const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;

const ROOM_KIND_KEYS = {
  combat: "DOMMT.Dungeon.Kind.combat",
  skill_challenge: "DOMMT.Dungeon.Kind.skill_challenge",
  puzzle_or_trap: "DOMMT.Dungeon.Kind.puzzle_or_trap",
  narrative: "DOMMT.Dungeon.Kind.narrative",
  safe_entry: "DOMMT.Dungeon.Kind.safe_entry",
  safe_rest: "DOMMT.Dungeon.Kind.safe_rest",
};

const EFFECT_KEYS = {
  friendly_aid: "DOMMT.Dungeon.Effect.friendly_aid",
  encounter: "DOMMT.Dungeon.Effect.encounter",
  ready_foraging: "DOMMT.Dungeon.Effect.ready_foraging",
  restless_night: "DOMMT.Dungeon.Effect.restless_night",
  reduced_travel_time: "DOMMT.Dungeon.Effect.reduced_travel_time",
  extra_travel_time: "DOMMT.Dungeon.Effect.extra_travel_time",
  treasure: "DOMMT.Dungeon.Effect.treasure",
  lost_gear: "DOMMT.Dungeon.Effect.lost_gear",
  exhaustion: "DOMMT.Dungeon.Effect.exhaustion",
  goal_cleared: "DOMMT.Dungeon.Effect.goal_cleared",
  goal_failed: "DOMMT.Dungeon.Effect.goal_failed",
  rest_room_passed: "DOMMT.Dungeon.Effect.rest_room_passed",
};

/** Rooms with nothing to resolve (no outcomeSlotId ever assigned) — never
 * counted toward the GM's own requested room total (ITEM-5's rest room joins
 * the entry here). */
const UNCOUNTED_ROOM_KINDS = new Set(["safe_entry", "safe_rest"]);

/** A skill slug's own display name — `CONFIG.PF2E.skills[slug].label` is an
 * i18n *key* (confirmed live: `"PF2E.Skill.Acrobatics"`, not resolved
 * text), not the label itself, so this always needs the extra localize
 * step. Falls back to the bare slug for a key PF2e's own config doesn't
 * carry (shouldn't happen for anything out of `ALL_SKILLS`, which was
 * itself confirmed live to match `CONFIG.PF2E.skills`'s own keys exactly). */
function skillLabel(slug) {
  const key = CONFIG.PF2E?.skills?.[slug]?.label;
  return key ? game.i18n.localize(key) : slug;
}

/**
 * Resolve the current room's outcome and build+populate+unlock whatever
 * follows. Not a class method — it only touches globals and the
 * dungeon-scene/runner modules, so the two action handlers below can call it
 * directly rather than needing `this` threaded through a shared private
 * static method. Exported (with an explicit `scene` override) because
 * dungeon-combat.mjs's automatic combat-resolution hooks need to call this
 * too, and a hook can fire while the GM is looking at a different scene
 * entirely — `canvas?.scene` alone isn't reliable there the way it is for a
 * button click inside this app.
 */
export async function resolveCurrentRoom(
  succeeded,
  { scene = canvas?.scene } = {},
) {
  if (!scene) return;
  const setpieces = await loadDungeonSetpieces();
  const { state, mutation, nextRoomId, nextPhysicalSlot } =
    await markRoomOutcome(
      { sceneId: scene.id, succeeded },
      { setpieceIds: setpieces.map((s) => s.id) },
    );
  if (mutation === "rerun_encounter")
    ui.notifications.warn(
      game.i18n.localize("DOMMT.Dungeon.RerunEncounterHint"),
    );
  if (!nextRoomId) return; // the goal room was just resolved — nothing more to build

  const nextRoom = state.rooms.find((r) => r.id === nextRoomId);
  await buildPopulateAndUnlockRoom(scene, state, nextRoom, nextPhysicalSlot);
}

export async function startDungeonRun({
  roomCount,
  traits,
  excludeTraits,
  previousSceneId,
  hostUserId,
}) {
  const scene = await createDungeonScene();
  const setpieces = await loadDungeonSetpieces();
  const state = await createRun(
    {
      sceneId: scene.id,
      roomCount,
      traits,
      excludeTraits,
      previousSceneId,
      hostUserId,
    },
    { setpieceIds: setpieces.map((s) => s.id) },
  );

  // Room 0 is always the safe entry — no encounter, trap or puzzle ever
  // spawns there (see dungeon-deck.mjs's buildRoomSequence).
  const entryRoom = state.rooms[0];
  await buildRoomAtSlot(scene, 0, {
    isGoal: entryRoom.isGoal,
    locationTag: entryRoom.locationTag,
    artVariant: entryRoom.artVariant,
    seed: state.seed,
  });

  // A combat first room's build+populate is deliberately deferred to the
  // next "Populate Next Room" action instead — see #onPopulateNext/
  // populateNextRoom below (ITEM-11).
  const firstRealRoom = state.rooms[1];
  if (firstRealRoom && firstRealRoom.kind !== "combat") {
    await buildPopulateAndUnlockRoom(scene, state, firstRealRoom, 1);
  }

  const partyMembers = (game.actors?.party?.members ?? []).filter(
    (m) => m.type === "character",
  );
  await placePartyInSlot(scene, 0, partyMembers, state.seed);
  await scene.activate();
  // The canvas doesn't finish switching to the new scene the instant
  // activate() resolves — animatePan needs a beat to land on it, same
  // settling delay scene-divination.mjs already relies on for its own
  // post-activate scene work.
  await new Promise((r) => setTimeout(r, 400));
  focusCameraOnSlot(scene, 0, state.seed);
}

export async function recordSkillChallengeOutcome(sceneId, roomId, outcome) {
  const newState = await recordSkillChallengeAttempt(sceneId, roomId, outcome);
  const resolved = newState?.rooms.find((r) => r.id === roomId)?.challenge
    ?.resolved;
  if (resolved)
    await resolveCurrentRoom(resolved === "success", {
      scene: game.scenes.get(sceneId),
    });
}

/**
 * A narrative room's own resolution (#163): saves whatever's in the
 * objective textarea (if anything — see #onContinueNarrative's own comment
 * on why a blank field leaves any existing objective alone) and always
 * resolves the room succeeded, since a narrative beat has nothing to fail.
 */
export async function continueNarrativeRoom(sceneId, objective) {
  if (objective) await setObjective(sceneId, objective);
  await resolveCurrentRoom(true, { scene: game.scenes.get(sceneId) });
}

export async function resolveCombatRoomOutcome(sceneId, succeeded) {
  const scene = game.scenes.get(sceneId);
  const state = scene ? getRunState(sceneId) : null;
  const currentRoom = state?.rooms[state.currentIndex];
  const slot = currentRoom ? state.physicalSlotByRoomId[currentRoom.id] : null;
  if (slot == null) return;
  await resolveSlotCombat(
    scene,
    slot,
    succeeded ? "victory" : "defeat",
    makeFoundryApi(),
  );
  await resolveCurrentRoom(succeeded, { scene });
}

export async function startCombatRecoveryFor(sceneId) {
  const scene = game.scenes.get(sceneId);
  const state = scene ? getRunState(sceneId) : null;
  const currentRoom = state?.rooms[state.currentIndex];
  const slot = currentRoom ? state.physicalSlotByRoomId[currentRoom.id] : null;
  if (slot == null) return;
  await startCombatForSlot(scene, slot);
}

export async function populateNextRoom(sceneId) {
  const scene = game.scenes.get(sceneId);
  const state = scene ? getRunState(sceneId) : null;
  const nextRoom = state?.rooms[state.currentIndex + 1] ?? null;
  const slot = nextRoom ? state.physicalSlotByRoomId[nextRoom.id] : null;
  if (!scene || slot == null) return;

  // A combat first room's walls don't exist yet the first time this runs
  // for it — startDungeonRun deliberately skipped building it — so build
  // them here too, same as every other recovery this function already
  // covers. A no-op for every normal case, where the room was already
  // built back when the room before it resolved.
  if (!isSlotBuilt(scene, slot)) {
    await buildRoomAtSlot(scene, slot, {
      isGoal: nextRoom.isGoal,
      locationTag: nextRoom.locationTag,
      artVariant: nextRoom.artVariant,
      seed: state.seed,
    });
  }

  await populateSlotEncounter(scene, slot, {
    prefillTraits: state.traits,
    prefillExcludeTraits: state.excludeTraits,
    levelOffsetBias: depthBiasFor({
      physicalSlot: slot,
      roomCount: state.rooms.length,
      isGoal: nextRoom.isGoal,
    }),
    locationTag: nextRoom.locationTag,
    seed: state.seed,
  });
  if (isSlotPopulated(scene, slot)) await unlockDoorToSlot(scene, slot);
}

export async function abandonDungeonRun(sceneId) {
  const scene = game.scenes.get(sceneId);
  const state = getRunState(sceneId);
  await abandonRun({ sceneId });
  if (scene)
    await teardownDungeonRun(scene, {
      previousSceneId: state?.previousSceneId ?? null,
    });
}

export class DungeonApp extends HandlebarsApplicationMixin(ApplicationV2) {
  static DEFAULT_OPTIONS = {
    id: "dommt-dungeon-app",
    tag: "section",
    window: { title: "DOMMT.Dungeon.Title", icon: "fa-solid fa-dungeon" },
    position: { width: 480, height: "auto" },
    actions: {
      start: DungeonApp.#onStart,
      succeed: DungeonApp.#onSucceed,
      fail: DungeonApp.#onFail,
      populateNext: DungeonApp.#onPopulateNext,
      undo: DungeonApp.#onUndo,
      abandon: DungeonApp.#onAbandon,
      declareVictory: DungeonApp.#onDeclareVictory,
      declareDefeat: DungeonApp.#onDeclareDefeat,
      startCombatRecovery: DungeonApp.#onStartCombatRecovery,
      openCombatTracker: DungeonApp.#onOpenCombatTracker,
      hide: DungeonApp.#onHide,
      attemptSkillChallenge: DungeonApp.#onAttemptSkillChallenge,
      continueNarrative: DungeonApp.#onContinueNarrative,
    },
  };

  static PARTS = {
    main: { template: `modules/${MODULE_ID}/templates/dungeon-tracker.hbs` },
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
    // #109: gated on game.user.isGM, not just "some state exists" — a
    // read-only broadcast viewer's render must never delete the run entry
    // for everyone. This legacy-migration path only ever needs to run once,
    // for a GM, since every run createRun produces today always carries
    // physicalSlotByRoomId already.
    if (state && !state.physicalSlotByRoomId && game.user.isGM) {
      await abandonRun({ sceneId });
      ui.notifications.info(
        game.i18n.localize("DOMMT.Dungeon.StaleRunCleared"),
      );
      state = null;
    }
    if (!state) {
      const availableTraits = await makeFoundryApi().listCreatureTraits();
      return {
        hasScene: true,
        hasRun: false,
        defaultRoomCount: 6,
        availableTraits,
        traitsFieldHtml: traitFieldHtml({
          name: "traits",
          label: game.i18n.localize("DOMMT.Encounter.ThemeLabel"),
          buttonLabel: game.i18n.localize("DOMMT.Encounter.ChooseTraitsButton"),
        }),
        excludeTraitsFieldHtml: traitFieldHtml({
          name: "excludeTraits",
          label: game.i18n.localize("DOMMT.Encounter.ExcludeTraitsLabel"),
          buttonLabel: game.i18n.localize("DOMMT.Encounter.ChooseTraitsButton"),
        }),
      };
    }

    const setpieces = await loadDungeonSetpieces();
    const setpiecesById = new Map(setpieces.map((s) => [s.id, s]));
    const currentRoom = state.rooms[state.currentIndex] ?? null;
    const setpiece = currentRoom?.setpieceId
      ? setpiecesById.get(currentRoom.setpieceId)
      : null;
    const currentRoomResolved =
      !!currentRoom && state.history.some((h) => h.roomId === currentRoom.id);

    const nextRoom = state.rooms[state.currentIndex + 1] ?? null;
    const nextSlot = nextRoom ? state.physicalSlotByRoomId[nextRoom.id] : null;
    const nextRoomPending = !!(
      nextRoom &&
      nextRoom.kind === "combat" &&
      nextSlot != null &&
      !isSlotPopulated(scene, nextSlot)
    );

    const currentSlot = currentRoom
      ? state.physicalSlotByRoomId[currentRoom.id]
      : null;
    const isCombatRoom = currentRoom?.kind === "combat" && !currentRoomResolved;
    const isSafeEntry = currentRoom?.kind === "safe_entry";
    const isSafeRest = currentRoom?.kind === "safe_rest";
    const activeCombat =
      isCombatRoom && currentSlot != null
        ? getCombatForSlot(scene, currentSlot)
        : null;

    // #109: whether THIS client may act on the run, not just whether one
    // exists — false for every read-only broadcast viewer, and also false
    // for the run's own host once any GM connects (see dungeon-permissions.mjs).
    const interactive = canActOnDungeon(state);
    const hostName = state.hostUserId
      ? (game.users.get(state.hostUserId)?.name ?? "?")
      : null;

    // #162/#109: the challenge is now attached at room-build time
    // (dungeon-scene.mjs's buildPopulateAndUnlockRoom), not lazily on
    // render — this is a pure read of whatever's already persisted.
    const isSkillChallenge =
      currentRoom?.kind === "skill_challenge" && !currentRoomResolved;
    let challenge = null;
    if (isSkillChallenge && currentRoom.challenge) {
      const raw = currentRoom.challenge;
      challenge = {
        vp: raw.vp,
        vpTarget: raw.vpTarget,
        attemptsRemaining: raw.attemptBudget - raw.attemptsUsed,
        specialtySkills: raw.specialtySkills.map((slug) => ({
          slug,
          label: skillLabel(slug),
        })),
        allSkills: ALL_SKILLS.map((slug) => ({
          slug,
          label: skillLabel(slug),
          isSpecialty: raw.specialtySkills.includes(slug),
        })),
      };
    }

    // #163: a narrative room is never succeeded/failed the way every other
    // resolvable room kind is — it's not a check or a fight, so it always
    // resolves as succeeded (still running the room's own Reward-side
    // Journey Spread outcome via the usual markRoomOutcome/resolveCurrentRoom
    // path, just never the Ruin side) via a single Continue action instead
    // of the plain Succeed/Fail choice. `setpieceId` is never actually
    // assigned for a narrative room yet (dungeon-deck.mjs's buildRoomSequence
    // only does that for puzzle_or_trap — a future narrative template
    // library, #165, is what would change that), so `setpiece` here is
    // always null in practice for now; the template falls back to a plain
    // placeholder rather than showing nothing.
    const isNarrativeRoom =
      currentRoom?.kind === "narrative" && !currentRoomResolved;

    return {
      hasScene: true,
      hasRun: true,
      interactive,
      hostName,
      sceneId,
      currentSlot,
      // Not rendered — just threaded to _onRender's own focusCameraOnSlot
      // call, which needs it to know the current room's actual size (ITEM-17).
      seed: state.seed,
      completed: state.completed,
      // Neither the entry nor a mid-dungeon rest room (ITEM-5) count toward
      // the room total the GM asked for — currentIndex 1 is real room 1 of
      // roomTotal, not room 2 of roomTotal+1, and a rest room further along
      // doesn't bump either number for the rooms after it.
      roomNumber: state.rooms
        .slice(0, state.currentIndex + 1)
        .filter((r) => !UNCOUNTED_ROOM_KINDS.has(r.kind)).length,
      roomTotal: state.rooms.filter((r) => !UNCOUNTED_ROOM_KINDS.has(r.kind))
        .length,
      currentRoomResolved,
      nextRoomPending,
      canUndo: canUndoRoomEntry(state),
      isSafeEntry,
      isSafeRest,
      isSafeRoom: isSafeEntry || isSafeRest,
      // A combat room never uses the plain Succeed/Fail buttons — it's
      // either mid-fight (combatActive) or something interrupted Combat's
      // own creation and needs the recovery button (combatMissing).
      isCombatRoom,
      combatActive: !!activeCombat,
      combatMissing: isCombatRoom && !activeCombat,
      // #162: a skill_challenge room uses its own Victory Point UI instead
      // of the plain Succeed/Fail buttons every other resolvable room kind
      // still uses.
      isSkillChallenge,
      challenge,
      // #163: a narrative room's own "direction for the rest of the run" —
      // run-wide, not per-room, so it's shown here regardless of which
      // room kind is actually current, the same way it persists in
      // `state.objective` regardless of which room set it.
      isNarrativeRoom,
      objective: state.objective ?? null,
      partyMembers: (game.actors?.party?.members ?? [])
        .filter((m) => m.type === "character")
        .map((m) => ({ id: m.id, name: m.name })),
      currentRoom: currentRoom && {
        isGoal: currentRoom.isGoal,
        kind: currentRoom.kind,
        kindLabel: game.i18n.localize(
          ROOM_KIND_KEYS[currentRoom.kind] ?? currentRoom.kind,
        ),
        setpiece: setpiece && {
          name: setpiece.name,
          summary: setpiece.summary,
          complete: setpiece.complete,
        },
      },
      traits: state.traits.join(", "),
      excludeTraits: state.excludeTraits.join(", "),
      history: state.history
        .slice()
        .reverse()
        .map((h) => ({
          ...h,
          effectLabel: game.i18n.localize(
            EFFECT_KEYS[h.effectKey] ?? h.effectKey,
          ),
          outcomeLabel: game.i18n.localize(
            `DOMMT.Dungeon.Outcome.${h.outcome}`,
          ),
        })),
    };
  }

  _onRender(context, options) {
    super._onRender(context, options);
    wireTraitPickerButtons(this.element, context.availableTraits ?? []);
    // Re-frame the current room on every render, not just on the one-shot
    // automatic room-entry trigger — see focusCameraOnSlot's own docs for why
    // that trigger alone isn't reliable with a five-token party.
    if (context.currentSlot != null && canvas?.scene?.id === context.sceneId) {
      focusCameraOnSlot(canvas.scene, context.currentSlot, context.seed);
    }
    // #109: a read-only broadcast viewer (or a host who's lost exclusive
    // control because a GM connected) sees every control disabled except
    // Hide, which only closes their own local window. This is a UI nicety,
    // not the real enforcement — each mutating action handler below
    // re-checks canActOnDungeon itself.
    if (context.hasRun && !context.interactive) {
      // Not just `footer button[data-action]` — the skill-challenge
      // (#onAttemptSkillChallenge) and narrative (#onContinueNarrative)
      // action buttons live inside their own <form>, not the footer.
      // Scoped to .window-content, not the whole element — the frame's own
      // header also has data-action buttons (close, toggleControls) that
      // must stay usable for a read-only viewer.
      this.element
        .querySelectorAll(".window-content button[data-action]")
        .forEach((btn) => {
          if (btn.dataset.action !== "hide") btn.disabled = true;
        });
    }
  }

  /**
   * Builds a fresh run's entry room, first real room, party placement, and
   * scene activation — the actual privileged work `#onStart` either does
   * directly (a GM) or asks the GM-side relay to do (dungeon-remote.mjs's
   * "startRun" action, for a non-GM host). Never touches `canvas?.scene` —
   * see this plan's Global Constraints.
   */
  static async #onStart() {
    const form = this.element.querySelector("form");
    const roomCount = Math.max(
      2,
      parseInt(form?.querySelector('[name="roomCount"]')?.value ?? "6", 10),
    );
    const traits = readTraitField(this.element, "traits");
    const excludeTraits = readTraitField(this.element, "excludeTraits");
    // Wherever the GM/party were right before starting — teardownDungeonRun
    // (ITEM-18) sends them back here if this run is later abandoned.
    const previousSceneId = canvas?.scene?.id ?? null;

    if (game.user.isGM) {
      await startDungeonRun({
        roomCount,
        traits,
        excludeTraits,
        previousSceneId,
        hostUserId: null,
      });
    } else {
      await requestDungeonAction("startRun", {
        roomCount,
        traits,
        excludeTraits,
        previousSceneId,
      });
    }
    this.render();
  }

  static async #onSucceed() {
    await DungeonApp.#resolveRoom(this, true);
  }
  static async #onFail() {
    await DungeonApp.#resolveRoom(this, false);
  }

  static async #resolveRoom(app, succeeded) {
    const sceneId = canvas?.scene?.id;
    if (!sceneId) return;
    if (game.user.isGM) {
      await resolveCurrentRoom(succeeded, { scene: game.scenes.get(sceneId) });
    } else {
      await requestDungeonAction("resolveRoom", { sceneId, succeeded });
    }
    app.render();
  }

  /**
   * Rolls the form's own selected actor/skill against the current room's
   * challenge (#162), records the attempt, and — only once the challenge
   * actually resolves — hands off to the same `resolveCurrentRoom` every
   * other room kind uses, so a skill challenge's own success/failure
   * consequences flow through the exact same room-resolution path combat,
   * traps, and puzzles already do. A no-op if the form has nothing
   * selected, or the roll itself came back empty (`actor.skills[skill]`
   * missing — shouldn't happen for a real `ALL_SKILLS` slug, guarded
   * anyway rather than trusted blind).
   */
  static async #onAttemptSkillChallenge() {
    const scene = canvas?.scene;
    const sceneId = scene?.id;
    const state = sceneId ? getRunState(sceneId) : null;
    const currentRoom = state?.rooms[state.currentIndex];
    if (!currentRoom?.challenge) return;

    const form = this.element.querySelector(
      ".dommt-dungeon__skill-challenge-form",
    );
    const actorId = form?.querySelector('[name="actorId"]')?.value;
    const skill = form?.querySelector('[name="skill"]')?.value;
    const actor = actorId ? game.actors.get(actorId) : null;
    if (!actor || !skill) return;

    const dc = dcForAttempt({
      partyLevel: await makeFoundryApi().partyLevel(),
      skill,
      specialtySkills: currentRoom.challenge.specialtySkills,
    });
    const result = await rollSkillChallengeAttempt(actor, skill, dc);
    if (!result) return;

    if (game.user.isGM) {
      await recordSkillChallengeOutcome(
        sceneId,
        currentRoom.id,
        result.outcome,
      );
    } else {
      await requestDungeonAction("recordSkillChallengeOutcome", {
        sceneId,
        roomId: currentRoom.id,
        outcome: result.outcome,
      });
    }
    this.render();
  }

  static async #onContinueNarrative() {
    const sceneId = canvas?.scene?.id;
    if (!sceneId) return;
    const textarea = this.element.querySelector(
      '[name="dommt-narrative-objective"]',
    );
    const objective = textarea?.value?.trim() || null;
    if (game.user.isGM) {
      await continueNarrativeRoom(sceneId, objective);
    } else {
      await requestDungeonAction("continueNarrativeRoom", {
        sceneId,
        objective,
      });
    }
    this.render();
  }

  /** Manual GM override — always available while a combat room's Combat is
   * active, alongside the automatic all-one-side-defeated detection.
   * `DungeonApp.#resolveCombatRoom(this, ...)`, not `this.constructor...` —
   * a private static called this way is a plain function call, so `this`
   * has to be threaded through explicitly rather than relying on the
   * instance binding Foundry's action dispatcher gives #onDeclareVictory
   * itself. */
  static async #onDeclareVictory() {
    await DungeonApp.#declareOutcome(this, true);
  }
  static async #onDeclareDefeat() {
    await DungeonApp.#declareOutcome(this, false);
  }

  static async #declareOutcome(app, succeeded) {
    const sceneId = canvas?.scene?.id;
    if (!sceneId) return;
    if (game.user.isGM) {
      await resolveCombatRoomOutcome(sceneId, succeeded);
    } else {
      await requestDungeonAction("declareOutcome", { sceneId, succeeded });
    }
    app.render();
  }

  /** Recovery-only — mirrors #onPopulateNext's own safety-net precedent for
   * when something (a reload mid-flow, say) left a combat room without a
   * Combat despite its monsters already being visible. */
  static async #onStartCombatRecovery() {
    const sceneId = canvas?.scene?.id;
    if (!sceneId) return;
    if (game.user.isGM) {
      await startCombatRecoveryFor(sceneId);
    } else {
      await requestDungeonAction("startCombatRecovery", { sceneId });
    }
    this.render();
  }

  static #onOpenCombatTracker() {
    ui.sidebar.activateTab("combat");
  }

  /** #158: a plain, explicit "close this for a bit" affordance, distinct
   * from Abandon (which deletes the whole run) — this only closes the
   * rendered window, exactly what the standard window-chrome close button
   * already does (confirmed live: no `_onClose` override exists on this
   * class, so `close()` here has no side effect on the persisted run
   * state). Needed once #158's auto-open makes the tracker pop open on its
   * own more often — a labeled in-content button makes it obvious this is
   * safe to dismiss, rather than relying on the small title-bar X. */
  static #onHide() {
    this.close();
  }

  static async #onPopulateNext() {
    const sceneId = canvas?.scene?.id;
    if (!sceneId) return;
    if (game.user.isGM) {
      await populateNextRoom(sceneId);
    } else {
      await requestDungeonAction("populateNext", { sceneId });
    }
    this.render();
  }

  static async #onUndo() {
    const sceneId = canvas?.scene?.id;
    if (!sceneId) return;
    if (game.user.isGM) {
      await undoRoomEntry(sceneId);
    } else {
      await requestDungeonAction("undoRoomEntry", { sceneId });
    }
    this.render();
  }

  /**
   * Cancels the run (ITEM-18): confirms first — this now does far more than
   * clear a settings entry, it moves the party out, deletes every NPC actor
   * the run's encounters spawned, and deletes the dungeon scene itself, none
   * of which is undoable. The confirmation itself always happens locally
   * (it's just a prompt); only the actual teardown is routed for a non-GM
   * host.
   */
  static async #onAbandon() {
    const sceneId = canvas?.scene?.id;
    if (!sceneId) return;

    const confirmed = await foundry.applications.api.DialogV2.confirm({
      window: { title: game.i18n.localize("DOMMT.Dungeon.AbandonButton") },
      content: `<p>${game.i18n.localize("DOMMT.Dungeon.AbandonConfirm")}</p>`,
      rejectClose: false,
    });
    if (!confirmed) return;

    if (game.user.isGM) {
      await abandonDungeonRun(sceneId);
    } else {
      await requestDungeonAction("abandonRun", { sceneId });
    }
    this.close();
  }
}
