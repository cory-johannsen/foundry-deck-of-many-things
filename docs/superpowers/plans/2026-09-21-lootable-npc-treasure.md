# Lootable NPC Treasure Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Trait-eligible spawned NPCs carry real, level-appropriate coin and (sometimes) a real item, and a defeated hostile's corpse becomes a genuinely lootable PF2e `loot` actor instead of vanishing — replacing the flat, party-wide `lootGpForXp` grant entirely.

**Architecture:** A new pure module (`scripts/treasure.mjs`) computes gp/item budgets and eligibility from data it's handed — no Foundry globals, fully Vitest-testable. Two Foundry-touching call sites apply it: `foundry-api.mjs`'s `spawnCreatures` grants treasure to eligible hostiles at spawn time (coins via the existing `addCoins`, an item via the existing compendium-copy pattern `grantItems` already uses), and `dungeon-combat.mjs`'s `resolveCombat` converts each defeated hostile's token to a freshly created `loot`-type actor instead of deleting it — **Foundry document types are immutable after creation** (confirmed live: `actor.update({type: "loot"})` on an existing actor succeeds with no error but silently leaves `type` unchanged), so this is a create-a-new-actor-and-repoint-the-token operation, not an in-place update.

**Tech Stack:** Vanilla JS ES modules, Foundry VTT v13 Actor/Token documents, PF2e system's native `loot` actor type, Vitest for unit tests, `foundry-rest` skill for live verification.

**Spec:** `docs/superpowers/specs/2026-09-21-lootable-npc-treasure-design.md`

## Global Constraints

- Module id is `"deck-of-many-more-things"` everywhere (`MODULE_ID` constant, repeated per-file — matches existing convention, do not centralize).
- Pure logic that depends on data fetched from Foundry takes that data as a parameter (an already-fetched index, an injectable `rng`) rather than reaching for `game`/`canvas` itself — required for Vitest coverage since there is no live Foundry in the test environment. `scripts/treasure.mjs` follows this throughout.
- Foundry-global-dependent wiring (`spawnCreatures`, `resolveCombat`) gets no direct unit tests, matching this codebase's established convention (`#onSucceed`, `computeConePlacements`, etc.) — verified live via the `foundry-rest` skill instead, in the final task.
- Every merged commit needs a `module.json` version bump in the same commit as the change (project rule) — done once, in the final task, not per-task.
- This feature requires live verification via the `foundry-rest` skill before merge (project `CLAUDE.md` rule: changes touching live Foundry document mutation need real testing) — it is the last task, and nothing merges until it passes.
- Do not touch `.claude/worktrees/**` — those are other agents' isolated worktrees, not this repo's live source.
- Two facts already confirmed live during planning (do not re-verify, just build on them):
  1. `actor.update({ type: "loot" })` on an existing actor is a silent no-op — `type` never changes. Creating a fresh actor with `type: "loot"` set at creation, then repointing the token's `actorId` to it via `tokenDocument.update({ actorId })`, works correctly (confirmed: the live token's `.actor.type` reads `"loot"` afterward, and a full copy of the source actor's items/currency survives onto the new actor unchanged).
  2. `Combatant#isDefeated` is already the established "this combatant died" flag used throughout `dungeon-combat.mjs` (`combatSideStatus`, `combatantOpponents`, `combatantAllies`, `applyDefeatIfReducedToZero`) — reuse it rather than inventing a new defeated-check.

---

## Task 1: `scripts/treasure.mjs` — pure treasure math

**Files:**
- Create: `scripts/treasure.mjs`
- Test: `tests/treasure.test.mjs`

**Interfaces:**
- Produces: `TREASURE_ELIGIBLE_TRAITS` (array of strings); `isTreasureEligible(npcTraits: string[]) => boolean`; `LOOTABLE_ITEM_TYPES` (array of strings); `TREASURE_GP_PER_LEVEL`, `ITEM_CHANCE`, `ITEM_PRICE_BUDGET_FRACTION` (tunable numeric constants); `rollNpcTreasure({ level: number, index: Array<{id: string, pack: string, level: number, priceGp: number}>, rng: () => number }) => { gp: number, itemRef: {id: string, pack: string} | null }`.
- Consumes: nothing (bottom of the new dependency graph — Task 2 and Task 3 both import from here).

- [ ] **Step 1: Write the failing tests**

```js
// tests/treasure.test.mjs
import { describe, it, expect } from 'vitest';
import {
  isTreasureEligible,
  TREASURE_ELIGIBLE_TRAITS,
  LOOTABLE_ITEM_TYPES,
  rollNpcTreasure,
  TREASURE_GP_PER_LEVEL,
  ITEM_CHANCE,
  ITEM_PRICE_BUDGET_FRACTION,
} from '../scripts/treasure.mjs';

describe('isTreasureEligible', () => {
  it('is true for a humanoid', () => {
    expect(isTreasureEligible(['humanoid', 'human'])).toBe(true);
  });

  it('is true for each eligible trait on its own', () => {
    for (const trait of TREASURE_ELIGIBLE_TRAITS) {
      expect(isTreasureEligible([trait])).toBe(true);
    }
  });

  it('is false for an animal with no eligible trait', () => {
    expect(isTreasureEligible(['animal', 'beast'])).toBe(false);
  });

  it('is false for no traits at all', () => {
    expect(isTreasureEligible([])).toBe(false);
    expect(isTreasureEligible(undefined)).toBe(false);
  });
});

describe('rollNpcTreasure', () => {
  const fakeIndex = [
    { id: 'cheap-dagger', pack: 'pf2e.equipment-srd', level: 0, priceGp: 2 },
    { id: 'mid-sword', pack: 'pf2e.equipment-srd', level: 3, priceGp: 30 },
    { id: 'pricey-wand', pack: 'pf2e.equipment-srd', level: 10, priceGp: 500 },
  ];
  const alwaysRoll = () => 0; // < any chance/threshold — always takes the branch
  const neverRoll = () => 0.999999; // > any chance/threshold — never takes it

  it('follows the documented gp-per-level formula', () => {
    const result = rollNpcTreasure({ level: 4, index: [], rng: neverRoll });
    expect(result.gp).toBe(Math.round(4 * TREASURE_GP_PER_LEVEL));
  });

  it('is 0 gp for level 0', () => {
    const result = rollNpcTreasure({ level: 0, index: [], rng: neverRoll });
    expect(result.gp).toBe(0);
  });

  it('never goes negative for a below-zero level input', () => {
    const result = rollNpcTreasure({ level: -1, index: [], rng: neverRoll });
    expect(result.gp).toBe(0);
  });

  it('never rolls an item when rng exceeds ITEM_CHANCE', () => {
    const result = rollNpcTreasure({ level: 5, index: fakeIndex, rng: neverRoll });
    expect(result.itemRef).toBeNull();
  });

  it('rolls an item within the level/price budget when rng favors it', () => {
    const result = rollNpcTreasure({ level: 5, index: fakeIndex, rng: alwaysRoll });
    expect(result.itemRef).not.toBeNull();
    expect(result.itemRef.id).toBe('cheap-dagger');
  });

  it('never selects an item above the level or price ceiling', () => {
    // level 1 with a small gp budget should never reach the level-10, 500gp wand
    const result = rollNpcTreasure({ level: 1, index: fakeIndex, rng: alwaysRoll });
    expect(result.itemRef?.id).not.toBe('pricey-wand');
  });

  it('is null when no candidate in the index fits the budget', () => {
    const result = rollNpcTreasure({
      level: 0,
      index: [{ id: 'too-pricey', pack: 'pf2e.equipment-srd', level: 0, priceGp: 999 }],
      rng: alwaysRoll,
    });
    expect(result.itemRef).toBeNull();
  });
});

describe('LOOTABLE_ITEM_TYPES', () => {
  it('includes the core tangible item types', () => {
    for (const t of ['weapon', 'armor', 'equipment', 'consumable', 'treasure']) {
      expect(LOOTABLE_ITEM_TYPES).toContain(t);
    }
  });

  it('excludes creature-feature item types', () => {
    for (const t of ['spell', 'spellcastingEntry', 'melee', 'action', 'lore', 'feat']) {
      expect(LOOTABLE_ITEM_TYPES).not.toContain(t);
    }
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/treasure.test.mjs`
Expected: FAIL — `Cannot find module '../scripts/treasure.mjs'` (the file doesn't exist yet).

- [ ] **Step 3: Write the implementation**

```js
// scripts/treasure.mjs
/**
 * Real, level-appropriate treasure for a spawned NPC — a disclosed
 * placeholder heuristic, same spirit as combat-rewards.mjs's lootGpForXp
 * before it (#172), not a byte-exact implementation of PF2e's GMG
 * "Treasure by Level" table. Foundry-free: the equipment index and rng are
 * both injected, so this is fully deterministic and testable without a
 * live Foundry instance — see scripts/foundry-api.mjs's spawnCreatures for
 * the caller that fetches the real index and applies the result.
 */

// Tunable, with no anchor in the source material — same "disclosed
// heuristic" status as combat-rewards.mjs's LOOT_GP_PER_XP.
export const TREASURE_GP_PER_LEVEL = 8;
export const ITEM_CHANCE = 0.5;
export const ITEM_PRICE_BUDGET_FRACTION = 0.5;

// PF2e's own bestiary convention: humanoid, fiend, dragon and undead
// entries typically carry a "Treasure" line; beast/aberration/construct/
// elemental/plant entries typically don't. Own curated list, same style as
// dungeon-deck.mjs's LOCATION_TAGS.
export const TREASURE_ELIGIBLE_TRAITS = ['humanoid', 'fiend', 'dragon', 'undead'];

export function isTreasureEligible(npcTraits) {
  return (npcTraits ?? []).some((t) => TREASURE_ELIGIBLE_TRAITS.includes(t));
}

// The item types worth copying onto a lootable corpse — tangible gear, not
// a creature's own spells/strikes/lore/feats, which would just clutter a
// loot sheet with things nobody can actually pick up.
export const LOOTABLE_ITEM_TYPES = [
  'weapon',
  'armor',
  'equipment',
  'consumable',
  'treasure',
  'backpack',
  'shield',
  'ammo',
];

export function rollNpcTreasure({ level, index, rng }) {
  const gp = Math.round(Math.max(0, level) * TREASURE_GP_PER_LEVEL);
  let itemRef = null;
  if (rng() < ITEM_CHANCE) {
    const priceBudget = gp * ITEM_PRICE_BUDGET_FRACTION;
    const candidates = index.filter(
      (e) => e.level <= level && e.priceGp > 0 && e.priceGp <= priceBudget,
    );
    if (candidates.length) {
      const pick = candidates[Math.floor(rng() * candidates.length)];
      itemRef = { id: pick.id, pack: pick.pack };
    }
  }
  return { gp, itemRef };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/treasure.test.mjs`
Expected: PASS, all tests green.

- [ ] **Step 5: Commit**

```bash
git add scripts/treasure.mjs tests/treasure.test.mjs
git commit -m "Add pure treasure-generation math for lootable NPCs (#172)"
```

---

## Task 2: Grant real treasure to eligible NPCs at spawn time

**Files:**
- Modify: `scripts/foundry-api.mjs:688-825` (the `spawnCreatures` method)

**Interfaces:**
- Consumes: `isTreasureEligible`, `rollNpcTreasure` from `scripts/treasure.mjs` (Task 1).
- Produces: no new exports — `spawnCreatures`'s existing return shape (`{name, actorId, tokenId}[]`) is unchanged; this task only adds a side effect (coins/item on eligible actors) before each entry is pushed onto `created`.

- [ ] **Step 1: Add the import**

At the top of `scripts/foundry-api.mjs`, alongside the module's other local imports:

```js
import { isTreasureEligible, rollNpcTreasure } from './treasure.mjs';
```

- [ ] **Step 2: Fetch the equipment index once per call, only when it can matter**

`spawnCreatures` only ever generates treasure for hostile creatures (`disposition < 0` — a player-side summon spawned with `disposition > 0` never gets looted, since it's never defeated as an opponent). Immediately after the existing `alliance` computation (around line 733, `const alliance = disposition > 0 ? "party" : ...`), add:

```js
    // Only a hostile spawn (a monster, never a player's own summon) can
    // ever end up on the lootable-corpse path resolveCombat drives — see
    // #172. Fetched once per call, not once per creature, same "index
    // first, cheap" discipline encounter-roster.mjs already follows for
    // the bestiary.
    const equipmentIndex =
      disposition < 0
        ? (
            await game.packs
              .get('pf2e.equipment-srd')
              ?.getIndex({ fields: ['type', 'system.level.value', 'system.price.value'] })
          )?.map((e) => ({
            id: e._id,
            pack: 'pf2e.equipment-srd',
            level: e.system?.level?.value ?? 0,
            // system.price.value is keyed by denomination ({gp}, {sp}, ...)
            // rather than always gp — normalized to a single gp-equivalent
            // number so rollNpcTreasure's price ceiling comparison is
            // meaningful regardless of which denomination a cheap item uses.
            priceGp:
              (e.system?.price?.value?.gp ?? 0) +
              (e.system?.price?.value?.sp ?? 0) / 10 +
              (e.system?.price?.value?.cp ?? 0) / 100,
          })) ?? []
        : [];
```

- [ ] **Step 3: Apply treasure after each eligible NPC actor is created**

Inside the `for (const [i, entry] of entries.entries())` loop, right after the existing actor creation (`const [actor] = await Actor.createDocuments([...]);`, around line 767) and before the token-placement code that follows it, add:

```js
        if (disposition < 0 && isTreasureEligible(actor.system?.traits?.value)) {
          const { gp, itemRef } = rollNpcTreasure({
            level: actor.system?.details?.level?.value ?? 0,
            index: equipmentIndex,
            rng: Math.random,
          });
          if (gp > 0) await actor.inventory.addCoins({ gp });
          if (itemRef) {
            const itemDoc = await game.packs.get(itemRef.pack)?.getDocument(itemRef.id);
            if (itemDoc) await actor.createEmbeddedDocuments('Item', [itemDoc.toObject()]);
          }
        }
```

- [ ] **Step 4: Manual sanity check (no unit test — Foundry-dependent)**

Run `node --check scripts/foundry-api.mjs` to confirm no syntax errors. Full behavior is confirmed in Task 5's live verification.

- [ ] **Step 5: Commit**

```bash
git add scripts/foundry-api.mjs
git commit -m "Grant real level-scaled treasure to eligible NPCs at spawn (#172)"
```

---

## Task 3: Convert defeated hostiles into lootable corpses, remove the flat grant

**Files:**
- Modify: `scripts/dungeon-combat.mjs:184-240` (the `resolveCombat` function)

**Interfaces:**
- Consumes: `LOOTABLE_ITEM_TYPES` from `scripts/treasure.mjs` (Task 1); the existing `combat.combatants`/`Combatant#isDefeated`/`Combatant#token` shapes already used elsewhere in this file (Global Constraints, confirmed-live fact 2).
- Produces: no new exports — `resolveCombat` stays a private (non-exported) function with the same call signature (`combat, outcome, api`); only its internal behavior on `outcome === 'victory'` and its NPC-cleanup step change.

- [ ] **Step 1: Add the import**

At the top of `scripts/dungeon-combat.mjs`, alongside its other local imports:

```js
import { LOOTABLE_ITEM_TYPES } from './treasure.mjs';
```

- [ ] **Step 2: Narrow the NPC-cleanup set to exclude defeated hostiles**

Replace:

```js
  const npcCombatants = combat.combatants.filter(
    (c) => c.actor?.id && !partyIds.has(c.actor.id),
  );
  const npcTokenIds = npcCombatants.map((c) => c.tokenId).filter(Boolean);
  const npcActorIds = [...new Set(npcCombatants.map((c) => c.actor.id))];
```

with:

```js
  const npcCombatants = combat.combatants.filter(
    (c) => c.actor?.id && !partyIds.has(c.actor.id),
  );
  // A defeated hostile becomes a lootable corpse (see the conversion step
  // below) instead of being deleted outright — everything else non-party
  // (a surviving player-summoned ally, an undefeated hostile the party
  // fled from) keeps the pre-#172 immediate-delete behavior unchanged.
  const defeatedHostileCombatants = npcCombatants.filter(
    (c) => c.isDefeated && c.token?.disposition === -1,
  );
  const otherNpcCombatants = npcCombatants.filter(
    (c) => !defeatedHostileCombatants.includes(c),
  );
  const npcTokenIds = otherNpcCombatants.map((c) => c.tokenId).filter(Boolean);
  const npcActorIds = [...new Set(otherNpcCombatants.map((c) => c.actor.id))];
```

- [ ] **Step 3: Remove the flat party-wide gp grant**

Replace:

```js
  if (outcome === "victory") {
    const hostileLevels = combat.combatants
      .filter((c) => c.token?.disposition === -1)
      .map((c) => c.actor?.system?.details?.level?.value ?? 0);
    const partyLevel = await api.partyLevel();
    const totalXp = totalCombatXp(hostileLevels, partyLevel);
    const party = (game.actors?.party?.members ?? []).filter(
      (m) => m.type === "character",
    );
    const share = xpPerSurvivor(totalXp, party.length);
    for (const member of party) {
      await member.update({
        "system.details.xp.value":
          (member.system.details.xp.value ?? 0) + share,
      });
    }
    if (game.actors.party)
      await api.addCoins(game.actors.party.id, { gp: lootGpForXp(totalXp) });
  }
```

with:

```js
  if (outcome === "victory") {
    const hostileLevels = combat.combatants
      .filter((c) => c.token?.disposition === -1)
      .map((c) => c.actor?.system?.details?.level?.value ?? 0);
    const partyLevel = await api.partyLevel();
    const totalXp = totalCombatXp(hostileLevels, partyLevel);
    const party = (game.actors?.party?.members ?? []).filter(
      (m) => m.type === "character",
    );
    const share = xpPerSurvivor(totalXp, party.length);
    for (const member of party) {
      await member.update({
        "system.details.xp.value":
          (member.system.details.xp.value ?? 0) + share,
      });
    }
  }
```

(`lootGpForXp` itself is deleted in Task 4, alongside its now-unused import into this file.)

- [ ] **Step 4: Convert each defeated hostile into a real loot actor**

Immediately after the block from Step 3 (still inside `resolveCombat`, before the existing `await combat.delete();` line), add:

```js
  // #172: a defeated hostile's own gear (granted at spawn time — see
  // spawnCreatures) becomes real, player-lootable treasure instead of
  // vanishing with its actor. Foundry document types are immutable after
  // creation (confirmed live: actor.update({type: "loot"}) silently no-ops)
  // — so this creates a fresh loot-type actor from the defeated actor's own
  // data and repoints the existing token at it, rather than updating in
  // place. Ownership defaults to full Owner so any player can loot it
  // immediately with no further GM permission step.
  for (const combatant of defeatedHostileCombatants) {
    const source = combatant.actor.toObject();
    const lootItems = source.items.filter((i) =>
      LOOTABLE_ITEM_TYPES.includes(i.type),
    );
    const [lootActor] = await Actor.createDocuments([
      {
        ...source,
        _id: undefined,
        type: "loot",
        name: `${combatant.actor.name} (corpse)`,
        items: lootItems,
        ownership: { default: 3 },
      },
    ]);
    await combatant.token.update({ actorId: lootActor.id });
  }
```

- [ ] **Step 5: Also delete the now-orphaned original NPC actors**

The loop above leaves each defeated hostile's *original* npc-type actor behind (only the token was repointed to the new loot actor) — add its cleanup right after the loop, still before `await combat.delete();`:

```js
  const lootedOriginalActorIds = defeatedHostileCombatants
    .map((c) => c.actor.id)
    .filter(Boolean);
  if (lootedOriginalActorIds.length)
    await Actor.deleteDocuments(lootedOriginalActorIds);
```

- [ ] **Step 6: Manual sanity check (no unit test — Foundry-dependent)**

Run `node --check scripts/dungeon-combat.mjs` to confirm no syntax errors. Full behavior is confirmed in Task 5's live verification.

- [ ] **Step 7: Commit**

```bash
git add scripts/dungeon-combat.mjs
git commit -m "Convert defeated hostiles to lootable corpses, drop flat gp grant (#172)"
```

---

## Task 4: Delete the now-dead flat-grant code

**Files:**
- Modify: `scripts/combat-rewards.mjs`
- Modify: `tests/combat-rewards.test.mjs`
- Modify: `scripts/dungeon-combat.mjs` (its import of `lootGpForXp`)

**Interfaces:**
- Consumes: nothing new.
- Produces: `combat-rewards.mjs` no longer exports `lootGpForXp`/`LOOT_GP_PER_XP` — confirm nothing outside this module still imports them (Task 3 already removed the one real call site; this task removes the now-dead export and its test coverage).

- [ ] **Step 1: Confirm no other caller remains**

Run: `grep -rn "lootGpForXp\|LOOT_GP_PER_XP" scripts/ tests/`
Expected: only `scripts/combat-rewards.mjs` (the definitions) and `tests/combat-rewards.test.mjs` (their tests) — `scripts/dungeon-combat.mjs`'s call site was already removed in Task 3, but its `import` line still names them.

- [ ] **Step 2: Remove the dead functions from `combat-rewards.mjs`**

Delete `LOOT_GP_PER_XP` and `lootGpForXp` (and their explanatory comment) from `scripts/combat-rewards.mjs`, leaving `totalCombatXp`/`xpPerSurvivor` untouched — treasure math now lives entirely in `scripts/treasure.mjs`.

- [ ] **Step 3: Remove their test coverage**

Delete the `describe('lootGpForXp', ...)` block from `tests/combat-rewards.test.mjs`, and drop `lootGpForXp, LOOT_GP_PER_XP` from that file's import line (keep `totalCombatXp`, `xpPerSurvivor`, `xpFor`).

- [ ] **Step 4: Clean up the now-unused import in `dungeon-combat.mjs`**

Find the import of `lootGpForXp` from `./combat-rewards.mjs` in `scripts/dungeon-combat.mjs` and remove just that name from the import list (keep `totalCombatXp`/`xpPerSurvivor` if imported from the same line).

- [ ] **Step 5: Run the full test suite**

Run: `npx vitest run`
Expected: PASS — every test file green, including the trimmed `combat-rewards.test.mjs`.

- [ ] **Step 6: Commit**

```bash
git add scripts/combat-rewards.mjs tests/combat-rewards.test.mjs scripts/dungeon-combat.mjs
git commit -m "Remove dead lootGpForXp flat-grant code (#172)"
```

---

## Task 5: Live verification and version bump

**Files:**
- Modify: `module.json`

- [ ] **Step 1: Live-verify spawn-time treasure generation**

Using the `foundry-rest` skill against the connected test world, spawn a treasure-eligible hostile (a `humanoid`-trait creature from `pf2e.pathfinder-monster-core`) via the real `spawnCreatures` code path (or an equivalent inline script exercising the same logic), and confirm: its `system.traits.value` includes an eligible trait, it ends up with `inventory.coins.gp > 0` when `rollNpcTreasure` would have rolled a nonzero amount, and — running enough trials to hit the `ITEM_CHANCE` branch — that a granted item's `system.level.value` and price never exceed the level/budget ceiling. Delete every actor/token this creates afterward.

- [ ] **Step 2: Live-verify the loot-conversion mechanism end to end**

Start (or reuse) a real combat encounter in the test world with at least one hostile combatant, defeat it (reduce to 0 HP so `Combatant#isDefeated` is true), and trigger `resolveCombat`'s victory path (Declare Victory, or the automatic all-hostiles-defeated hook). Confirm live: the defeated hostile's token is still on the scene (not deleted), its `token.actor.type` reads `"loot"`, its item list matches `LOOTABLE_ITEM_TYPES` only (no leftover `spell`/`melee`/`lore` entries), its coins match what spawn-time treasure granted, and its `ownership.default` is `3`. Confirm a surviving non-hostile non-party combatant (if any were present) still gets deleted as before. Clean up the encounter afterward.

- [ ] **Step 3: Bump the module version**

Read the current `"version"` in `module.json`, then bump the patch component by one (matching this project's existing version-bump convention — check `git log --oneline -5 -- module.json` for the exact current value and format immediately before editing, since other work may have advanced it since this plan was written).

- [ ] **Step 4: Run the full test suite one final time**

Run: `npx vitest run`
Expected: PASS — every test file green.

- [ ] **Step 5: Commit**

```bash
git add module.json
git commit -m "Bump version for #172 (lootable NPC treasure)"
```
