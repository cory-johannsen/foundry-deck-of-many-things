# Backlog

_Last updated: 2026-09-08 (ITEM-1 done)_

## Active

### ITEM-2: Generated art for encounter opponents
**State:** backlog
**Blocked:** false
**Summary:** Auto-generate token art (via the existing ComfyUI pipeline) for creatures spawned by the encounter generator — many bestiary entries, especially SRD ones, ship with no token art at all.

### ITEM-3: Expand trap/puzzle generation with realistic content
**State:** backlog
**Blocked:** false
**Summary:** Grow `data/dungeon-setpieces.json` beyond the current 2 fully-transcribed puzzles + 3 stub traps into a fuller, more varied set of realistic traps and puzzles, and implement real generation/selection logic on top of it rather than a fixed small pool.

## Done

### ITEM-1: Balance encounter builder against current location
**State:** done
**Blocked:** false
**Summary:** Have the encounter generator (`encounter-deck.mjs`/`encounter-roster.mjs`) balance creature level/composition against the current location's own restrictions — e.g. a dungeon room's depth or theme traits — rather than flat party-level defaults regardless of where the party is.

#### Spec

**Problem.** Every combat room in a dungeon run currently generates its encounter identically: the same fixed level-offset distribution (`encounter-deck.mjs`'s `CREATURE_SLOT_TEMPLATES`, always skewed at-or-below party level) and the same `traits`/`excludeTraits` captured once at "Start Dungeon" and reused unchanged for every room, including the goal/boss room. Depth and room identity currently have zero effect on encounter difficulty or flavor.

**Goal.** Two independent adjustments, both derived automatically from a room's own generated identity (its position/depth and its kind) rather than requiring GM input per room:

1. **Depth-scaled difficulty** — encounters get harder as the party goes deeper, culminating in a noticeably tougher goal-room fight.
2. **Per-room trait restriction** — each room carries its own location flavor, derived from its position/kind at generation time, which *restricts* (not merely favors) which creatures can appear there, layered on top of the dungeon-wide traits set at Start.

**Scope.** Dungeon rooms only (`dungeon-deck.mjs`/`dungeon-scene.mjs`). The standalone "DOMMT: Generate Encounter" macro is unaffected — every new parameter is optional and defaults to today's exact behavior.

**Non-goals.** No GM-facing UI for manual per-room trait overrides (ruled out explicitly). No change to `skill_challenge`/`puzzle_or_trap`/`narrative` room generation — this item is combat rooms only, since those are the only rooms with a level-offset/traits concept today.

#### Plan

**Refinement of the spec's Mechanism 1.** The spec proposed baking `levelOffsetBias` into `encounter-deck.mjs`'s `buildEncounterDeck` slot templates. Building it showed a conflict: `resolveDraws`'s twin-pair override (`levelOffset: TWIN_PAIR_LEVEL_OFFSET`) hard-assigns a constant when both twins are drawn, which would silently erase any bias baked into the slots beforehand. The bias is instead applied once, uniformly, at roster-resolution time — `encounter-deck.mjs` and `dungeon-deck.mjs`'s `resolveRoomOutcome`/`applySequenceMutation` stayed completely untouched.

**1. `scripts/dungeon-deck.mjs`** — two new pure exports: `MAX_DEPTH_BIAS` (2), `depthBiasFor({ physicalSlot, roomCount, isGoal })` (linear ramp 0 → max, goal room always max); `LOCATION_TAGS` (8 broad PF2e creature-type traits), `locationTagAt(seed, index)` (seeded pick, same pattern as `outcomeSlotAt`/`setpieceAt`). Every room built by `buildRoomSequence` and `applySequenceMutation`'s `insert_after` carries a `locationTag`.

**2. `scripts/foundry-api.mjs`** — `findCreatures` gains `requireTrait` (single string, hard ANDed filter), kept separate from the existing any-match `traits` param since folding a location's own required trait into that array would have *broadened* the query instead of narrowing it.

**3. `scripts/encounter-roster.mjs`** — `pickCreature`/`resolveEncounterRoster` gain `levelOffsetBias`/`requireTrait`, applied uniformly to foes, friend, lurker and twins. Fallback chain when `requireTrait` is set and nothing matches: Monster Core (dungeon traits + room tag) → full packs (same restriction) → full packs with the dungeon-wide traits dropped, room tag kept → `null`. The room's own flavor is always the harder, non-negotiable restriction; the broader dungeon theme yields first. `approxXp` reflects the biased offset.

**4–6.** `encounter-generator.mjs`'s `generateEncounter` gains `levelOffsetBias`/`locationTag`, threaded into `resolveEncounterRoster` (renamed to `requireTrait` only at that boundary). `dungeon-scene.mjs`'s `populateSlotEncounter` gains the same two params, passed to `generateEncounter`. `dungeon-app.mjs`'s three population call sites (`#onStart`, `resolveCurrentRoom`, `#onPopulateNext`) compute `depthBiasFor(...)` and read `room.locationTag` before calling it.

**Verification.** `npm test` — 443 passing, 16 new (`tests/dungeon-deck.test.mjs`'s `depthBiasFor`/`locationTagAt` suites plus insert_after coverage; `tests/encounter-roster.test.mjs`'s `levelOffsetBias`/`requireTrait` suites including the fallback chain). `npm run validate` / `validate:dungeon` unaffected. Live sanity check via the `foundry-rest` skill: queried the installed bestiaries for all 8 `LOCATION_TAGS` — each has 180–830 matching creatures, so the restriction is very unlikely to starve a room in practice. Not yet exercised through the actual in-game UI (needs the module reloaded in a running world) — worth a live playtest pass covering a multi-row dungeon (confirm the goal room's reported severity is visibly higher than room 1's) and a deliberately mismatched dungeon-theme/room-tag combination (confirm the graceful fallback rather than an empty room).
