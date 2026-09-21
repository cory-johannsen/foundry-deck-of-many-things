/**
 * Authorization for the GM-less dungeon crawl (#109) — a GM can always act;
 * otherwise only a run's own designated host, and only while no GM is
 * connected (a GM logging in mid-run immediately regains exclusive
 * control). See docs/superpowers/specs/2026-09-20-gm-less-dungeon-crawl-design.md.
 *
 * Refs are injectable so this is testable without a live Foundry — same
 * pattern as draw-target.mjs's canvasRef/userRef.
 */
function resolveUser(userRef) {
  return userRef ?? (typeof game !== "undefined" ? game.user : null);
}
function resolveUsers(usersRef) {
  return usersRef ?? (typeof game !== "undefined" ? game.users : null);
}
function isAnyGmActive(usersRef) {
  const users = resolveUsers(usersRef);
  return !!users?.some?.((u) => u.isGM && u.active);
}

export function canActOnDungeon(run, { userRef = null, usersRef = null } = {}) {
  const user = resolveUser(userRef);
  if (user?.isGM) return true;
  if (isAnyGmActive(usersRef)) return false;
  return !!run?.hostUserId && run.hostUserId === user?.id;
}

/**
 * What `module.mjs`'s `openDungeon()` should do — a GM always renders; a
 * non-GM is refused while any GM is active; otherwise they may render
 * (either starting fresh or reopening their own already-hosted run), unless
 * a *different* player already hosts the one active GM-less run.
 */
export function decideOpenDungeon(
  hostedRun,
  { userRef = null, usersRef = null } = {},
) {
  const user = resolveUser(userRef);
  if (user?.isGM) return { action: "render" };
  if (isAnyGmActive(usersRef)) return { action: "warnGmOnly" };
  if (hostedRun && hostedRun.hostUserId !== user?.id) {
    return { action: "warnAlreadyHosted", hostUserId: hostedRun.hostUserId };
  }
  return { action: "render" };
}

/**
 * What a non-host, non-GM client should do with its own local `DungeonApp`
 * instance whenever the `dungeonRuns` setting changes or the canvas
 * settles — open a fresh read-only copy, re-render an existing one, close
 * one whose run just ended, or nothing. Never touches the host's own
 * window (it manages itself via its own action handlers' render() calls)
 * or a GM's (never auto-opened).
 */
export function decideGmLessBroadcast(
  hostedRun,
  hasOpenInstance,
  { userRef = null } = {},
) {
  const user = resolveUser(userRef);
  if (user?.isGM) return { action: "none" };
  if (hostedRun?.hostUserId === user?.id) return { action: "none" };
  if (hostedRun) return { action: hasOpenInstance ? "render" : "open" };
  return { action: hasOpenInstance ? "close" : "none" };
}

/**
 * Merges `roles` into `currentPermissions.SETTINGS_MODIFY` (Foundry's own
 * "Modify World Settings" user permission), preserving every other role and
 * every other permission key already there. Returns null when nothing
 * needs to change, so the caller can skip a pointless settings write.
 * Foundry enforces this permission on `game.settings.set` for world-scope
 * settings independent of anything this module checks — see the spec's
 * "Permission prerequisite" section for how this was confirmed live.
 */
export function withSettingsModifyGrantedTo(currentPermissions, roles) {
  const existing = currentPermissions?.SETTINGS_MODIFY ?? [];
  const missing = roles.filter((r) => !existing.includes(r));
  if (!missing.length) return null;
  return {
    ...currentPermissions,
    SETTINGS_MODIFY: [...existing, ...missing].sort((a, b) => a - b),
  };
}
