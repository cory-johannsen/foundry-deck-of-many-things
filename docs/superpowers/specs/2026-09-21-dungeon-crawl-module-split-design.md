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

### Moves to `foundry-pf2e-dungeon-crawl`

- `scripts/dungeon-combat.mjs`, `dungeon-deck.mjs`, `dungeon-layout.mjs`,
  `dungeon-permissions.mjs`, `dungeon-remote.mjs`, `dungeon-runner.mjs`,
  `dungeon-scene.mjs`, `dungeon-sound.mjs`
- `scripts/encounter-deck.mjs`, `encounter-generator.mjs`,
  `encounter-roster.mjs`
- `scripts/trap-combat.mjs`, `trap-library.mjs`, `trap-mechanics.mjs`
- `scripts/pathfinding.mjs`, `placement.mjs`, `agent-candidates.mjs`,
  `npc-benchmark.mjs`, `gm-resolution.mjs`, `combat-rewards.mjs`,
  `cover-items.mjs`
- `scripts/puzzle.mjs`, `puzzle-mechanics.mjs`
- `scripts/skill-challenge.mjs`, `skill-challenge-mechanics.mjs`
- `scripts/narrative-mechanics.mjs`
- `scripts/ui/dungeon-app.mjs`
- `scripts/creature-art.mjs`, `data/creature-art.json`,
  `assets/creature-art/`, `docs/creature-art-todo.csv`,
  `tools/generate-token-art.mjs`, `tools/check-token-art.mjs`,
  `tools/make-bg-transparent.mjs`, `tools/validate-creature-art.mjs`
- `data/dungeon-setpieces.json`
- `tools/agent-loop`, `docs/superpowers/specs/2026-09-20-agent-bridge-combat-ai-design.md`

Each moved `.mjs` file's corresponding test file (e.g.
`tests/dungeon-layout.test.mjs`) moves with it.

### Stays in `deck-of-many-more-things` (deck-focused)

`scripts/deck.mjs`, `card-effects.mjs`, `card-handlers-extra.mjs`,
`card-handlers-narrative.mjs`, `card-sound.mjs`, `charge-sound.mjs`,
`choice-prompts.mjs`, `choice-routing.mjs`, `death-avatar.mjs`,
`draw-run.mjs`, `draw-target.mjs`, `keep-one.mjs`, `player-choice.mjs`,
`scene-divination.mjs`, `trait-picker.mjs`, `warrior-template.mjs`.

### Shared infra (stays here, consumed via Foundry module dependency)

`scripts/foundry-api.mjs`, `data-loader.mjs`, `prng.mjs`, `dice.mjs`,
`audio.mjs`, `i18n.mjs`, `treasure.mjs`, `effect-plan.mjs`.

`treasure.mjs` is imported directly by `foundry-api.mjs`; `effect-plan.mjs`
is imported by both dungeon-side `gm-resolution.mjs` and deck-side
`keep-one.mjs`/`draw-run.mjs`. Both stay here rather than moving, so neither
module ends up with a dangling import or a duplicated copy.

`foundry-pf2e-dungeon-crawl`'s `module.json` declares
`deck-of-many-more-things` under `relationships.requires`, and its moved
scripts import these shared files directly from this module's `scripts/`
tree (same mechanism Foundry already uses for cross-module dependencies —
load order guaranteed by the manifest relationship). `deck-of-many-more-things`
does **not** depend on `foundry-pf2e-dungeon-crawl` — it can run standalone
with no dungeon-crawl functionality.

## Generator interface

`foundry-pf2e-dungeon-crawl` exposes a registration point on its module API:

```js
game.modules.get('pf2e-dungeon-crawl').api.registerGenerator(generatorObj);
```

A generator is a plain, duck-typed object (matching this codebase's existing
`game.modules.get(id).api = {...}` convention) implementing:

- `buildRoomSequence({ seed, roomCount, setpieceIds, narrativeSetpieceIds }) => Room[]`
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
Encounter", "DOMMT: Open Dungeon Tracker") and UI move to the new module
wholesale. Internally they call whatever generator is currently registered
instead of importing `dungeon-deck.mjs`/`encounter-roster.mjs` functions
directly.

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
   `relationships.requires` dependency on `deck-of-many-more-things`),
   `package.json`, test runner config, CI, README.
2. Move the dungeon-crawl `.mjs` files and their tests into the new repo;
   get `npm test` green there against the shared-infra files copied
   temporarily (not yet wired via the real dependency) just to unblock this
   step, OR wire the real cross-module import path from the start if the
   local dev/test setup can resolve it — implementation plan decides which
   is less friction.
3. Build the generator interface (`registerGenerator` API) and
   `DefaultGenerator`; wire `startDungeonRun`/`createRun`/UI/macros to call
   the registered generator instead of importing `dungeon-deck.mjs`
   directly.
4. Wire the real Foundry module dependency for shared infra
   (`foundry-api.mjs`, `data-loader.mjs`, `prng.mjs`, `dice.mjs`,
   `audio.mjs`, `i18n.mjs`, `treasure.mjs`, `effect-plan.mjs`), removing any
   temporary copies from step 2.
5. Migrate creature art (data, assets, tooling, docs) into the new repo;
   verify; update #93.
6. Strip all moved code/data from `deck-of-many-more-things`; bump both
   modules' `module.json` versions.
7. Transfer #134–139 and #162–167 to the new repo.
8. Live-verify via `foundry-rest` with both modules installed in the test
   world.

## Out of scope

- Any change to the physical 66-card deck's own mechanics or the Celtic
  Cross divination.
- A published shared npm package for the utility files (Foundry module
  dependency is sufficient at this scale; revisit only if a third consumer
  ever needs these utilities).
- A deck-specific custom generator (left for future work, once a concrete
  card effect wants dungeon-crawl behavior the default doesn't provide).
