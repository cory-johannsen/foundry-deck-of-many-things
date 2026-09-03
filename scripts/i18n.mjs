/**
 * Localise a string that is about to be *stored*, not rendered.
 *
 * Foundry localises template output, but an effect's name is data: whatever
 * string it is created with is the string on the sheet forever. Passing a
 * translation key straight into `name` therefore puts the key itself in front
 * of the player — which is exactly what "DOMMT.Effects.Euryale.Label" hovering
 * over the Euryale icon was.
 *
 * The fallback is required rather than optional, so a name is always readable:
 * handlers run in tests with no `game` at all, and a missing key returns the
 * key rather than throwing.
 */
export function t(key, fallback) {
  const out = globalThis.game?.i18n?.localize?.(key);
  return out && out !== key ? out : fallback;
}
