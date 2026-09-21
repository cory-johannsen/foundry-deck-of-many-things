/**
 * Foundry glue for core trap mechanics (#134) — the live-document half of
 * trap-mechanics.mjs's pure detection/disable/classification logic. Kept in
 * its own file rather than folded into dungeon-combat.mjs: a trap isn't a
 * Combatant (it can trigger outside a tracked Combat entirely, on room
 * reveal or a party member simply walking somewhere), so it has no `combat`
 * object to thread through the way every function in that file does.
 */
import {
  parseDisableChecks,
  trapDetectionDC,
  isSimpleAutomatableTrap,
} from "./trap-mechanics.mjs";

const MODULE_ID = "deck-of-many-more-things";

/**
 * Classifies a live hazard Actor the same way trap-mechanics.mjs's pure
 * `isSimpleAutomatableTrap` does, pulling the plain values off the real
 * document first — the one place that extraction happens, so nothing else
 * needs to know hazard Actors keep this data at `system.details`/
 * `system.actions` rather than trust the shape blind.
 */
export function classifyTrap(hazardActor) {
  const disableChecks = parseDisableChecks(
    hazardActor.system?.details?.disable,
  );
  const strikeActionCount = (hazardActor.system?.actions ?? []).filter(
    (a) => a.type === "strike" && a.ready !== false,
  ).length;
  const isComplex = !!hazardActor.system?.details?.isComplex;
  return {
    isComplex,
    strikeActionCount,
    disableChecks,
    automatable: isSimpleAutomatableTrap({
      isComplex,
      strikeActionCount,
      disableChecks,
    }),
  };
}

/** Suppresses PF2e's own check/damage confirmation dialogs for the duration
 * of `fn`, restoring whatever they were set to afterward — the exact same
 * pattern every roll in dungeon-combat.mjs already uses, so an automated
 * trap roll doesn't sit blocked on a dialog nobody's there to click. */
async function withDialogsSuppressed(fn) {
  const prevShowCheck = game.user.flags?.pf2e?.settings?.showCheckDialogs;
  const prevShowDamage = game.user.flags?.pf2e?.settings?.showDamageDialogs;
  await game.user.update({
    "flags.pf2e.settings.showCheckDialogs": false,
    "flags.pf2e.settings.showDamageDialogs": false,
  });
  try {
    return await fn();
  } finally {
    await game.user.update({
      "flags.pf2e.settings.showCheckDialogs": prevShowCheck,
      "flags.pf2e.settings.showDamageDialogs": prevShowDamage,
    });
  }
}

/**
 * Rolls Perception for `seeker` against `hazardActor`'s own detection DC
 * (its Stealth value converted the standard way). Returns
 * `{detected, dc, outcome}` — confirmed live: `actor.perception.roll(...)`
 * is a real, callable PF2e API, same shape as every other check/save roll
 * already used elsewhere in this module.
 */
export async function rollTrapDetection(hazardActor, seeker) {
  const dc = trapDetectionDC(hazardActor.system?.attributes?.stealth?.value);
  return withDialogsSuppressed(async () => {
    await seeker.perception.roll({ dc: { value: dc }, createMessage: true });
    const outcome =
      game.messages.contents.at(-1)?.flags?.pf2e?.context?.outcome ?? null;
    const detected = outcome === "success" || outcome === "criticalSuccess";
    return { detected, dc, outcome };
  });
}

/**
 * Attempts to disable `hazardActor` using `actor`'s skill against one of the
 * hazard's own parsed disable options — `skill` should be a slug a
 * `classifyTrap`/`parseDisableChecks` entry actually offered; falls back to
 * the first parsed option if the requested one isn't found (matching a
 * caller that doesn't yet have a picker UI to offer a real choice with, per
 * #134's own "core mechanics, not the room-dialog UI" scope). On success,
 * flags the hazard `trapDisabled` so `triggerTrap` treats it as inert —
 * the hazard Actor itself is left alone, still visible/present, the same
 * way #96's cover items stay on the scene until the encounter that spawned
 * them resolves, rather than being deleted the moment it's beaten.
 */
export async function rollTrapDisableAttempt(hazardActor, actor, skill) {
  const checks = parseDisableChecks(hazardActor.system?.details?.disable);
  const check = checks.find((c) => c.skill === skill) ?? checks[0];
  if (!check) return null;
  const skillStat = actor.skills?.[check.skill];
  if (!skillStat) return null;

  return withDialogsSuppressed(async () => {
    await skillStat.roll({ dc: { value: check.dc }, createMessage: true });
    const outcome =
      game.messages.contents.at(-1)?.flags?.pf2e?.context?.outcome ?? null;
    const disabled = outcome === "success" || outcome === "criticalSuccess";
    if (disabled) await hazardActor.setFlag(MODULE_ID, "trapDisabled", true);
    return { disabled, outcome, dc: check.dc, skill: check.skill };
  });
}

/**
 * Triggers `hazardActor`'s own single ready strike against `target`
 * (`{actor, token}`, a real placed Token — same shape `rollAndApplyStrike`'s
 * own `target` parameter already takes, since triggering a trap only ever
 * meaningfully happens against a party member actually on the scene) and
 * applies damage on a hit — the exact same roll/damage/applyDamage sequence
 * dungeon-combat.mjs's `rollAndApplyStrike` already uses for a combatant's
 * strike, since a simple trap's routine compiles into a real Strike the
 * same way (confirmed live: `hazardActor.system.actions[0]` has the same
 * `.variants[0].roll()`/`.damage()` shape).
 *
 * Confirmed live the hard way: `strike.variants[0].roll({target: {document:
 * ...}})` needs that document to actually be a Token, not a bare Actor — a
 * bare Actor resolves to `target: null` on the resulting chat message and
 * therefore `outcome: null`, silently, with no error at all. An earlier
 * version of this function fell back to a bare Actor when no token was
 * given, which is exactly this failure mode; removed rather than left in
 * as a trap for the next caller.
 *
 * A no-op if the trap has already been disabled (`rollTrapDisableAttempt`)
 * or has no ready strike at all — call `classifyTrap(hazardActor).automatable`
 * first to know whether this function applies before calling it.
 */
export async function triggerTrap(hazardActor, target) {
  if (hazardActor.getFlag(MODULE_ID, "trapDisabled")) return null;
  const strike = (hazardActor.system?.actions ?? []).find(
    (a) => a.type === "strike" && a.ready !== false,
  );
  if (!strike) return null;

  return withDialogsSuppressed(async () => {
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
      }
    }
    return outcome;
  });
}
