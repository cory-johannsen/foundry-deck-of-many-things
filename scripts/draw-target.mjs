/**
 * Work out which actor a drawn card applies to, from who is drawing.
 *
 *   Player  — draws for themselves, so their assigned character is the target.
 *             A controlled token is a fallback for a player with no assigned
 *             character.
 *   GM      — draws on someone's behalf, so the target is whichever token they
 *             have selected. A GM with nothing selected resolves to no actor.
 *
 * There is no actor picker at draw time. When this returns nothing the card is
 * posted pending and the GM is asked to choose an actor when they apply it —
 * that keeps the choice at the moment it matters instead of making every draw
 * start with a dropdown.
 */
export function resolveDrawActor({
  actorId = null,      // explicit override, used by the scripting API
  isGM = null,
  canvasRef = null,
  userRef = null,
  actorsRef = null
} = {}) {
  // Refs are injectable so this is testable without a live Foundry.
  const cnv = canvasRef ?? (typeof canvas !== 'undefined' ? canvas : null);
  const usr = userRef ?? (typeof game !== 'undefined' ? game.user : null);
  const all = actorsRef ?? (typeof game !== 'undefined' ? game.actors : null);
  const gm = isGM ?? usr?.isGM ?? false;

  if (actorId) {
    const explicit = all?.get?.(actorId) ?? null;
    if (explicit) return { actor: explicit, source: 'explicit', ambiguous: false };
  }

  const controlled = cnv?.tokens?.controlled ?? [];
  const fromToken = controlled.find((t) => t?.actor)?.actor ?? null;

  if (!gm) {
    if (usr?.character) return { actor: usr.character, source: 'assigned', ambiguous: false };
    if (fromToken) return { actor: fromToken, source: 'token', ambiguous: controlled.length > 1 };
    return { actor: null, source: 'none', ambiguous: false };
  }

  if (fromToken) return { actor: fromToken, source: 'token', ambiguous: controlled.length > 1 };
  return { actor: null, source: 'none', ambiguous: false };
}
