# Backlog

_Last updated: 2026-09-18 (ITEM-10 done)_

## Active

### ITEM-8: Automate non-player turns in combat
**State:** backlog
**Blocked:** false
**Depends-on:** ITEM-6
**Summary:** When a non-player-controlled combatant (foe/friend/lurker/twin) comes up in the Combat Tracker's initiative order, it should act automatically according to its default behavior instead of waiting on a GM to manually run its turn.

### ITEM-5: Refactor combat encounter difficulty scaling
**State:** backlog
**Blocked:** false
**Summary:** Dungeon crawl encounters, traps, and puzzles should start easy (scaled to party level) at the first room and increase in difficulty each subsequent room; players must always be able to flee backward to a previously completed room; dungeons with more than 6 rooms get a safe resting room in the middle.

### ITEM-3: Expand trap/puzzle generation with realistic content
**State:** backlog
**Blocked:** false
**Summary:** Grow `data/dungeon-setpieces.json` beyond the current 2 fully-transcribed puzzles + 3 stub traps into a fuller, more varied set of realistic traps and puzzles, and implement real generation/selection logic on top of it rather than a fixed small pool.

## Done

### ITEM-10: Trigger room discovery by opening a real door, not walking in
**State:** done
**Blocked:** false
**Summary:** The "reveal door" ITEM-9 added on each room's incoming face (previously a plain wall-gap) becomes a real interactive Foundry door, and opening it — not a token merely walking into the room's rectangle — is what reveals the room's contents and advances the tracker.

#### Spec

**Problem/Goal.** ITEM-9 gave each room's incoming face a *gap* (no door object, always passable) rather than a real door. The reveal/advance trigger was a Region's `tokenEnter` behavior, firing the instant a party token's movement crossed into the room's rectangle — no tactile "open the door" moment, and nothing stopped a token from being inside the room's footprint before any door-like interaction happened. The user wants an actual door on each end of the connecting hallway, and wants *opening the second one* — not stepping past it — to be the moment a room reveals itself.

**Mechanism.**
1. `dungeon-layout.mjs`'s `buildConnectionGeometry` already computed the incoming face's gap position (`incomingOffset`) for ITEM-9's flanking walls; it now also returns that exact segment as `revealDoorWall` (a normal door-shaped wall segment) instead of leaving it as an implicit omission between two flanking segments.
2. `dungeon-scene.mjs`'s `buildRoomAtSlot` creates `revealDoorWall` as a real Foundry door, flagged `dungeonRevealDoorForSlot: slot`, starting `CLOSED` (never `LOCKED`) — the *first* door (`dungeonDoorToSlot`, unchanged) stays the GM-gated progress lock; this second one is always freely operable by players once they're through it, its only job is to be the discovery trigger.
3. The Region + `tokenEnter` `executeScript` behavior is removed entirely (it had no other purpose — confirmed nothing else reads the Region or its `physicalSlot` flag). Discovery is now driven by a `Hooks.on('updateWall', ...)` registered directly in `module.mjs`, checking `changes.ds === CONST.WALL_DOOR_STATES.OPEN` and calling `handleDungeonDoorOpened(sceneId, wallId)` (renamed from `handleDungeonRoomEnter`, same internal logic — reveal tokens, start Combat if applicable, `advanceToRoom`, focus camera — just keyed off a door-open event instead of a token-position event). No `module.api` entry is needed for this any more (the old Region-behavior trigger needed one because a Region's `executeScript` runs in a more sandboxed context; a plain Foundry hook registered in `module.mjs` already has direct access).
4. `relockDoorToSlot` (the undo path) now also re-closes the reveal door, so undoing an accidental entry fully reverts both doors' state, not just the progress-gate one.

**Non-goals.** Locking the reveal door — it's deliberately never lockable. Changing anything about the first (progress-gate) door's own lock/unlock flow.

#### Plan

Implemented directly (small, mechanical change riding entirely on ITEM-9's already-computed offsets): `dungeon-layout.mjs` (+`revealDoorWall`), `dungeon-scene.mjs` (second door creation, Region removal, `handleDungeonRoomEnter` → `handleDungeonDoorOpened`, `relockDoorToSlot` closes both), `module.mjs` (`updateWall` hook replacing the `onDungeonRoomEnter` API entry). `tests/dungeon-layout.test.mjs` gained coverage for `revealDoorWall`'s own position/face/independence from the outgoing door.

**Verification.** `npm test` — 539 passing, 2 new. `npm run validate`/`validate:dungeon`/`validate:creature-art` unaffected. Live-verified via `foundry-rest` in scratch scenes: (1) the exact `buildRoomAtSlot` wall-creation shape — gate door `door:1, ds:LOCKED`, reveal door `door:1, ds:CLOSED` (never locked), offsets confirmed different (0 vs 5); (2) the `updateWall` hook itself — opening a flagged reveal door fires the hook with `changes.ds` matching `WALL_DOOR_STATES.OPEN`, `wall.parent.id` correctly resolves to the scene, the `dungeonRevealDoorForSlot` flag reads correctly inside the handler, and *closing* a door (not an open transition) correctly does not fire the filter. The `getRunState`/`advanceToRoom` portion of `handleDungeonDoorOpened` is pre-existing, previously-verified code reached through a new trigger path — not independently re-verified here since `game.settings.set` is unreachable through the live-script relay (banned substring); a live playtest pass once this merges will exercise it end to end.

### ITEM-9: Randomize door placement so rooms don't align
**State:** done
**Blocked:** false
**Summary:** Each room's own door (both the outgoing door a room's builder places and the incoming opening the next room gets) is independently randomized along the connecting wall, instead of both always sitting dead-center facing each other — so lines of sight and approach angles vary room to room instead of every connection looking the same.

#### Spec

**Problem/Goal.** Today `buildConnectionGeometry` centers a connection's one door on both rooms' facing walls (as of ITEM-7, on an integer-aligned near-center square, but always the *same* offset mirrored on both sides). The user wants each room's door position picked independently at random, so the two ends of a connection often don't line up — approach angles and sightlines through a doorway should vary dynamically rather than every corridor being a straight, predictable poke between two centered doors.

**Design decision (user-selected): an L-shaped dogleg, not a longer corridor.** `CORRIDOR_LEN` stays `1` — the gap between rooms doesn't grow. When the two doors land on different rows/columns, the connecting space becomes a `1`-square-wide gallery spanning the *entire* connecting face (not just the door row), naturally enclosed by each room's own wall (solid except for its own door/opening) with two short fixed caps closing the very top/bottom (or left/right) of that gallery. No dependency on how far apart the two doors are — the geometry is exactly as simple whether they align or sit at opposite corners.

**Mechanism.**
1. **Two independent per-slot door offsets**, both integers in `[0, ROOM_SIZE - DOOR_WIDTH]`, seeded off the run's own seed (deterministic, reproducible, same pattern as `locationTagAt`): the *outgoing* offset (slot's own door, into the connection to slot+1) and the *incoming* offset (slot's own opening, on the face receiving the connection from slot-1). A room's incoming face and outgoing face are almost always different sides, so these are genuinely two separate values per room, not one reused twice.
2. **Only the outgoing side is a real, lockable Foundry door** (`door:1`, starts `LOCKED`, gated by the GM exactly as today). The incoming side is just an opening — a gap left in an otherwise-solid wall, no door object, always passable — matching today's "later room's facing side gets no wall" spirit, except now it's "no wall *at one specific, independently-random spot*" instead of "no wall at all." This keeps the GM's existing single lock/unlock action working completely unchanged; nothing about the progress-gating mechanism needs to learn about two doors.
3. **Each room's own flanking wall segments span its full connecting face** (solid the whole height/width of the room, minus its own one-square gap) — not just short segments framing the door the way a single centered door needed. Two fixed capping segments (independent of either offset) close the very top/bottom (east/west) or left/right (south) of the shared 1-square-wide gap column, so nothing can wander past the ends of it. Worked through concretely: with those pieces in place, the gap column is already fully enclosed by the combination of the two rooms' own gapped walls — nothing needs to change size or position based on how far apart the two offsets land.
4. **Corridor floor art**: the existing `corridor.webp` is a small self-contained "box" texture, checked directly — stretching it to a tall/wide strip looks wrong (baked-in wall lines would distort). Instead of one stretched tile, place the *same* unstretched square tile once per grid square along the now-taller/wider gap (`ROOM_SIZE` placements instead of `1`) — reuses the existing asset with zero distortion, and reads as a proper connecting gallery rather than one warped image.

**Non-goals.** Changing `CORRIDOR_LEN`, `ROOM_SIZE`, or `DOOR_WIDTH`. Making the incoming side a second lockable door — it's deliberately a plain opening. Trimming the gap-column art/walls down to just the row/column span between the two offsets — the full-face gallery approach was chosen for its fixed, offset-independent simplicity (and reads as a feature: extra tactical space near a doorway, not wasted space).

#### Plan

**1. `scripts/dungeon-layout.mjs`.**
- Import `splitmix32`/`seedFromString` from `./prng.mjs` (this file had no prng dependency before — first one, matching `dungeon-deck.mjs`'s existing pattern).
- New `export function doorOffsetAt(seed, slot, role)` (`role` is `'outgoing'` or `'incoming'`) — `Math.floor(splitmix32(seedFromString(`${seed}-door-${role}-${slot}`))() * (ROOM_SIZE - DOOR_WIDTH + 1))`, same seeded-per-index convention as `locationTagAt`.
- `buildConnectionGeometry(slot, seed)` gains the `seed` parameter. Computes `outgoingOffset = doorOffsetAt(seed, slot, 'outgoing')` (slot's own door) and `incomingOffset = doorOffsetAt(seed, slot + 1, 'incoming')` (slot+1's own opening). Both branches (east/west and south) rebuilt per the Spec's Mechanism: `doorWall` uses `outgoingOffset`; a second pair of flanking segments for slot+1's face uses `incomingOffset` (spanning slot+1's *full* height/width minus its own gap, not just a short frame); two fixed cap segments at the room's own top/bottom (or left/right) edges close the shared gap column. `corridorRect` becomes `{ gx, gy, gw: CORRIDOR_LEN, gh: ROOM_SIZE }` for east/west (transposed for south) — always the full connecting face, never dependent on either offset.
- `roomEnclosureWalls` needs no change — its existing incoming/outgoing exclusion already defers exactly the two faces `buildConnectionGeometry` now fully owns.

**2. `scripts/dungeon-scene.mjs`.**
- `buildRoomAtSlot` gains a `seed` parameter, passed through to `buildConnectionGeometry(slot - 1, seed)`.
- Corridor tile placement changes from one tile to a loop over `corridorRect`'s now-larger footprint: `for (let dx = 0; dx < corridorRect.gw; dx++) for (let dy = 0; dy < corridorRect.gh; dy++)` pushing one `1×1` `CORRIDOR_ART_PATH` tile per square — works unchanged for both orientations since exactly one of `gw`/`gh` is always `1`.

**3. `scripts/ui/dungeon-app.mjs`.** Every existing `buildRoomAtSlot(scene, slot, {...})` call site (`#onStart`, `resolveCurrentRoom`, `#onPopulateNext`) adds `seed: state.seed` — already in scope at each site (the run's own persisted seed), no new plumbing needed.

**Tests.** `tests/dungeon-layout.test.mjs` rewritten for the new contract: `doorOffsetAt` — deterministic per seed/slot/role, varies across slots/roles, always in bounds. `buildConnectionGeometry(slot, seed)` — every call site updated to pass a seed; the old "exact/near center" assertions replaced with: door and opening are each independently within `[0, ROOM_SIZE-DOOR_WIDTH]` of their own face; different seeds produce different offsets (not always centered); `corridorRect` is always `{gw:1, gh:ROOM_SIZE}` (or transposed) regardless of offsets; still-integer coordinates (ITEM-7 must not regress); no duplicate wall segments between the door/opening flanking pairs and the two fixed caps.

**Verification.** `npm test` — 537 passing, 7 new (`doorOffsetAt`'s determinism/bounds/variation, `buildConnectionGeometry`'s corridor-always-spans-the-full-face invariant across seeds, the degenerate-zero-length-segment drop). `npm run validate`/`validate:dungeon`/`validate:creature-art` unaffected. Found and fixed one thing the tests caught before shipping: an offset landing at either extreme (`0` or `ROOM_SIZE - DOOR_WIDTH`) leaves no room for the flanking segment on that side, producing a zero-length `plainWalls` entry — filtered out before returning rather than handed to Foundry as a degenerate Wall.

**Live end-to-end verification**, via `foundry-rest` in a scratch scene (built and torn down within the script, replicating the exact shipped `dungeon-layout.mjs` + `dungeon-scene.mjs` logic since the module isn't deployed yet): built one real connection end to end — `outgoingOffset:4`, `incomingOffset:5`, confirmed genuinely different (the two doors don't line up); 6 Wall documents created (one real door plus the flanking/capping segments, one degenerate segment correctly dropped); 6 separate `100×100`px corridor Tiles placed (not one stretched tile), each confirmed `anchorX:0, anchorY:0` and exactly `1×1` grid squares; scratch scene cleaned up after.


### ITEM-7: Fix half-grid-square door/corridor misalignment
**State:** done
**Blocked:** false
**Summary:** The door/corridor connector tile between two dungeon rooms is offset by half a grid square from the scene's grid lines, so the door sits straddling a grid line instead of flush inside one cell — breaking token movement snapping and wall/line-of-sight alignment through that doorway.

#### Spec

**Problem (confirmed via screenshot `Screenshot 2026-09-17 153607.png`).** The door tile between two rooms visibly straddles a grid line instead of sitting flush inside a single grid cell, and the highlighted door tile's bounding box is centered on a grid line rather than aligned to a cell edge.

**Root cause.** `scripts/dungeon-layout.mjs`'s `buildConnectionGeometry` (lines 87-125) computes the door's offset within a room face as `(gh - DOOR_WIDTH) / 2` for east/west connections (line 98, assigned to `doorY0`) and `(gw - DOOR_WIDTH) / 2` for south connections (line 112, assigned to `doorX0`). With the module's actual constants — `ROOM_SIZE = 6` and `DOOR_WIDTH = 1` (`dungeon-layout.mjs:23-26`) — this evaluates to `(6 - 1) / 2 = 2.5`, a fractional grid coordinate, because `ROOM_SIZE - DOOR_WIDTH` (5) is odd and doesn't divide evenly by 2. That `2.5` flows unchanged into `corridorRect.gx`/`gy` (lines 107/121) and from there into `dungeon-scene.mjs`'s `toPixels(gridVal) = gridVal * GRID_SIZE` (`dungeon-scene.mjs:28`), which is a plain scalar multiply with no origin snapping — `toPixels(2.5)` with `GRID_SIZE = 100` yields `250`, i.e. `x*100 + 50`, landing the door wall and corridor Tile exactly 50px (half a grid square) off every grid line. `toPixels` and the Tile/Wall document builders (`dungeon-scene.mjs:112-126`, `:46`) are not themselves buggy — they faithfully place whatever grid coordinate they're handed; the fractional coordinate originates in `buildConnectionGeometry`'s door-centering arithmetic.

**Goal.** The door wall, the door's Region/Tile, and the corridor Tile should always land on integer grid coordinates so they align exactly with the scene's grid lines, restoring correct token-movement snapping and correct wall/line-of-sight geometry through every door.

**Scope.** `buildConnectionGeometry`'s door-centering math (`dungeon-layout.mjs`) for both the east/west and south branches. Likely also touches whichever of `ROOM_SIZE`/`DOOR_WIDTH` is adjusted, or the rounding applied to `doorY0`/`doorX0`, plus every derived rect (`corridorRect`, the door wall segment, `plainWalls`) that depends on those two values — all of dungeon layout is seeded off the same room/door constants, so a change here needs re-verification against every existing dungeon-layout test, not just a patch to the two offending lines.

**Candidate fixes (to weigh at planning time, not decided here).** (a) Round/floor the door offset to the nearest integer grid unit (simplest, smallest diff, but shifts the door slightly off perfect visual center within the wall — likely imperceptible at `DOOR_WIDTH = 1`). (b) Change `ROOM_SIZE` and/or `DOOR_WIDTH` so `ROOM_SIZE - DOOR_WIDTH` is always even (guarantees exact centering, but `ROOM_SIZE` is already load-bearing across the whole dungeon layout/art system — e.g. ITEM-4's fixed 600×600px room art assumes `ROOM_SIZE = 6` — so this option needs a fuller impact check before committing to it).

**Non-goals.** Redesigning room/corridor sizing generally. Any change to `toPixels` or the Tile/Wall document builders — they are not the source of the bug and don't need touching.

#### Plan

**Chosen fix: candidate (a).** `ROOM_SIZE = 6` is load-bearing well beyond this file — ITEM-4's 33 room-art assets are baked at the exact 600×600px this constant implies, and a "make `ROOM_SIZE - DOOR_WIDTH` even" change (candidate b) would mean either resizing every existing room-art asset or widening the door to 2 grid squares (a real gameplay-visible change to what a doorway looks like, not just a coordinate fix). Flooring the door offset to the nearest integer grid unit is the minimal, correct fix: the door stays exactly `DOOR_WIDTH` (1) square wide and fully inside the room's face, just very slightly off perfect center (2 squares of wall above/left of the door, 3 below/right, instead of 2.5/2.5) — imperceptible at this scale, and exactly what the Spec already flagged as the lower-risk option.

**1. `scripts/dungeon-layout.mjs`.** In `buildConnectionGeometry`, both branches gain a `Math.floor`:
```js
// east/west branch
const doorY0 = gy + Math.floor((gh - DOOR_WIDTH) / 2);
// south branch
const doorX0 = gx + Math.floor((gw - DOOR_WIDTH) / 2);
```
Nothing else in the function changes — `doorY1`/`doorX1`, `corridorRect`, and every `plainWalls` segment are already derived from `doorY0`/`doorX0`, so they inherit the integer alignment automatically. `roomEnclosureWalls` and `slotRect` don't touch door positioning at all and need no change.

**2. `tests/dungeon-layout.test.mjs`.** The existing "places an east-facing door on the room's east edge, centered" test asserts the door's midpoint exactly equals the room's geometric midpoint (`toBeCloseTo`, effectively exact) — true today only because the fractional `2.5` happened to average out perfectly; it will legitimately fail once the offset floors to `2`. Replace that exact-center assertion with what actually matters: the door sits fully inside the room's face and lands on integer coordinates. New/updated assertions:
- `doorY0`/`doorX0` (and therefore `doorWall`'s and `corridorRect`'s coordinates) are integers, for every slot in a multi-row dungeon — the actual bug being fixed, so this is the one existing test-file gap that let it ship unnoticed.
- The door remains within `[gy, gy + gh - DOOR_WIDTH]` (or the `gx` equivalent) — still fully inside the room's face, never spilling past a corner.
- Keep a "close to center" check but with a tolerance of `DOOR_WIDTH` grid units rather than exact equality, so it still catches a wildly-off-center regression without re-baking in the exact fractional value that was the bug.

**Tests.** `npm test` — every existing `dungeon-layout.test.mjs`/`dungeon-deck.test.mjs` case re-run (this touches shared, heavily-depended-on geometry, per the Spec's own scope note), plus the new integer-coordinate assertions.

**Verification.** `npm test` — 530 passing, 2 new in `dungeon-layout.test.mjs` (the exact-center assertion loosened to a `DOOR_WIDTH` tolerance, plus new integer-coordinate and within-bounds checks across every slot in a two-row dungeon). `npm run validate`/`validate:dungeon`/`validate:creature-art` unaffected. Confirmed directly (pure function, no Foundry needed): `buildConnectionGeometry(0)` (east) now returns `doorWall {x1:6,y1:2,x2:6,y2:3}`, `corridorRect {gx:6,gy:2,gw:1,gh:1}`; `buildConnectionGeometry(4)` (the row-wrap, south) returns `doorWall {x1:30,y1:6,x2:31,y2:6}`, `corridorRect {gx:30,gy:6,gw:1,gh:1}` — every value an integer, where the east one previously carried a `.5`. A live spot-check (build a fresh dungeon room in the test world once this ships) is still worth doing to visually confirm the door now sits flush on a grid line, matching the screenshot that reported this.


### ITEM-6: Wire combat encounters into Foundry's encounter tracker
**State:** done
**Blocked:** false
**Summary:** Combat encounters currently bypass Foundry's Combat tracker entirely; spawned combat actors should be flagged as combatants, a real Combat encounter created, all combatants must roll initiative, and combat must proceed through the tracker. XP and loot rewards should be granted when the encounter ends (not before), and players must be blocked from advancing deeper into the dungeon until the combat is completed.

#### Spec

**Problem.** Combat-kind dungeon rooms spawn monster tokens, but nothing else ties them into PF2e's actual combat rules: there's no `Combat` encounter, no initiative order, no per-creature defeated tracking — the GM manually clicks "Mark Succeeded"/"Mark Failed" (`dungeon-tracker.hbs`) whenever they judge the fight over, entirely independent of what's actually happening on the table. There's also no reward mechanism at all: the "Treasure" reward/ruin outcome (`dungeon-deck.mjs`'s `OUTCOME_SLOT_TEMPLATES`) is pure flavor text (`DOMMT.Dungeon.Effect.treasure`) with no `grantItems`/`addCoins` call behind it, and no XP is ever granted for combat — even though the roster already carries the exact per-creature level data (`roster.foes[].level` etc.) needed to compute it, since `encounter-roster.mjs`'s `RELATIVE_XP`/`xpFor` already exists for the "approximate severity" readout.

**Goal.** Turn a combat room's encounter into a real, trackable PF2e Combat: combatants added and flagged, initiative rolled, the fight actually plays out in Foundry's own Combat Tracker. Room outcome (succeeded/failed) is derived from that Combat's actual resolution rather than a bare manual click. The party can't advance through the next room's door while combat is active. When combat resolves in the party's favor, real XP and loot are granted — not just a narrative chat line.

**Scope.** Combat (`kind === 'combat'`) dungeon rooms only. Non-combat rooms (`skill_challenge`, `puzzle_or_trap`, `narrative`) keep today's manual Mark Succeeded/Failed flow entirely unchanged — there's no PF2e Combat construct to hang those on. The standalone "DOMMT: Generate Encounter" macro also gets a real Combat created for whatever it spawns (a natural, low-cost extension of the same mechanism, useful on its own outside a dungeon run too) — but "blocking further progress" obviously doesn't apply there, since there's no "next room" concept.

**Mechanism.**
1. **Combat creation.** As soon as a combat room's tokens become visible to the party — room 0's immediate spawn (`hidden:false`), or `revealSlotTokens` on room entry for every room after — create a `Combat` document on the scene, add every spawned encounter token (foes/friend/lurker/twins) *and* every party token as Combatants, flagged with which dungeon room/slot they belong to (same `{[MODULE_ID]: {dungeonSlot}}` convention `spawnCreatures`/tokens already use). Foundry's own token disposition (already set correctly today: `-1` hostile for foes/lurker/twins, `+1` friendly for friend/party) is reused as-is to tell hostile combatants from the party's side — no new bookkeeping needed for that distinction. Roll initiative for everyone and start the Combat.
2. **Blocking progress.** The dungeon tracker's Succeed/Fail buttons (and the "Populate Next Room"/door-unlock flow that follows them) are gated off for a combat room whose linked Combat exists and hasn't ended yet — the party cannot advance until that Combat resolves. Rooms without a linked Combat are entirely unaffected.
3. **Resolution.**
   - **Victory (automatic):** once every hostile-disposition combatant is defeated (`Combatant#isDefeated`, confirmed to exist in this system), the Combat is treated as won — end it, resolve the room as succeeded through the same `markRoomOutcome` path used today, and grant rewards (below).
   - **Defeat:** either automatic (every party-member combatant defeated — a TPK) or a manual GM escape hatch (an explicit "End Combat" tracker action, for retreat/negotiation/any other real-play ending that isn't a clean sweep) — both resolve the room as failed through the same `markRoomOutcome` path.
   - Either way, the linked Combat is ended/deleted and the room's succeeded/failed resolution proceeds exactly as it does today from that point on (outcome slot, mutation, next room build/door unlock) — this item only changes *what decides* succeeded/failed for a combat room, not what happens afterward.
4. **Rewards, granted only on victory, only now (never before the fight, never on defeat):**
   - **XP:** sum `xpFor(levelOffset)` (the same GM Core relative-XP table already used for the severity readout) across every hostile combatant actually defeated, split evenly and added to each surviving party member's `system.details.xp.value` (confirmed live: a plain, directly-updatable number, e.g. `{value:0, min:0, max:1000, pct:0}`).
   - **Loot:** a real item/coin grant (reusing the existing `api.grantItems`/`api.addCoins` primitives the card system's own treasure handlers already use) into the Party actor's shared inventory (`game.actors.party`, confirmed live to have a working `inventory`) rather than an individual character — avoids "who holds the loot" bookkeeping. Exact loot table/generosity is a planning-time call.
   - The room's existing reward/ruin flavor text (`DOMMT.Dungeon.Effect.treasure` etc.) stays as the chat narration; this item makes "Treasure" (and a combat win generally) actually hand something over instead of just saying so.

**Non-goals.** Changing anything about non-combat room resolution. A full PF2e "Reward XP" UI/tool (using whatever built-in party-sheet tooling the system may offer) instead of a direct XP-field update — start with the direct, scriptable approach; revisit only if it turns out to fight the system's own UI. Retroactively granting rewards for rooms already resolved before this ships. Loot *table* design (what specific items get granted) — this item wires the *mechanism*, not a content pass.

**Deferred to planning (needs live Foundry access to exercise the exact API shapes).** Already confirmed live: `Combatant#isDefeated` exists as a getter, PF2e's `Combat#endCombat()` exists, `game.actors.party` has a working `inventory`, and `system.details.xp.value` is a plain updatable number. Still needed before locking the Plan: the precise `Combat.create`/`createEmbeddedDocuments('Combatant', ...)` payload shape built from existing scene tokens, how `combat.rollAll()` behaves and whether it needs a per-combatant fallback, and how the Combat Tracker UI actually reflects a scripted combat start/end (so the GM sees a normal-looking encounter, not something visibly hacked-together).

#### Plan

**Live research findings (all confirmed against the real PF2ETest world, scratch scene, cleaned up after).**
- `Combat.create({ scene: sceneId })` then `combat.createEmbeddedDocuments('Combatant', [{ tokenId, sceneId }, ...])` is all that's needed — Foundry derives `actorId`/`name`/`img` from the token automatically.
- **`combat.rollAll()` and even a bare `combat.rollInitiative([id])` hang indefinitely** (relay 502s waiting) — confirmed by inspecting PF2e's own `Combat#rollInitiative` source: it routes through `actor.initiative.roll({...options, combatant, ...})`, PF2e's normal Statistic-roll pipeline, which opens an interactive check dialog by default. **The fix, confirmed working live: `combat.rollInitiative(ids, { skipDialog: true })`** — rolls and commits initiative for every id with no dialog, no hang.
- **`combat.endCombat()` also hangs** — it opens an "End Encounter?" confirmation dialog (confirmed live by finding that exact window open after the hang). The correct scripted equivalent is **`combat.delete()`** directly — confirmed live: clean, instant, no dialog.
- `Combatant#isDefeated` is `this.defeated || actor.statuses.has(CONFIG.specialStatusEffects.DEFEATED)` (`DEFEATED` resolves to `'dead'` in this system) — confirmed live both that a plain `combatant.update({ defeated: true })` (the GM's own skull-icon toggle) flips it, and that this is the same getter the system itself relies on, so it also picks up an actor's own `'dead'` status automatically with no extra wiring.
- `combatant.token.disposition` reliably distinguishes hostile (`-1`) from party (`+1`) combatants — matches the disposition already set correctly by today's `spawnCreatures`/`placePartyInSlot`, no new bookkeeping needed.
- `game.actors.party.system.details.xp` doesn't exist — XP lives per-character (`actor.system.details.xp.value`, confirmed a plain `{value, min, max, pct}` object on a real party member); the Party actor's own `inventory` (confirmed present) is the right place for shared loot instead.

**Refinement of the spec.** The Spec's "automatic victory / automatic-or-manual defeat" asymmetry turned out to have no real justification once the mechanism was designed — both directions need a human-override escape hatch for messy real play (a GM might declare victory on a fled-not-dead remnant, or defeat on a costly retreat). The Plan makes both directions symmetric: automatic detection for the clean case (every hostile down → victory, every party member down → defeat) *and* two manual GM buttons ("Declare Victory" / "Declare Defeat") always available while a combat room's Combat is active, both funneling into the exact same resolution path.

**1. New `scripts/combat-rewards.mjs`** — pure, no Foundry deps (model: `dungeon-deck.mjs`):
```js
import { xpFor } from './encounter-roster.mjs'; // newly exported, see below

export function totalCombatXp(defeatedHostileLevels, partyLevel) {
  return defeatedHostileLevels.reduce((sum, level) => sum + xpFor(level - partyLevel), 0);
}

export function xpPerSurvivor(totalXp, partySize) {
  return partySize > 0 ? Math.floor(totalXp / partySize) : 0;
}

// Placeholder heuristic, not a real treasure table — see the Spec's non-goals.
// Roughly "loot scales with the XP just earned", nothing fancier than that.
export const LOOT_GP_PER_XP = 1;
export function lootGpForXp(totalXp) {
  return totalXp * LOOT_GP_PER_XP;
}
```

**2. `scripts/encounter-roster.mjs`** — export the already-existing `xpFor` (currently module-private); no behavior change, purely an added export.

**3. New `scripts/dungeon-combat.mjs`** — Foundry-touching Combat orchestration (model: `dungeon-scene.mjs`; no unit tests, live-verify only, same as that file):
```js
const MODULE_ID = 'deck-of-many-more-things';

/** Every token on `scene` carrying `flagKey === flagValue`, plus every current party token. */
function combatantTokens(scene, flagKey, flagValue) {
  const monsterTokens = scene.tokens.filter((t) => t.getFlag(MODULE_ID, flagKey) === flagValue);
  const partyIds = new Set((game.actors?.party?.members ?? []).map((m) => m.id));
  const partyTokens = scene.tokens.filter((t) => partyIds.has(t.actor?.id));
  return [...monsterTokens, ...partyTokens];
}

async function startCombat(scene, flagKey, flagValue) {
  const tokens = combatantTokens(scene, flagKey, flagValue);
  if (!tokens.length) return null;
  const combat = await Combat.create({ scene: scene.id });
  await combat.setFlag(MODULE_ID, flagKey, flagValue);
  const combatants = await combat.createEmbeddedDocuments(
    'Combatant', tokens.map((t) => ({ tokenId: t.id, sceneId: scene.id }))
  );
  await combat.rollInitiative(combatants.map((c) => c.id), { skipDialog: true });
  await combat.startCombat();
  return combat;
}

export const startCombatForSlot = (scene, slot) => startCombat(scene, 'dungeonSlot', slot);
export const startCombatForEncounterId = (scene, encounterId) => startCombat(scene, 'encounterId', encounterId);

export function getCombatForSlot(scene, slot) {
  return game.combats.find((c) => c.scene?.id === scene.id && c.getFlag(MODULE_ID, 'dungeonSlot') === slot) ?? null;
}

/** { hostilesDefeated, partyDefeated } — false/false while the fight's still going. */
export function combatSideStatus(combat) {
  const groups = { hostile: [], party: [] };
  for (const c of combat.combatants) (c.token?.disposition === -1 ? groups.hostile : groups.party).push(c);
  return {
    hostilesDefeated: groups.hostile.length > 0 && groups.hostile.every((c) => c.isDefeated),
    partyDefeated: groups.party.length > 0 && groups.party.every((c) => c.isDefeated)
  };
}

/** Grants XP/loot on victory, then deletes the Combat either way. */
async function resolveCombat(combat, outcome, api) {
  if (outcome === 'victory') {
    const hostileLevels = combat.combatants
      .filter((c) => c.token?.disposition === -1)
      .map((c) => c.actor?.system?.details?.level?.value ?? 0);
    const partyLevel = await api.partyLevel();
    const totalXp = totalCombatXp(hostileLevels, partyLevel);
    const party = (game.actors?.party?.members ?? []).filter((m) => m.type === 'character');
    const share = xpPerSurvivor(totalXp, party.length);
    for (const member of party) {
      await member.update({ 'system.details.xp.value': (member.system.details.xp.value ?? 0) + share });
    }
    if (game.actors.party) await api.addCoins(game.actors.party.id, { gp: lootGpForXp(totalXp) });
  }
  await combat.delete();
}

/** Shared by both the automatic hooks and the manual GM buttons. */
export async function resolveSlotCombat(scene, slot, outcome, api) {
  const combat = getCombatForSlot(scene, slot);
  if (!combat) return;
  await resolveCombat(combat, outcome, api);
}

async function autoResolveIfDecided(combat) {
  if (!game.user.isGM || !game.combats.has(combat.id)) return; // already resolved by another update
  const { hostilesDefeated, partyDefeated } = combatSideStatus(combat);
  if (!hostilesDefeated && !partyDefeated) return;
  const outcome = hostilesDefeated ? 'victory' : 'defeat';
  const api = makeFoundryApi();
  const dungeonSlot = combat.getFlag(MODULE_ID, 'dungeonSlot');
  await resolveCombat(combat, outcome, api);
  if (dungeonSlot != null) await resolveCurrentRoom(outcome === 'victory', { scene: combat.scene });
}

function isModuleCombat(c) {
  return c.getFlag(MODULE_ID, 'dungeonSlot') != null || c.getFlag(MODULE_ID, 'encounterId') != null;
}

export function onActorUpdatedForCombat(actor) {
  const combat = game.combats.find((c) => isModuleCombat(c) && c.combatants.some((cb) => cb.actorId === actor.id));
  if (combat) autoResolveIfDecided(combat);
}

export function onCombatantUpdatedForCombat(combatant, changes) {
  if (!('defeated' in changes)) return;
  const combat = combatant.parent;
  if (combat && isModuleCombat(combat)) {
    autoResolveIfDecided(combat);
  }
}
```
(`makeFoundryApi`/`resolveCurrentRoom`/`totalCombatXp`/`xpPerSurvivor`/`lootGpForXp` imported at the top from their real homes — omitted above for length.)

**4. `scripts/encounter-generator.mjs`.** `generateEncounter` generates a fresh `encounterId` (same `freshSeed()`-style helper already in this file) and merges it into every spawned token's flags alongside whatever `extraFlags` the caller passed (dungeon rooms already pass their own `dungeonSlot` via `extraFlags` — both flags coexist on the same tokens, no conflict). At the very end, **only when `!originArea`** (the existing, already-present signal that this call is the standalone macro, not a dungeon-room population — dungeon rooms always pass `originArea`, the standalone macro never does): `await startCombatForEncounterId(canvas.scene, encounterId)`. Dungeon rooms get their own combat-start call elsewhere (next), deliberately deferred past `generateEncounter` returning, since dungeon monsters spawn hidden and combat must wait for the room's actual reveal — starting it here would leak the fight's existence the moment the room is merely *built*, not yet entered.

**5. `scripts/dungeon-scene.mjs`.**
- `handleDungeonRoomEnter`: after `revealSlotTokens(scene, slot)`, look up the room's `kind` (`state.rooms.find(r => r.id === nextRoomId)`) and, if `'combat'`, `await startCombatForSlot(scene, slot)` — before `advanceToRoom`, so the fight is live the instant the room becomes current.

**6. `scripts/ui/dungeon-app.mjs`.**
- `#onStart`: inside the existing `if (room0.kind === 'combat')` block, right after `populateSlotEncounter(scene, 0, { hidden: false, ... })`, add `await startCombatForSlot(scene, 0)` — room 0 has no reveal step, so combat starts immediately, matching how its encounter already spawns visible.
- `resolveCurrentRoom` (currently a private module-level function) gains an optional second parameter and is exported: `export async function resolveCurrentRoom(succeeded, { scene = canvas?.scene } = {})` — every internal use of `canvas?.scene` inside it becomes `scene`. Existing call sites (`#onSucceed`/`#onFail`) are unaffected (no args needed, same default). The new hook-driven auto-resolution path (`dungeon-combat.mjs`) calls it with an explicit `{ scene: combat.scene }`, since a hook can fire while the GM is looking at a different scene entirely.
- `_prepareContext`: for a combat-kind `currentRoom`, look up `getCombatForSlot(scene, currentSlot)` and add `combatActive: !!combat` to the context (and, defensively, `combatMissing: room.kind==='combat' && !combat && currentSlot != null` for the same "something got interrupted" recovery case `#onPopulateNext` already exists for).
- New static actions: `#onDeclareVictory` / `#onDeclareDefeat` → `resolveSlotCombat(scene, currentSlot, 'victory'|'defeat', makeFoundryApi())` → `resolveCurrentRoom(outcome === 'victory')` → `this.render()`. `#onStartCombatRecovery` → `startCombatForSlot(scene, currentSlot)` → `this.render()`. `#onOpenCombatTracker` → `ui.sidebar.activateTab('combat')`.

**7. `templates/dungeon-tracker.hbs`.** The existing Succeed/Fail footer (inside `{{#unless currentRoomResolved}}`) becomes conditional: when `currentRoom.kind === 'combat'`, show combat-mode UI instead — a hint plus "Open Combat Tracker" (`data-action="openCombatTracker"`) and "Declare Victory"/"Declare Defeat" (`combatActive`), or a "Start Combat" recovery button (`combatMissing`). Every other room kind keeps today's plain Succeed/Fail buttons untouched.

**8. `scripts/module.mjs`.** Register `Hooks.on('updateActor', onActorUpdatedForCombat)` and `Hooks.on('updateCombatant', onCombatantUpdatedForCombat)`, imported from `dungeon-combat.mjs` — same style as the existing `Hooks.on('renderChatMessageHTML', bindPendingDrawButton)`.

**9. `lang/en.json`.** New `DOMMT.Dungeon.Combat*` keys: `InProgressHint`, `OpenTrackerButton`, `DeclareVictoryButton`, `DeclareDefeatButton`, `StartCombatButton`.

**Known limitation, not blocking this item.** A still-hidden lurker (revealed by whatever separate mechanic reveals it) isn't a combatant at combat-start time and isn't retroactively added — pre-existing lurker-reveal behavior is untouched by this item, and a lurker ambushing mid-fight without formally joining the Combat is a real but pre-existing gap, not a regression. Worth a follow-up note if it turns out to matter in play.

**Tests.**
- `tests/combat-rewards.test.mjs` (new, pure): `totalCombatXp` sums `xpFor(level - partyLevel)` correctly across several hostile levels; `xpPerSurvivor` divides/floors correctly including a zero-party-size guard; `lootGpForXp` follows the documented placeholder multiplier.
- `dungeon-combat.mjs` itself gets no unit tests — entirely Foundry/Combat-API-touching, same precedent as `dungeon-scene.mjs` (live-verify only).
- Existing `tests/dungeon-runner.test.mjs`/`encounter-roster.test.mjs` untouched; `resolveCurrentRoom`'s signature change is additive (default parameter), so no existing call site needs updating.

**Verification.** `npm test` — 528 passing, 8 new (`tests/combat-rewards.test.mjs`). `npm run validate`/`validate:dungeon`/`validate:creature-art` unaffected.

**Implementation note — the hook handlers ended up returning data, not calling `resolveCurrentRoom` directly.** Writing `dungeon-combat.mjs` surfaced a real import cycle the code sketch above glossed over: `dungeon-scene.mjs` needs `startCombatForSlot` from `dungeon-combat.mjs`, and the sketch had `dungeon-combat.mjs` calling back into `resolveCurrentRoom` (which lives in `ui/dungeon-app.mjs`, itself importing from `dungeon-scene.mjs`) — a genuine cycle. Fixed by keeping `dungeon-combat.mjs` fully one-directional: its hook targets (renamed `maybeResolveCombatForActor`/`maybeResolveCombatForCombatant`) resolve the Combat (rewards + delete) and return `{ outcome, dungeonSlot, scene } | null` rather than advancing the room themselves. `module.mjs` — the composition root that already imports from every file in this chain — registers both hooks itself and calls `resolveCurrentRoom` when a result carries a `dungeonSlot`. Every other part of the Plan (the API sequence, the reward math, the manual GM buttons, the template gating) shipped exactly as designed.

**Live end-to-end verification**, via `foundry-rest` in a scratch scene (created and torn down within the script): built a real Combat from a level-1 Imp (hostile) and the live world's actual Cleric party member (party) using the exact shipped sequence — `Combat.create` → `setFlag` → `createEmbeddedDocuments('Combatant', ...)` → `rollInitiative(ids, {skipDialog:true})` → `startCombat()` — confirmed `started:true`, 2 combatants, no hang. Marked the hostile `defeated:true`, confirmed `isDefeated` flips and `combatSideStatus` correctly reports `hostilesDefeated:true`. Ran the exact reward math live: level 1 vs level 1 → `xpFor(0) = 40` XP, granted to the Cleric's `system.details.xp.value` and confirmed landing (then reverted, leaving no lasting mark on the real party actor). `combat.delete()` confirmed clean, no dialog, no trace left in `game.combats`. Not yet exercised: the actual UI wiring (tracker buttons, template gating, the automatic-trigger hooks) — the deployed world is still on the pre-ITEM-6 module version, so that needs a live pass once this merges and updates, the same deployment-model caveat every prior item has hit.


### ITEM-2: Generated art for encounter opponents
**State:** done
**Blocked:** false
**Summary:** Auto-generate token art (via the existing ComfyUI pipeline) for creatures spawned by the encounter generator — many bestiary entries, especially SRD ones, ship with no token art at all.

#### Spec

**Problem.** The `pf2e-data` skill's own documented finding — "SRD bestiaries ship no token art" — is already why the Dragon/Ooze/Monstrosity card handlers each needed an `imgFallback`. The encounter generator has no equivalent: `encounter-generator.mjs`'s `spawnEncounterTokens` calls `api.spawnCreatures(entries, {...place(...), disposition})` with no `img`/`imgFallback` at all. Since `pickCreature` (`encounter-roster.mjs`) prefers `MONSTER_CORE_PACKS` first, and Monster Core is exactly the pack family the `pf2e-data` skill flags as art-sparse, most creatures a generated encounter actually spawns likely render as Foundry's blank default silhouette today. This is a real, visible gap — not a handful of edge cases.

**Goal.** Generate real per-creature token art for a **prioritized subset** of the bestiary, not an exhaustive pass — starting with the creatures a level 1 party is most likely to actually be shown by this module's own encounter generator, per the user's explicit prioritization: most frequently encountered first, starting at what a level 1 party faces.

**Prioritization methodology (resolves "frequency" concretely, not by guessing at "iconic monsters" from memory).** Three filters, all directly computable against the live bestiary, all already load-bearing concepts elsewhere in this codebase:
1. **Level band**: `CREATURE_SLOT_TEMPLATES` (`encounter-deck.mjs`) draws `levelOffset`s from -2 to +2, heavily weighted toward -1/0/+1 — so for a level 1 party (± `LEVEL_TOLERANCE`), the realistic common band is roughly creature level -2 to +2, weighted toward the low end. This is the *same* band the generator itself actually queries, not an invented threshold.
2. **Pack**: Monster Core first (`MONSTER_CORE_PACKS`), matching `pickCreature`'s own preference order — these are the creatures a generated encounter reaches for before ever falling back to the wider bestiary.
3. **"Frequently encountered" = eligible in the most draws**: within that level band, a creature that satisfies more of the 8 `locationTag`s (`LOCATION_TAGS`, from ITEM-1) is eligible for more of the encounter generator's actual queries (both the standalone macro's free-text `traits` and every dungeon room's `requireTrait` restriction) than one that only matches a single niche trait — so trait-breadth within the level band is a real, computable proxy for draw frequency, not a subjective ranking.
4. Exclude `troop`/`swarm` (`MANDATORY_EXCLUDE`, already enforced everywhere else) and anything that already has real art (`isDefaultArt`, the same check `spawnCreatures` already uses for `imgFallback`) — the actual gap being closed.

**Mechanism.**
- New `data/creature-art.json` (+ schema + validator, same trio pattern as `cards.json`/`dungeon-setpieces.json`): each entry `{ id, pack, docId, name, level, art }` — `pack`+`docId` is the precise lookup key, matching `resolveEncounterRoster`'s own `{pack, id}` output exactly; `name`/`level` kept for human readability and schema cross-checks, not used at lookup time.
- `foundry-api.mjs`'s `spawnCreatures` currently accepts only one call-level `img`/`imgFallback` for a whole `entries` array — real limitation here, since one `foes` call can contain several *different* creatures needing *different* art. Needs a small additive change: each `entries[]` item gains an optional `imgFallback` (and/or `img`) that overrides the call-level default for that one entry — backward compatible, every existing caller (Dragon/Ooze/Monstrosity, the encounter generator itself) is unaffected since none currently sets a per-entry image.
- New small lookup (pure, keyed off the loaded `creature-art.json`): given `{pack, id}`, return the art path or `null`. `encounter-generator.mjs`'s `spawnEncounterTokens` calls it for every foe/friend/twin/lurker entry and attaches the result as that entry's `imgFallback`.
- Art style matches the existing `assets/tokens/*.webp` convention already established in this module (dragon/ooze/monstrosity/warrior-by-ancestry images) — confirm the exact visual language against one of those at plan time before generating anything new.
- Grows incrementally over time, same pattern as `dungeon-setpieces.json`'s 2-complete-plus-3-stub start — this pass covers a first batch (default proposal: 15-20 creatures, comparable in scope to ITEM-4's 33 images), not the whole bestiary.

**Non-goals.** Covering the entire installed bestiary in one pass. Live-generating art on demand at encounter time (pregenerated only, matching ITEM-4's precedent). Changing `pickCreature`'s selection logic itself — this only affects what a *chosen* creature looks like once spawned, never which creature gets chosen.

**Deferred to planning (needs the Foundry world back online).** The actual query — level -2..+2, Monster Core, art-missing, ranked by `locationTag` breadth — needs to run live to produce the real candidate list; nothing here should be treated as that list. Final batch size is a call to make once the query shows how many genuinely common, art-missing creatures exist in that band.

#### Plan

**Live query results** (both Monster Core packs, `foundry-rest` against the running world, level -2..+2, `troop`/`swarm` excluded, default/missing art only): 238 candidates total. Distribution by `locationTag` match count: 2 tags — 2 creatures (`Soulrider (Fiend)`, `Spawning Soulrider (Fiend)`, both `fiend`+`aberration`); 1 tag — 85 creatures; 0 tags — 151 (excluded — a creature matching none of the 8 tags is never reachable by a dungeon room's `requireTrait` restriction, only by the standalone macro's free-text theme, which is a weaker frequency signal). Per-tag candidate counts among the 1-and-2-tag group: construct 19, aberration 17, fiend 16, elemental 13, undead 12, beast 6, plant 3, dragon 3 — `plant`/`dragon`/`beast` are the scarcest, so the batch deliberately keeps at least 2 per tag rather than letting the naturally construct/aberration/fiend-heavy ranking crowd them out entirely.

**Batch (20 creatures, all Monster Core, level -1 to 2, every one of the 8 `LOCATION_TAGS` covered by 2–3 creatures):**

| name | pack | docId | level | tags |
|---|---|---|---|---|
| Soulrider (Fiend) | monster-core-2 | `sMemLmJWM0g0FxbZ` | -1 | fiend, aberration |
| Spawning Soulrider (Fiend) | monster-core-2 | `8O1z1xSgpykJEUBI` | 1 | fiend, aberration |
| Homunculus | monster-core | `9wNjq9BirBoxyJVH` | 0 | construct |
| Animated Armor | monster-core | `CFlx1tkRxKC9qAC7` | 2 | construct |
| Clockwork Spy | monster-core-2 | `9Uc7T3x3cxNo7lvY` | -1 | construct |
| Wolf Skeleton | monster-core-2 | `MTEuAbMboUe33rw1` | 0 | undead |
| Ghoul Stalker | monster-core | `iLkQt8A99nQWUI8k` | 1 | undead |
| Draugr | monster-core-2 | `lCDygpomjUnutb5b` | 2 | undead |
| Fire Wisp | monster-core-2 | `micllXbcz1eBcAoz` | 0 | elemental |
| Icicle Snake | monster-core-2 | `6sYj9SQRzKywNDOJ` | 2 | elemental |
| Grindylow | monster-core | `sC4B1pjGrKFXhjOQ` | 0 | aberration |
| Reefclaw | monster-core | `Rr1u6WvZEdPw1s6v` | 1 | aberration |
| Imp | monster-core | `yPYQC2bfOYmqcfIB` | 1 | fiend |
| Ort | monster-core | `kohQQtOfhwxbzWZB` | 0 | fiend |
| Leaf Leshy | monster-core | `v1UK3IwCB8wCbL3L` | 0 | plant |
| Sprigjack | monster-core | `TElwkEGZy1zgwoVg` | -1 | plant |
| Carbuncle | monster-core-2 | `hXWykGzjb5RLkJvZ` | 1 | beast |
| Kappa | monster-core-2 | `hoqQ2x6x1tffC6wX` | 2 | beast |
| House Drake | monster-core-2 | `Zh8awPHA7DZxTboc` | 1 | dragon |
| Fey Dragonet | monster-core | `QIXc18xHrEWDmtKW` | 2 | dragon |

`pack` in the table is short for readability; the actual data uses the full collection id (`pf2e.pathfinder-monster-core` / `pf2e.pathfinder-monster-core-2`), matching `resolveEncounterRoster`'s own `pack` field exactly.

**Reuse, not regenerate.** `assets/tokens/homunculus.webp` (existing, used by `card-handlers-extra.mjs`'s Homunculus card) is visually the same creature as the bestiary's Monster Core `Homunculus` entry above — reused as-is rather than generating a near-duplicate. **19 new images generated**, 1 reused.

**1. `data/creature-art.json` + `data/schema/creature-art.schema.json` + `tools/validate-creature-art.mjs`** — same trio pattern as `dungeon-setpieces.json`. Schema: array of `{ id, pack, docId, name, level, art }`, `additionalProperties: false`, `id` a slug (`^[a-z][a-z0-9_]*$`), `pack` one of the two Monster Core collection ids, `docId` non-empty string, `level` integer, `art` non-empty string (a bare filename under `assets/creature-art/`, e.g. `"imp.webp"` — not a full module path, matching how `dungeon-scene.mjs`'s `ROOM_ART_DIR` constant builds the full path rather than baking `modules/${MODULE_ID}/...` into the data file). Validator checks schema, duplicate `id`s, and duplicate `{pack, docId}` pairs (the actual lookup key — two entries for the same creature would be a silent bug at lookup time, worse than a duplicate `id`). `package.json` gains `"validate:creature-art": "node tools/validate-creature-art.mjs"`.

**2. New `scripts/creature-art.mjs`** — pure, no Foundry deps (model: `dungeon-deck.mjs`):
```js
const ART_DIR = 'creature-art';
export function findCreatureArt(list, { pack, id }) {
  const entry = list.find((e) => e.pack === pack && e.docId === id);
  return entry ? entry.art : null;
}
export function creatureArtPath(filename) {
  return `${ART_DIR}/${filename}`;
}
```
`creatureArtPath` is a plain string join, kept separate from the Foundry-touching `modules/${MODULE_ID}/...` prefix the same way `roomArtPath`'s directory constant is separated from `MODULE_ID` in `dungeon-scene.mjs` — the prefix is added once, at the actual `fetch`/asset-reference boundary.

**3. `scripts/data-loader.mjs`** — add `CREATURE_ART_CACHE` + `loadCreatureArt()` (fetches `data/creature-art.json`, same shape as `loadDungeonSetpieces`), included in `invalidateCaches()`.

**4. `scripts/foundry-api.mjs`'s `spawnCreatures`** — per-entry override, additive:
```js
const entryImg = entry.img ?? img;
const entryImgFallback = entry.imgFallback ?? imgFallback;
const art = entryImg ?? (bare ? entryImgFallback : null);
```
(replacing the current `const art = img ?? (bare ? imgFallback : null);`). Every existing caller passes plain `{pack, id}`/`{actorId}` entries with no `img`/`imgFallback` field, so `entryImg`/`entryImgFallback` fall through to the call-level values unchanged — this is a strict widening, not a behavior change, for every caller that doesn't opt in.

**5. `scripts/encounter-generator.mjs`** — `generateEncounter` calls `loadCreatureArt()` once (alongside its existing setup, before building the deck) and passes the result to `spawnEncounterTokens`, which builds a small helper `withArt = (e) => ({ ...e, imgFallback: findCreatureArt(creatureArt, e) })` and maps it over every `entries` array right before each `api.spawnCreatures(...)` call (foes, friend, twins, lurker) — four one-line additions, no change to the roster-building logic above them.

**6. Assets.** `assets/creature-art/<slug>.webp` for the 19 new creatures (slug = lowercase, hyphenated name — `imp.webp`, `wolf-skeleton.webp`, `soulrider-fiend.webp`, etc.), generated via the existing ComfyUI pipeline, matching the established `assets/tokens/*.webp` visual language (portrait-style single-creature token art, not a top-down map tile like ITEM-4's room art) — confirmed against `assets/tokens/imp`-adjacent existing art (dragon/ooze/monstrosity) before generating the batch. Each reviewed individually before acceptance, same discipline as ITEM-4's 33-image batch (that pass needed 3 redos after visual review; budget for the same here rather than treating generation as one-shot).

**Tests:**
- `tests/creature-art.test.mjs` (new): `findCreatureArt` — matches on `{pack, docId}` exactly (not `id` alone, not a partial match), returns `null` for no match; `creatureArtPath` — plain join.
- Schema/validator exercised via `npm run validate:creature-art` (added to whatever aggregate `npm run validate` script, if any, chains the others — check `package.json` at implementation time; `validate`/`validate:dungeon` are currently separate scripts, not chained, so this likely stays a third standalone script rather than assuming a combined one exists).
- `tests/foundry-api.test.mjs` (existing, if present — otherwise inline in whatever currently covers `spawnCreatures`): per-entry `img`/`imgFallback` overrides a call-level default; a call-level default still applies when an entry sets neither.
- `tests/encounter-generator.test.mjs`/`encounter-roster.test.mjs` (existing): `spawnEncounterTokens` attaches the right `imgFallback` per entry from a stub creature-art list, and passes `null` through untouched for a creature not in the list (today's exact behavior, preserved for anything outside the batch).

**Verification.** `npm test` — 512 passing, 21 new (`tests/creature-art.test.mjs`'s `findCreatureArt`/`creatureArtPath` suite, `tests/creature-art-assets.test.mjs`'s exhaustive asset-existence check across all 20 entries — Homunculus included, since it's now a copy of `assets/tokens/homunculus.webp` under `assets/creature-art/` too, keeping the lookup path convention uniform rather than special-casing one entry). `npm run validate:creature-art` — 20 entries, no duplicate lookup keys. All 19 new images generated via the existing `tools/generate-token-art.mjs` pipeline (extended with a `MONSTER_ART` list rather than a bespoke generation path) and reviewed individually — 7 of 19 needed at least one redo: `ghoul-stalker` and an early `clockwork-spy` attempt both grew the pipeline's known circular-halo/roundel artifact; `grindylow` and `kappa` came back on a solid colored (green) background that the automated brightness-based checker doesn't catch (a real gap in `tools/check-token-art.mjs`, worth a future fix — colored, non-black backgrounds aren't currently flagged, only pale/bright ones); `sprigjack` first came back as a cluttered multi-pumpkin scene with a decorative vine border; `leaf-leshy` repeated the exact human-face-and-pale-background failure mode the leshy *warrior* entry above it already documents; `house-drake` first came back as a literal bird. Every fix is recorded as an explicit `avoid`/prompt change in `tools/generate-token-art.mjs`, not just a reroll, so the fix persists if these are ever regenerated. `tools/check-token-art.mjs` extended to also scan `assets/creature-art/`. Live-verified via `foundry-rest` in a scratch scene (created and deleted within the same script): built an Actor from the real Imp bestiary document with the same `img`/`prototypeToken.texture.src`/alliance overrides the updated `spawnCreatures` applies, confirmed the resulting actor and token both carry the new art path and correct hostile disposition, then deleted the scratch actor and scene. The deployed world installs the module from GitHub rather than mounting this working tree, so the actual image bytes aren't fetch-reachable in-world until this merges and the module updates — not a defect, the same deployment-model caveat ITEM-4 already hit; the live check therefore verifies the document mechanics, not pixel rendering.

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
