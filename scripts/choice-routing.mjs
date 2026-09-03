/**
 * Who answers a card's question.
 *
 * A card that says "choose one" is asking the person whose character it lands
 * on. Star raising an ability, Elemental picking a damage type, Jester trading
 * experience for draws — those are the player's calls, and routing them to the
 * GM made the GM guess at someone else's character.
 *
 * The GM still decides for anything that is not a player's character, and
 * still decides when the owning player is not connected, because a card must
 * not stall waiting for someone who went home.
 */

/**
 * The player who should answer, or null when the GM should.
 * Refs are injectable so this is testable without a live Foundry.
 */
export function whoDecides({ actor, users = [], activeOnly = true } = {}) {
  if (!actor) return { user: null, reason: 'no-actor' };

  const owners = users.filter((u) => !u.isGM && ownsActor(u, actor));
  if (!owners.length) return { user: null, reason: 'gm-owned' };

  const present = activeOnly ? owners.filter((u) => u.active) : owners;
  if (!present.length) return { user: null, reason: 'owner-offline' };

  // A character with several owners is unusual; the one whose assigned
  // character it is has the better claim, otherwise the first connected owner.
  const assigned = present.find((u) => u.character?.id === actor.id);
  return { user: assigned ?? present[0], reason: 'player-owned' };
}

function ownsActor(user, actor) {
  if (user.character?.id === actor.id) return true;
  // Foundry's own check when it is available, falling back to raw ownership so
  // this stays usable in tests and outside a live client.
  if (typeof actor.testUserPermission === 'function') {
    return actor.testUserPermission(user, 'OWNER');
  }
  const level = actor.ownership?.[user.id] ?? actor.ownership?.default ?? 0;
  return level >= 3;
}
