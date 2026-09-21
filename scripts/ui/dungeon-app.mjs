import { loadDungeonSetpieces } from "../data-loader.mjs";
import {
  getRunState,
  createRun,
  markRoomOutcome,
  abandonRun,
  canUndoRoomEntry,
  ensureSkillChallenge,
  recordSkillChallengeAttempt,
  setObjective,
} from "../dungeon-runner.mjs";
import { depthBiasFor, lootGpForTreasureRoom } from "../dungeon-deck.mjs";
import { makeFoundryApi } from "../foundry-api.mjs";
import { rollSkillChallengeAttempt } from "../skill-challenge.mjs";
import {
  ALL_SKILLS,
  dcForAttempt,
  selectSkillChallengeTemplate,
} from "../skill-challenge-mechanics.mjs";
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
  treasure: "DOMMT.Dungeon.Kind.treasure",
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
      claimTreasure: DungeonApp.#onClaimTreasure,
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
    if (state && !state.physicalSlotByRoomId) {
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

    // #162: lazily attach a fresh Victory Point challenge to the current
    // room the first time it's rendered — ensureSkillChallenge is itself a
    // no-op if one's already attached, so a plain re-render never rerolls
    // specialty skills mid-challenge. #164: the template (if any) is
    // selected only the *first* time (`ensureSkillChallenge` is a no-op
    // past that point) — #166 needs a stable place for an external agent's
    // own customization to land and stick, so `name`/`summary`/
    // `skillFlavor` are persisted directly on the challenge at creation
    // (`initSkillChallengeState`) rather than re-derived from a freshly
    // reselected template on every render the way an earlier version of
    // this block worked; this just reads them straight back off it.
    const isSkillChallenge =
      currentRoom?.kind === "skill_challenge" && !currentRoomResolved;
    let challenge = null;
    if (isSkillChallenge) {
      const partyMembers = (game.actors?.party?.members ?? []).filter(
        (m) => m.type === "character",
      );
      const template = selectSkillChallengeTemplate(
        setpieces,
        state.seed,
        currentRoom.id,
      );
      const ensured = await ensureSkillChallenge(sceneId, currentRoom.id, {
        seed: state.seed,
        locationTag: currentRoom.locationTag,
        partySize: partyMembers.length,
        template,
      });
      const raw = ensured?.rooms.find(
        (r) => r.id === currentRoom.id,
      )?.challenge;
      if (raw) {
        challenge = {
          vp: raw.vp,
          vpTarget: raw.vpTarget,
          attemptsRemaining: raw.attemptBudget - raw.attemptsUsed,
          templateName: raw.name,
          templateSummary: raw.summary,
          specialtySkills: raw.specialtySkills.map((slug) => ({
            slug,
            label: skillLabel(slug),
            flavor: raw.skillFlavor?.[slug] ?? null,
          })),
          allSkills: ALL_SKILLS.map((slug) => ({
            slug,
            label: skillLabel(slug),
            isSpecialty: raw.specialtySkills.includes(slug),
          })),
        };
      }
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
    // #169: a treasure room, like a narrative room, is never succeeded/
    // failed the plain way — it always has something to find, so claiming
    // it always succeeds (still running the usual Reward-side Journey
    // Spread outcome via resolveCurrentRoom/markRoomOutcome).
    const isTreasureRoom =
      currentRoom?.kind === "treasure" && !currentRoomResolved;

    return {
      hasScene: true,
      hasRun: true,
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
      isTreasureRoom,
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
  }

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
    // Captured before createDungeonScene/activate ever touch canvas.scene.
    const previousSceneId = canvas?.scene?.id ?? null;

    const scene = await createDungeonScene();
    const setpieces = await loadDungeonSetpieces();
    const state = await createRun(
      { sceneId: scene.id, roomCount, traits, excludeTraits, previousSceneId },
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

    // The entry has nothing to resolve, so — unlike every other room — its
    // own exit is unlocked immediately, with no GM click required: "the exit
    // from this room is always visible." That still holds outright for a
    // non-combat first room (built and unlocked right here, same as always).
    // A *combat* first room's build+populate is deliberately deferred to the
    // GM's own "Populate Next Room" click instead (#onPopulateNext, below) —
    // Start used to pop its Accept/Reroll preview immediately, before the GM
    // had even seen the dungeon scene (ITEM-11 reopening).
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

    this.render();
  }

  static async #onSucceed() {
    await resolveCurrentRoom(true);
    this.render();
  }
  static async #onFail() {
    await resolveCurrentRoom(false);
    this.render();
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

    const newState = await recordSkillChallengeAttempt(
      sceneId,
      currentRoom.id,
      result.outcome,
    );
    const resolved = newState?.rooms.find((r) => r.id === currentRoom.id)
      ?.challenge?.resolved;
    if (resolved) await resolveCurrentRoom(resolved === "success");
    this.render();
  }

  /**
   * A narrative room's own resolution (#163): saves whatever's in the
   * objective textarea (if anything — a blank field just leaves whatever
   * objective was already set alone, `setObjective` itself only clears on
   * an explicit `null`/whitespace-only call, and an empty textarea here
   * means "nothing new to set," not "clear it") and always resolves the
   * room succeeded, since a narrative beat has nothing to fail.
   */
  static async #onContinueNarrative() {
    const sceneId = canvas?.scene?.id;
    if (!sceneId) return;
    const textarea = this.element.querySelector(
      '[name="dommt-narrative-objective"]',
    );
    const value = textarea?.value?.trim();
    if (value) await setObjective(sceneId, value);
    await resolveCurrentRoom(true);
    this.render();
  }

  /**
   * A treasure room's own resolution (#169): grants real coins to the party
   * actor, scaled by party level and the room's own depthBiasFor ramp
   * (lootGpForTreasureRoom), then always resolves succeeded — same "nothing
   * to fail at" shape as #onContinueNarrative. Silently grants nothing if
   * there's no party actor to fund (matches resolveSlotCombat's own
   * `game.actors.party` guard for its combat-loot grant).
   */
  static async #onClaimTreasure() {
    const sceneId = canvas?.scene?.id;
    if (!sceneId) return;
    const state = getRunState(sceneId);
    const currentRoom = state?.rooms[state.currentIndex];
    const physicalSlot = currentRoom
      ? state.physicalSlotByRoomId[currentRoom.id]
      : null;
    if (physicalSlot == null) return;
    if (game.actors.party) {
      const api = makeFoundryApi();
      const partyLevel = await api.partyLevel();
      const gp = lootGpForTreasureRoom({
        partyLevel,
        physicalSlot,
        roomCount: state.rooms.length,
        isGoal: currentRoom.isGoal,
      });
      await api.addCoins(game.actors.party.id, { gp });
      ui.notifications.info(
        game.i18n.format("DOMMT.Dungeon.Treasure.Found", { gp }),
      );
    }
    await resolveCurrentRoom(true);
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
    await DungeonApp.#resolveCombatRoom(this, true);
  }
  static async #onDeclareDefeat() {
    await DungeonApp.#resolveCombatRoom(this, false);
  }

  static async #resolveCombatRoom(app, succeeded) {
    const scene = canvas?.scene;
    const sceneId = scene?.id;
    const state = sceneId ? getRunState(sceneId) : null;
    const currentRoom = state?.rooms[state.currentIndex];
    const slot = currentRoom
      ? state.physicalSlotByRoomId[currentRoom.id]
      : null;
    if (slot == null) return;
    await resolveSlotCombat(
      scene,
      slot,
      succeeded ? "victory" : "defeat",
      makeFoundryApi(),
    );
    await resolveCurrentRoom(succeeded);
    app.render();
  }

  /** Recovery-only — mirrors #onPopulateNext's own safety-net precedent for
   * when something (a reload mid-flow, say) left a combat room without a
   * Combat despite its monsters already being visible. */
  static async #onStartCombatRecovery() {
    const scene = canvas?.scene;
    const sceneId = scene?.id;
    const state = sceneId ? getRunState(sceneId) : null;
    const currentRoom = state?.rooms[state.currentIndex];
    const slot = currentRoom
      ? state.physicalSlotByRoomId[currentRoom.id]
      : null;
    if (slot == null) return;
    await startCombatForSlot(scene, slot);
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
    const scene = canvas?.scene;
    const sceneId = scene?.id;
    const state = sceneId ? getRunState(sceneId) : null;
    const nextRoom = state?.rooms[state.currentIndex + 1] ?? null;
    const slot = nextRoom ? state.physicalSlotByRoomId[nextRoom.id] : null;
    if (slot == null) return;

    // A combat first room's walls don't exist yet the first time this runs
    // for it — Start deliberately skipped building it (see #onStart) — so
    // build them here too, same as every other recovery this button already
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
    this.render();
  }

  static async #onUndo() {
    const sceneId = canvas?.scene?.id;
    if (!sceneId) return;
    await undoRoomEntry(sceneId);
    this.render();
  }

  /**
   * Cancels the run (ITEM-18): confirms first — this now does far more than
   * clear a settings entry, it moves the party out, deletes every NPC actor
   * the run's encounters spawned, and deletes the dungeon scene itself, none
   * of which is undoable — then hands off to teardownDungeonRun and closes
   * the app, since its whole scene is gone by the time that returns.
   */
  static async #onAbandon() {
    const scene = canvas?.scene;
    const sceneId = scene?.id;
    if (!sceneId) return;

    const confirmed = await foundry.applications.api.DialogV2.confirm({
      window: { title: game.i18n.localize("DOMMT.Dungeon.AbandonButton") },
      content: `<p>${game.i18n.localize("DOMMT.Dungeon.AbandonConfirm")}</p>`,
      rejectClose: false,
    });
    if (!confirmed) return;

    const state = getRunState(sceneId);
    await abandonRun({ sceneId });
    await teardownDungeonRun(scene, {
      previousSceneId: state?.previousSceneId ?? null,
    });
    this.close();
  }
}
