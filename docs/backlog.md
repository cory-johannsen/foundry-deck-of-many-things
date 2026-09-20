# Backlog

_Last updated: 2026-09-19 (ITEM-20 reopening resolved and done — leak does not reproduce live, padding:0 added; ITEM-17 done, ITEM-18 level -1 tier fully complete, ITEM-23 spec'd)_

## Active

### ITEM-23: Agent bridge for GM-less play — event-driven combat AI and dynamic puzzle generation
**State:** spec
**Blocked:** false
**Summary:** An external LLM agent should be able to stand in as the dungeon's GM — receiving pushed events for combat turns, room discovery, and puzzle/trap moments as they happen, and returning structured actions the module applies — so no human player has to be flagged GM (and thereby able to see hidden monster stats, DCs, and setpiece solutions that should stay hidden from players).

#### Spec

**Problem.** This module already runs entirely from Foundry `Hooks` inside whichever client is logged in as GM (`module.mjs`'s `updateWall`/`updateActor`/`updateCombatant`/`updateCombat`/`renderChatMessageHTML` registrations) — that client already has full visibility into hidden state (actor HP/traits, setpiece solutions, unrevealed room contents) by virtue of being flagged GM in Foundry, which is exactly why a *human* player can't safely run that client without spoiling the crawl for themselves. There's no way today to swap that human out for a non-human decision-maker: `foundryrestapi.com`'s relay (`foundry-rest` skill) is one-shot request/response only — it can run a script on demand, but nothing calls out *to* an external process when something happens, so an outside agent has no way to know a combat turn or a room discovery occurred without polling.

**What already exists that this builds on, not around.** ITEM-8 (`dungeon-combat.mjs`'s `autoPlayCombatantTurnIfDue`) already automates every non-player combatant's turn with a fixed heuristic (move toward nearest opponent, first ready strike, apply damage, advance turn) — proof this module can already act on a hidden combatant's behalf with no GM click. That heuristic is deliberately dumb (straight-line movement, no tactics, first strike only) and is the honest ceiling of what a hardcoded rule can do. ITEM-3 separately notes `data/dungeon-setpieces.json` is still "2 fully-transcribed puzzles + 3 stub traps," a fixed small pool with no way to tailor a puzzle to the actual party in front of it. Both gaps are instances of one underlying problem: some decisions in this crawl (how a boss actually fights, what puzzle fits this room and this party's skills) need judgment a fixed heuristic or a static content pool can't give, but do need to be made by something that can legitimately see hidden state.

**Goal.** A companion bridge, running inside the same GM-authorized client this module already runs from, that (a) pushes structured event envelopes to an external agent process the instant specific things happen, and (b) applies the agent's returned actions back through this module's own existing mutation helpers — never through arbitrary code the agent supplies. Scoped to the two concrete cases the user asked about:
1. **Advanced combat AI for higher-level/boss enemies** — an opt-in upgrade path over ITEM-8's heuristic, not a replacement for it. Ordinary trash mobs keep using the existing fixed heuristic (bounded cost/latency, no round-trip needed); only combatants flagged `flags.dommt.agentControlled` (set when a room/encounter is built above some level or role threshold — e.g. a named boss or a room's designated "twin"/leader) defer their `updateCombat`-triggered turn to the agent instead.
2. **Dynamic puzzle/trap generation** — when a non-combat room is revealed, instead of drawing from `dungeon-setpieces.json`'s fixed pool, the agent is given the room's terrain tags and the actual party's skills (`system.skills` per PF2e actor, readable exactly the way `pf2e-data` already documents) and returns a setpiece in the same shape `dungeon-deck.mjs` already consumes, so nothing downstream of setpiece selection needs to change.

**Architecture sketch.**
- **New file `scripts/agent-bridge.mjs`**, following this module's existing one-concern-per-file convention (`dungeon-combat.mjs`, `choice-routing.mjs`). Owns: building outbound event envelopes, the transport call, validating and applying inbound action envelopes.
- **Hook set (all in `module.mjs`, alongside the existing registrations):**
  - `Hooks.on('updateCombat', ...)` — already exists for ITEM-8; extended so that when the due combatant has `flags.dommt.agentControlled`, the bridge is called instead of `autoPlayCombatantTurnIfDue`.
  - `Hooks.on('createCombat', ...)` (new) — fires once per encounter, not per turn: hands the agent the full encounter context (party composition, terrain, hidden traits) up front so per-turn requests can stay small instead of re-sending static context every round.
  - `Hooks.on('updateWall', ...)` — already exists for door-reveal (`handleDungeonDoorOpened`); extended so a non-combat room's reveal also asks the bridge for a generated setpiece before falling back to `dungeon-setpieces.json`'s pool if the agent is unavailable or times out.
  - `Hooks.on('renderChatMessageHTML', ...)` — already exists for pending-draw buttons; reused as the place agent-authored narration/flavor text gets posted back to the chat log, and left as the natural future hook if the agent ever wants ambient visibility into chat (deliberately not wired for that yet — see Non-goals).
- **Transport.** The browser-side client can't spawn a subprocess, so the bridge talks over `fetch`/`WebSocket` (both already outside the `foundry-rest` relay's script-filter ban list, and this module's client scripts already use `fetch` for local module assets in `data-loader.mjs` — this would be the first time the *shipped* module, rather than a build-time tool, calls out to a non-bundled endpoint) to a small local relay process sitting between Foundry and the actual agent loop. Outbound envelope: `{type, dungeonRunId, slotId, payload}`. Inbound: `{type: 'combatAction' | 'puzzleSpec' | 'narration', ...}` — the bridge is the only thing that turns an inbound envelope into a real document mutation, and only via calls already used elsewhere in this module (`strike.roll()`/`applyDamage()`, `dungeon-deck.mjs`'s setpiece shape) — never `eval`, never a raw script handed to the relay. A malfunctioning or hallucinating agent can send a nonsensical envelope; it can't send code.
- **Fallback.** Every agent call needs a timeout and a fallback to the existing hardcoded behavior (ITEM-8's heuristic for combat, the static pool for setpieces) — an unreachable agent process degrades the crawl back to today's behavior rather than stalling a turn indefinitely.

**Non-goals.** Replacing ITEM-8's heuristic outright — it stays the default for anything not explicitly flagged `agentControlled`, both to bound API cost/latency and because most combatants don't need it. A general "agent can do anything" bridge — scoped to the two decision points above, not narration-on-every-message, not world/scene editing, not settings changes. Solving where the agent process itself runs, how it's authenticated, or its own model/cost tradeoffs — those are a separate operational decision once this bridge's shape is agreed, not part of this item. Removing the human GM's ability to run the crawl manually — this is an alternate path, not a replacement for the existing (already-working) GM-driven flow.

### ITEM-22: Sound effects for dungeon-crawl actions and outcomes
**State:** backlog
**Blocked:** false
**Summary:** Common dungeon-crawl events — doors (open/locked/unlock), attacks/strikes, a creature's death, trap triggers, and other frequent actions/outcomes — should have sound effects that play automatically when the triggering event happens, the same way card draws already do (`card-sound.mjs`/`audio.mjs`'s `playSound`).

### ITEM-18: Generate token art for the full core bestiary
**State:** in-progress
**Blocked:** false
**Depends-on:** ITEM-2
**Summary:** Extend ITEM-2's token-art batch from a 20-creature sample to full coverage of every art-missing NPC in the module's core bestiary packs (1,609 remaining), generated in priority order: lowest level first, and within a level, least-rare rarity first.

#### Spec

**Problem.** ITEM-2 shipped art for 20 creatures, deliberately described as "a first batch... not the whole bestiary" (its own non-goal: "Covering the entire installed bestiary in one pass"). `pickCreature` (`encounter-roster.mjs`) can draw from far more than those 20 — any NPC in any pack matching `CREATURE_PACK_PATTERN` once its Monster Core-first/traited search comes up empty. The user now wants the actual remaining gap closed: a full, ordered worklist covering every creature the encounter generator could plausibly hand a player with no real token art.

**Scope decision.** "All enemies available in-game for encounters" is scoped to the **core, non-adventure-specific bestiary packs** — `pf2e.pathfinder-monster-core`, `pf2e.pathfinder-monster-core-2`, `pf2e.pathfinder-bestiary`, `pf2e.pathfinder-bestiary-2`, `pf2e.pathfinder-bestiary-3`, `pf2e.pathfinder-npc-core`, `pf2e.npc-gallery` — matching this module's own already-documented preference (`pickCreature`'s `MONSTER_CORE_PACKS`-first order, and the `pf2e-data` skill's explicit "prefer Monster Core over adventure bestiaries when picking at random: the adventure packs are full of named characters with a place in someone's plot"). Confirmed via user choice over the alternative (every pack `pickCreature` can technically fall back to, including all 55 adventure-path bestiaries — 6,095 art-missing creatures, an order of magnitude larger and full of one-off plot NPCs this module already avoids handing the party at random).

**Live query (confirmed via `foundry-rest` against the running world, 2026-09-18).** Across the 7 core packs: 1,705 total NPC entries, 76 excluded as `troop`/`swarm` (`MANDATORY_EXCLUDE`, per existing convention), 1,629 with default/missing art (`isDefaultArt` check, same pattern `findWorldActors`/`spawnCreatures` already use). Of those, 20 are already covered by ITEM-2's `data/creature-art.json` (confirmed by exact `{pack, docId}` match) — **1,609 remaining**.

**Full ordered list.** `docs/creature-art-todo.csv` (1,609 rows, columns `level,rarity,pack,docId,name`), sorted by `level` ascending, then `rarity` ascending (`common < uncommon < rare < unique`, the same `RARITY_ORDER` already defined in `foundry-api.mjs`), then `name` for stable ordering within a level+rarity tie. Distribution:
- **Level range:** -1 to 25.
- **Rarity totals:** common 1,225, uncommon 265, rare 112, unique 7.
- First few rows (L-1, common): Adept, Animated Broom, Apothecary, Apprentice, Barrister, Beggar, Bloodseeker, Common Eurypterid, Commoner, Compsognathus, Court Historian, Crawling Hand.
- Last few rows (L23-25, rare/unique): Jabberwock (L23, rare), Solar (L23, rare), Green Man (L24, rare), Hekatonkheires Titan (L24, rare), Sorvuth-Ka (L24, unique), Treerazer (L25, unique).

**Goal.** Work through `docs/creature-art-todo.csv` top to bottom, generating one `assets/creature-art/<slug>.webp` and one `data/creature-art.json` entry per row (same shape/pipeline ITEM-2 already established: `tools/generate-token-art.mjs`'s `MONSTER_ART` list, reviewed individually, checked with `tools/check-token-art.mjs`), same lookup/`imgFallback` wiring already in place from ITEM-2 (`findCreatureArt`, `spawnCreatures`'s per-entry override) — no new mechanism needed, this item is pure content volume against ITEM-2's already-shipped plumbing.

**Non-goals.** The 55 adventure-path bestiaries (a separate, explicitly-deferred future scope if ever wanted). Changing `pickCreature`'s pack preference or `LEVEL_TOLERANCE`. Re-generating any of the 20 creatures ITEM-2 already covered. A live re-query at implementation time is expected before generating each sub-batch, since the bestiary can change between now and then (new packs installed, existing art added) — `docs/creature-art-todo.csv` is a snapshot, not a live view.

**Scale note.** 1,609 creatures is roughly 80x ITEM-2's batch (which itself needed individual review and several redo cycles per creature). This is a multi-session content-generation effort, not a single pass — expect it to be worked in sub-batches (e.g. by level band or rarity tier, following the CSV's own priority order) rather than closed in one PR.

#### Plan

No mechanism to design — this item is pure content volume against ITEM-2's already-shipped plumbing (`findCreatureArt`, `data-loader.mjs`'s `loadCreatureArt`, `spawnCreatures`'s per-entry `imgFallback`, all unchanged). Each sub-batch: pick the next N rows off the top of `docs/creature-art-todo.csv`, write matching entries into `tools/generate-token-art.mjs`'s `MONSTER_ART` list (prompt + `avoid` list per creature, `shapeless: true` for bodiless/non-bust subjects), run `node tools/generate-token-art.mjs <ids...>`, review every image individually against `node tools/check-token-art.mjs`'s automated background check *and* by eye (the checker only catches bright/pale backgrounds — it does not catch off-style monochrome/woodcut drift, wrong-subject drift, or a solid-colored non-black background, all of which showed up in batch 1 and needed a manual catch + prompt fix + redo), add the corresponding `data/creature-art.json` entries, `npm run validate:creature-art`, `npm test`, remove each finished sub-batch's rows from `docs/creature-art-todo.csv` (progress tracking — the file is a live worklist, not a frozen snapshot once work starts), bump `module.json`.

**Batch 1 (20 creatures, all level -1 common, this PR).** Adept, Animated Broom, Apothecary, Apprentice, Barrister, Beggar, Bloodseeker, Common Eurypterid, Commoner, Compsognathus, Court Historian, Crawling Hand, Eagle, Flash Beetle, Giant Centipede, Giant Rat, Gnome Philomath, Goblin Warrior, Grimple, Guard Dog. `data/schema/creature-art.schema.json`'s `pack` enum widened from the 2 Monster Core packs to all 7 core packs this item's Scope decision covers (`pf2e.pathfinder-bestiary`/`-2`/`-3`, `pf2e.pathfinder-npc-core`, `pf2e.npc-gallery`) — the first batch to actually need a pack outside Monster Core.

**Redo tally (7 of 20 needed at least one redo, matching ITEM-2's own "budget for redos, not a one-shot" precedent):** `adept` and `barrister` both drew a bright halo/arch motif behind the subject that `backgroundScore`'s edge-ring heuristic didn't catch (inset, not touching the very edge) — fixed by naming the artifact in `avoid` (circular halo, moon, arch, archway, gothic frame, etc.), a failure mode not previously documented for humanoid/robed prompts. `beggar`, `commoner`, and an early `gnome-philomath` attempt all drifted into a monochrome woodcut/engraving style with an ornate circular frame, entirely off the module's full-color aesthetic — fixed by adding "full color illustration" to the prompt and naming the monochrome/frame failure in `avoid`. `crawling-hand` first drew a demonic purple clawed hand (wrong subject), then — after `avoid`ing "like spider legs" from the prompt's own wording — a full moonlit-forest-with-a-spider scene (the comparison phrase had been read as literal scenery); fixed by rewriting the prompt as an extreme-close-up with an explicit "nothing else in frame" and a long list of named scenery/creature exclusions. `gnome-philomath` also needed a second redo for a solid teal background (the same "colored, non-black background" gap ITEM-2's own Verification section already flagged as unfixed in `check-token-art.mjs`) before landing clean. `guard-dog` drew a decorative metal ring border — traced to the prompt's own "a metal ring" collar detail being read as a decorative frame; fixed by dropping that phrase and naming ring/roundel motifs in `avoid`. `bloodseeker`'s first accepted image passed `backgroundScore` (65, under the generator's own keep-best fallback) but failed `check-token-art.mjs`'s stricter standalone check over a faint ground/horizon gradient — redone with explicit ground/horizon/water exclusions.

**Verification.** `npm test` — 573 passing, 47 in the two creature-art suites (6 `findCreatureArt`/`creatureArtPath`, 41 asset-existence — up from 20 to 40 entries). `npm run validate:creature-art` — 40 entries, no duplicate lookup keys. `node tools/check-token-art.mjs` — 38 of 40 creature-art images report `clean`; one pre-existing ITEM-2 image (`ghoul-stalker`) and one from this batch (`grimple`, a faint floor-gradient the checker's edge-ring measure is sensitive to at this margin) report `borderline` rather than `clean` — neither hits the tool's own `BACKGROUND`/needs-regenerating tier, and both were accepted on individual visual review (matches the Spec's own point that the checker catches brightness, not every subjective flaw). `npm run validate`/`validate:dungeon` unaffected. Implemented in an isolated git worktree; `docs/creature-art-todo.csv` updated to remove these 20 rows (1,589 remaining).

**Batch 2 — prompts preconstructed, not yet generated.** Per the user's explicit ask ("using what you learned generating the first batch, preconstruct the prompts for the remaining tokens so each has a high probability of success on first attempt"), two things were done ahead of spending any more GPU time:
1. **Promoted every cross-cutting batch-1 failure into the shared `NEGATIVE`/`SHAPELESS_NEGATIVE`/`STYLE`/`SHAPELESS_STYLE` constants** in `tools/generate-token-art.mjs`, instead of leaving each fix on the one creature's own `avoid` list where it was discovered. The halo/circular-frame failure in particular had already been independently rediscovered and re-fixed per-creature at least four times across `drake`/`house-drake`/`fey-dragonet`, `ghoul-stalker`/`grindylow`, `ICON_NEGATIVE` (icons only), and now `adept`/`barrister`/`guard-dog` — it had never once made it back to the base token `NEGATIVE` all four previous times. Now fixed at the source: `NEGATIVE` gained a frame/halo/ring cluster, a monochrome/woodcut cluster, and a colored-background cluster; `STYLE`/`SHAPELESS_STYLE` both gained an explicit "full color illustration" phrase; `SHAPELESS_NEGATIVE` gained a reflection/water/ground cluster for the `bloodseeker` gradient failure.
2. **Added a permanent prompt-authoring checklist** to the `MONSTER_ART` docblock covering the lessons that aren't fixable by a shared negative list (ground every description in live bestiary text, never describe shape via simile to another creature, don't call a small worn accessory a "ring", frame an isolated body part/object as an explicit extreme close-up, when to reach for `shapeless: true`, review by eye as well as by `check-token-art.mjs`).
3. **Pre-wrote all 38 remaining level -1 creatures' `MONSTER_ART` entries** (completing that whole priority tier), each grounded in a live `foundry-rest` lookup of the real bestiary entry's traits/size/`publicNotes` rather than assumed from memory, and each `avoid` list trimmed to only the risks specific to that one creature — the recurring cross-cutting failures no longer need repeating per entry now that they're global.

No images generated yet for this batch — that's the next step, separately, once there's GPU time to spend; `docs/creature-art-todo.csv` is unchanged (still 1,589 rows) since nothing has actually been produced or validated against disk yet. `npm test` still 573 passing (no new art means no new asset-existence tests yet); confirmed the updated file still imports cleanly and has no duplicate `MONSTER_ART` ids.

**Full-worklist prompt preconstruction (this PR) — every remaining creature now has a written prompt.** Per the resume plan's explicit ask, prompts were preconstructed for the entire rest of the worklist (levels 0–25, 1,551 creatures) before resuming any more generation, so every future generation batch going forward is just "run the generator, review, wire in, ship" with no research/writing pause in between.

Worked in an isolated git worktree, split `docs/creature-art-todo.csv`'s remaining rows into 15 level-banded chunks (one per level for 0–10, then 11–13/14–16/17–19/20–25), and ran 15 parallel subagents — one per chunk — each grounding every prompt in a live `foundry-rest` lookup of that creature's real `system.traits.value`/`system.traits.size.value`/`system.details.publicNotes` (never guessed from name alone) and following this file's own prompt-authoring checklist. All 1,551 rows resolved cleanly against the live world — 0 skipped, no renamed/missing docIds encountered. Merged all 15 chunks' output into `MONSTER_ART`: 1,628 total entries (77 pre-existing + 1,551 new), all ids verified unique, `node --check` and `npm test` (590 passing, unchanged — no new art means no new asset-existence tests) both clean.

Cross-cutting notes from the parallel run: 6 true creature-name collisions turned up across the whole worklist (`barghest`, `giant-mantis`, `quatoid`, `quelaunt`, `tripkee-scout`, and a cross-pack `melody-on-the-wind`), each disambiguated with a short pack suffix (e.g. `barghest-mc`/`barghest-b1`) per chunk. A recurring data gap: many `pathfinder-npc-core` profession NPCs and a handful of high-level fiends/undead have thin or empty `publicNotes` with no physical description — those were grounded in the creature's real `traits`/`size` plus (for NPCs) role/gear implied by the text, never invented from the name, and flagged individually by the agent that hit them. Several chunks also caught and fixed source-text similes ("cross between a shark and a seal", "shark-toothed") that would have violated checklist rule 2 if copied verbatim from `publicNotes`.

`docs/creature-art-todo.csv` is unchanged (still 1,589 rows, including the 38 level -1 rows whose prompts already existed pre-this-PR) — rows only come out once art is actually generated and validated, not when a prompt is written. Every remaining row (and the 38 level -1 rows from batch 2) now has a `MONSTER_ART` entry ready to generate. `module.json` bumped to 0.43.0.

**Next up:** resume actual generation batch-by-batch (see the Plan's per-batch steps below), starting from the top of `docs/creature-art-todo.csv` (level -1). ITEM-18 stays `in-progress` until that CSV is empty.

**Batch 3 (37 of the 38 remaining level -1 creatures, this PR) — completes the level -1 tier except for one deferred creature.** `node tools/generate-token-art.mjs` run against all 38 level -1 `MONSTER_ART` entries preconstructed in batch 2.

**A real bug found and fixed before this batch could proceed.** `--reroll=N` (used to force a different image on a redo) was silently a no-op for any multi-word creature id: the seed hash (`[...id].reduce((a,c) => a*31+c.charCodeAt(0), 7)`) took its modulo only once at the end, so for ids longer than ~10 characters the accumulator blew past `Number.MAX_SAFE_INTEGER` mid-loop and lost precision — `+ reroll * 104_729` rounded away to nothing, and every "reroll" reproduced the exact same seed (and thus the exact same image) as `reroll=0`. Caught live: a `--reroll=1` redo of `halfling-street-watcher` reproduced all 4 of its original attempts' background scores exactly. Fixed by taking the modulo on every step of the reduce (`tools/generate-token-art.mjs`).

**A new cross-cutting failure class, not caught by `backgroundScore`/`check-token-art.mjs`.** Several images came back with a full (often dark, so score-invisible) scene behind the subject instead of a plain black background — profession NPCs pulled toward showing their "workplace" (a librarian's bookshelves, a merchant's shelf of coins, a physician's wall of bottles, a teacher's chalkboard) even though nothing in their prompts asked for one, plus a few unrelated full-landscape backdrops and glow-ring halos. Promoted to the shared `NEGATIVE` constant (room/shop/shelf/landscape/vignette/glow-ring terms) rather than chasing it per creature — this is exactly the "fix at the source" precedent batch 2 already established for the frame/monochrome/colored-background clusters.

**Redo tally: 24 of the 38 needed at least one redo, several needed many** (a higher rate than batch 1's 7/20 — this batch leaned harder on profession-NPC and prop-heavy prompts, the exact archetype the new failure class above targets). Two creatures needed rewritten prompts, not just added `avoid` terms: `yellow-musk-thrall` first rendered as a bare skull instead of the described fleshy "shambling humanoid" (prompt rewritten to explicitly require visible flesh and a full head/shoulders/torso), and `halfling-street-watcher` never once landed on a black background across 6 rounds and 25 total generations — including with the shared-constant fix, per-creature `avoid` additions, an explicit "solid black background" phrase in the prompt, and a raised CFG scale (10 vs the default 7) — before a full rewrite dropping the word "street" (the likely trigger, pulling toward an outdoor-scene association) got it down to a persistent dark grey (best score 56) but still not clean.

**`halfling-street-watcher` deferred, not shipped in batch 3.** After 6 rounds of genuinely different mitigations, this is a real, specific model/prompt interaction rather than an unlucky roll — continuing to spend GPU time on it had sharply diminishing returns. Its row stayed in `docs/creature-art-todo.csv` pending a decision.

**Verification (batch 3).** `npm test` — 627 passing (up from 590; 78 asset-existence entries, up from 41). `npm run validate:creature-art` — 77 entries, no duplicate lookup keys. `node tools/check-token-art.mjs` — all clean. `npm run validate`/`validate:dungeon` unaffected. Implemented in an isolated git worktree. `docs/creature-art-todo.csv` updated to remove the 37 shipped rows (1,552 remaining, 1 of which was the deferred level -1 creature). `module.json` bumped to 0.44.0.

**`halfling-street-watcher` resolved (level -1 tier now fully complete).** Rather than a 7th automated redo round, the user reviewed ComfyUI's own saved output history directly (`dommt-token-halfling-street-watcher_00022_.png`, generated during batch 3's round-2 redo pass) and accepted it as good enough despite its grey-gradient background — a deliberate, explicit exception to this module's black-background convention, not a bug or an oversight. Converted with the same PNG→WEBP method the generator itself uses (512×512, Pillow LANCZOS, quality 88) and wired in directly; `node tools/check-token-art.mjs` correctly flags it `BACKGROUND + PALE BACKDROP` — that verdict is expected and should not be "fixed" by a future regeneration pass without checking with the user first, since this exact image was a deliberate pick. `docs/creature-art-todo.csv`'s level -1 tier is now fully empty (0 rows) — the first tier to be completely finished under ITEM-18. `npm test` — 628 passing. `npm run validate:creature-art` — 78 entries. `module.json` bumped to 0.45.0.

### ITEM-15: Randomly place destructible cover items in rooms
**State:** backlog
**Blocked:** false
**Summary:** Rooms should randomly get destructible cover items (e.g. crates, barrels, rubble) placed in them for tactical cover during encounters.

### ITEM-3: Expand trap/puzzle generation with realistic content
**State:** backlog
**Blocked:** false
**Summary:** Grow `data/dungeon-setpieces.json` beyond the current 2 fully-transcribed puzzles + 3 stub traps into a fuller, more varied set of realistic traps and puzzles, and implement real generation/selection logic on top of it rather than a fixed small pool.

## Done

### ITEM-20: Frontier room's open outgoing face leaks vision/light past its walls
**State:** done
**Blocked:** false
**Summary:** The room a party currently occupies is only walled on the sides that already connect to a built room — its not-yet-connected outgoing face has no wall at all until the next room is built, so a selected token's vision (and the room's own light) spills unobstructed across the entire rest of the pre-sized scene canvas instead of stopping at the room's boundary.

#### Spec

**Problem, in three stages (confirmed via `Screenshot 2026-09-18 183347.png`, `183412.png`, `183648.png`, same dungeon run).** (1) GM view, no token selected: two built rooms render normally, rest of the canvas is plain grey/unexplored — looks correct. (2) A party token in the second (rightmost, currently-occupied) room is selected: nearly everything goes dark except a narrow vision wedge that reaches far past both rooms into open canvas well beyond any wall or built geometry — this was mistakenly attributed to the scene's 25ft padding and "fixed" by removing the padding. (3) With padding removed: the occupied room itself now renders fully and correctly, but the vision wedge still extends across the *entire* rest of the scene canvas — a large, still-mostly-empty area with no rooms in it at all — instead of stopping where the built dungeon ends. Padding wasn't the (whole) cause; it just changed how far past the room the leak reached.

**Root cause, confirmed live via `foundry-rest` against the actual affected scene (`I3D5ksi6MRWKJGj8`).** `buildRoomAtSlot` (`dungeon-scene.mjs:114`) builds a room's own perimeter via `roomEnclosureWalls(slot, { hasOutgoing: !isGoal })` — which deliberately *excludes* the wall on a room's outgoing-connection side, on the assumption that `buildConnectionGeometry` will fill it in with the real door-plus-opening geometry once the connection is built. But that connection geometry is only ever added when the *next* room is built (`buildRoomAtSlot`'s `if (slot > 0) { const {...} = buildConnectionGeometry(slot - 1, seed); ... }`, run for `slot`, not `slot - 1`) — so between "this room is built and occupied" and "the next room is built," the occupied room's own far face has **zero wall segments**, confirmed directly: a live wall dump of the affected scene shows walls only spanning `x:0` to `x:1300` (the two built rooms, each 600px/6 squares wide, joined by a corridor), with the second room's east face (`x:1300`) completely absent — nothing stops a sightline there. Combined with the scene being deliberately pre-sized with headroom for two rows of rooms before any of that space is built (`focusCameraOnSlot`'s own docblock, `dungeon-scene.mjs:193-198`, confirms this is intentional canvas pre-sizing, not a leftover bug) — this scene is `3600x1500`, more than 5x the width the two built rooms actually occupy — an unwalled outgoing face doesn't just leak a few feet, it leaks across nearly the whole rest of the canvas.

**Goal.** A room's walls should always fully enclose it the moment it's built, on every side, including the side that will eventually connect to a not-yet-built room — so a token's vision and a room's own light (ITEM-14) never extend past the room's actual boundary just because the next room hasn't been built yet.

**Scope.** `roomEnclosureWalls`/`buildRoomAtSlot`'s wall-building sequence (`dungeon-layout.mjs`, `dungeon-scene.mjs`) for the outgoing-connection side specifically — the three already-walled sides (incoming, and the two non-connecting sides) are unaffected; this is purely about the gap between "room built" and "next room built."

**Non-goals.** Anything about ITEM-14's lighting fix (AmbientLight per room) — that fix is correct and unrelated; this item is purely about wall/vision-blocking geometry. Changing how/when the *next* room gets built (ITEM-11's pre-build-first-real-room behavior, or whatever currently triggers building room N+1) — this item only needs the *currently frontier* room to be fully enclosed in the meantime, regardless of when the next build happens.

#### Plan

**Chosen fix: candidate (a) from the Spec.** `roomEnclosureWalls` keeps excluding the outgoing side exactly as before (it's still correct that the room's *static* perimeter shouldn't include connection-specific geometry), but `buildRoomAtSlot` now always fills that gap with a temporary, full-face placeholder wall the instant a non-goal room is built — then the *next* room's own build step deletes that placeholder before adding the real trimmed door/opening/`plainWalls` geometry for the same connection, so the two never coexist. Mirrors `relockDoorToSlot`'s existing precedent of a later step mutating an earlier room's already-created walls.

**1. `dungeon-layout.mjs`.** `roomEnclosureWalls`'s inline `sides` object factored into a shared `roomSides(slot)` helper (no behavior change). New exported `outgoingFaceWall(slot)` returns the full, unsplit segment on `slot`'s own outgoing face — `{ dir, ...roomSides(slot)[dir] }`, `dir = connectionDirection(slot)` — i.e. exactly the segment `roomEnclosureWalls` excludes when `hasOutgoing` is true.

**2. `dungeon-scene.mjs`.** `buildRoomAtSlot`: (a) when `slot > 0`, before building the new connection geometry, finds and deletes any wall flagged `dungeonFrontierWallForSlot === slot - 1` (the previous room's placeholder, now superseded); (b) when `!isGoal`, after the room's own enclosure walls, adds `outgoingFaceWall(slot)` as a plain solid wall flagged `{ dungeonFrontierWallForSlot: slot }`. A goal room needs neither — its outgoing side is already a normal wall from `roomEnclosureWalls` (nothing excluded there, since `hasOutgoing` is false for a goal room), and it never gets a "next room" to build against it.

**Tests.** `tests/dungeon-layout.test.mjs`: `outgoingFaceWall` — proven equal to exactly the segment `roomEnclosureWalls` drops when going from `hasOutgoing:false` to `hasOutgoing:true`, across several slots including a row-wrap; confirmed it spans the room's *full* face (not a trimmed door-width segment). `dungeon-scene.mjs`'s own sequencing gets no unit test — Foundry-document-touching, same precedent as the rest of that file (live-verify only).

**Verification.** `npm test` — 553 passing (2 new). `npm run validate`/`validate:dungeon` unaffected. Live via `foundry-rest`, module not yet deployed with this change so replicated faithfully against a scratch scene (production constants: `ROOM_SIZE:6, CORRIDOR_LEN:1, DOOR_WIDTH:1, GRID_SIZE:100`): built "room 0" alone — confirmed exactly one frontier-flagged wall exists, spanning its *entire* east face (`600,0`–`600,600`, blocking that whole side, where before this fix there would have been zero wall segments there at all); built "room 1" next — confirmed room 0's placeholder is gone (not just covered), a real `LOCKED` door now sits at the same face flanked by the connection's `plainWalls`, and room 1 gets its own new frontier placeholder on *its* east face (`1300,0`–`1300,600`) — exactly the hand-off the fix is meant to produce. Scratch scene deleted after.

#### Reopened (2026-09-19)

**The user reports the leak is still visible in actual play**, via `Screenshot 2026-09-19 114644.png`: a party token standing in a corridor cell between two already-built rooms, with a large fog/vision wedge spilling down and to the right into open, unbuilt canvas well past the corridor — the same shape of problem this item's original Spec described. The user also flagged a second, previously-unaddressed detail: **the scene's Grid-tab "Padding Percentage" still reads 0.25 (25%)** on this scene, despite an earlier request to fix it — visible directly in the same screenshot's Foundry Scene Configuration panel.

**Two things checked directly against the current code (this repo, post-merge) before re-diagnosing further:**
1. The frontier-placeholder-wall mechanism this item's Plan describes (`outgoingFaceWall`, the `dungeonFrontierWallForSlot` flag, `buildRoomAtSlot`'s delete-then-rebuild sequencing) **is genuinely present** in `dungeon-layout.mjs`/`dungeon-scene.mjs` — the code fix did merge, it isn't missing or reverted.
2. **`createDungeonScene` never sets a `padding` value at all** — grepping `scripts/dungeon-scene.mjs` for `padding` finds nothing. Every dungeon scene this module creates gets Foundry's own default (0.25), unconditionally. Whatever "fix the padding" request preceded this reopening, it was never actually turned into a code change here — at most a one-off manual edit to a single already-created scene (which wouldn't survive that scene being torn down and a fresh one built, and wouldn't affect any run started since).

**What's still unconfirmed.** This item's own original Verification section admits its live check never touched the actually-deployed module — "module not yet deployed with this change so replicated faithfully against a scratch scene" — only a hand-built replica of the logic in a throwaway script. Whether the *real* Foundry world's installed module has actually picked up this fix (the deployment-model gap already flagged in ITEM-2/ITEM-4 — the world installs from GitHub, not this working tree) hasn't been checked, and neither has whether the screenshot's own scene predates the fix and is just carrying stale explored-fog geometry from before it existed. Both are live-verification work for whoever picks this back up, not yet done here.

**Reopening scope, going forward:** (a) verify live whether the deployed module actually contains the frontier-wall fix, and if not, what it takes to get the world onto a version that does; (b) if the fix is live and the leak still reproduces on a *freshly started* run, re-diagnose from there rather than assuming the original root cause was complete; (c) add explicit `padding` handling to `createDungeonScene` (`dungeon-scene.mjs`) — decide and set an appropriate value (likely `0`, given this module already manages its own canvas sizing via `ensureSceneCovers`/pre-sized headroom rather than relying on Foundry's padding mechanic) instead of silently inheriting Foundry's default.

#### Reopening resolution (2026-09-19)

**(a) Deployed version confirmed live via `foundry-rest` against the real `pf2etest` world.** `game.modules.get('deck-of-many-more-things').version` = `0.41.0`, `active: true` — well past the original fix's merge, so the world's installed module already carries the frontier-wall mechanism.

**(b) Re-tested on a genuinely fresh run — the leak does not reproduce.** No dungeon-run scene existed on the world at all (the screenshot's own scene had already been torn down, so it couldn't be inspected directly). Started a brand-new run through the module's *actual* deployed UI (`api.openDungeon()`, real form input, real Start button click — not a replicated scratch scene), then inspected the resulting scene and a controlled token's live-computed vision:
- Wall dump of the new scene showed the expected frontier placeholder (`dungeonFrontierWallForSlot`) fully spanning room 1's east face (`x:1300, y:0→600`) — the fix's mechanism fired correctly on a real run.
- A token placed in room 0 had `los` bounds exactly `[0,0]–[600,600]` — its own room, nothing more — against a scene sized `3600×1500`.
- A token placed in room 1, right against the frontier wall, had `los` bounds exactly `[700,0]–[1300,600]` — again its own room exactly, zero leak into the remaining unbuilt canvas.

No vision leak reproduces against the currently-deployed code on a fresh run. The most likely explanation for the user's `Screenshot 2026-09-19 114644.png` is a scene that predated the original fix (stale explored-fog/wall geometry carried on a scene created before the module was updated) — consistent with this item's own Spec already having flagged that possibility as unconfirmed.

**(c) Done.** `createDungeonScene` (`dungeon-scene.mjs`) now sets `padding: 0` explicitly, rather than silently inheriting Foundry's 0.25 default — this module pre-sizes its own canvas via `ensureSceneCovers`/`requiredDimensions` and never relied on Foundry's padding mechanic. (Confirmed via the live investigation that padding was not itself a source of the vision leak — walls bound `los` correctly regardless of padding — but leaving Foundry's default padding on is still visible, confusing dead space around the built dungeon in Scene Configuration, worth closing regardless.)

**Verification.** `npm test` and `npm run validate`/`validate:dungeon` (no logic change beyond the one literal `Scene.create` field, no new test needed there). Live-verified end-to-end as described above, including cleanup: test tokens and the scratch dungeon scene deleted via the module's own `api.resetDungeon(sceneId)`, party confirmed back on the world's original active scene, no lingering state left on the live world beyond three unrelated pre-existing orphaned `dungeonRuns` setting entries (scenes already gone before this session, out of scope here).


### ITEM-17: Randomize room size between small and large
**State:** done
**Blocked:** false
**Summary:** Room sizes should be randomized between small (6x6 tiles / 30'x30' in-game) and large (12x12 tiles / 60'x60' in-game), instead of every room using the current fixed `ROOM_SIZE`.

#### Spec

**Problem.** Every room used the same hardcoded `ROOM_SIZE` (6). The GM wants tactical/spatial variety: some rooms should feel cramped, others should feel genuinely large (60'x60'), at random.

**Why this was a bigger change than it sounds.** `ROOM_SIZE` wasn't just a room's own footprint — it was load-bearing across the *layout* (every room positioned by a uniform `slot * stride` formula, assuming every room the same size) and the *room art* (33 pre-generated assets baked at a fixed 600x600px, per ITEM-7's own prior note). Before committing to an architecture, both were checked directly rather than assumed:
- **Art:** a quick side-by-side (stretching the existing 6x6 art 2x linearly vs. tiling it 2x2) showed stretching looks completely fine — a stylized top-down room with a beveled border scales cleanly, with none of the obvious seams/repetition tiling produced. Foundry Tile documents already render room art at whatever pixel size `slotRect`'s `gw`/`gh` specify (`width: toPixels(rect.gw)`, already fully dynamic) — so **no new art assets were needed at all**, only correct layout math.
- **Layout:** this was the real work. Every room is square (small or large, never rectangular), so a room's width always equals its height — but positioning stopped being a simple formula once rooms could differ in size, because of one specific invariant this module already promised: "a row's last room and the next row's first room always share a grid column — the wrap between rows is a plain straight corridor, never a jog" (`dungeon-layout.mjs`'s own docblock, predating this item). Working through several candidate designs (independent per-row column widths, a shared max-size-per-column grid reserving unused margin around small rooms) — all either broke that wrap guarantee or reintroduced long, ugly, variable-length corridors from unused reserved space. The design that actually preserves the guarantee *and* keeps corridors tight: positions are a **cumulative walk in slot order** (0, 1, 2, ...) rather than an O(1) formula — see Mechanism.

**Goal.** Every room is independently, deterministically (per-run-seed) either `ROOM_SIZE_SMALL` (6) or `ROOM_SIZE_LARGE` (12), with correct walls/doors/corridors/lighting regardless of which size a room or its neighbor turned out to be, and the boustrophedon wrap's "never a jog" guarantee intact.

**Non-goals.** New/dedicated "large room" art — the existing pool, scaled, already looks right (see above). Letting a room be anything other than square, or any size besides these two. A GM-facing size-weighting control — a fixed 3:1 small:large weight, matching this module's existing convention of picking reasonable fixed weights with no source-material anchor (`ROOM_KIND_WEIGHTS`, etc.).

#### Plan

**Mechanism — `slotRect(seed, slot)` becomes a cumulative walk, not `slot * stride`:**
1. `roomSizeAt(seed, slot)` — new seeded weighted pick (3:1 small:large), same per-index convention as every other seeded pick in this module.
2. Walking from slot 0 up to the target slot, tracking `gx`/`gy`: an **east** step advances `gx` by the *departing* room's own width + `CORRIDOR_LEN`; a **west** step advances it by the *arriving* room's own width + `CORRIDOR_LEN` (subtracted); gy is untouched either way — every room in a row shares its top edge ("top-aligned," not centered), so a large room in an otherwise-small row simply extends further down than its neighbours. A **south** step (the row wrap) carries `gx` forward **completely unchanged** — not recomputed from either room's width — which is exactly what guarantees the wrap-connected rooms share a column no matter how different their sizes are; `gy` advances by the departing room's own height + `CORRIDOR_LEN`.
3. `doorOffsetAt` gains a `roomSize` parameter (previously read a module-level `ROOM_SIZE` constant) — the offset is bounded by *whichever room the door/opening actually sits on*, not a shared assumption.
4. `buildConnectionGeometry` now fetches **both** ends' own rects (`slotRect(seed, slot)` and `slotRect(seed, slot + 1)`) and builds each room's own wall segments from its own rect — previously it read one room's `gy`/`gh` and reused it for both sides, silently correct only because every room was the same size before this item. Confirmed live this was a real, would-have-shipped bug: a scratch two-room connection with a 12-room next to a 6-room produced each side's wall spanning that side's own actual full height (0-9 and 10-12 for the 12-room; 0-4 and 5-6 for the 6-room) rather than reusing one room's height for both.
5. **A second real bug caught live, not in review:** the cumulative walk can legitimately produce a *negative* `gx` — a west-moving row can walk backward by its own full width, and nothing else bounds `gx` from below (unlike `gy`, which only ever increases). Confirmed directly: a 2-row scratch dungeon (an all-small east row followed by an all-large west row) drove `gx` to -6. Fixed with `INITIAL_GX` (300) — every room's `gx` is offset by this from the start, comfortably past the worst realistic drift for this module's own 20-room cap (confirmed empirically: a 2000-seed × 24-slot sweep never went below 264; a 3000-seed × 60-slot sweep — well past any dungeon this module can actually build — never went below 234).
6. **A third bug, also only found live:** `dungeon-scene.mjs`'s `requiredDimensions` (which pre-sizes the scene and grows it before every room build) computed width from the *old* `slot * stride` assumption and had no idea about `INITIAL_GX` — so a scene could be sized too narrow to contain the now-offset content. Confirmed directly: an under-sized scratch scene silently misplaced a Tile whose `x` exceeded the scene's own declared width. Fixed by adding `INITIAL_GX` into `requiredDimensions`'s width term (re-exported from `dungeon-layout.mjs`); re-verified the exact same scenario with a correctly-sized scene and got exactly the expected coordinates.
7. Room lighting (ITEM-14) and pre-sizing (ITEM-20) both already used `ROOM_SIZE` as a fixed constant for radius/stride math — both now derive from the room's own actual size at build time: light radii scale via `roomLightRadii(roomSizeSquares)` (reproduces the exact original bright:22/dim:40 for a small room, scales up for large), and `requiredDimensions`'s stride uses `ROOM_SIZE_LARGE` as a safe worst-case upper bound (an all-small dungeon just leaves some of that headroom unused, same over-provisioning this module already accepted post-ITEM-20).
8. `seed` had to be threaded through several `dungeon-scene.mjs` functions that call `slotRect` but didn't previously need it (`focusCameraOnSlot`, `populateSlotEncounter`, `placePartyInSlot`, `moveTokensToSlot`) — mechanical plumbing from callers that already had `state.seed` in scope, including a new `seed` field on `DungeonApp`'s render context (unused by the template itself, only by `_onRender`'s own `focusCameraOnSlot` call).

**Tests.** `tests/dungeon-layout.test.mjs` substantially rewritten for the new (seed, slot) signatures throughout, plus new coverage specific to this item: `roomSizeAt` determinism/range/variety; every room square and matching `roomSizeAt`; the wrap-alignment guarantee explicitly re-verified *across five different seeds* (not just the one it happened to hold for); same-row top-alignment holding even when sizes differ; a 200-seed × 24-slot sweep asserting `gx`/`gy` never go negative (the exact bug class caught live); `buildConnectionGeometry` building each side's wall segments from that side's own rect when a search finds a genuinely different-sized connected pair.

**Verification.** `npm test` — 590 passing. `npm run validate`/`validate:dungeon` unaffected. Live via `foundry-rest`, entirely against scratch scenes (never the real active run): reproduced and fixed the negative-`gx` bug and the under-sized-scene bug (both described above, both confirmed only by actually running the code, not by review); then built the exact previously-broken scenario (a 12-room connected to a 6-room, real coordinates traced by hand first via a plain Node script importing the pure `dungeon-layout.mjs` module directly) end to end in a correctly-sized scratch scene and confirmed every one of the 8 created Walls and 8 created Tiles landed at exactly the expected coordinates/sizes — including each room's own wall spanning its own full height, the trimmed corridor span, and both doors. All scratch scenes deleted immediately after each check; confirmed none left behind.

### ITEM-5: Refactor combat encounter difficulty scaling
**State:** done
**Blocked:** false
**Summary:** Dungeon crawl encounters, traps, and puzzles should start easy (scaled to party level) at the first room and increase in difficulty each subsequent room; players must always be able to flee backward to a previously completed room; dungeons with more than 6 rooms get a safe resting room in the middle.

#### Spec

**Problem, broken into its three real parts (only one of which was actually missing).**
1. **Difficulty scaling.** `depthBiasFor` (`dungeon-deck.mjs`) already existed and already does exactly this for combat rooms — a linear ramp from 0 at the first real room to `MAX_DEPTH_BIAS` at the goal, fed into `resolveEncounterRoster` as `levelOffsetBias` every time a combat room is populated (Start, room-to-room progression, "Populate Next Room" recovery — confirmed by tracing every `populateSlotEncounter` call site, same audit ITEM-21 already did for the theme-dialog fix). Already covered by its own existing tests (`depthBiasFor`'s zero-at-start/max-at-goal/monotonic-ramp assertions). Trap/puzzle difficulty has no equivalent because there's no *content* to scale yet — `data/dungeon-setpieces.json` is still ITEM-3's "2 fully-transcribed puzzles + 3 stub traps," with no difficulty axis at all to bias. Scaling a pool that small would be cosmetic, not real difficulty control.
2. **Backward retreat.** Audited every call site of `relockDoorToSlot` (the only function that ever re-locks a progress-gate door): it's called exactly once, from `undoRoomEntry` (a GM-only undo action), never as part of normal forward progression. A door, once unlocked, stays unlocked — the party can already always walk back to any previously-cleared room. Nothing was broken here.
3. **Mid-dungeon rest room.** The actual gap. No room kind existed for "safe, no encounter, encountered partway through" — only the entry (`safe_entry`, always room 0, always built and unlocked at Start) had that treatment. A long dungeon had no breather.

**Goal.** Close gap 3 without disturbing 1 or 2: a dungeon requested with more than 6 rooms gets exactly one additional safe rest room, inserted near the midpoint of the sequence, never counted against the GM's own requested room count (matching how the entry is already "free"), reached through the normal door-reveal flow (not a Start-time special case like the entry) and auto-advanced past the instant it's revealed, exactly like the entry's own "the way onward is already open."

**Scope.** `buildRoomSequence` (`dungeon-deck.mjs`) for inserting the room; `markRoomOutcome` (`dungeon-runner.mjs`) for advancing past it with no reward/ruin to resolve; `handleDungeonDoorOpened` (`dungeon-scene.mjs`) for triggering that advance the moment it's revealed; the tracker UI (`ui/dungeon-app.mjs`/`dungeon-tracker.hbs`) for showing it correctly (no Succeed/Fail buttons, a distinct hint, room numbering that still lines up with the GM's requested total).

**Non-goals.** Trap/puzzle-specific difficulty scaling — deferred to ITEM-3; there's no content there yet worth scaling. Changing `depthBiasFor`'s own ramp shape or `MAX_DEPTH_BIAS` — already correct, untouched. Any new mechanism for backward retreat — already guaranteed by existing design, verified rather than changed. Letting the GM configure the rest-room threshold or position — a fixed `MID_DUNGEON_REST_THRESHOLD` (6) and a fixed "nearest the midpoint" placement, matching the item's own plain wording.

#### Plan

**1. `scripts/dungeon-deck.mjs`.** New `MID_DUNGEON_REST_THRESHOLD = 6`. `buildRoomSequence` computes `restAfterIndex` (the loop index nearest the midpoint of the real, non-goal rooms) whenever `roomCount > MID_DUNGEON_REST_THRESHOLD`, and inserts a `{ kind: 'safe_rest', isGoal: false, setpieceId: null, outcomeSlotId: null, ... }` room right after it — same shape as the entry room, just reached mid-run instead of at Start.

**2. `scripts/dungeon-runner.mjs`.** `markRoomOutcome`'s existing "nothing to resolve" guard (`!room.isGoal && room.outcomeSlotId == null`) now excludes `kind === 'safe_rest'` from the early return — a rest room still needs the *slot-assignment* half of this function (so the room after it gets built), just not the reward/ruin half. A new `effectKey: 'rest_room_passed'` (`mutation: null`) stands in for `resolveRoomOutcome`'s normal result when the current room is `safe_rest`, so history still gets a sensible entry instead of `findOutcomeTemplate(null)` crashing.

**3. `scripts/dungeon-scene.mjs`.** `buildPopulateAndUnlockRoom` — previously a private helper duplicated in `ui/dungeon-app.mjs` — **moved here and exported**, since `handleDungeonDoorOpened` now needs it too and this file deliberately never imports from `ui/dungeon-app.mjs` (existing architectural rule, see `dungeon-combat.mjs`'s own docblock). `handleDungeonDoorOpened`: after `advanceToRoom` lands the party on a freshly-revealed room, if that room is `kind === 'safe_rest'`, immediately calls `markRoomOutcome({succeeded: true})` and `buildPopulateAndUnlockRoom` for whatever comes after it — the same "way forward already open, no GM click" treatment the entry gets, just triggered by discovery instead of Start.

**4. `scripts/ui/dungeon-app.mjs`.** Its own private `buildPopulateAndUnlockRoom` deleted, replaced by importing the one now in `dungeon-scene.mjs` (still used by `#onStart` and `resolveCurrentRoom`'s normal path, unchanged behavior). `ROOM_KIND_KEYS`/`EFFECT_KEYS` gain `safe_rest`/`rest_room_passed`. `roomNumber`/`roomTotal` generalized from "subtract 1 for the entry" to "count only rooms outside `UNCOUNTED_ROOM_KINDS` (`safe_entry`, `safe_rest`)" — a strict generalization that produces identical numbers when no rest room exists (verified: old formula was exactly this new one specialized to a set of size 1). New `isSafeRest`/`isSafeRoom` context flags alongside the existing `isSafeEntry`.

**5. `templates/dungeon-tracker.hbs`.** The progress-label line and the Succeed/Fail-hiding branch both switch from `{{#if isSafeEntry}}` to `{{#if isSafeRoom}}`, with the progress label itself simplified to reuse `currentRoom.kindLabel` (already resolves to the same string `{{localize "DOMMT.Dungeon.Kind.safe_entry"}}` did) instead of a hardcoded key, so it renders correctly for either safe kind with no new template branch; the hint text still branches on `isSafeEntry` vs. not, since the two moments read differently ("you've arrived" vs. "you may rest here").

**6. `lang/en.json`.** New `DOMMT.Dungeon.Kind.safe_rest`, `DOMMT.Dungeon.SafeRestHint`, `DOMMT.Dungeon.Effect.rest_room_passed`.

**Tests.** `tests/dungeon-deck.test.mjs`: no rest room at or below the threshold (room count unchanged, `roomCount + 1` total); exactly one rest room above it, uncounted (`roomCount + 2` total), with `outcomeSlotId`/`setpieceId` both null; lands strictly between the entry and the goal, within 2 rooms of dead-center; the goal room and overall shape are unaffected. `tests/dungeon-runner.test.mjs`: a real run walked forward (via the actual `markRoomOutcome`/`advanceToRoom` — not mocked) until `currentIndex` lands on the rest room, then `markRoomOutcome` there is asserted to return `effectKey: 'rest_room_passed'`, `mutation: null`, a real `nextRoomId` with its physical slot correctly assigned, and a matching history entry — exercising the exact production code path, not a replica.

**Verification.** `npm test` — 558 passing (5 new: 4 in `dungeon-deck.test.mjs`, 1 in `dungeon-runner.test.mjs`; one pre-existing test's non-entry filter widened to also exclude `safe_rest`, since `roomCount: 10` now legitimately produces one). `npm run validate`/`validate:dungeon` unaffected. `node --check` clean on all four touched files; confirmed no new import cycle (`dungeon-scene.mjs`'s two new imports — `depthBiasFor` from the already-leaf `dungeon-deck.mjs`, `markRoomOutcome` from `dungeon-runner.mjs`, which itself only imports `dungeon-deck.mjs` — neither imports back). The rest room reuses the entry's own art-selection convention (`locationTagAt(seed, 'rest')`, same `LOCATION_TAGS` pool every other room draws from), so it needs no new art assets. Difficulty scaling (part 1) and backward retreat (part 2) were verified by tracing existing code, not changed — see Spec.

### ITEM-8: Automate non-player turns in combat
**State:** done
**Blocked:** false
**Depends-on:** ITEM-6
**Summary:** When a non-player-controlled combatant (foe/friend/lurker/twin) comes up in the Combat Tracker's initiative order, it should act automatically according to its default behavior instead of waiting on a GM to manually run its turn.

#### Spec

**Problem.** ITEM-6 wires every dungeon (and standalone-macro) encounter into a real PF2e `Combat`, with initiative rolled for everyone — but nothing ever *acts* for a non-player combatant. When a foe/friend/lurker/twin comes up in the turn order, the GM has to manually open its sheet, roll its strike, apply damage, and click "next turn," for every single NPC, every single round. This is exactly the busywork ITEM-6's own automation should have removed.

**Goal.** The moment a non-player-owned combatant's turn comes up in a module-created `Combat` (dungeon room or the standalone "DOMMT: Generate Encounter" macro), it plays itself: move toward the nearest opposing combatant if not already adjacent, make its first available strike against it, apply the result (including damage on a hit), then advance to the next turn — with no GM click needed. A real party member's own turn is never touched; that combatant is genuinely GM/player-controlled.

**Scope decisions, resolved with the user up front (three real design forks, not guessed):**
1. **Move-then-attack**, not attack-only-in-place and not full tactical pathfinding — a simple straight-line "step toward" heuristic (see Mechanism), not real A*/wall-avoidance.
2. **Damage auto-applies** — not just rolled into chat for the GM to click "Apply Damage."
3. **Every non-player-owned combatant auto-plays** — foes, lurker, twins *and* friend (an ally NPC) — not hostiles only. The only thing that stays manual is an actual party character's own turn.

**Root cause / why this needed live research first.** PF2e's own strike-roll pipeline (`actor.system.actions[i].variants[j].roll()`) unconditionally opens a `CheckModifiersDialog` unless the *current user's own* `flags.pf2e.settings.showCheckDialogs`/`showDamageDialogs` are off — confirmed live by inspecting `game.pf2e.Check.roll`'s own source (`t.skipDialog ??= !game.user.settings.showCheckDialogs`), and confirmed that a strike's own `roll()`/`damage()` wrapper does **not** forward a `skipDialog` option itself (two scratch-script calls hung on exactly this dialog until worked around). And `strike.damage()` only *rolls* damage — it never applies it; the actual HP change needs a separate call to `ActorPF2e#applyDamage` (the same method PF2e's own chat-card "Apply Damage" button calls, confirmed via the actor class's real prototype chain — `CONFIG.Actor.documentClass.prototype` only shows the base Foundry `Actor`, not the `ActorPF2e` subclass PF2e actually uses).

**Mechanism (all confirmed live, end to end, against fully scratch actors/scene/combat — never the real active run).**
1. Toggle the current user's own `flags.pf2e.settings.showCheckDialogs`/`showDamageDialogs` to `false`, immediately restoring both in a `finally` right after — scoped to the GM's own client (these are user flags, not a world/`game.settings` write) and only for the duration of the automated roll, so a GM's own manual rolls elsewhere are unaffected.
2. Pick a target: the nearest still-alive combatant whose token disposition differs from the acting combatant's own (Chebyshev/8-directional grid distance, matching how this module already measures everything else).
3. If farther than 1 square away, move the acting token in a straight line toward the target by up to its speed (in squares, from `system.movement.speeds.land.value` ÷ the scene's own `grid.distance` — confirmed live; `system.attributes.speed` doesn't exist on an NPC actor at all, and a first pass at this used that wrong path, silently producing 0 speed and no movement), stopping once adjacent — never further than needed, never past its own speed. No wall-avoidance, no real pathfinding.
4. Roll its first `ready` strike action, targeting the opponent via `{ document: targetTokenDocument }` — confirmed live this works with **no dependency on which scene the GM's own canvas currently has open** (a plain `TokenDocument` reference is enough; a rendered placeable is not required), which matters because a hook can fire while the GM is looking at a different scene.
5. On a hit (`success` or `criticalSuccess`), roll damage and apply it via `actor.applyDamage(...)` (handles resistances/weaknesses/immunities correctly, since it's PF2e's own real method, not a hand-rolled HP subtraction).
6. Advance the turn (`combat.nextTurn()`). If the *next* combatant is also non-player-owned, the same `updateCombat` hook fires again naturally and the sequence repeats — several NPC turns in a row chain automatically with no extra wiring.

**Non-goals.** Real pathfinding/wall-avoidance for movement (explicitly accepted trade-off — see Scope decision 1). Reach-weapon-aware threat ranges, ranged-weapon range increments, or any other tactical nuance beyond "move adjacent, then strike" — every automated combatant is treated as a simple melee attacker for range purposes. Choosing *which* strike to use when a creature has several (always its first `ready` one). Multiple-attack-penalty iteration (a creature always makes exactly one strike on its automated turn, never a second/third at increasing MAP). Reactions, spells, or any non-strike action. Marking a reduced-to-0-HP combatant `defeated` — that's the pre-existing mechanism ITEM-6 already built (and this item doesn't change); `autoResolveIfDecided` still only fires off however that flag actually gets set today. A way for the GM to disable/pause auto-play per-encounter — always on for any module-created Combat, matching the item's own plain wording; a toggle can be a follow-up if it turns out to be wanted.

#### Plan

**1. `scripts/dungeon-combat.mjs`.** New pure-ish helpers (Foundry-document-touching, so not unit-tested, same precedent as the rest of this file) alongside the existing `isModuleCombat`/`combatSideStatus`:
- `combatantOpponents(combat, combatant)` — every other still-alive combatant whose token disposition differs from `combatant`'s own.
- `nearestOpponent(combat, combatant)` — the closest of those, by Chebyshev grid distance using the combat's own scene's `grid.size`; `null` if none.
- `stepToward(combat, combatant, target, distanceSquares)` — moves `combatant.token` up to its speed (in squares) straight toward `target.token`, stopping at 1 square away; no-ops if already adjacent or if speed is 0.
- `rollAndApplyStrike(combatant, target)` — the dialog-suppression / roll / damage / `applyDamage` sequence from the Mechanism section, in a `try/finally` that always restores the user's dialog flags.
- `autoPlayCombatantTurnIfDue(combat)` — the orchestrator: bails unless `game.user.isGM` and `isModuleCombat(combat)`; bails if the current combatant is player-owned (`combatant.actor?.hasPlayerOwner`) — that one stays manual; immediately advances the turn (no roll) if the current combatant is already `isDefeated`; otherwise waits a short beat (`AUTO_PLAY_DELAY_MS`, matching this codebase's existing `DEAL_DELAY_MS`-style pacing precedent) so the GM can actually see the round advance, re-checks the turn hasn't already moved on (another client, or the combat auto-resolving mid-wait), finds a target, steps toward it, strikes, then calls `combat.nextTurn()` regardless of whether it found a target.

**2. `scripts/module.mjs`.** New `Hooks.on('updateCombat', (combat, changes) => { if (changes.turn === undefined && changes.round === undefined) return; autoPlayCombatantTurnIfDue(combat); })` — not awaited at the top level, matching the existing `updateWall` hook's own fire-and-forget style. `combat.startCombat()` itself updates `round`/`turn`, so this also covers a combat's very first turn with no separate wiring.

**Tests.** No new unit tests — every new function is Foundry-document/PF2e-actor-API-touching with no pure-logic surface to isolate, same precedent as the rest of `dungeon-combat.mjs` (live-verify only, which this item already did extensively before writing any code).

**Verification (live, via `foundry-rest`, entirely against scratch actors/scene/combat — never the real active run).**

*Piece-by-piece, before writing any code:* (1) the dialog-hang and its fix — two calls without the user-flag workaround hung the relay on a real `CheckModifiersDialog`, cleaned up by closing the stuck `Application` instances and reading their `constructor.name`; the flag-toggle fix produced a clean, dialog-free roll; (2) `strike.variants[0].roll({ target })` needs the target as something exposing `.document` — passing a plain `{ document: tokenDocument }` (not a rendered canvas placeable) works identically and was confirmed **not** to depend on that scene being the GM's currently-viewed one; (3) a forced-low-AC scratch target produced a real `criticalSuccess` outcome with a correctly-computed `dc.value` against its actual AC; (4) `strike.damage()` alone does *not* change HP (`hpChangedAutomatically: false`) — only the follow-up `actor.applyDamage({ damage, token, outcome })` call did, taking a target from 15 HP to 9 on a confirmed crit.

*After assembly, against the real functions added to `dungeon-combat.mjs` (module not yet deployed with this change, so replicated faithfully — same precedent as every other item this session):* a scratch combat with an attacker 8 squares from a forced-low-AC target caught a real bug — the first pass at `stepToward` read speed from `system.attributes.speed.value`, which doesn't exist on an NPC actor (confirmed directly: `Object.keys(actor.system.attributes)` has no `speed` key at all), so `speedFt` silently fell back to `0` and the attacker never moved. Fixed to `system.movement.speeds.land.value` (confirmed present, `40` on the test creature) and re-verified: `distanceSquares:8, speedSquares:8, steps:7` — the attacker moved exactly 7 squares, stopping 1 short of the target (never past `MELEE_REACH_SQUARES`, never past its own speed), then struck for a confirmed `criticalSuccess` and applied damage (15→9 HP), with the Combat's `turn` advancing `0→1` throughout. Separately confirmed both remaining guard clauses on the assembled `autoPlayCombatantTurnIfDue` logic: an already-`isDefeated` combatant's turn is skipped with just a `nextTurn()` call (no roll attempted) and the turn correctly advances past it; a real party character combatant (`hasPlayerOwner: true`) is left completely untouched — the turn does not advance and nothing is rolled, confirming a player's own turn is never auto-played. `npm test` — 553 passing, unchanged (no pure-function surface; same precedent as the rest of this file). Every scratch actor/scene/combat created during this research was deleted immediately after each test (confirmed via a final sweep — zero `SCRATCH`-named actors/scenes remained), and the GM's own `showCheckDialogs`/`showDamageDialogs` flags were confirmed restored to `true`/`true` (their original values) after the last test run.

### ITEM-21: Starting a dungeon re-prompts the encounter theme dialog it just collected
**State:** done
**Blocked:** false
**Summary:** Clicking "Start Dungeon" already collects theme/exclude traits on its own form, but immediately pops up the separate "DOMMT: Generate Encounter" theme dialog again (for the first real room, if it's a combat room) — a redundant, unexpected extra prompt right after the GM just filled in the same fields.

#### Spec

**Problem.** Clicking "Start Dungeon" (`DungeonApp.#onStart`, `dungeon-app.mjs:208`) reads `traits`/`excludeTraits` off its own form and passes them into `createRun`, then immediately builds and populates the first real room via `buildPopulateAndUnlockRoom` → `populateSlotEncounter`. If that first room is a combat room, this chain ends up calling `generateEncounter()` (`encounter-generator.mjs:117`), which **unconditionally** opens `chooseThemeAndSize`'s `DialogV2` (`encounter-generator.mjs:22`, titled `DOMMT.Encounter.Title` — the same "Generate Encounter" theme dialog the standalone macro uses) before it will generate anything — even though `populateSlotEncounter` already passed the just-collected `state.traits`/`state.excludeTraits` in as `prefillTraits`/`prefillExcludeTraits`. Prefilling only pre-checks the dialog's own trait pickers; it doesn't skip the dialog. The GM sees: fill in traits on the Start form → click Start → immediately get asked to fill in (the same, already-checked) traits again in a second popup before the dungeon actually starts.

**Root cause.** `generateEncounter` was designed for the standalone "DOMMT: Generate Encounter" macro, where there's no prior context and the theme dialog is the *entire* point. `populateSlotEncounter` (`dungeon-scene.mjs:279`) reuses `generateEncounter` wholesale for dungeon-room population, and its own docblock says this was a deliberate choice ("The GM still gets the existing theme dialog + Accept/Reroll preview — nothing about that flow changes"). But ITEM-1's own Spec already documents the actual intended design as the opposite: traits are "captured once at 'Start Dungeon' and reused unchanged for every room" — `generateEncounter` never got a way to honor that once prefill values are already known, so every dungeon-room population (Start, "Populate Next Room", combat recovery) re-prompts for input the run already has.

**Goal.** Starting a dungeon run should not re-ask for theme traits it was just given. Once traits/excludeTraits are set at Start, populating a combat room during that run should proceed straight to the Accept/Reroll encounter preview using those already-known traits, with no intermediate theme dialog.

**Scope.** `generateEncounter`/`chooseThemeAndSize` (`encounter-generator.mjs`) and `populateSlotEncounter`'s call into it (`dungeon-scene.mjs`). Likely needs a way for a caller that already has final traits (not just a prefill suggestion) to skip `chooseThemeAndSize` entirely and go straight to dealing/previewing the encounter.

**Non-goals.** The standalone "DOMMT: Generate Encounter" macro keeps its theme dialog exactly as-is — it has no prior run context to draw traits from, so the prompt is doing real work there. Removing the Accept/Reroll preview dialog — that one stays for every path, dungeon or standalone; only the *theme* prompt is redundant when a run already supplied it. Whether "Populate Next Room" should ever let a GM change theme mid-run per room (a real, separate question ITEM-1 already gestures at) — out of scope here; this item only removes the *redundant* re-ask of information already given, not a deliberate later re-ask.

#### Plan

**Chosen fix.** `generateEncounter` gains a `skipThemeDialog` param (default `false`, so the standalone macro's own call — which never sets it — is completely unaffected). When `true`, it builds `theme` directly from `{ traits: prefillTraits, excludeTraits: prefillExcludeTraits }` instead of awaiting `chooseThemeAndSize`'s `DialogV2` — the same `{traits, excludeTraits}` shape that dialog's own callback already returns, so nothing downstream needed to change. `populateSlotEncounter` (`dungeon-scene.mjs`) — the single choke point every dungeon-room population call goes through (`buildPopulateAndUnlockRoom`, used by both `#onStart` and `resolveCurrentRoom`'s room-to-room progression, and `#onPopulateNext`'s recovery path) — now always passes `skipThemeDialog: true`, since a dungeon run's traits are already final by the time any room gets populated, not just a suggestion.

**1. `scripts/encounter-generator.mjs`.** `generateEncounter` signature gains `skipThemeDialog = false`. The `chooseThemeAndSize` call becomes conditional: skip it and build `theme` from `prefillTraits`/`prefillExcludeTraits` directly when `skipThemeDialog` is true, otherwise unchanged.

**2. `scripts/dungeon-scene.mjs`.** `populateSlotEncounter`'s call into `generateEncounter` adds `skipThemeDialog: true`. Docblock updated — it previously said "the GM still gets the existing theme dialog," which is no longer true for the theme prompt specifically (the Accept/Reroll preview is untouched).

**Tests.** No new unit tests — both functions are `DialogV2`/`canvas`-dependent with no existing pure-function test coverage in this codebase (same precedent as the rest of `dungeon-scene.mjs`/`encounter-generator.mjs`); the change itself is a plain conditional with no new pure logic to isolate.

**Verification.** `npm test` — 553 passing, unchanged (no test surface touched). `npm run validate`/`validate:dungeon` unaffected. Confirmed by tracing every `populateSlotEncounter` call site (`dungeon-app.mjs`'s `buildPopulateAndUnlockRoom` — covering both `#onStart`'s first-real-room build and every subsequent `resolveCurrentRoom` room-to-room advance — and `#onPopulateNext`) all funnel through the same choke point, so the fix applies uniformly to every point in a run where a combat room gets populated, not just the first. The standalone "DOMMT: Generate Encounter" macro's own call (`module.mjs`'s `generateEncounter: (options) => generateEncounter(options)`) never sets `skipThemeDialog`, so its dialog is untouched, matching the Non-goals exactly.

### ITEM-19: Clean up a dungeon run when it's cancelled
**State:** done
**Blocked:** false
**Summary:** Abandoning a dungeon run only cleared its in-memory tracker state — the party's tokens stayed marooned in the deleted-in-spirit dungeon scene, the scene itself was never removed, and every NPC actor the run's encounters had spawned was left behind permanently. The world had accumulated 72 such orphaned NPC actors before this shipped.

#### Spec

**Problem.** `abandonRun` (`dungeon-runner.mjs`) only deleted the run's entry from the `dungeonRuns` world setting — a bookkeeping-only reset. Nothing moved the party's tokens anywhere, nothing deleted the dungeon `Scene`, and nothing touched the NPC `Actor` documents `foundry-api.mjs`'s `spawnCreatures`/`spawnBuiltCreature` create for every single monster/friend/twin/lurker an encounter spawns (`Actor.createDocuments`, confirmed live — a real, permanent world Actor, not an unlinked token-only copy). Investigating the live world turned up 77 total NPC actors, 72 of them with zero tokens anywhere — pure leftovers from past encounters (dungeon or otherwise) whose tokens were long gone but whose Actor record never was.

**Goal.** Cancelling a dungeon run (the tracker's "Abandon Dungeon" button, or the `resetDungeon` API) should: move the party's tokens back to whatever scene they were on before the run started, or Foundry's own built-in "Foundry Virtual Tabletop" default scene if that prior scene is itself gone; delete every NPC actor the run's own encounters spawned; then delete the dungeon scene itself.

**Non-goals.** Auto-teardown on *successful* completion (reaching and resolving the goal room) — only explicit cancellation is in scope; a GM may want to linger in a finished dungeon before leaving. Retroactively fixing every other place this module spawns actors (standalone card-drawn Allies/Enemies via the same `spawnCreatures` primitive) — those are permanent-by-design, not dungeon-run-scoped, and must never be swept up by this. The one-time cleanup of the 77 already-accumulated actors was handled directly, live, rather than through new product code — see Verification.

#### Plan

**1. `dungeon-runner.mjs`.** `createRun` gains `previousSceneId` (default `null`), stored on the run state as `state.previousSceneId` — the scene the GM was viewing right before Start, so a later cancel knows where to send the party back.

**2. `dungeon-scene.mjs`.**
- Extracted `removeActorTokensFromAllScenes(actorId)` from `placePartyInSlot`'s inline loop (an actor should only ever have one token in the world at a time) — now shared with the new teardown path, not duplicated.
- New `placePartyNearSceneCenter(destScene, partyMembers)` — clusters the party near an arbitrary destination scene's own center, using *that* scene's own `grid.size` rather than this module's fixed `GRID_SIZE` constant, since `destScene` (the party's regular scene, or Foundry's default one) is never a scene this module built and can't be assumed to share its grid.
- New exported `teardownDungeonRun(scene, { previousSceneId })`: collects every non-party token's actor id on `scene` (the NPC actors to delete), resolves the destination scene (`previousSceneId` if it still exists, else the scene literally named `'Foundry Virtual Tabletop'`), moves the party there and activates it, deletes the collected NPC actors, then deletes `scene` itself.

**3. `scripts/ui/dungeon-app.mjs`.** `#onStart` captures `canvas?.scene?.id` as `previousSceneId` before `createDungeonScene`/`activate` ever touch `canvas.scene`, threading it into `createRun`. `#onAbandon` now: shows a `DialogV2.confirm` (this got a lot more destructive than a settings-clear, so it needed one — no prior confirm existed), then `abandonRun` (clears the settings entry) followed by `teardownDungeonRun`, then `this.close()` — the app's whole scene context is gone by the time that returns, so re-rendering it doesn't make sense.

**4. `scripts/module.mjs`.** `module.api.resetDungeon` (the scriptable equivalent of the Abandon button) updated to run the same `abandonRun` + `teardownDungeonRun` sequence instead of just `abandonRun`.

**5. `lang/en.json`.** New `DOMMT.Dungeon.AbandonConfirm` key spelling out exactly what's about to happen (party moved, monsters deleted, scene deleted, irreversible).

**Tests.** `tests/dungeon-runner.test.mjs`: two new assertions — `createRun` defaults `previousSceneId` to `null`, and threads through an explicit one when given. `dungeon-scene.mjs`'s new functions get no unit tests — entirely Foundry-document-touching, same precedent as the rest of that file (live-verify only).

**Verification.** `npm test` — 551 passing (1 new). `npm run validate`/`validate:dungeon` unaffected. Live via `foundry-rest`, in two parts:
- **The one-time cleanup**, run directly against the live world rather than through new code: enumerated all 77 non-party NPC actors, cross-referenced against every token in every scene, found 72 with no token anywhere (all clearly `spawnCreatures` leftovers — `ownership.default:0`, `system.details.alliance` set exactly per its override, names matching the deck's own creature roster or bare bestiary copies). Re-verified the same criteria at delete time (a second live query, immediately before deleting) and removed exactly those 72, leaving only the 5 actors backing the world's currently-live encounter.
- **The new `teardownDungeonRun` logic**, replicated faithfully against fully scratch fixtures (a throwaway dungeon-like Scene, a throwaway NPC actor+token on it, a throwaway `character` actor standing in for a party member — the real party and the real active run were never touched): confirmed the NPC actor was correctly identified and deleted, confirmed the party stand-in landed in the destination scene at its computed center (using *that* scene's own grid size, 70, not this module's 100 — the math came out exactly `centerX - grid.size` for the single-member case), confirmed it had exactly one token across every scene afterward (no duplicate left behind), and confirmed the scratch dungeon scene was actually deleted. All scratch fixtures removed afterward; confirmed clean.

### ITEM-14: Token vision is clipped by the scene background instead of actual walls
**State:** done
**Blocked:** false
**Summary:** Selecting a player token collapses most of the visible dungeon into darkness, with only a narrow wedge of vision remaining that cuts across tiles at an angle — as if the scene background art is being read as vision-blocking geometry, rather than the dungeon's own generated walls.

#### Spec

**Problem (confirmed via screenshots `Screenshot 2026-09-18 171956.png` and `Screenshot 2026-09-18 172111.png`, same moment in the same scene).** With no player token selected, the full revealed portion of the dungeon renders normally under grey fog-of-war-explored shading. The instant a party token is selected, nearly the entire scene goes black except a narrow wedge around the token.

**Root cause (revised from the original "background/wall geometry" hypothesis — confirmed live via `foundry-rest` against the actual affected scene, module v0.37.0).** The wall/tile geometry was checked exhaustively and is **not** the problem: every Tile in the scene has no vision/light-blocking flags (`occlusion.mode:0`, no `restrictions`), every Wall is exactly where `dungeon-layout.mjs`/`dungeon-scene.mjs` should have put it (no stray or duplicate segments), and a party token's actual computed line-of-sight polygon correctly spans the entire built dungeon area with no unexpected cutoff. The real cause: the scene had **zero `AmbientLight` documents** — nothing ever placed a real Foundry light source, even though every room's painted art shows lit torches (baked into the image, not a light Foundry's engine knows about). Combined with PF2e's Rules-Based Vision (enabled in the live world) giving a non-darkvision character a computed vision **radius of 0** (confirmed live on the party's own Cleric token, a Leshy with low-light vision — not even darkvision-equipped characters were exempt), a party member standing in a fully-built, fully-walled room had no way to actually see it: the walls were correct, but nothing was lighting the room they enclosed.

**Goal.** A party member without darkvision can see the room they're standing in (and a reasonable amount beyond it) once it's built/revealed, without needing the wall geometry itself to change.

**Non-goals.** Redesigning fog-of-war or token vision behavior generally. Matching each room art variant's painted torch positions exactly — checked several variants directly and torch presence/position is inconsistent across them (e.g. the `construct` line has none at all), so a generic centered room light was chosen over trying to track per-image art.

#### Plan

**Mechanism.** `buildRoomAtSlot` (`dungeon-scene.mjs`) now creates one `AmbientLight` document centered on every room it builds, alongside the walls/tiles it already creates. Sized off the room's own geometry: `ROOM_SIZE` (6 squares) at this scene's 5ft/square grid makes a 30x30ft room whose half-diagonal (center to corner) is ~21.2ft, so `ROOM_LIGHT_BRIGHT = 22` reaches every corner at full brightness and `ROOM_LIGHT_DIM = 40` gives a generous soft falloff beyond the room into its connecting corridor — both expressed in scene units (feet), matching how Foundry's `AmbientLight.config.dim/bright` are defined. A warm torch-like color/alpha (`#ff8844`, `0.35`) matches the painted-torch aesthetic without literally trying to reposition per that art.

**Tests.** No new unit test — like the rest of `dungeon-scene.mjs`'s Foundry-document-building code, this has no pure-function surface to assert against (same precedent as the corridor-tiling loop). `npm test` re-run to confirm no regression (550 passing, unchanged — expected).

**Verification.** Live via `foundry-rest` against the real, currently-active `xrPSYLalV2uwizn4` scene: (1) confirmed zero `AmbientLight` documents existed before this fix; (2) confirmed `rulesBasedVision: true` and the Cleric's live `token.vision.radius === 0` despite having low-light vision, with `scene.environment.darknessLevel === 0`; (3) confirmed the LOS polygon computed for that same token already spans the full built area (`0,0` to `700,600`) — independently ruling out the wall geometry as a contributing factor; (4) added the two lights the fixed code would now generate for this scene's two already-built rooms (center of each, matching `ROOM_LIGHT_*` constants) directly via the relay, repairing the live scene the same way ITEM-16 did. Point-by-point `canvas.visibility.testVisibility` probing (used successfully to verify ITEM-16's mesh positioning) turned out **not** to be a reliable oracle for the *lighting* half of this fix specifically — it returned the same (visible) result with and without the lights present when driven through a GM-context script, most likely because a scripted `token.control()` doesn't fully replicate the render pass a real client-side token selection triggers. The wall-blocking half of the same tool remained trustworthy throughout (it correctly reported a corridor point shadowed by a real wall as not visible). Given that residual gap in tooling, this item's final confirmation is a visual one — ask for a fresh screenshot with a token selected on the now-lit scene.

### ITEM-16: Rotated corridor tiles render one cell off from their declared position
**State:** done
**Blocked:** false
**Summary:** A corridor-end/corridor-mid Tile placed with a non-zero rotation (ITEM-12) renders shifted diagonally into a neighboring grid cell instead of staying in its own, making a multi-square corridor gallery look like it has a stray misplaced tile.

#### Spec

**Problem (confirmed via screenshot `Screenshot 2026-09-18 175152.png`).** A vertical 3-tile corridor gallery (an `end`/`mid`/`end` stack, ITEM-12's own scenario) showed a phantom fourth box one cell up-and-to-the-left of the bottom `end` tile's declared position, while that tile's own declared cell rendered empty. The two unrotated tiles (`rotation:0`) rendered fine; only the 180°-rotated one was affected.

**Root cause, confirmed live via `foundry-rest`.** `buildRoomAtSlot`'s corridor-tiling loop (`dungeon-scene.mjs`) creates every corridor Tile with `texture: { anchorX: 0, anchorY: 0 }` and `x`/`y` as the cell's top-left corner — a pattern introduced correctly in an earlier fix (`f7e49c6`, "Fix room art rendering centered on its own corner") for Tiles that are *never* rotated. ITEM-12 started rotating corridor tiles (90°/180°/270°) for the first time, and PIXI applies `rotation` around the texture's own anchor point. With `anchorX/Y:0` (the texture's top-left corner) as that pivot, rotating spins the tile around its own corner instead of its center, moving its visible footprint into a neighboring cell. Confirmed directly by inspecting the live PIXI mesh of both the broken pattern and the fix: `anchorX/Y:0` with top-left `x,y` renders a 180°-rotated tile centered one full cell up-and-left of where it belongs; Foundry's own default anchor (0.5, 0.5) with `x,y` passed as the cell's *center* keeps the mesh's `anchor`/position exactly matching the intended cell regardless of rotation — the same pattern `scene-divination.mjs` already uses for its own rotated card Tiles (its own comment: "Foundry v14 anchors a Tile on its CENTRE, not its top-left corner").

**Goal.** A rotated corridor tile renders in exactly the grid cell it was placed at, matching an unrotated one.

**Scope.** Only the corridor-tiling loop in `dungeon-scene.mjs`'s `buildRoomAtSlot` (the part ITEM-12 touched). The room-art Tile in the same function is unaffected — it's never rotated, so its existing `anchorX/Y:0` + top-left `x,y` (from `f7e49c6`) stays correct and untouched.

#### Plan

**Fix.** Corridor tiles drop `anchorX: 0, anchorY: 0` (falling back to Foundry's own default center anchor) and pass `x`/`y` as the cell's center (`toPixels(gx+dx) + toPixels(1)/2`, `toPixels(gy+dy) + toPixels(1)/2`) instead of its top-left corner — mirroring `scene-divination.mjs`'s already-correct pattern for rotated Tiles exactly.

**Tests.** No new unit test — this is a Foundry/PIXI rendering behavior with no pure-function surface to assert against (same precedent as the rest of `dungeon-scene.mjs`). `npm test` re-run to confirm nothing else regressed (550 passing, unchanged count — expected, since this file isn't unit-tested).

**Verification.** Live via `foundry-rest` against the real, currently-active `xrPSYLalV2uwizn4` scene (module v0.37.0, already running the ITEM-12/13 code): (1) reproduced the bug directly — a scratch Tile built with the *old* pattern (`anchorX/Y:0`, top-left `x,y`, `rotation:180`) showed mesh `anchor:(0,0)`, `position:(1000,1000)` (its raw declared top-left, unadjusted) — PIXI's own rotation pivot, confirming the mechanism; (2) confirmed the fix — a scratch Tile built with the *new* pattern (`rotation:180`, center `x,y`) showed mesh `anchor:(0.5,0.5)`, `position` exactly at the cell's center; (3) re-created all three of the scene's real corridor tiles with the fixed pattern and got the expected centers (`(650,350)`, `(650,450)`, `(650,550)` for the `gy:3,4,5` cells at `gx:6`) before deleting the scratch copies; (4) **repaired the user's actual broken scene in place** — patched the 3 existing corridor Tile documents there (`GEHt033Jxkx9SAkP`, `QG2vNTKx618zUCuj`, `3RWThEh6ewSVTiOw`) to `anchorX/Y:0.5` and their cell centers, confirmed via a follow-up read that all three now report the corrected `x`/`y`/anchor — so the screenshot's own dungeon run is fixed, not just future ones.

### ITEM-12: Make adjacent hallway connectors read as one continuous corridor
**State:** done
**Blocked:** false
**Summary:** Hallway rooms should have at least one open wall on the sides that open to other hallways, so that the dungeon appears as a linear sequence of connected rooms instead of several disparate, disconnected rooms that are actually connected.

#### Spec

**Problem (confirmed via screenshot `Screenshot 2026-09-18 171616.png`, the same one that motivated ITEM-13).** The gap between two rooms is tiled with `corridor.webp`, one copy per grid square. `corridor.webp` (`assets/dungeon-rooms/corridor.webp`, confirmed by direct inspection) is a small self-contained "box" texture — a floor with a wall painted on all four sides, designed to depict one isolated 1x1 alcove. Tiling that same fully-walled box repeatedly to fill a multi-square gallery (ITEM-9's L-shaped dogleg, still present after ITEM-13 trimmed its length) makes every square show walls on its own top and bottom (or left/right) edges, even on the sides that face the next corridor square and have no real Wall there — the art claims a boundary the Wall geometry doesn't have. The result reads as a stack of separate boxed rooms stitched together, not one hallway, exactly as the screenshot shows and as the item's own summary describes.

**Goal.** A multi-square corridor gallery should read as one continuous hallway: walled along its two real, fixed sides (the sides that back onto each room's own perimeter wall) the whole way through, and open at the seams between consecutive squares — walled only at its two true ends (where the outer cap walls from `buildConnectionGeometry` actually are).

**Scope.** The corridor art and the tile-placement loop in `dungeon-scene.mjs`'s `buildRoomAtSlot` for any gallery longer than one square. A single-square gallery (both doors aligned) keeps using plain `corridor.webp` unchanged — a fully-boxed alcove is correct there, since both of its short ends really are walled. Reconciled with ITEM-13 (already shipped) rather than the other way around, per ITEM-13's own scope note — ITEM-13's trimmed `corridorRect` is exactly the span this item now tiles.

**Non-goals.** Redesigning the room art or door art. Changing `buildConnectionGeometry`'s wall geometry itself — it's already correct (confirmed by ITEM-9/ITEM-13); only the *art* misrepresented it.

#### Plan

**Chosen mechanism.** Derive two new open-sided art assets from the existing `corridor.webp` (same floor style, no new generation) rather than hand-drawing or prompting new art:
- `corridor-mid.webp` — walled only on its left/right, open top and bottom (floor extends edge-to-edge vertically). Used for every tile strictly between the two ends of a gallery.
- `corridor-end.webp` — keeps the top wall, opens the bottom. Used for the two end tiles, each of which needs a wall against the real outer cap and an open side facing inward.

Both are built once in a canonical "wall on top" orientation; `dungeon-scene.mjs` places them with Foundry's own Tile `rotation` (already used elsewhere in this codebase, e.g. `scene-divination.mjs`) to cover all four orientations needed — no extra image files for the rotated cases.

**1. `tools/derive-corridor-connector-art.py`** (new, PIL, mirrors `compose_cards.py`'s ad-hoc-tool precedent — run once, output checked in, not part of the runtime or `npm run art`). Crops the few px of white margin baked into `corridor.webp` (confirmed present at the pixel level, left in it would show as a visible seam every time a tile repeats) and rescales back to 512x512; then, against that clean image, stretches the floor band (found by sampling brightness along the center row/column for the wall/floor shadow line, ~118px wall band on a now-margin-free 512px image) to fill the bottom wall band (`corridor-end.webp`) or both the top and bottom bands (`corridor-mid.webp`), while leaving the left/right wall columns untouched. Run via `.venv/bin/python3 tools/derive-corridor-connector-art.py`, writing `assets/dungeon-rooms/corridor-end.webp` and `corridor-mid.webp` directly (`corridor.webp` itself untouched).

**2. `scripts/dungeon-layout.mjs`** — new pure, unit-tested `corridorTileVariant(index, length, vertical)`, alongside `buildConnectionGeometry` (same pure/no-Foundry-dependency split this file already keeps): `length <= 1` → `{variant:'single', rotation:0}` (plain `corridor.webp`, unchanged behavior). Otherwise `index === 0` or `index === length - 1` → `{variant:'end', rotation}` (0°/180° for a vertical — east/west-connection — gallery, 270°/90° for a horizontal — south-connection — one, rotating the canonical top-wall onto the near/far real wall). Every other index → `{variant:'mid', rotation}` (0° vertical, 90° horizontal — `mid`'s own left/right walls are symmetric, so 90°/270° are equivalent).

**3. `scripts/dungeon-scene.mjs`** — `buildRoomAtSlot`'s corridor-tiling loop replaced: determine `vertical = corridorRect.gh >= corridorRect.gw` and `length` (whichever of `gw`/`gh` is the varying one), call `corridorTileVariant(i, length, vertical)` per tile, and place it with the matching asset (`CORRIDOR_ART_BY_VARIANT` map) and `rotation`. `dx`/`dy` stepping switched from a double loop to a single loop along the gallery's one varying axis (the other axis is always exactly `CORRIDOR_LEN` = 1, so no dimension was lost).

**Tests.**
- `tests/dungeon-layout.test.mjs`: `corridorTileVariant` — length-1 always `single`; length-2 vertical/horizontal both ends, no mid; a longer gallery sandwiches the right count of `mid` tiles between exactly two `end` tiles, for both orientations; swept across every length 1–`ROOM_SIZE` for an exact-count invariant (`endCount === 2`, `midCount === length - 2` for `length > 1`).
- `tests/dungeon-room-art.test.mjs`: `corridor-end.webp`/`corridor-mid.webp` added to the on-disk existence sweep (the "guard on the guard" count bumped by 2).
- `dungeon-scene.mjs`'s own tiling loop gets no unit test — Foundry/`CONST`-touching, same precedent as the rest of that file.

**Verification.** `npm test` — 550 passing (33 in `dungeon-layout.test.mjs`, 6 new for `corridorTileVariant`; 36 in `dungeon-room-art.test.mjs`, 2 new for the derived assets). `npm run validate`/`validate:dungeon` unaffected. Visually verified by rendering the derived assets at actual in-game tile scale (100x100px) in composited preview strips before and after generation: a 4-tile vertical gallery (`end, mid, mid, end` rotated 180°) reads as one continuous walled hallway open at every internal seam, closed only at its two true ends; a 2-tile gallery (both `end`, no `mid`) likewise; a 3-tile horizontal gallery, rotated for a south/row-wrap connection, confirms the rotation mapping holds on that axis too. Confirmed directly against real seeded geometry: `buildConnectionGeometry(0, 'demo2').corridorRect` (`{gx:6, gy:2, gw:1, gh:2}`) fed through the new loop's own `vertical`/`length` derivation produces exactly `[{variant:'end',rotation:0}, {variant:'end',rotation:180}]`, matching the 2-tile case with no `mid` tile.

### ITEM-13: Corridor tile count should match the actual door-to-door gap
**State:** done
**Blocked:** false
**Summary:** The hallway between two rooms is always rendered as a full room-face's worth of corridor tiles (6, at current constants), regardless of how far apart the two rooms' doors actually are — a screenshot shows a 6-tile hallway between two doors that sit only ~1-2 tiles apart. Corridor tile count should equal the real door-to-door offset.

#### Spec

**Problem (confirmed via screenshot `Screenshot 2026-09-18 171616.png`).** The corridor between two rooms renders as 6 stacked grid tiles, but the two rooms' doors are visibly close together near the top of their shared wall — only about 1-2 grid units apart. The corridor art doesn't reflect the actual passable gap between the doors.

**Root cause.** Two independent pieces of geometry are conflated:
1. **Door position varies per room.** `dungeon-layout.mjs`'s `doorOffsetAt(seed, slot, direction)` independently randomizes each room's door offset along its connecting wall, in `[0, ROOM_SIZE - DOOR_WIDTH]` (`[0,5]` at current constants) — by design, "so the two doors often don't line up" (per the function's own docblock). `buildConnectionGeometry` uses `outgoingOffset`/`incomingOffset` to place each room's own door wall segment correctly.
2. **Corridor art ignores door position entirely.** `corridorRect` (also from `buildConnectionGeometry`) is always sized to the *entire* connecting face — `corridorRect.gw = ROOM_SIZE` for a south connection (`dungeon-layout.mjs:167`), `CORRIDOR_LEN` deep — not to the span between the two actual door offsets. `dungeon-scene.mjs`'s `buildRoomAtSlot` (lines ~122-130) then double-loops `dx`/`dy` over the full `corridorRect.gw × corridorRect.gh`, stamping one `corridor.webp` Tile per grid square across the whole face — 6 tiles wide regardless of where the two doors actually sit within that face.

The result: the corridor's rendered width/length is tied to the fixed `ROOM_SIZE` constant, while the real passable door-to-door distance is tied to the two independently-random `doorOffsetAt` values — two unrelated code paths that were never reconciled.

**Goal.** The visible corridor art (and, if relevant, its walkable footprint) should span only the actual gap between the outgoing door and the incoming door, not the full room face — so a dungeon with doors close together shows a short hallway, and doors far apart show a longer one, matching what the player can actually see and walk through.

**Scope.** `buildConnectionGeometry`'s `corridorRect` computation (`dungeon-layout.mjs`) for both east/west and south connections, and the corridor-tiling loop in `dungeon-scene.mjs`'s `buildRoomAtSlot`. Needs to account for both doors' offsets (`outgoingOffset`/`incomingOffset`) when sizing/positioning the corridor rect, not just the fixed room/corridor constants. Also needs to be checked against ITEM-7 (half-grid-square door misalignment) and ITEM-12 (adjacent hallway connectors reading as one continuous corridor) — all three touch the same `buildConnectionGeometry`/corridor-tiling code and should be reconciled together rather than patched independently, to avoid one fix re-breaking another.

**Non-goals.** Changing how door offsets are randomized (`doorOffsetAt` itself) — the per-room randomization is intentional; only how the corridor art responds to it needs to change. Wall/collision geometry beyond what's needed to keep the corridor visually and mechanically consistent — full re-validation of wall placement is part of the fix, not a scope expansion.

#### Plan

**Chosen fix.** `buildConnectionGeometry`'s room-perimeter wall segments (each room's own solid wall minus its own door/gap) already correctly span the *entire* connecting face regardless of the other side's offset — that part is correct and unchanged; a room's own wall shouldn't depend on where the neighboring room's door sits. What was wrong was the shared 1-square-wide *gap column* between the two faces: it was always capped at the room's own top/bottom (or left/right) edges (`gy`/`gy+gh`, or `gx`/`gx+gw`), rather than at the actual span the two doors need. Fix: compute `spanY0 = Math.min(doorY0, gapY0)` / `spanY1 = Math.max(doorY1, gapY1)` (transposed to `spanX0`/`spanX1` for a south connection) and use those — instead of the room's own face bounds — for (a) the two capping wall segments that close off the gap column, and (b) `corridorRect`'s position/size. No other geometry (door walls, reveal-door walls, room-perimeter `plainWalls` segments, `roomEnclosureWalls`) needed to change. `dungeon-scene.mjs`'s corridor-tiling loop already iterates generically over `corridorRect.gw × corridorRect.gh`, so it needed no change at all — it now simply tiles a smaller (or larger) rect automatically.

**1. `scripts/dungeon-layout.mjs`.** In `buildConnectionGeometry`, both branches (east/west and south) gain the `spanY0`/`spanY1` (or `spanX0`/`spanX1`) computation right after the door/gap coordinates, and the two cap-wall segments plus `corridorRect` are rebuilt from those spans instead of `gy`/`gy+gh` (or `gx`/`gx+gw`). Docblock updated to describe the trimmed-gap-column behavior instead of ITEM-9's "always the full face" description.

**2. `tests/dungeon-layout.test.mjs`.** Three tests that encoded the old "always full face regardless of seed" contract were rewritten: `corridorRect`'s height/width now asserted to equal `max(outgoing,incoming)+DOOR_WIDTH-min(outgoing,incoming)` rather than a fixed `ROOM_SIZE`; a new test confirms the size actually varies across seeds (closely-offset vs. far-apart doors); the "flush against the room" test loosened from "spans full height" to "stays within the room's face." No other existing test needed to change — the door/reveal-door placement, integer-coordinate, degenerate-segment-dropping, and no-duplicate-segment tests all still hold under the trimmed geometry.

**Non-goals unaffected.** `doorOffsetAt`'s randomization itself, and all wall/collision geometry outside the gap column, are untouched, matching the Spec. ITEM-7 (integer alignment) isn't disturbed — both span bounds are sums of already-integer offsets. ITEM-12 (adjacent hallways reading as one corridor) remains a separate, unimplemented backlog item; this change doesn't block or interact with it since ITEM-12 hasn't touched this code yet.

**Verification.** `npm test` — 542 passing (27 in `dungeon-layout.test.mjs`, 3 rewritten + 2 new for the trimmed-span contract). `npm run validate`/`validate:dungeon` unaffected (no dungeon-layout dependency). Confirmed directly via a scratch `buildConnectionGeometry(0, 'demo')` call: offsets `outgoing:3, incoming:4` (adjacent) now produce `corridorRect: {gx:6, gy:3, gw:1, gh:2}` — a 2-tile hallway — with cap walls at `y=3` and `y=5` sealing off the unused gallery space, instead of the old fixed `gh:6` spanning the whole room face.

### ITEM-11: Prepend a safe entry room, exit always unlocked
**State:** done
**Blocked:** false
**Summary:** The first room of a dungeon crawl is always a safe room with no encounter, trap or puzzle — an entry vestibule that doesn't count toward the dungeon's room count, whose exit door is unlocked immediately rather than gated behind a GM click.

#### Spec

**Problem/Goal.** Every room (including the original room 0) drew from the same weighted kind pool, so a dungeon could — and often would — open directly into a fight. The user wants the party to always start somewhere safe: no encounter, trap, or puzzle, an entry the party can freely walk out of without any GM action, and this entry shouldn't count against the room count the GM actually asked for (a 6-room dungeon should still mean 6 real rooms, plus the entry).

**Mechanism.**
1. `dungeon-deck.mjs`'s `buildRoomSequence` always prepends one `kind: 'safe_entry'` room (`id: 'room-entry'`, `outcomeSlotId: null`, `setpieceId: null`) ahead of the `roomCount` real rooms it already built — `roomCount`'s own meaning and validation are unchanged, the entry is purely additive.
2. `dungeon-runner.mjs`'s `createRun` pre-assigns the *first real room's* physical slot (1) right away, alongside the entry's own slot 0 — normally a room's slot is only assigned when `markRoomOutcome` resolves the room before it, but the entry has nothing to resolve (`markRoomOutcome` itself now guards against being called on a room with no `outcomeSlotId` and no goal, returning a no-op instead of crashing on a null outcome template).
3. `dungeon-app.mjs`'s `#onStart` builds the entry room (always safe, so the old `if (room0.kind === 'combat')` special-case is dead code and removed) and then immediately builds, populates (if needed) and unlocks the *first real room* too, using a helper (`buildPopulateAndUnlockRoom`) factored out of `resolveCurrentRoom` so both paths share the exact same build/populate/unlock logic. `currentIndex` stays at 0 (the party is still standing in the entry) until they actually walk to and open the first real room's own reveal door (ITEM-10's existing mechanism, unchanged) — only the *gate* door's unlock is moved earlier, from "after a GM clicks Mark Succeeded" to "immediately at Start."
4. The tracker UI shows neither the plain Succeed/Fail buttons nor the combat UI while standing in the entry (a new `isSafeEntry` flag) — just a hint that the way onward is already open. The room-count display (`roomNumber`/`roomTotal`) is computed to exclude the entry, so a GM sees "room 1 of 6," not "room 2 of 7."

**Non-goals.** Any kind of resolution/outcome for the entry room — it deliberately has none. Changing anything about how the first *real* room's own discovery (reveal door) works — only its gate door's timing changes.

#### Plan

Implemented directly (composes entirely out of already-existing, already-verified primitives — `buildRoomAtSlot`/`populateSlotEncounter`/`unlockDoorToSlot`, all unchanged): `dungeon-deck.mjs` (entry room prepend), `dungeon-runner.mjs` (`createRun`'s pre-assignment, `markRoomOutcome`'s no-op guard), `dungeon-app.mjs` (`buildPopulateAndUnlockRoom` extraction, `#onStart`'s auto-advance, `_prepareContext`'s `isSafeEntry`/adjusted room-count display), `dungeon-tracker.hbs` (safe-entry branch), `lang/en.json` (two new keys). `tests/dungeon-deck.test.mjs` and `tests/dungeon-runner.test.mjs` both updated substantially for the new room-count-plus-one, pre-assigned-slot-1, and no-op-on-the-entry contracts.

**Verification.** `npm test` — 542 passing. `npm run validate`/`validate:dungeon`/`validate:creature-art` unaffected. Live-verified via `foundry-rest` in a scratch scene: a door created `LOCKED` (matching how `buildRoomAtSlot` always creates a gate door) is confirmed unlocked to `CLOSED` by the same update `buildPopulateAndUnlockRoom`'s non-combat branch performs, with no GM click in between, and a player can then open it — directly confirming "the exit from this room is always visible." The higher-level orchestration (which room gets auto-advanced, when) is unit-tested rather than re-verified live, since it's pure composition of primitives already live-verified in ITEM-6/9/10.

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
**Required-by:** ITEM-18
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
