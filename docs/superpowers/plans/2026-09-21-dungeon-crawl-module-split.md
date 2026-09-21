# Dungeon-Crawl Module Split Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Split the dungeon-crawl subsystem out of `deck-of-many-more-things` into a new Foundry module, `foundry-pf2e-dungeon-crawl` (package id `pf2e-dungeon-crawl`), driven by a swappable generator interface, with `deck-of-many-more-things` reduced to the card deck + Celtic Cross divination plus a set of shared-infra files the new module depends on.

**Architecture:** Two Foundry modules on disk as siblings. `foundry-pf2e-dungeon-crawl` owns all dungeon-crawl logic/UI/data and declares a Foundry `relationships.requires` dependency on `deck-of-many-more-things` for eleven shared-infra files it imports directly via a package-id-keyed relative path. A `generator-registry.mjs` in the new module exposes `registerGenerator`/`getGenerator`; a `DefaultGenerator` (today's `dungeon-deck.mjs`/`encounter-roster.mjs` logic, unchanged) self-registers at `ready` if nothing else has.

**Tech Stack:** Foundry VTT v13 module (ESM, no bundler), Vitest for unit tests, `ajv`/`ajv-formats` for JSON-schema validation tooling, ComfyUI-driven Python for token-art generation.

**Spec:** `docs/superpowers/specs/2026-09-21-dungeon-crawl-module-split-design.md`

## Global Constraints

- New module package id: `pf2e-dungeon-crawl`. Repo: `foundry-pf2e-dungeon-crawl` (already exists on GitHub, empty).
- Local clone path for the new repo: `~/src/foundry-pf2e-dungeon-crawl`, a sibling of this repo's local checkout (`~/src/foundry-deck-of-many-things`) — the vitest alias in Task 1 assumes this exact relative layout.
- `deck-of-many-more-things` must never import from `foundry-pf2e-dungeon-crawl`. The dependency is one-directional (new module depends on this one).
- No git history is carried across the repo boundary for any moved file — plain copy, fresh commits in the new repo.
- No migration code for the live `dungeonRuns` world setting — clean cutover.
- Every moved `.mjs` file's existing unit test moves with it unchanged in behavior (same assertions, same pass/fail outcomes) — a moved test is allowed to have its import path rewritten, never its expectations.
- `npm test` must be green in **both** repos at the end of every task that touches test files.

---

## File Structure

**New repo (`foundry-pf2e-dungeon-crawl`):**
- `module.json`, `package.json`, `vitest.config.mjs`, `.gitignore`, `README.md` — new, Task 1
- `scripts/module.mjs` — new, Task 3 (dungeon-only subset of the old `module.mjs`)
- `scripts/generator-registry.mjs` — new, Task 3 (registration point + interface)
- `scripts/default-generator.mjs` — new, Task 3 (wraps `dungeon-deck.mjs`/`encounter-roster.mjs` as the default generator object)
- `scripts/*.mjs` (23 files) + `scripts/ui/dungeon-app.mjs` — copied, Task 2 (list in Task 2)
- `scripts/creature-art.mjs`, `data/creature-art.json`, `assets/creature-art/`, `docs/creature-art-todo.csv`, `tools/{generate-token-art,check-token-art,make-bg-transparent,validate-creature-art}.mjs` — copied, Task 4
- `data/dungeon-setpieces.json` — copied, Task 2
- `tools/agent-loop/` — copied, Task 2
- `styles/dungeon.css` — new, Task 2 (extracted from this repo's `styles/deck.css`)
- `tests/*.test.mjs` (moved test files) — copied, Task 2 / Task 4
- `docs/superpowers/specs/2026-09-20-agent-bridge-combat-ai-design.md` — copied, Task 2

**This repo (`deck-of-many-more-things`), modified:**
- `scripts/module.mjs` — Task 5 (dungeon-related settings/hooks/macros removed)
- `styles/deck.css` — Task 5 (`.dommt-dungeon*`/`.dommt-trait-field*` rules removed)
- `package.json` — Task 5 (`@modelcontextprotocol/sdk`, `zod` dropped; dungeon/agent-loop/token npm scripts removed)
- `tests/asset-paths.test.mjs` — Task 5 (stop scanning removed asset paths)
- `module.json` — Task 5 (version bump)
- All 23 moved `.mjs` files, `ui/dungeon-app.mjs`, `data/dungeon-setpieces.json`, creature-art files, their tests, `tools/agent-loop/` — deleted, Task 5

---

### Task 1: Scaffold `foundry-pf2e-dungeon-crawl`

**Files:**
- Create (new repo): `module.json`, `package.json`, `vitest.config.mjs`, `.gitignore`, `README.md`

**Interfaces:**
- Produces: the new repo's local path (`~/src/foundry-pf2e-dungeon-crawl`), its `vitest.config.mjs` alias (consumed by every later task's tests), its `package.json` `test`/`validate*` scripts (consumed by Tasks 2–5).

- [ ] **Step 1: Clone the empty repo locally**

```bash
cd ~/src
git clone https://github.com/cory-johannsen/foundry-pf2e-dungeon-crawl.git
cd foundry-pf2e-dungeon-crawl
```

- [ ] **Step 2: Write `module.json`**

```json
{
  "id": "pf2e-dungeon-crawl",
  "title": "PF2e Dungeon Crawl",
  "description": "GM-less-capable dungeon-crawl subsystem for Pathfinder 2E: procedurally sequenced rooms, encounter generation, traps, puzzles, skill challenges and combat AI, driven by a swappable generator interface.",
  "version": "0.1.0",
  "compatibility": {
    "minimum": "13",
    "verified": "14"
  },
  "authors": [{ "name": "Cory Johannsen" }],
  "socket": true,
  "esmodules": ["scripts/module.mjs"],
  "styles": ["styles/dungeon.css"],
  "languages": [{ "lang": "en", "name": "English", "path": "lang/en.json" }],
  "packs": [],
  "relationships": {
    "systems": [
      {
        "id": "pf2e",
        "type": "system",
        "compatibility": { "minimum": "6.0.0" }
      }
    ],
    "requires": [
      {
        "id": "deck-of-many-more-things",
        "type": "module",
        "compatibility": { "minimum": "0.70.0" }
      }
    ]
  },
  "url": "https://github.com/cory-johannsen/foundry-pf2e-dungeon-crawl",
  "manifest": "https://raw.githubusercontent.com/cory-johannsen/foundry-pf2e-dungeon-crawl/main/module.json",
  "download": "https://github.com/cory-johannsen/foundry-pf2e-dungeon-crawl/archive/refs/heads/main.zip"
}
```

- [ ] **Step 3: Write `package.json`**

```json
{
  "name": "foundry-pf2e-dungeon-crawl",
  "version": "0.0.1",
  "private": true,
  "type": "module",
  "description": "Foundry VTT v13 module: GM-less-capable dungeon crawl for Pathfinder 2E.",
  "scripts": {
    "test": "vitest run",
    "test:watch": "vitest",
    "validate:dungeon": "node tools/validate-dungeon-setpieces.mjs",
    "validate:creature-art": "node tools/validate-creature-art.mjs",
    "tokens": "node tools/generate-token-art.mjs",
    "tokens:check": "node tools/check-token-art.mjs",
    "agent-loop": "node tools/agent-loop/poll.mjs",
    "agent-bridge-mcp": "node tools/agent-loop/mcp-server.mjs",
    "format": "prettier --write ."
  },
  "devDependencies": {
    "@modelcontextprotocol/sdk": "^1.30.0",
    "ajv": "^8.17.1",
    "ajv-formats": "^3.0.1",
    "prettier": "^3.3.3",
    "vitest": "^2.1.4",
    "zod": "^4.6.5"
  }
}
```

- [ ] **Step 4: Write `vitest.config.mjs` with the shared-infra alias**

```js
import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const dirname = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  test: {
    include: ['tests/**/*.test.mjs'],
    environment: 'node'
  },
  resolve: {
    alias: [
      {
        // Production code imports shared infra via the package-id-keyed
        // path Foundry actually uses at runtime (Data/modules/<id>/...).
        // Locally, sibling checkouts are named after their repo, not their
        // package id, so redirect that literal prefix to wherever this
        // repo's sibling checkout of deck-of-many-more-things actually
        // lives. Adjust the replacement path if your local clone differs.
        find: /^(\.\.\/)+deck-of-many-more-things\/scripts\//,
        replacement: path.resolve(dirname, '../foundry-deck-of-many-things/scripts/') + '/'
      }
    ]
  }
});
```

- [ ] **Step 5: Write `.gitignore` (same relevant entries as the deck repo)**

```
node_modules/
.env
.env.local
.DS_Store
*.log
.idea/
coverage/
.vitest-cache/
.venv/
/*.jpg
/*.jpeg
/*.png
/*.ogg
.preview-*.png
```

- [ ] **Step 6: Write a minimal `README.md`**

```markdown
# PF2e Dungeon Crawl

Foundry VTT v13 module for Pathfinder 2E: procedurally sequenced dungeon
rooms, encounter generation, traps, puzzles, skill challenges and
GM-less-capable combat AI, driven by a swappable generator interface.
Split out of [deck-of-many-more-things](https://github.com/cory-johannsen/foundry-deck-of-many-things)
(see that repo's `docs/superpowers/specs/2026-09-21-dungeon-crawl-module-split-design.md`).

Requires `deck-of-many-more-things` to be installed alongside this module
for shared infrastructure (Foundry API glue, RNG, data loading, and a few
other utilities).

## Install

Install by manifest URL in Foundry:

\`\`\`
https://raw.githubusercontent.com/cory-johannsen/foundry-pf2e-dungeon-crawl/main/module.json
\`\`\`

## Development

\`\`\`bash
npm install
npm test
\`\`\`
```

- [ ] **Step 7: Install dependencies and commit**

```bash
npm install
git add module.json package.json vitest.config.mjs .gitignore README.md
git commit -m "Scaffold foundry-pf2e-dungeon-crawl module"
git push -u origin main
```

Expected: push succeeds against the previously-empty repo.

---

### Task 2: Move dungeon-crawl logic, data and tests

**Files:**
- Create (new repo), copied verbatim from this repo unless noted:
  `scripts/dungeon-combat.mjs`, `scripts/dungeon-deck.mjs`, `scripts/dungeon-layout.mjs`, `scripts/dungeon-permissions.mjs`, `scripts/dungeon-remote.mjs`, `scripts/dungeon-runner.mjs`, `scripts/dungeon-scene.mjs`, `scripts/dungeon-sound.mjs`, `scripts/encounter-deck.mjs`, `scripts/encounter-generator.mjs`, `scripts/encounter-roster.mjs`, `scripts/trap-library.mjs`, `scripts/pathfinding.mjs`, `scripts/agent-candidates.mjs`, `scripts/combat-rewards.mjs`, `scripts/puzzle.mjs`, `scripts/puzzle-mechanics.mjs`, `scripts/skill-challenge.mjs`, `scripts/skill-challenge-mechanics.mjs`, `scripts/narrative-mechanics.mjs`, `scripts/trait-picker.mjs`, `scripts/ui/dungeon-app.mjs`
- Create (new repo), data: `data/dungeon-setpieces.json`
- Create (new repo), tests: `tests/dungeon-deck.test.mjs`, `tests/dungeon-layout.test.mjs`, `tests/dungeon-permissions.test.mjs`, `tests/dungeon-runner.test.mjs`, `tests/dungeon-sound.test.mjs`, `tests/encounter-deck.test.mjs`, `tests/encounter-roster.test.mjs`, `tests/trap-library.test.mjs`, `tests/pathfinding.test.mjs`, `tests/agent-candidates.test.mjs`, `tests/combat-rewards.test.mjs`, `tests/puzzle-mechanics.test.mjs`, `tests/skill-challenge-mechanics.test.mjs`, `tests/narrative-mechanics.test.mjs`, `tests/trait-picker.test.mjs`, `tests/dungeon-room-art.test.mjs`
- Create (new repo): `tools/agent-loop/` (whole directory: `foundry-client.mjs`, `mcp-server.mjs`, `poll.mjs`, `providers/`, `README.md`), `tests/agent-loop-claude-provider.test.mjs`, `tests/agent-loop-foundry-client.test.mjs`, `tests/agent-loop-laya-provider.test.mjs`, `tests/agent-loop-mcp-server.test.mjs`, `tests/agent-loop-provider-selection.test.mjs`
- Create (new repo): `docs/superpowers/specs/2026-09-20-agent-bridge-combat-ai-design.md`
- Create (new repo): `styles/dungeon.css`
- Modify (this repo, read-only reference during this task; deletion happens in Task 5)

Note: `dungeon-combat.mjs`, `dungeon-scene.mjs`, `encounter-generator.mjs`, `dungeon-remote.mjs` have no dedicated unit test files today (Foundry/`CONST`-touching, existing precedent) — nothing to copy for those.

**Interfaces:**
- Consumes: Task 1's `vitest.config.mjs` alias.
- Produces: every symbol these 22 files export, unchanged, now importable within the new repo at the same relative paths they had in this repo (e.g. `../dungeon-deck.mjs`, `./dungeon-layout.mjs`) — Task 3 imports from `dungeon-deck.mjs` and `encounter-roster.mjs` here.

- [ ] **Step 1: Copy the files**

```bash
cd ~/src/foundry-deck-of-many-things
DEST=~/src/foundry-pf2e-dungeon-crawl

mkdir -p "$DEST/scripts/ui" "$DEST/data" "$DEST/docs/superpowers/specs" "$DEST/styles"

for f in dungeon-combat dungeon-deck dungeon-layout dungeon-permissions \
         dungeon-remote dungeon-runner dungeon-scene dungeon-sound \
         encounter-deck encounter-generator encounter-roster trap-library \
         pathfinding agent-candidates combat-rewards puzzle puzzle-mechanics \
         skill-challenge skill-challenge-mechanics narrative-mechanics trait-picker; do
  cp "scripts/$f.mjs" "$DEST/scripts/$f.mjs"
done
cp scripts/ui/dungeon-app.mjs "$DEST/scripts/ui/dungeon-app.mjs"
cp data/dungeon-setpieces.json "$DEST/data/dungeon-setpieces.json"
cp -r tools/agent-loop "$DEST/tools/agent-loop"
cp docs/superpowers/specs/2026-09-20-agent-bridge-combat-ai-design.md \
   "$DEST/docs/superpowers/specs/"

for t in dungeon-deck dungeon-layout dungeon-permissions dungeon-runner \
         dungeon-sound encounter-deck encounter-roster trap-library \
         pathfinding agent-candidates combat-rewards puzzle-mechanics \
         skill-challenge-mechanics narrative-mechanics trait-picker \
         dungeon-room-art agent-loop-claude-provider agent-loop-foundry-client \
         agent-loop-laya-provider agent-loop-mcp-server agent-loop-provider-selection; do
  cp "tests/$t.test.mjs" "$DEST/tests/$t.test.mjs"
done
```

- [ ] **Step 2: Rewrite shared-infra import paths in the copied `.mjs` files**

Each copied file that imports one of the eleven shared-infra files
(`foundry-api.mjs`, `data-loader.mjs`, `prng.mjs`, `audio.mjs`,
`choice-prompts.mjs`, `player-choice.mjs`, `cover-items.mjs`,
`placement.mjs`, `treasure.mjs`, `trap-combat.mjs`, `trap-mechanics.mjs`)
needs that import rewritten to the cross-module path. Run this from the new
repo's root:

```bash
cd ~/src/foundry-pf2e-dungeon-crawl
for lib in foundry-api data-loader prng audio choice-prompts player-choice \
           cover-items placement treasure trap-combat trap-mechanics; do
  # scripts/*.mjs: "./lib.mjs" -> "../../deck-of-many-more-things/scripts/lib.mjs"
  grep -rl "['\"]\./${lib}\.mjs['\"]" scripts/*.mjs 2>/dev/null | while read -r f; do
    sed -i "s#\./${lib}\.mjs#../../deck-of-many-more-things/scripts/${lib}.mjs#g" "$f"
  done
  # scripts/ui/*.mjs: "../lib.mjs" -> "../../../deck-of-many-more-things/scripts/lib.mjs"
  grep -rl "['\"]\.\./${lib}\.mjs['\"]" scripts/ui/*.mjs 2>/dev/null | while read -r f; do
    sed -i "s#\.\./${lib}\.mjs#../../../deck-of-many-more-things/scripts/${lib}.mjs#g" "$f"
  done
done
```

- [ ] **Step 3: Extract the dungeon CSS**

Copy `.dommt-dungeon*` (lines 77–86) and `.dommt-trait-field*` (lines
88–90) from this repo's `styles/deck.css` into
`~/src/foundry-pf2e-dungeon-crawl/styles/dungeon.css`, keeping the same
rules verbatim (leave this repo's `styles/deck.css` untouched for now —
Task 5 removes them from there).

- [ ] **Step 4: Run the new repo's tests**

```bash
cd ~/src/foundry-pf2e-dungeon-crawl
npm test
```

Expected: most suites pass immediately. Any failure at this point is
either a missed shared-infra import (re-check Step 2's `sed` covered every
occurrence — `grep -rn "['\"]\./\(foundry-api\|data-loader\|prng\|audio\|choice-prompts\|player-choice\|cover-items\|placement\|treasure\|trap-combat\|trap-mechanics\)\.mjs['\"]" scripts/` should return nothing left unrewritten) or a test that reaches into `data/creature-art.json`/`assets/creature-art/` (not copied until Task 4 — `tests/dungeon-room-art.test.mjs` only touches room art, not creature art, so it should already be green; if any other copied test unexpectedly touches creature-art paths, leave it failing and note it for Task 4 rather than improvising a fix here).

- [ ] **Step 5: Fix any remaining import stragglers, re-run until green**

```bash
npm test
```

Expected: PASS for every suite except any explicitly deferred to Task 4 above.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "Move dungeon-crawl logic, data and tests from deck-of-many-more-things"
git push
```

---

### Task 3: Generator interface + `DefaultGenerator` + new `module.mjs`

**Files:**
- Create (new repo): `scripts/generator-registry.mjs`
- Create (new repo): `scripts/default-generator.mjs`
- Create (new repo): `tests/generator-registry.test.mjs`
- Create (new repo): `scripts/module.mjs`
- Create (new repo): `assets/icons/macro-encounter.webp`, `assets/icons/macro-dungeon.webp` (copied from this repo's `assets/icons/`)
- Modify (new repo): `scripts/dungeon-runner.mjs` — replace its direct `dungeon-deck.mjs` import with the registry
- Modify (new repo): `scripts/encounter-generator.mjs` — replace its direct `encounter-roster.mjs` import with the registry

**Interfaces:**
- Produces: `registerGenerator(generatorObj)`, `getGenerator()` from `generator-registry.mjs` — `generatorObj` must implement `buildRoomSequence({seed, roomCount, setpieceIds, narrativeSetpieceIds}) => Room[]`, `findOutcomeTemplate(outcomeSlotId) => OutcomeSlotTemplate`, `resolveRoomOutcome(template, succeeded) => {effectKey, mutation}`, `applySequenceMutation(rooms, currentIndex, mutation, ctx) => Room[]`, `generateEncounterRoster({resolved, api, partyLevel, traits, excludeTraits, levelOffsetBias, requireTrait, partySize}) => roster`.
- Consumes: Task 2's `dungeon-deck.mjs` (`buildRoomSequence`, `findOutcomeTemplate`, `resolveRoomOutcome`, `applySequenceMutation`), `encounter-roster.mjs` (`resolveEncounterRoster`).

- [ ] **Step 1: Write the failing test for the registry**

Create `~/src/foundry-pf2e-dungeon-crawl/tests/generator-registry.test.mjs`:

```js
import { describe, it, expect, beforeEach } from 'vitest';
import { registerGenerator, getGenerator, __resetGeneratorForTests } from '../scripts/generator-registry.mjs';

describe('generator-registry', () => {
  beforeEach(() => {
    __resetGeneratorForTests();
  });

  it('throws if nothing has ever been registered', () => {
    expect(() => getGenerator()).toThrow(/no generator registered/i);
  });

  it('returns the most recently registered generator', () => {
    const genA = { buildRoomSequence: () => 'a' };
    const genB = { buildRoomSequence: () => 'b' };
    registerGenerator(genA);
    registerGenerator(genB);
    expect(getGenerator()).toBe(genB);
  });

  it('rejects a generator missing a required method', () => {
    expect(() => registerGenerator({ buildRoomSequence: () => {} })).toThrow(
      /findOutcomeTemplate/,
    );
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

```bash
cd ~/src/foundry-pf2e-dungeon-crawl
npx vitest run tests/generator-registry.test.mjs
```

Expected: FAIL — `generator-registry.mjs` does not exist yet.

- [ ] **Step 3: Write `scripts/generator-registry.mjs`**

```js
/**
 * The swappable generator contract this module is driven by. A generator
 * supplies room sequencing and encounter rosters; deck-of-many-more-things
 * (or any other caller) may register its own, but nothing needs to — see
 * default-generator.mjs, self-registered at ready if no one else has.
 */
const REQUIRED_METHODS = [
  'buildRoomSequence',
  'findOutcomeTemplate',
  'resolveRoomOutcome',
  'applySequenceMutation',
  'generateEncounterRoster',
];

let current = null;

export function registerGenerator(generatorObj) {
  const missing = REQUIRED_METHODS.filter(
    (m) => typeof generatorObj?.[m] !== 'function',
  );
  if (missing.length) {
    throw new Error(
      `registerGenerator: generator is missing required method(s): ${missing.join(', ')}`,
    );
  }
  current = generatorObj;
}

export function getGenerator() {
  if (!current) {
    throw new Error(
      'getGenerator: no generator registered — call registerGenerator first (foundry-pf2e-dungeon-crawl registers DefaultGenerator at ready if nothing else has).',
    );
  }
  return current;
}

/** Test-only: clears the registered generator between test cases. */
export function __resetGeneratorForTests() {
  current = null;
}
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
npx vitest run tests/generator-registry.test.mjs
```

Expected: PASS, 3/3.

- [ ] **Step 5: Write `scripts/default-generator.mjs`**

```js
/**
 * The generator this module falls back to when nothing else registers one
 * — today's dungeon-deck.mjs/encounter-roster.mjs logic, unchanged, just
 * exposed through the generator-registry.mjs contract instead of being
 * imported directly.
 */
import {
  buildRoomSequence,
  findOutcomeTemplate,
  resolveRoomOutcome,
  applySequenceMutation,
} from './dungeon-deck.mjs';
import { resolveEncounterRoster } from './encounter-roster.mjs';

export const DefaultGenerator = {
  buildRoomSequence,
  findOutcomeTemplate,
  resolveRoomOutcome,
  applySequenceMutation,
  generateEncounterRoster: resolveEncounterRoster,
};
```

- [ ] **Step 6: Wire `dungeon-runner.mjs` to the registry**

In `~/src/foundry-pf2e-dungeon-crawl/scripts/dungeon-runner.mjs`, replace:

```js
import {
  buildRoomSequence,
  findOutcomeTemplate,
  resolveRoomOutcome,
  applySequenceMutation,
} from "./dungeon-deck.mjs";
```

with:

```js
import { getGenerator } from "./generator-registry.mjs";
```

Then replace the two call sites:
- `buildRoomSequence({ seed: runSeed, roomCount, setpieceIds, narrativeSetpieceIds })` → `getGenerator().buildRoomSequence({ seed: runSeed, roomCount, setpieceIds, narrativeSetpieceIds })`
- `resolveRoomOutcome(findOutcomeTemplate(room.outcomeSlotId), succeeded)` → `getGenerator().resolveRoomOutcome(getGenerator().findOutcomeTemplate(room.outcomeSlotId), succeeded)`
- the `applySequenceMutation(state.rooms, state.currentIndex, mutation, {...})` call → `getGenerator().applySequenceMutation(state.rooms, state.currentIndex, mutation, {...})`

- [ ] **Step 7: Run `dungeon-runner.mjs`'s existing tests**

```bash
npx vitest run tests/dungeon-runner.test.mjs
```

Expected: FAIL — no generator is registered in the test environment yet.

- [ ] **Step 8: Update `tests/dungeon-runner.test.mjs`'s setup to register `DefaultGenerator`**

Add near the top of the test file (alongside its existing imports):

```js
import { registerGenerator } from '../scripts/generator-registry.mjs';
import { DefaultGenerator } from '../scripts/default-generator.mjs';

registerGenerator(DefaultGenerator);
```

- [ ] **Step 9: Re-run and confirm green**

```bash
npx vitest run tests/dungeon-runner.test.mjs
```

Expected: PASS, same count as before this task.

- [ ] **Step 10: Wire `encounter-generator.mjs` to the registry**

In `~/src/foundry-pf2e-dungeon-crawl/scripts/encounter-generator.mjs`, replace:

```js
import { resolveEncounterRoster } from "./encounter-roster.mjs";
```

with:

```js
import { getGenerator } from "./generator-registry.mjs";
```

and change its call site from `resolveEncounterRoster({...})` to
`getGenerator().generateEncounterRoster({...})`.

- [ ] **Step 11: Run full test suite**

```bash
npm test
```

Expected: PASS across the whole repo.

- [ ] **Step 12: Write the new module's `scripts/module.mjs`**

Before writing this, re-read this repo's *current*
`scripts/module.mjs` in full — it may have changed since this plan was
written — and diff it against the version quoted below (captured at
plan-writing time) to catch anything dungeon-related added since. What
follows is the complete, exact port of every dungeon-related piece of
that file (verified line-by-line against it, not an approximation):

```js
import { generateEncounter } from "./encounter-generator.mjs";
import { DungeonApp, resolveCurrentRoom } from "./ui/dungeon-app.mjs";
import {
  abandonRun,
  getRunState,
  findActiveHostedRun,
  findHostedRunForBroadcast,
  getPendingSkillChallengeCustomization,
  applySkillChallengeCustomization,
  getPendingPuzzleCustomization,
  applyPuzzleCustomization,
  getPendingNarrativeCustomization,
  applyNarrativeCustomization,
} from "./dungeon-runner.mjs";
import {
  decideOpenDungeon,
  decideGmLessBroadcast,
} from "./dungeon-permissions.mjs";
import { registerDungeonActionSocket } from "./dungeon-remote.mjs";
import {
  handleDungeonDoorOpened,
  teardownDungeonRun,
} from "./dungeon-scene.mjs";
import {
  maybeResolveCombatForActor,
  maybeResolveCombatForCombatant,
  autoPlayCombatantTurnIfDue,
  getPendingAgentTurn,
  applyAgentDecision,
  toggleAgentControlled,
  agentLoopStatus,
  handleRangedAttackForReactiveStrike,
} from "./dungeon-combat.mjs";
import {
  getPendingTrapCustomization,
  applyTrapCustomization,
} from "./trap-combat.mjs";
import { registerGenerator } from "./generator-registry.mjs";
import { DefaultGenerator } from "./default-generator.mjs";

const MODULE_ID = "pf2e-dungeon-crawl";

Hooks.once("init", () => {
  game.settings.register(MODULE_ID, "dungeonRuns", {
    scope: "world",
    config: false,
    type: Object,
    default: {},
  });
  game.settings.register(MODULE_ID, "agentLoopHeartbeat", {
    scope: "world",
    config: false,
    type: Object,
    default: null,
  });
});

Hooks.once("ready", async () => {
  registerGenerator(DefaultGenerator);
  const module = game.modules.get(MODULE_ID);
  module.api = {
    generateEncounter: (options) => generateEncounter(options),
    openDungeon: () => {
      const decision = decideOpenDungeon(findActiveHostedRun());
      if (decision.action === "warnAlreadyHosted") {
        const hostUser = game.users.get(decision.hostUserId);
        return ui.notifications.warn(
          game.i18n.format("DOMMT.Dungeon.AlreadyHostedWarning", {
            host: hostUser?.name ?? "?",
          }),
        );
      }
      return new DungeonApp().render(true);
    },
    resetDungeon: async (sceneId) => {
      if (!game.user.isGM)
        return ui.notifications.warn(
          game.i18n.localize("DOMMT.Dungeon.GmOnlyWarning"),
        );
      const targetSceneId = sceneId ?? canvas?.scene?.id;
      if (!targetSceneId) return;
      const scene = game.scenes.get(targetSceneId);
      const state = getRunState(targetSceneId);
      await abandonRun({ sceneId: targetSceneId });
      if (scene)
        await teardownDungeonRun(scene, {
          previousSceneId: state?.previousSceneId ?? null,
        });
    },
    getPendingAgentTurn: async (combatId) => {
      if (!game.user.isGM)
        return ui.notifications.warn(
          game.i18n.localize("DOMMT.Dungeon.GmOnlyWarning"),
        );
      const combat = game.combats.get(combatId ?? game.combat?.id);
      return combat ? await getPendingAgentTurn(combat) : null;
    },
    applyAgentDecision: (
      combatId,
      combatantId,
      candidateId,
      rationale = null,
    ) => {
      if (!game.user.isGM)
        return ui.notifications.warn(
          game.i18n.localize("DOMMT.Dungeon.GmOnlyWarning"),
        );
      const combat = game.combats.get(combatId);
      return combat
        ? applyAgentDecision(combat, combatantId, candidateId, rationale)
        : null;
    },
    recordAgentLoopHeartbeat: ({
      provider = null,
      pollIntervalMs = null,
    } = {}) => {
      if (!game.user.isGM)
        return ui.notifications.warn(
          game.i18n.localize("DOMMT.Dungeon.GmOnlyWarning"),
        );
      return game.settings.set(MODULE_ID, "agentLoopHeartbeat", {
        timestamp: Date.now(),
        provider,
        pollIntervalMs,
      });
    },
    getAgentLoopStatus: () => {
      if (!game.user.isGM)
        return ui.notifications.warn(
          game.i18n.localize("DOMMT.Dungeon.GmOnlyWarning"),
        );
      return agentLoopStatus();
    },
    postAgentLoopStatus: async () => {
      if (!game.user.isGM)
        return ui.notifications.warn(
          game.i18n.localize("DOMMT.Dungeon.GmOnlyWarning"),
        );
      const status = agentLoopStatus();
      const key = status.connected
        ? "DOMMT.Dungeon.Combat.AgentLoopStatusConnected"
        : status.lastSeenMs
          ? "DOMMT.Dungeon.Combat.AgentLoopStatusStale"
          : "DOMMT.Dungeon.Combat.AgentLoopStatusNeverSeen";
      const content = game.i18n.format(key, {
        provider: status.provider ?? "?",
        seconds: status.secondsAgo ?? 0,
      });
      const gmIds = ChatMessage.getWhisperRecipients("GM").map((u) => u.id);
      return ChatMessage.create({ content, whisper: gmIds });
    },
    getPendingTrapCustomization: (sceneId) => {
      if (!game.user.isGM)
        return ui.notifications.warn(
          game.i18n.localize("DOMMT.Dungeon.GmOnlyWarning"),
        );
      return getPendingTrapCustomization(sceneId ?? canvas?.scene?.id);
    },
    applyTrapCustomization: (actorId, customization) => {
      if (!game.user.isGM)
        return ui.notifications.warn(
          game.i18n.localize("DOMMT.Dungeon.GmOnlyWarning"),
        );
      return applyTrapCustomization(actorId, customization);
    },
    getPendingSkillChallengeCustomization: (sceneId) => {
      if (!game.user.isGM)
        return ui.notifications.warn(
          game.i18n.localize("DOMMT.Dungeon.GmOnlyWarning"),
        );
      return getPendingSkillChallengeCustomization(
        sceneId ?? canvas?.scene?.id,
      );
    },
    applySkillChallengeCustomization: (sceneId, roomId, customization) => {
      if (!game.user.isGM)
        return ui.notifications.warn(
          game.i18n.localize("DOMMT.Dungeon.GmOnlyWarning"),
        );
      return applySkillChallengeCustomization(
        sceneId ?? canvas?.scene?.id,
        roomId,
        customization,
      );
    },
    getPendingPuzzleCustomization: (sceneId) => {
      if (!game.user.isGM)
        return ui.notifications.warn(
          game.i18n.localize("DOMMT.Dungeon.GmOnlyWarning"),
        );
      return getPendingPuzzleCustomization(sceneId ?? canvas?.scene?.id);
    },
    applyPuzzleCustomization: (sceneId, roomId, customization) => {
      if (!game.user.isGM)
        return ui.notifications.warn(
          game.i18n.localize("DOMMT.Dungeon.GmOnlyWarning"),
        );
      return applyPuzzleCustomization(
        sceneId ?? canvas?.scene?.id,
        roomId,
        customization,
      );
    },
    getPendingNarrativeCustomization: (sceneId) => {
      if (!game.user.isGM)
        return ui.notifications.warn(
          game.i18n.localize("DOMMT.Dungeon.GmOnlyWarning"),
        );
      return getPendingNarrativeCustomization(sceneId ?? canvas?.scene?.id);
    },
    applyNarrativeCustomization: (sceneId, roomId, customization) => {
      if (!game.user.isGM)
        return ui.notifications.warn(
          game.i18n.localize("DOMMT.Dungeon.GmOnlyWarning"),
        );
      return applyNarrativeCustomization(
        sceneId ?? canvas?.scene?.id,
        roomId,
        customization,
      );
    },
    registerGenerator,
  };
  if (game.user.isGM) {
    try {
      await ensureWorldMacros();
    } catch (e) {
      console.error(`${MODULE_ID} | ensureWorldMacros failed`, e);
    }
  }
  console.log(
    `${MODULE_ID} | ready — api attached to game.modules.get('${MODULE_ID}').api`,
  );
});

const MACRO_DEFS = [
  {
    name: "DOMMT: Generate Encounter",
    img: `modules/${MODULE_ID}/assets/icons/macro-encounter.webp`,
    command: `game.modules.get('${MODULE_ID}').api.generateEncounter();`,
  },
  {
    name: "DOMMT: Dungeon Crawl",
    img: `modules/${MODULE_ID}/assets/icons/macro-dungeon.webp`,
    command: `game.modules.get('${MODULE_ID}').api.openDungeon();`,
  },
];

async function ensureWorldMacros({ force = false } = {}) {
  const toCreate = [];
  const toUpdate = [];
  for (const def of MACRO_DEFS) {
    const existing = game.macros.find((m) => m.name === def.name);
    if (existing) {
      if (
        force ||
        existing.command !== def.command ||
        existing.img !== def.img
      ) {
        toUpdate.push({ _id: existing.id, command: def.command, img: def.img });
      }
    } else {
      toCreate.push({
        name: def.name,
        type: "script",
        img: def.img,
        command: def.command,
        scope: "global",
        flags: { [MODULE_ID]: { generated: true } },
      });
    }
  }
  if (toCreate.length) await Macro.createDocuments(toCreate);
  if (toUpdate.length) await Macro.updateDocuments(toUpdate);
  const msg = `PF2e Dungeon Crawl: ${toCreate.length} macro(s) created, ${toUpdate.length} updated.`;
  ui.notifications?.info(msg);
  console.log(`${MODULE_ID} | ${msg}`);
  return { created: toCreate.length, updated: toUpdate.length };
}

Hooks.once("ready", registerDungeonActionSocket);

/** #158: opens the Dungeon Crawl tracker if it isn't already rendered. */
function openDungeonTrackerIfNotOpen() {
  if (!foundry.applications.instances.get("dommt-dungeon-app"))
    new DungeonApp().render(true);
}

Hooks.on("updateWall", async (wall, changes) => {
  if (changes.ds !== CONST.WALL_DOOR_STATES.OPEN) return;
  const { autoOpenTracker } = await handleDungeonDoorOpened(
    wall.parent?.id,
    wall.id,
  );
  if (autoOpenTracker) openDungeonTrackerIfNotOpen();
});

/** #109: keeps every non-host, non-GM client's DungeonApp in sync with a
 * GM-less run. */
function syncGmLessDungeonBroadcast() {
  const existing = foundry.applications.instances.get("dommt-dungeon-app");
  const decision = decideGmLessBroadcast(
    findHostedRunForBroadcast(),
    !!existing,
  );
  if (decision.action === "open") new DungeonApp().render(true);
  else if (decision.action === "render") existing.render();
  else if (decision.action === "close") existing.close();
}

function onDungeonRunsSettingChanged(setting) {
  if (setting.key !== `${MODULE_ID}.dungeonRuns`) return;
  syncGmLessDungeonBroadcast();
}
Hooks.on("updateSetting", onDungeonRunsSettingChanged);
Hooks.on("createSetting", onDungeonRunsSettingChanged);
Hooks.on("canvasReady", syncGmLessDungeonBroadcast);

/** Advances a dungeon room the instant its Combat auto-resolves. */
async function onCombatAutoResolved(result) {
  if (result?.dungeonSlot != null)
    await resolveCurrentRoom(result.outcome === "victory", {
      scene: result.scene,
    });
}

Hooks.on("updateActor", async (actor) =>
  onCombatAutoResolved(await maybeResolveCombatForActor(actor)),
);
Hooks.on("updateCombatant", async (combatant, changes) =>
  onCombatAutoResolved(
    await maybeResolveCombatForCombatant(combatant, changes),
  ),
);

/** ITEM-8: plays a non-player combatant's turn automatically. */
Hooks.on("updateCombat", (combat, changes) => {
  if (changes.turn === undefined && changes.round === undefined) return;
  autoPlayCombatantTurnIfDue(combat);
});

/** #202: reactive/triggered NPC abilities (ranged-Strike-triggered Reactive
 * Strike/Attack of Opportunity). */
Hooks.on("createChatMessage", handleRangedAttackForReactiveStrike);

Hooks.on("getSceneControlButtons", (controls) => {
  const tokenControl =
    controls.find?.((c) => c.name === "token") ?? controls.token;
  if (!tokenControl) return;
  const agentLoopButton = {
    name: "dommt-agent-loop-status",
    title: game.i18n.localize("DOMMT.SceneControl.AgentLoopStatusLabel"),
    icon: "fa-solid fa-robot",
    visible: game.user.isGM,
    button: true,
    onClick: () => game.modules.get(MODULE_ID).api.postAgentLoopStatus(),
  };
  if (Array.isArray(tokenControl.tools)) {
    tokenControl.tools.push(agentLoopButton);
  } else if (tokenControl.tools && typeof tokenControl.tools === "object") {
    tokenControl.tools["dommt-agent-loop-status"] = agentLoopButton;
  }
});

/** GM per-combatant override for the agentControlled default (Task 2). */
Hooks.on("getCombatTrackerEntryContext", (html, menuItems) => {
  menuItems.push({
    name: "DOMMT.Dungeon.Combat.ToggleAgentControlLabel",
    icon: '<i class="fa-solid fa-robot"></i>',
    condition: (li) => {
      const combatant = game.combat?.combatants.get(li.dataset.combatantId);
      return (
        !!combatant &&
        !game.actors?.party?.members?.some((m) => m.id === combatant.actor?.id)
      );
    },
    callback: (li) => {
      const combatant = game.combat?.combatants.get(li.dataset.combatantId);
      if (combatant) toggleAgentControlled(combatant);
    },
  });
});
```

Note: inside `module.api.getPendingAgentTurn`/`applyAgentDecision`, the
call to `getPendingAgentTurn(combat)`/`applyAgentDecision(combat, ...)`
resolves to the **imported** function from `dungeon-combat.mjs`, not the
object property being defined (object-literal keys aren't in scope inside
their own value) — this is existing behavior in the current file, not a
bug introduced here; preserve it exactly rather than "fixing" an apparent
naming collision that isn't one.

- [ ] **Step 13: Copy the macro icon assets**

```bash
mkdir -p ~/src/foundry-pf2e-dungeon-crawl/assets/icons
cp ~/src/foundry-deck-of-many-things/assets/icons/macro-encounter.webp \
   ~/src/foundry-deck-of-many-things/assets/icons/macro-dungeon.webp \
   ~/src/foundry-pf2e-dungeon-crawl/assets/icons/
```

- [ ] **Step 14: Run the full suite once more and commit**

```bash
cd ~/src/foundry-pf2e-dungeon-crawl
npm test
git add -A
git commit -m "Add generator interface, DefaultGenerator, and module.mjs"
git push
```

---

### Task 4: Migrate creature art

**Files:**
- Create (new repo): `scripts/creature-art.mjs`, `data/creature-art.json`, `assets/creature-art/` (whole tree), `docs/creature-art-todo.csv`, `tools/generate-token-art.mjs`, `tools/check-token-art.mjs`, `tools/make-bg-transparent.mjs`, `tools/validate-creature-art.mjs`, `tests/creature-art.test.mjs`, `tests/creature-art-assets.test.mjs`
- Modify (new repo): `scripts/encounter-generator.mjs` — rewrite its `./creature-art.mjs` import if Task 2's copy left it pointing anywhere unexpected (it shouldn't — same relative path — but confirm)

**Interfaces:**
- Consumes: nothing new from earlier tasks.
- Produces: `creature-art.mjs`'s exports, unchanged, available at the same relative path `encounter-generator.mjs` already expects.

- [ ] **Step 1: Copy the files**

```bash
cd ~/src/foundry-deck-of-many-things
DEST=~/src/foundry-pf2e-dungeon-crawl

cp scripts/creature-art.mjs "$DEST/scripts/creature-art.mjs"
cp data/creature-art.json "$DEST/data/creature-art.json"
cp -r assets/creature-art "$DEST/assets/creature-art"
cp docs/creature-art-todo.csv "$DEST/docs/creature-art-todo.csv"
cp tools/generate-token-art.mjs tools/check-token-art.mjs tools/make-bg-transparent.mjs tools/validate-creature-art.mjs "$DEST/tools/"
cp tests/creature-art.test.mjs tests/creature-art-assets.test.mjs "$DEST/tests/"
```

- [ ] **Step 2: Run the new repo's full test suite**

```bash
cd ~/src/foundry-pf2e-dungeon-crawl
npm test
```

Expected: PASS, including `tests/creature-art.test.mjs` and
`tests/creature-art-assets.test.mjs` and any test deferred from Task 2
Step 4 that needed creature-art paths.

- [ ] **Step 3: Run the creature-art validator**

```bash
npm run validate:creature-art
```

Expected: exits 0, same result it produced in this repo before the copy.

- [ ] **Step 4: Spot-check the STYLE/NEGATIVE prompt constants survived intact**

```bash
diff <(grep -A5 "^const STYLE" ~/src/foundry-deck-of-many-things/tools/generate-token-art.mjs) \
     <(grep -A5 "^const STYLE" ~/src/foundry-pf2e-dungeon-crawl/tools/generate-token-art.mjs)
diff <(grep -A5 "^const NEGATIVE" ~/src/foundry-deck-of-many-things/tools/generate-token-art.mjs) \
     <(grep -A5 "^const NEGATIVE" ~/src/foundry-pf2e-dungeon-crawl/tools/generate-token-art.mjs)
```

Expected: no output (identical).

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "Migrate creature art (data, assets, tooling, docs) from deck-of-many-more-things"
git push
```

- [ ] **Step 6: Update issue #93 with the new resume location**

```bash
cd ~/src/foundry-deck-of-many-things
gh issue comment 93 --body "ITEM-18's resume state now lives in foundry-pf2e-dungeon-crawl: data/creature-art.json, assets/creature-art/, docs/creature-art-todo.csv, and tools/{generate-token-art,check-token-art,make-bg-transparent,validate-creature-art}.mjs all moved there verbatim (~500+ entries, STYLE/NEGATIVE prompt constants intact — see foundry-pf2e-dungeon-crawl's own git history for the migration commit). Resume ITEM-18 against that repo."
```

---

### Task 5: Strip moved code from `deck-of-many-more-things`

**Files:**
- Delete: the 22 `.mjs` files from Task 2's list, `scripts/ui/dungeon-app.mjs`, `data/dungeon-setpieces.json`, `tools/agent-loop/`, `scripts/creature-art.mjs`, `data/creature-art.json`, `assets/creature-art/`, `docs/creature-art-todo.csv`, `tools/{generate-token-art,check-token-art,make-bg-transparent,validate-creature-art}.mjs`, and every test file copied in Tasks 2 and 4
- Modify: `scripts/module.mjs`, `styles/deck.css`, `package.json`, `tests/asset-paths.test.mjs`, `module.json`

**Interfaces:**
- Consumes: nothing (this is the old repo).
- Produces: nothing new — this task only removes.

- [ ] **Step 1: Delete the moved script/data/tool files**

```bash
cd ~/src/foundry-deck-of-many-things
for f in dungeon-combat dungeon-deck dungeon-layout dungeon-permissions \
         dungeon-remote dungeon-runner dungeon-scene dungeon-sound \
         encounter-deck encounter-generator encounter-roster trap-library \
         pathfinding agent-candidates combat-rewards puzzle puzzle-mechanics \
         skill-challenge skill-challenge-mechanics narrative-mechanics \
         trait-picker creature-art; do
  git rm "scripts/$f.mjs"
done
git rm scripts/ui/dungeon-app.mjs
git rm data/dungeon-setpieces.json data/creature-art.json
git rm -r assets/creature-art
git rm docs/creature-art-todo.csv
git rm tools/generate-token-art.mjs tools/check-token-art.mjs tools/make-bg-transparent.mjs tools/validate-creature-art.mjs
git rm -r tools/agent-loop
git rm docs/superpowers/specs/2026-09-20-agent-bridge-combat-ai-design.md

for t in dungeon-deck dungeon-layout dungeon-permissions dungeon-runner \
         dungeon-sound encounter-deck encounter-roster trap-library \
         pathfinding agent-candidates combat-rewards puzzle-mechanics \
         skill-challenge-mechanics narrative-mechanics trait-picker \
         dungeon-room-art creature-art creature-art-assets \
         agent-loop-claude-provider agent-loop-foundry-client \
         agent-loop-laya-provider agent-loop-mcp-server agent-loop-provider-selection; do
  git rm "tests/$t.test.mjs"
done
```

- [ ] **Step 2: Replace `scripts/module.mjs` with its deck-only remainder**

Before replacing anything, re-read this repo's *current*
`scripts/module.mjs` in full and diff it against the version Task 3 Step
12 quoted — carry over anything non-dungeon that changed since this plan
was written into the file below before applying it. Assuming nothing
non-dungeon changed, replace the entire file with this exact content
(every dungeon-related import, setting, `module.api` entry, macro def,
and hook from the original removed; every deck/divination piece kept
byte-for-byte unchanged):

```js
import { DeckApp } from "./ui/deck-app.mjs";
import { DivinationApp } from "./ui/divination-app.mjs";
import { loadCards } from "./data-loader.mjs";
import { drawFromPlay, freshPlayDeckState, makeCardsById } from "./deck.mjs";
import { applyCardEffect } from "./card-effects.mjs";
import { playCardSound } from "./card-sound.mjs";
import { registerChoiceSocket } from "./player-choice.mjs";
import { registerChargeSound } from "./charge-sound.mjs";
import { runDraws } from "./draw-run.mjs";
import { makeFoundryApi } from "./foundry-api.mjs";
import { resolveDrawActor } from "./draw-target.mjs";
import { resolvePendingDraw, markMessageResolved } from "./gm-resolution.mjs";
import { postDrawCard } from "./ui/card-message.mjs";
import {
  ensureDivinationScene,
  performDivinationOnTable,
  clearDivinationTable,
} from "./scene-divination.mjs";

const MODULE_ID = "deck-of-many-more-things";

Hooks.once("init", () => {
  game.settings.register(MODULE_ID, "autoApplyEffects", {
    name: "DOMMT.Settings.AutoApplyEffects.Name",
    hint: "DOMMT.Settings.AutoApplyEffects.Hint",
    scope: "world",
    config: true,
    type: Boolean,
    default: true,
  });
  game.settings.register(MODULE_ID, "divinationVisibility", {
    name: "DOMMT.Settings.DivinationVisibility.Name",
    hint: "DOMMT.Settings.DivinationVisibility.Hint",
    scope: "world",
    config: true,
    type: String,
    choices: {
      gm_only: "DOMMT.Settings.DivinationVisibility.gm_only",
      whisper_player: "DOMMT.Settings.DivinationVisibility.whisper_player",
      public: "DOMMT.Settings.DivinationVisibility.public",
    },
    default: "gm_only",
  });
  game.settings.register(MODULE_ID, "worldSeed", {
    scope: "world",
    config: false,
    type: String,
    default: "",
  });
  game.settings.register(MODULE_ID, "playDeck", {
    scope: "world",
    config: false,
    type: Object,
    default: { remaining: [], drawn: [], seed: "" },
  });
});

Hooks.once("ready", async () => {
  const module = game.modules.get(MODULE_ID);
  module.api = {
    openDeck: () => new DeckApp().render(true),
    openDivinationPanel: () => new DivinationApp().render(true),
    openDivination: () => performDivinationOnTable(),
    divineOnTable: () => performDivinationOnTable(),
    clearTable: () => clearDivinationTable(),
    drawForced: drawForced,
    draw: (count = 1, { actorId = null } = {}) =>
      runDraws({
        count,
        actor: actorId ? game.actors.get(actorId) : resolveDrawActor().actor,
      }),
    resetDeck: async () => {
      const cards = await loadCards();
      const seed = String(Date.now());
      const state = freshPlayDeckState(cards, seed);
      await game.settings.set(MODULE_ID, "worldSeed", seed);
      await game.settings.set(MODULE_ID, "playDeck", state);
    },
    installMacros: () => ensureWorldMacros({ force: true }),
    installDivinationScene: () => ensureDivinationScene(),
  };
  if (game.user.isGM) {
    try {
      await ensureWorldMacros();
    } catch (e) {
      console.error(`${MODULE_ID} | ensureWorldMacros failed`, e);
    }
    try {
      await ensureDivinationScene();
    } catch (e) {
      console.error(`${MODULE_ID} | ensureDivinationScene failed`, e);
    }
  }
  console.log(
    `${MODULE_ID} | ready — api attached to game.modules.get('${MODULE_ID}').api`,
  );
});

const MACRO_DEFS = [
  {
    name: "DOMMT: Play the Deck",
    img: `modules/${MODULE_ID}/assets/icons/macro-deck.webp`,
    command: `game.modules.get('${MODULE_ID}').api.openDeck();`,
  },
  {
    name: "DOMMT: Divine",
    img: `modules/${MODULE_ID}/assets/icons/macro-divine.webp`,
    command: `game.modules.get('${MODULE_ID}').api.openDivination();`,
  },
  {
    name: "DOMMT: Reset Play Deck (GM)",
    img: `modules/${MODULE_ID}/assets/icons/macro-reset.webp`,
    command: `if (!game.user.isGM) return ui.notifications.warn('GM only');\nawait game.modules.get('${MODULE_ID}').api.resetDeck();\nui.notifications.info('Deck reset');`,
  },
];

async function ensureWorldMacros({ force = false } = {}) {
  const toCreate = [];
  const toUpdate = [];
  for (const def of MACRO_DEFS) {
    const existing = game.macros.find((m) => m.name === def.name);
    if (existing) {
      if (
        force ||
        existing.command !== def.command ||
        existing.img !== def.img
      ) {
        toUpdate.push({ _id: existing.id, command: def.command, img: def.img });
      }
    } else {
      toCreate.push({
        name: def.name,
        type: "script",
        img: def.img,
        command: def.command,
        scope: "global",
        flags: { [MODULE_ID]: { generated: true } },
      });
    }
  }
  if (toCreate.length) await Macro.createDocuments(toCreate);
  if (toUpdate.length) await Macro.updateDocuments(toUpdate);
  const msg = `Deck of Many More Things: ${toCreate.length} macro(s) created, ${toUpdate.length} updated.`;
  ui.notifications?.info(msg);
  console.log(`${MODULE_ID} | ${msg}`);
  return { created: toCreate.length, updated: toUpdate.length };
}

function bindPendingDrawButton(message, html) {
  const root = html?.[0] ?? html;
  const button = root?.querySelector?.('[data-action="dommt-resolve"]');
  if (!button || button.dataset.dommtBound) return;
  button.dataset.dommtBound = "1";
  if (!game.user.isGM) {
    button.closest(".dommt-chat__gm-actions")?.remove();
    return;
  }
  button.addEventListener("click", async () => {
    button.disabled = true;
    try {
      const outcome = await resolvePendingDraw(message);
      if (outcome) {
        await markMessageResolved(message, outcome);
        if (outcome.extraDraws > 0) {
          await runDraws({
            count: outcome.extraDraws,
            actor: game.actors.get(outcome.actorId),
          });
        }
      } else button.disabled = false;
    } catch (e) {
      console.error(`${MODULE_ID} | resolving pending draw failed`, e);
      ui.notifications.error(game.i18n.localize("DOMMT.GM.ResolveFailed"));
      button.disabled = false;
    }
  });
}

Hooks.once("ready", registerChoiceSocket);
Hooks.once("ready", registerChargeSound);

Hooks.on("renderChatMessageHTML", bindPendingDrawButton);

Hooks.on("getSceneControlButtons", (controls) => {
  const tokenControl =
    controls.find?.((c) => c.name === "token") ?? controls.token;
  if (!tokenControl) return;
  const button = {
    name: "dommt-deck",
    title: game.i18n.localize("DOMMT.SceneControl.Label"),
    icon: "fa-solid fa-cards",
    visible: true,
    button: true,
    onClick: () => new DeckApp().render(true),
  };
  if (Array.isArray(tokenControl.tools)) {
    tokenControl.tools.push(button);
  } else if (tokenControl.tools && typeof tokenControl.tools === "object") {
    tokenControl.tools["dommt-deck"] = button;
  }
});

async function drawForced(cardId, { actorId = null } = {}) {
  const cards = await loadCards();
  const byId = makeCardsById(cards);
  const card = byId.get(cardId);
  if (!card) throw new Error(`Unknown card: ${cardId}`);
  let state = game.settings.get(MODULE_ID, "playDeck");
  if (!state.remaining?.length) {
    state = freshPlayDeckState(cards, String(Date.now()));
  }
  const remaining = state.remaining.filter((id) => id !== cardId);
  const drawn = state.drawn.concat([{ cardId, actorId, at: Date.now() }]);
  await game.settings.set(MODULE_ID, "playDeck", {
    ...state,
    remaining,
    drawn,
  });
  const { actor } = resolveDrawActor({ actorId });
  const api = makeFoundryApi();
  const autoApply = game.settings.get(MODULE_ID, "autoApplyEffects");
  const result = await applyCardEffect({
    card,
    actor,
    api,
    autoApplyEnabled: autoApply,
  });
  if (result.mode === "auto") playCardSound(card, actor);
  await postDrawCard({ card, actor, result });
  return result;
}
```

- [ ] **Step 3: Edit `styles/deck.css`**

Delete the `/* ----- Dungeon crawl tracker ----- */` comment and its
`.dommt-dungeon*` rules, and the `/* ----- Trait picker ... ----- */`
comment and its `.dommt-trait-field*` rules (already copied into the new
repo's `styles/dungeon.css` in Task 2 Step 3).

- [ ] **Step 4: Edit `package.json`**

Remove the `@modelcontextprotocol/sdk` and `zod` devDependencies (nothing
left in this repo imports them once `tools/agent-loop` is gone — confirm
with `grep -rln "from ['\"]@modelcontextprotocol\|from ['\"]zod" --include="*.mjs" . | grep -v node_modules` returning empty before removing). Remove the
`validate:dungeon`, `tokens`, `tokens:check`, `tokens:import`, `prompts`,
`agent-loop`, `agent-bridge-mcp`, `validate:creature-art` scripts (their
underlying tools moved). Run `npm install` afterward to refresh
`package-lock.json` (or the repo's lockfile equivalent) for the dropped
deps.

- [ ] **Step 5: Edit `tests/asset-paths.test.mjs`**

Open the file and check what it scans (a `readdirSync`/glob-based sweep
over `scripts/`/`assets/`, per its own docblock). Confirm it no longer
references any now-deleted directory or file; if it hardcodes any path
under `assets/creature-art/` or a dungeon-specific asset directory,
remove that reference. If it only walks whatever's currently on disk, no
edit is needed — verify by running it (next step) rather than guessing.

- [ ] **Step 6: Bump `module.json`'s version**

Per this repo's own convention (`feedback_version_bump` memory), bump the
`version` field in `module.json` — this is a breaking structural change,
so bump the minor version (e.g. `0.70.0` → `0.71.0`; check the file's
current value first, since other work may have bumped it since this plan
was written).

- [ ] **Step 7: Run the full test suite and validators**

```bash
npm test
npm run validate
```

Expected: PASS — no reference to any deleted file remains anywhere in
`scripts/`, `tests/`, or `module.mjs`. If `npm test` fails on a leftover
import, grep for the deleted filename across `scripts/`/`tests/` and fix
the straggler.

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "Remove dungeon-crawl subsystem, now split into foundry-pf2e-dungeon-crawl

Bumps module version for the breaking structural change. See
docs/superpowers/specs/2026-09-21-dungeon-crawl-module-split-design.md."
```

---

### Task 6: Transfer related issues

**Files:** none (GitHub-only).

**Interfaces:** none.

- [ ] **Step 1: Transfer each issue**

```bash
for n in 134 135 136 137 138 139 162 163 164 165 166 167; do
  gh issue transfer "$n" cory-johannsen/foundry-pf2e-dungeon-crawl \
    --repo cory-johannsen/foundry-deck-of-many-things
done
```

Expected: each command prints the issue's new URL in the target repo.

- [ ] **Step 2: Verify**

```bash
gh issue list --repo cory-johannsen/foundry-pf2e-dungeon-crawl --state all
```

Expected: all 12 transferred issues appear, with their original numbers
(GitHub issue transfer does not renumber within the destination repo's own
sequence — confirm the actual behavior in the output rather than assuming
number preservation).

- [ ] **Step 3: Comment on #180 summarizing what happened**

```bash
gh issue comment 180 --repo cory-johannsen/foundry-deck-of-many-things --body "Split complete: foundry-pf2e-dungeon-crawl now owns dungeon-crawl logic/UI/data, driven by a registerGenerator interface (DefaultGenerator ships built-in). deck-of-many-more-things keeps the card deck + divination plus shared infra the new module depends on. #134-139 and #162-167 transferred to the new repo. See docs/superpowers/specs/2026-09-21-dungeon-crawl-module-split-design.md for the full design."
```

---

### Task 7: Live verification

**Files:** none (live Foundry world, via the `foundry-rest` skill).

**Interfaces:** none.

- [ ] **Step 1: Install both modules in the test world**

Using the `foundry-rest` skill, confirm (or install) both modules'
manifest URLs in the live test world:
`https://raw.githubusercontent.com/cory-johannsen/foundry-deck-of-many-things/main/module.json`
and
`https://raw.githubusercontent.com/cory-johannsen/foundry-pf2e-dungeon-crawl/main/module.json`,
then enable both.

- [ ] **Step 2: Confirm no missing-dependency error**

Check the world's module list / console for a Foundry dependency warning
on `pf2e-dungeon-crawl` about its `deck-of-many-more-things` requirement —
none expected, since it's installed.

- [ ] **Step 3: Start a dungeon run**

Via `foundry-rest`, trigger `game.modules.get('pf2e-dungeon-crawl').api.openDungeon()`
(or the "DOMMT: Dungeon Crawl" macro) and start a run. Confirm:
- The entry room builds without error.
- The first real room populates an encounter (confirms
  `generateEncounterRoster` resolves through `getGenerator()` correctly).
- Spawned creature tokens render with their art (confirms the creature-art
  migration).

- [ ] **Step 4: Confirm shared-infra calls work**

Trigger something that exercises a shared-infra path from dungeon-side
code — e.g. a trap room populating (`trap-combat.mjs`, shared infra) or a
spawned NPC getting treasure (`treasure.mjs`, shared infra via
`foundry-api.mjs`). Confirm no `Cannot find module` or `is not a function`
error in the world's console.

- [ ] **Step 5: Report results**

Summarize what was verified live (and anything that didn't work) back to
the user — this is the final step of the plan; any live-verification
failure gets filed as a new issue against whichever repo actually owns
the broken code, not silently patched here.
