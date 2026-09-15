# Backlog

_Last updated: 2026-09-15 (ITEM-4 done)_

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

### ITEM-4: Environment art for dungeon rooms
**State:** done
**Blocked:** false
**Summary:** Give each generated dungeon room a real background map image instead of `dungeon-scene.mjs`'s flat neutral fill (`#2b2620`) — to start, a pregenerated image per category rather than a unique image per room. "Category" naturally maps to something already in the data model from ITEM-1 — each room's `locationTag` (undead/beast/fiend/aberration/construct/elemental/plant/dragon) and/or its `kind` (combat/skill_challenge/puzzle_or_trap/narrative) — so this is likely a tile/background swap keyed off data the room already carries, not a new categorization scheme.

#### Spec

**Problem.** All rooms in one dungeon run share a single Foundry Scene (`createDungeonScene()`, called once at Start) — rooms are just wall-enclosed rectangles and Regions *within* that scene, not separate Scene documents. The whole thing currently renders as one flat neutral fill (`backgroundColor: '#2b2620'`) with zero visual distinction between rooms, themes, or the corridors connecting them; only walls and doors are visible structure. Because there's one Scene background for the whole dungeon, a per-room image can't be done via `Scene.background` at all — it needs a placed image object per room.

**Goal.** Give each room a real background image reflecting its `locationTag`, pregenerated (not generated live per room) and placed as a Foundry `Tile` sized to that room's footprint — the same mechanism `scene-divination.mjs` already uses for its card images (`scene.createEmbeddedDocuments('Tile', [...])`), applied per room instead of per scene.

**Scope.**
- **Category axis: `locationTag`** (the 8 creature-theme traits from ITEM-1), not `kind` — a room's gameplay function (combat vs. narrative vs. puzzle) doesn't change what the chamber looks like, but its theme does, and every room already carries a `locationTag` regardless of kind.
- **A couple of pregenerated variants per category** (2–3, exact count a planning-time call), picked via the same deterministic seeded pattern as `locationTagAt` — so the same seed reproduces the same look, and a run of same-theme rooms in one dungeon doesn't look identical.
- **The goal room gets a distinct look** — its own dedicated art, or a marked-up variant of its own `locationTag`'s pool (decide in planning) — reinforcing the climax, consistent with ITEM-1 already giving it max depth-bias.
- **Corridors get art too**: a plain, theme-neutral connector texture (not per-`locationTag`) so there's no visible seam between a room's Tile and the scene's flat background along the connecting passage.
- All rooms are a fixed, identical square footprint (`ROOM_SIZE = 6` grid squares → 600×600px at the dungeon scene's `GRID_SIZE = 100`), so every room image is one fixed square resolution — no aspect-ratio or stretching handling needed.

**Mechanism.**
- Art assets are static files shipped with the module (e.g. `assets/dungeon-rooms/<locationTag>-<n>.webp`), generated ahead of time via the existing ComfyUI pipeline (the same tool already used for card/token/macro-icon art this session) — not generated live at play time.
- Image selection is a new **pure** function, same file/pattern as `locationTagAt` (`dungeon-layout.mjs`): deterministic, seeded, returns an asset filename/variant index — no Foundry dependency, fully unit-testable.
- Placing the Tile is Foundry-touching work in `dungeon-scene.mjs`'s `buildRoomAtSlot` (one Tile per room) plus wherever corridor geometry is built (one Tile per connector segment), positioned/sized from the already-computed pixel rects (`slotRect`/`buildConnectionGeometry`), `sort` set low enough to sit beneath walls and tokens — matching `scene-divination.mjs`'s existing Tile-placement precedent exactly.

**Non-goals.** Live/on-demand image generation per room (pregenerated pool only, for v1). Unique art per individual room — variants are a shared, reused pool, not one-of-a-kind per room. `kind`-based art layering (e.g. a distinct puzzle-room overlay) — `locationTag` is the only axis for v1.

**Open for planning (not settled here).** Exact asset resolution/format and how many variants per category is "enough" — a judgment call best made once the art pipeline is actually run and the results reviewed, not fixed in advance. Whether the goal room gets wholly separate art or a marked-up variant of its own `locationTag`. Whether corridor art needs to vary by orientation (the boustrophedon layout has both horizontal and vertical connectors) or one texture works for both via rotation.

#### Plan

**Resolving the spec's open items.**
- **Goal room art**: a dedicated image per `locationTag` (8 total), separate from the regular variant pool — not an edited/marked-up variant. There's only ever one goal room per run, so no variant pool is needed for it, and a dedicated static image is far simpler than building image-compositing logic to "mark up" a regular one.
- **Corridor orientation**: turns out not to matter. `CORRIDOR_LEN = 1` and `DOOR_WIDTH = 1` (`dungeon-layout.mjs`), so every corridor's floor footprint is a single 1×1 grid square (100×100px) regardless of whether it runs east/west or south — one square texture serves every corridor with no rotation logic needed.
- **Variant count**: `ROOM_ART_VARIANTS = 3` as the starting default (a tunable constant, easy to change without touching any logic).

**Total asset count for v1**: 8 `locationTag`s × 3 variants = 24 regular room images, + 8 goal-room images (one per tag), + 1 corridor image = **33 static images**, generated ahead of time via the existing ComfyUI pipeline (the tool already used for card/token/macro-icon art this session). Generating and reviewing 33 images is the actual bulk of this item's effort — the code changes below are comparatively small.

**1. `scripts/dungeon-layout.mjs`:**
- `buildConnectionGeometry(slot)` gains a third return field, `corridorRect` — the connector's own floor rect in grid units (`{ gx, gy, gw, gh }`), computed from the same door-offset math the function already has (no duplicated logic): `{ gw: CORRIDOR_LEN, gh: DOOR_WIDTH }` for east/west, `{ gw: DOOR_WIDTH, gh: CORRIDOR_LEN }` for south. Additive to the existing return shape — every current caller destructures only `{ doorWall, plainWalls }` and is unaffected.

**2. `scripts/dungeon-deck.mjs`:**
- New `export const ROOM_ART_VARIANTS = 3;` and `export function roomArtVariantAt(seed, index)` — `Math.floor(splitmix32(seedFromString(`${seed}-art-${index}`))() * ROOM_ART_VARIANTS)`, same seeded-per-index pattern as `locationTagAt`, deliberately *not* routed through `pickAt`/`weightedPick` since it's a plain uniform integer pick with no weighting concept.
- `buildRoomSequence` and `applySequenceMutation`'s `insert_after` branch each gain one more field per room, computed alongside the existing `locationTag: locationTagAt(seed, i)` line: `artVariant: roomArtVariantAt(seed, i)`. Precomputed once per room at build time (same as every other per-room random pick in this file), not recomputed later from `physicalSlot` — keeps a room's look stable regardless of when its Tile actually gets placed.

**3. `scripts/dungeon-scene.mjs`:**
- New small pure-ish helper (Foundry-free path construction, same style as the existing `REGION_ENTRY_SCRIPT` constant):
  ```js
  const ROOM_ART_DIR = `modules/${MODULE_ID}/assets/dungeon-rooms`;
  function roomArtPath({ locationTag, isGoal, artVariant }) {
    return isGoal ? `${ROOM_ART_DIR}/${locationTag}-goal.webp` : `${ROOM_ART_DIR}/${locationTag}-${artVariant}.webp`;
  }
  const CORRIDOR_ART_PATH = `${ROOM_ART_DIR}/corridor.webp`;
  ```
- `buildRoomAtSlot(scene, slot, { isGoal = false, locationTag = null, artVariant = 0 } = {})` — signature gains the two new params. After the existing Wall/Region creation, adds one `Tile` for the room's own footprint: `scene.createEmbeddedDocuments('Tile', [{ texture: { src: roomArtPath({ locationTag, isGoal, artVariant }) }, x: toPixels(rect.gx), y: toPixels(rect.gy), width: toPixels(rect.gw), height: toPixels(rect.gh) }])` (same `rect` already computed for the Region). No special `sort`/`elevation` needed — Foundry's Tiles layer already renders below the Tokens layer by default, and walls are a separate document type entirely unaffected by Tile z-order.
- If `slot > 0`: one more `Tile` for the connecting corridor, using `buildConnectionGeometry(slot - 1)`'s new `corridorRect`, `texture.src: CORRIDOR_ART_PATH` — placed in the same `createEmbeddedDocuments('Wall', ...)`-adjacent block where the door/plain walls for that connection are already built, so room and corridor art land together in one pass.

**4. `scripts/ui/dungeon-app.mjs`:** the three existing `buildRoomAtSlot(scene, slot, { isGoal })` call sites (`#onStart`, `resolveCurrentRoom`, `#onPopulateNext`) each add `locationTag: room.locationTag, artVariant: room.artVariant` — the room object is already in scope at every one of those call sites (needed there already for `depthBiasFor`/`locationTag` from ITEM-1), so this is a one-line addition per site, not new plumbing.

**5. Assets.** `assets/dungeon-rooms/<tag>-0.webp` / `-1.webp` / `-2.webp` for each of the 8 `LOCATION_TAGS`, `assets/dungeon-rooms/<tag>-goal.webp` per tag, `assets/dungeon-rooms/corridor.webp` — all square, matching the fixed 600×600px room footprint (`ROOM_SIZE * GRID_SIZE`) for room art and 100×100px for the corridor tile, generated via ComfyUI and reviewed for the "flat glossy emblem" mistakes this session already ran into once with the macro icons (gray/product-shot backgrounds instead of the intended look) before accepting each one.

**Tests:**
- `tests/dungeon-layout.test.mjs`: `buildConnectionGeometry`'s new `corridorRect` — correct dimensions for an east/west connection (`gw: CORRIDOR_LEN, gh: DOOR_WIDTH`) vs. a south one (`gw: DOOR_WIDTH, gh: CORRIDOR_LEN`), and that it sits immediately adjacent to the door wall's coordinates (no gap, no overlap with the room rect itself).
- `tests/dungeon-deck.test.mjs`: `roomArtVariantAt` — deterministic per seed/index, always in `[0, ROOM_ART_VARIANTS)`; `buildRoomSequence`/`insert_after` — every room (including an inserted one) carries an `artVariant`.
- **New `tests/dungeon-room-art.test.mjs`**: enumerates every `{locationTag} × {0..ROOM_ART_VARIANTS-1, 'goal'}` combination plus the corridor asset and asserts each file exists on disk under `assets/dungeon-rooms/` — this codebase already treats "a missing asset is silent everywhere" as a real, previously-hit failure mode (the macro-icon work earlier in this session added exactly this kind of check for hotbar icons), and `roomArtPath`'s output is built from two interpolated variables so the existing regex-based `tests/asset-paths.test.mjs` scanner can't catch a missing file here the way it does for mostly-literal paths.

**Verification.** `npm test` — 485 passing, 34 new (`tests/dungeon-room-art.test.mjs`'s exhaustive asset-existence check across all 33 combinations, plus `corridorRect`/`roomArtVariantAt` coverage in the existing layout/deck test files). All 33 images generated via ComfyUI and reviewed individually before acceptance — 3 of 33 were regenerated (two `beast` variants that showed background bleed / an inconsistent parchment-vignette style, and the `plant` goal room, which first came back as a side-view tree portrait instead of a top-down floor tile). Live-verified via the `foundry-rest` skill in a scratch scene (cleaned up after) that a `Tile` document with these exact fields creates correctly; confirmed the deployed world installs the module from GitHub rather than mounting this working tree directly, so the new asset files themselves won't be `fetch`-reachable in-world until this merges and the module is reinstalled/updated — not a defect, just the deployment model, consistent with every other asset shipped this session.

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
