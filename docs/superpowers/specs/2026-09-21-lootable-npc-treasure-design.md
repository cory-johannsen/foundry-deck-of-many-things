# Lootable NPC treasure — design

**Tracks:** [#172](https://github.com/cory-johannsen/foundry-deck-of-many-things/issues/172)

## Summary

Defeated NPCs currently carry no real treasure — `dungeon-combat.mjs`'s `resolveCombat` grants a flat, XP-scaled gp lump sum straight to the party's shared purse (`lootGpForXp`, explicitly documented as a placeholder "until a real treasure-table pass exists") and immediately deletes every defeated NPC's Actor and Token, before a player could ever interact with it.

This design gives trait-eligible NPCs real, level-appropriate coin and (occasionally) a real item at spawn time, and turns a defeated NPC's corpse into a genuinely lootable container — using PF2e's own native `loot` actor type, so players drag items off the corpse's sheet the same way they already do with any other loot pile in this system, rather than a bespoke UI this module would have to build and maintain.

## Why this shape

Three architectural choices drive everything else:

1. **Real items need a real source.** There is no treasure-table data anywhere in this repo. Hand-authoring one doesn't scale to the full core bestiary this module already targets (#93's token-art work covers hundreds of creatures) — so treasure is sampled live from `pf2e.equipment-srd` (~5,800 items, each carrying `system.level.value` and `system.price.value.gp`), the same "query a compendium index, weighted-pick" pattern this module already uses for the bestiary (`encounter-roster.mjs`) and for card-effect item grants (`grantItems`).
2. **PF2e already has the interaction we want.** Converting a defeated NPC's own actor to `type: "loot"` in place gives players PF2e's native loot sheet — coin distribution, item drag-and-drop — for free. Building a custom "click to loot" affordance would be reinventing a worse version of something the system already ships.
3. **The existing Abandon-time cleanup already generalizes.** `dungeon-scene.mjs`'s `teardownDungeonRun` deletes *any* non-party actor/token still on the scene, regardless of type — it never assumed "npc" specifically. A converted, un-looted Loot actor is caught by it with zero new code.

## Non-goals

- Byte-exact implementation of PF2e's GMG "Treasure by Level" table. The gp/item budget is a disclosed heuristic, same spirit as `lootGpForXp` before it and `lootGpForTreasureRoom` (#169).
- A UI affordance for looting. Players use PF2e's native Loot actor sheet directly.
- Explicit cleanup-on-loot or cleanup-on-room-advance. Un-looted corpses simply persist on the scene (as any Loot actor would) until the run ends, at which point `teardownDungeonRun` sweeps them.
- Cover items (#96) are unaffected — still deleted immediately on combat resolution, since they're scenery, not creatures, and never carried treasure.

## Components

### 1. `scripts/treasure.mjs` (new, pure, Foundry-free)

Same injectable-refs split this codebase already uses for Foundry-dependent pure logic (`draw-target.mjs`, `dungeon-runner.mjs`): the actual compendium fetch happens elsewhere (see §3); this module only does math and selection over data it's handed, so it's fully Vitest-testable with a fake index.

```js
export const TREASURE_GP_PER_LEVEL = <tunable, same placeholder spirit as combat-rewards.mjs>;
export const ITEM_CHANCE = <tunable, e.g. 0.5 — chance a treasure-eligible NPC also gets one real item>;
export const ITEM_PRICE_BUDGET_FRACTION = <tunable, e.g. 0.5 — the sampled item's price ceiling as a fraction of the gp budget>;

/** A trait-eligible NPC's own gp amount plus (maybe) one sampled item, from
 * an already-fetched equipment index. `rng` is injectable (same convention
 * as dungeon-deck.mjs's seeded picks) so this is deterministic in tests and
 * seeded-random in play. */
export function rollNpcTreasure({ level, index, rng }) {
  const gp = Math.round(Math.max(0, level) * TREASURE_GP_PER_LEVEL);
  let itemRef = null;
  if (rng() < ITEM_CHANCE) {
    const priceBudget = gp * ITEM_PRICE_BUDGET_FRACTION;
    const candidates = index.filter(
      (e) => e.level <= level && e.priceGp <= priceBudget && e.priceGp > 0
    );
    if (candidates.length) {
      itemRef = candidates[Math.floor(rng() * candidates.length)];
    }
  }
  return { gp, itemRef };
}

/** True if a spawned NPC's own trait array makes it plausible for it to be
 * carrying treasure at all — PF2e's own bestiary convention: humanoid,
 * fiend, dragon and undead entries typically carry a "Treasure" line;
 * beast/aberration/construct/elemental/plant entries typically don't. Own
 * curated list, same style as dungeon-deck.mjs's LOCATION_TAGS. */
export const TREASURE_ELIGIBLE_TRAITS = ['humanoid', 'fiend', 'dragon', 'undead'];
export function isTreasureEligible(npcTraits) {
  return (npcTraits ?? []).some((t) => TREASURE_ELIGIBLE_TRAITS.includes(t));
}
```

The exact constants (`TREASURE_GP_PER_LEVEL`, `ITEM_CHANCE`, `ITEM_PRICE_BUDGET_FRACTION`) and the item-selection weighting (uniform among candidates vs. some price-proximity weighting) are planning-level decisions, not spec-level ones — this shape is what the plan implements against.

### 2. Wiring into spawn — `scripts/foundry-api.mjs`'s `spawnCreatures`

After each NPC actor is created (existing loop, around where `alliance`/`disposition` overrides are already applied): if `isTreasureEligible(actor's system.traits.value)`, call `rollNpcTreasure` (with the equipment-srd index fetched once per `spawnCreatures` call, not once per creature — same "index first, cheap" discipline the bestiary querying already follows) and apply the result:
- `gp` via `actor.inventory.addCoins({ gp })` — the same call already proven live for #169's treasure rooms and for the existing (soon-removed) party-wide combat grant.
- `itemRef` (if any) via `createEmbeddedDocuments("Item", [copiedDoc])` — the same copy-from-compendium shape `grantItems` already uses.

### 3. Lootable corpses — `scripts/dungeon-combat.mjs`'s `resolveCombat`

Currently (on any resolved combat, win or lose):
```js
if (npcTokenIds.length && scene) await scene.deleteEmbeddedDocuments("Token", npcTokenIds);
if (npcActorIds.length) await Actor.deleteDocuments(npcActorIds);
```

Changes to: for each defeated NPC's actor, `actor.update({ type: "loot" })` instead of deleting it — the token is untouched (still on the scene, at its defeat position), the actor keeps its id and its embedded items/currency (including whatever `spawnCreatures` attached), but now renders PF2e's native Loot sheet. Cover item cleanup (`coverTokenIds`/`coverActorIds`) is unchanged — still an immediate delete.

Open question for planning: does this conversion apply only on `outcome === 'victory'`, or also when combat resolves some other way (e.g., the party flees)? The existing delete runs "either way" per the current code's own comment — the natural read is: convert to loot whenever a *hostile* combatant is defeated, regardless of how the overall combat resolves for the party, since "this specific monster died" is a fact independent of the party's own outcome. Confirmed in planning against the actual defeated/not-defeated state available at this point (`npcCombatants` currently means "every non-party combatant," not "every non-party combatant that died" — the plan needs to narrow this to actually-defeated ones only, so a monster that fled or was never engaged isn't wrongly turned into a corpse).

### 4. Removing the flat grant — `scripts/combat-rewards.mjs`

`lootGpForXp` and `LOOT_GP_PER_XP` are deleted (dead code once the flat grant is gone), along with their call site in `resolveCombat` and their test coverage in `tests/combat-rewards.test.mjs`. `totalCombatXp`/`xpPerSurvivor` are unaffected — XP still flows to the party the same way; only the coin side changes.

### 5. Cleanup — no new code

`dungeon-scene.mjs`'s `teardownDungeonRun` already deletes every non-party actor still on the scene at Abandon time, keyed only on "is this token's actor NOT a party member" — a converted Loot actor satisfies that check exactly the same as an NPC actor did, with zero changes needed.

## Testing

- `scripts/treasure.mjs`: full Vitest coverage in a new `tests/treasure.test.mjs` — `rollNpcTreasure`'s gp scaling, item-chance/price-ceiling behavior with a fake index and a seeded/fake `rng`, and `isTreasureEligible`'s trait matching. Pure, Foundry-free, same rigor as `dungeon-deck.mjs`'s own tests.
- `spawnCreatures`'s treasure application and `resolveCombat`'s loot-conversion: no direct unit tests, matching this codebase's established convention for Foundry-global-dependent wiring (`#onSucceed`, `computeConePlacements`, etc.) — verified live via `foundry-rest` before merge, per the project's own rule.

## Risks / things planning should watch for

- **Actor-type conversion side effects.** Converting `type: "npc"` → `"loot"` via `actor.update` needs confirming live that PF2e doesn't reject or partially-apply a type change on an existing document, and that the resulting Loot actor's embedded items/currency survive the conversion intact (not something this design can assert from reading code alone).
- **Narrowing "defeated" correctly**, as noted in §3 — `resolveCombat`'s current `npcCombatants` set is "every non-party combatant in the fight," not "every one that actually died." Converting a fled-but-alive monster to loot would be a bug, not a feature.
- **Item price shape.** Confirmed live that `system.price.value` is `{ gp: N }` for the samples checked, but very cheap items may price in `sp`/`cp` instead — planning should confirm this doesn't silently break the price-ceiling filter (e.g., normalize to a single gp-equivalent number when building the index).
