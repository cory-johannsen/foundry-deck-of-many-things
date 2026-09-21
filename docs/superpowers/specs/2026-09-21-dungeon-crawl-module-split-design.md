# Split the dungeon-crawl subsystem into `foundry-pf2e-dungeon-crawl`

**Issue:** [cory-johannsen/foundry-deck-of-many-things#180](https://github.com/cory-johannsen/foundry-deck-of-many-things/issues/180)
**Related:** ITEM-18 / #93 (paused pending this split's creature-art decision)

## Goal

Split the dungeon-crawl subsystem (rooms, combat AI, encounter generation,
traps, pathfinding, layout, token art) out of `deck-of-many-more-things` into
its own Foundry module, `foundry-pf2e-dungeon-crawl` (repo already created,
currently empty). `deck-of-many-more-things` keeps the card deck and Celtic
Cross divination, and becomes one possible *generator* that can drive the
dungeon-crawl module rather than owning dungeon-crawl mechanics directly. The
dungeon-crawl module defines a generator interface and ships a default
implementation, so it works standalone or driven by a generator other than
this deck.

## Module boundary

The issue's own file grounding turned out to be unreliable in several
places once checked against the actual `import` graph (traced
programmatically from every `from './x.mjs'` edge in `scripts/`, starting
from each side's genuine entry points — `ui/dungeon-app.mjs`,
`dungeon-remote.mjs`, `dungeon-scene.mjs`, `dungeon-runner.mjs`,
`dungeon-permissions.mjs`, `encounter-generator.mjs` for dungeon-crawl;
`ui/deck-app.mjs`, `ui/divination-app.mjs`, `draw-run.mjs`,
`scene-divination.mjs`, `charge-sound.mjs`, `keep-one.mjs`,
`death-avatar.mjs`, `warrior-template.mjs`, `gm-resolution.mjs`,
`card-effects.mjs` for the deck). The boundary below is the verified result,
not the issue's original list.

### Moves to `foundry-pf2e-dungeon-crawl`

- `scripts/dungeon-combat.mjs`, `dungeon-deck.mjs`, `dungeon-layout.mjs`,
  `dungeon-permissions.mjs`, `dungeon-remote.mjs`, `dungeon-runner.mjs`,
  `dungeon-scene.mjs`, `dungeon-sound.mjs`
- `scripts/encounter-deck.mjs`, `encounter-generator.mjs`,
  `encounter-roster.mjs`
- `scripts/trap-library.mjs`
- `scripts/pathfinding.mjs`, `agent-candidates.mjs`, `combat-rewards.mjs`
- `scripts/puzzle.mjs`, `puzzle-mechanics.mjs`
- `scripts/skill-challenge.mjs`, `skill-challenge-mechanics.mjs`
- `scripts/narrative-mechanics.mjs`
- `scripts/trait-picker.mjs` — used only by `encounter-generator.mjs` and
  `dungeon-app.mjs`, despite the issue listing it as deck-side.
- `scripts/ui/dungeon-app.mjs`
- `scripts/creature-art.mjs`, `data/creature-art.json`,
  `assets/creature-art/`, `docs/creature-art-todo.csv`,
  `tools/generate-token-art.mjs`, `tools/check-token-art.mjs`,
  `tools/make-bg-transparent.mjs`, `tools/validate-creature-art.mjs`
- `data/dungeon-setpieces.json`
- `tools/agent-loop`, `docs/superpowers/specs/2026-09-20-agent-bridge-combat-ai-design.md`

Each moved `.mjs` file's corresponding test file (e.g.
`tests/dungeon-layout.test.mjs`) moves with it.

`styles/deck.css`'s `.dommt-dungeon*` rules (the dungeon tracker UI) and
`.dommt-trait-field*` rules (trait-picker's own styles, since
`trait-picker.mjs` moves) move into a new `styles/dungeon.css` in the new
module, referenced from its own `module.json`'s `styles` array.

**Not moving, despite the issue listing them as dungeon-crawl candidates:**
`gm-resolution.mjs` and `npc-benchmark.mjs` have no dungeon-crawl involvement
at all — `gm-resolution.mjs` is the general "GM confirms a card effect it
couldn't auto-apply" flow (imported only by `module.mjs` and `draw-run.mjs`),
and `npc-benchmark.mjs` is NPC-statblock-by-level data used only by
`death-avatar.mjs`/`warrior-template.mjs` (the Skull/Knight cards building a
creature from nothing). Both stay in the deck module as ordinary deck-only
files.

### Stays in `deck-of-many-more-things` (deck-only, no cross-module exposure needed)

`scripts/deck.mjs`, `card-effects.mjs`, `card-handlers-extra.mjs`,
`card-handlers-narrative.mjs`, `card-sound.mjs`, `charge-sound.mjs`,
`choice-routing.mjs`, `death-avatar.mjs`, `dice.mjs`, `draw-run.mjs`,
`draw-target.mjs`, `effect-plan.mjs`, `gm-resolution.mjs`, `i18n.mjs`,
`keep-one.mjs`, `npc-benchmark.mjs`, `scene-divination.mjs`,
`warrior-template.mjs`, `ui/card-message.mjs`, `ui/deck-app.mjs`,
`ui/divination-app.mjs`.

`effect-plan.mjs`, `dice.mjs` and `i18n.mjs` were originally thought to need
shared-infra treatment, but that was based on `gm-resolution.mjs` wrongly
being treated as dungeon-side; none of the three is ever imported from the
dungeon-crawl side, so they need no cross-module exposure.

### Shared infra (stays here, consumed via Foundry module dependency)

`scripts/foundry-api.mjs`, `data-loader.mjs`, `prng.mjs`, `audio.mjs`,
`choice-prompts.mjs`, `player-choice.mjs`, `cover-items.mjs`,
`placement.mjs`, `treasure.mjs`, `trap-combat.mjs`, `trap-mechanics.mjs`.

Each is here because a moving file needs it transitively through
`foundry-api.mjs` (`placement.mjs`, `cover-items.mjs`, `treasure.mjs`,
`trap-combat.mjs` → `trap-mechanics.mjs`, all imported by `foundry-api.mjs`
directly) or because `dungeon-remote.mjs` imports `player-choice.mjs`
directly (which itself imports `choice-prompts.mjs`). All eleven stay here
rather than moving, so neither module ends up with a dangling import or a
duplicated copy.

### More gaps found during Task 5 (discovered during implementation)

Task 5 (stripping the old repo) surfaced further items the original file
analysis missed, since none of them showed up via the `import`-graph
method — they're either runtime fetch-path literals or files with no
`.mjs` importer at all (templates, npm-script-only tools):

**Genuinely missed — moved to `foundry-pf2e-dungeon-crawl`, deleted here:**
- `tools/import-token.mjs`, `tools/token-prompts.mjs` — companion tools to
  `generate-token-art.mjs` (Task 4), both importing directly from it
  (`./generate-token-art.mjs`); `import-token.mjs` was flat-out broken in
  this repo after Task 4/5 (its import target no longer exists here).
- `tools/validate-dungeon-setpieces.mjs` — the new repo's own
  `package.json` (`validate:dungeon` script) already referenced this file
  from Task 1, but the file itself was never copied.
- `data/schema/dungeon-setpieces.schema.json` — `validate-dungeon-setpieces.mjs`'s
  load-time schema dependency, same class of gap as `creature-art.schema.json`
  in Task 4.
- `docs/token-prompts.md` — `token-prompts.mjs`'s own generated-output
  target.
- The new repo's `package.json` needs `tokens:import`/`prompts` npm
  script entries added (mirroring the old repo's, now-removed ones) once
  these tools land there.

**Confirmed correctly positioned, no action needed** (same "MODULE_ID
stays pinned to the owning module" pattern as the room-art/dungeon-sound
assets below): `templates/dungeon-tracker.hbs` (`dungeon-app.mjs` builds
its path from a hardcoded `MODULE_ID = "deck-of-many-more-things"`),
`templates/encounter-chat.hbs` (same, from `encounter-generator.mjs`),
and `styles/deck.css`'s `.dommt-encounter__*` rules (styles for that
template, which stays here too).

**Real functional break found and fixed:** `data-loader.mjs`'s
`loadDungeonSetpieces()`/`loadCreatureArt()` build their fetch path from
the same file-level `MODULE_ID = "deck-of-many-more-things"` constant
`loadCards()`/`loadCelticCross()` use — but unlike those two, the actual
JSON files they read (`data/dungeon-setpieces.json`, `data/creature-art.json`)
moved to the new repo in Task 2/4. Left as-is, both functions would 404 at
runtime the instant `pf2e-dungeon-crawl`'s `dungeon-scene.mjs`/
`encounter-generator.mjs`/`dungeon-app.mjs` called them (which they do,
via the cross-repo shared-infra import). Fix: these two functions build
their fetch path from a second constant, `DUNGEON_MODULE_ID = "pf2e-dungeon-crawl"`,
instead — `loadCards`/`loadCelticCross` are untouched.

### Room-art and dungeon-sound assets stay behind too (discovered during implementation)

`dungeon-scene.mjs`'s `ROOM_ART_DIR` and `dungeon-sound.mjs`'s `SOUND_DIR`
hardcode `MODULE_ID = "deck-of-many-more-things"` and build their runtime
asset paths from it (`modules/deck-of-many-more-things/assets/dungeon-rooms/...`,
`.../assets/sounds/...`). This never showed up in the import-graph analysis
above, since it's a runtime path string literal, not an `import` statement.

`assets/sounds/` is a genuinely shared flat directory — `dungeon-sound.mjs`'s
own `SPELL_HIT_SOUND` constant points at `card-arcane.ogg`, a card-sound
asset also used by `card-sound.mjs` — so it cannot be split between the two
repos. `assets/dungeon-rooms/` was never scheduled to move either.
`dungeon-scene.mjs`'s `MODULE_ID` additionally namespaces dozens of
Wall/Token/Scene flag reads/writes throughout the file, not just the asset
path, so renaming it would be a large, separately-scoped refactor with no
functional benefit (Foundry doesn't care which id a flag is namespaced
under) and would conflict with the "no live migration for run state"
decision above (existing flags on a live world's documents would silently
stop resolving).

**Ruling:** `MODULE_ID` stays `"deck-of-many-more-things"` in both files,
even though the `.mjs` files themselves move to the new module.
`assets/dungeon-rooms/` and `assets/sounds/` stay in
`deck-of-many-more-things` permanently, alongside the eleven shared-infra
scripts — this is the intended end state, not a defect for a later task to
fix. A future maintainer wanting true asset/namespace independence for the
new module faces a bounded, mechanical follow-up (copy the two asset
directories, rename `MODULE_ID` at every flag call site in
`dungeon-scene.mjs`), not a redesign.

### `module.mjs` splits

`scripts/module.mjs` is the one file genuinely shared by intent (it's the
init/ready entry point for both subsystems today) rather than by the graph.
Its dungeon-related pieces move to the new module's own `module.mjs`: the
`dungeonRuns` and `agentLoopHeartbeat` world settings, the
`DungeonApp`/`resolveCurrentRoom` import and its macro/hook wiring, the
`handleDungeonDoorOpened`/`teardownDungeonRun` hooks, and the "DOMMT:
Generate Encounter"/"DOMMT: Dungeon Crawl" macro definitions (plus their
`assets/icons/macro-encounter.webp`/`macro-dungeon.webp` icons). Everything
else in `module.mjs` — deck settings, deck macros, the deck/divination
hooks — stays.

`foundry-pf2e-dungeon-crawl`'s `module.json` declares
`deck-of-many-more-things` under `relationships.requires`, and its moved
scripts import these shared files directly from this module's `scripts/`
tree (same mechanism Foundry already uses for cross-module dependencies —
load order guaranteed by the manifest relationship). `deck-of-many-more-things`
does **not** depend on `foundry-pf2e-dungeon-crawl` — it can run standalone
with no dungeon-crawl functionality.

## Module identity and cross-repo imports

The new module's Foundry package id is `pf2e-dungeon-crawl` (the repo is
named `foundry-pf2e-dungeon-crawl`, matching this repo's own precedent of
repo name differing from package id — `foundry-deck-of-many-things` repo,
`deck-of-many-more-things` id).

Foundry installs modules into sibling directories named after their package
id (`Data/modules/<id>/`), regardless of source repo name. So at runtime, a
moved file importing shared infra uses a relative path keyed to the
**package id**, e.g. from `foundry-pf2e-dungeon-crawl/scripts/dungeon-combat.mjs`:

```js
import { makeFoundryApi } from "../../deck-of-many-more-things/scripts/foundry-api.mjs";
```

This is correct for the real deployed layout but won't resolve during local
`npm test`, since local git checkouts are cloned under whatever directory
names the developer chose (in this environment, `~/src/foundry-deck-of-many-things`
and `~/src/foundry-pf2e-dungeon-crawl` — package-id-named path, not
repo-name-named). `foundry-pf2e-dungeon-crawl`'s `vitest.config.mjs` adds a
`resolve.alias` redirecting the `../../deck-of-many-more-things/scripts/`
prefix to the actual local sibling checkout path
(`path.resolve(__dirname, '../foundry-deck-of-many-things/scripts')`), so
production import paths stay correct for Foundry's real layout while local
tests still resolve. If a developer's local clone lives somewhere else, the
alias's relative path needs adjusting — this is a one-line, obvious fix,
not a design concern.

## Generator interface

`foundry-pf2e-dungeon-crawl` exposes a registration point on its module API:

```js
game.modules.get('pf2e-dungeon-crawl').api.registerGenerator(generatorObj);
```

A generator is a plain, duck-typed object (matching this codebase's existing
`game.modules.get(id).api = {...}` convention) implementing:

- `buildRoomSequence({ seed, roomCount, setpieceIds, narrativeSetpieceIds }) => Room[]`
- `findOutcomeTemplate(outcomeSlotId) => OutcomeSlotTemplate`
- `resolveRoomOutcome(outcomeSlotTemplate, succeeded) => { effectKey, mutation }`
- `applySequenceMutation(rooms, currentIndex, mutation, ctx) => Room[]`
- `generateEncounterRoster({ resolved, api, partyLevel, traits, excludeTraits, levelOffsetBias, requireTrait, partySize }) => roster`

This is exactly `dungeon-deck.mjs`'s and `encounter-roster.mjs`'s current
exported shape, formalized into a swappable contract instead of hardcoded
imports. `foundry-pf2e-dungeon-crawl` ships a `DefaultGenerator` built from
that existing logic verbatim, and self-registers it during its own `ready`
hook if nothing has registered a generator yet — so the module is fully
functional standalone.

`deck-of-many-more-things` does not need a custom generator for this split:
its `module.mjs` does not call `registerGenerator`, and
`foundry-pf2e-dungeon-crawl`'s own default takes over. This keeps the door
open for a future card effect to register a deck-flavored generator later
without requiring one now.

`startDungeonRun`, `createRun`, the dungeon-related macros ("DOMMT: Generate
Encounter", "DOMMT: Dungeon Crawl" — plus their `macro-encounter.webp`/
`macro-dungeon.webp` icons) and UI move to the new module wholesale.
Internally they call whatever generator is currently registered instead of
importing `dungeon-deck.mjs`/`encounter-roster.mjs` functions directly.

## Creature art migration

Per the issue's own flagged ambiguity and ITEM-18's paused, in-flight state:
creature art moves to `foundry-pf2e-dungeon-crawl`, since it exists to
illustrate dungeon-crawl encounters and travels naturally with
`encounter-generator.mjs`/`encounter-roster.mjs`.

- Copy `data/creature-art.json`, `assets/creature-art/`,
  `docs/creature-art-todo.csv`, and the `generate-token-art.mjs` pipeline
  (plus `check-token-art.mjs`/`make-bg-transparent.mjs`/
  `validate-creature-art.mjs`) into the new repo verbatim. Git history is not
  preserved for these — they're generated assets, not authored source worth
  carrying across a repo boundary.
- Verify the ~500+ existing entries and the `STYLE`/`NEGATIVE` prompt
  constants in `generate-token-art.mjs` are intact and functional in the new
  repo before deleting them from this one.
- Update issue #93 with a comment pointing ITEM-18's resume state at the new
  repo's paths, so the paused effort resumes there instead of here.

## World-state migration

The live `dungeonRuns` world setting (keyed by scene id) is abandoned as
part of a clean cutover — no migration code reads or rewrites it under the
new module's namespace. There is no in-progress dungeon run in the test
world worth preserving through this change.

## Related issues

`#134`–`#139` and `#162`–`#167` (room-content mechanics: traps, puzzles,
skill challenges, narrative core mechanics, template libraries, agent
customization) transfer to `foundry-pf2e-dungeon-crawl` as part of this
effort, since their subject matter is moving there. GitHub's built-in
cross-repo issue transfer is used rather than manual recreation, to preserve
issue numbers, comments and history where possible.

## Testing

- Every moved `.mjs` file's existing unit tests move with it and must pass
  unchanged in the new repo (same `npm test` runner setup, mirrored into the
  new repo's `package.json`).
- New tests for the generator registration point: registering a generator
  makes it the active one; no registration falls back to `DefaultGenerator`;
  `DefaultGenerator`'s behavior is byte-for-byte the same as current
  `dungeon-deck.mjs`/`encounter-roster.mjs` (existing test suites moved
  over should already cover this, since the logic itself doesn't change).
- `npm run validate` / `validate:dungeon` equivalents move with their
  underlying data files.
- Live verification via the `foundry-rest` skill, once both modules are
  installed in the test world: start a dungeon run, confirm encounters
  populate, confirm the shared-infra dependency resolves (no missing-module
  errors), confirm creature art renders on spawned tokens.

## Rollout sequencing

This is a large split, sequenced as several PRs rather than one atomic
commit:

1. Scaffold `foundry-pf2e-dungeon-crawl`: `module.json` (with the
   `relationships.requires` dependency on `deck-of-many-more-things` and
   package id `pf2e-dungeon-crawl`), `package.json` mirroring this repo's
   `vitest`-based test setup, and a `vitest.config.mjs` with the
   shared-infra path alias described above.
2. Move the dungeon-crawl `.mjs` files and their tests into the new repo,
   using the real package-id-keyed cross-module import path
   (`../../deck-of-many-more-things/scripts/...`) for shared infra from the
   start — the vitest alias from step 1 makes `npm test` resolve it locally
   immediately, so there's no temporary-copy step to later undo.
3. Build the generator interface (`registerGenerator` API) and
   `DefaultGenerator`; wire `startDungeonRun`/`createRun`/UI/macros to call
   the registered generator instead of importing `dungeon-deck.mjs`
   directly.
4. Migrate creature art (data, assets, tooling, docs) into the new repo;
   verify; update #93.
5. Strip all moved code/data from `deck-of-many-more-things`; bump both
   modules' `module.json` versions.
6. Transfer #134–139 and #162–167 to the new repo.
7. Live-verify via `foundry-rest` with both modules installed in the test
   world.

## Out of scope

- Any change to the physical 66-card deck's own mechanics or the Celtic
  Cross divination.
- A published shared npm package for the utility files (Foundry module
  dependency is sufficient at this scale; revisit only if a third consumer
  ever needs these utilities).
- A deck-specific custom generator (left for future work, once a concrete
  card effect wants dungeon-crawl behavior the default doesn't provide).
