# Deck of Many More Things — Foundry VTT Module

Foundry v13 module implementing the **Deck of Many More Things** (all 66 cards) for **Pathfinder 2E**. Includes two play modes:

1. **Playing the Deck** — declare N draws, draw within 1 hour, effects auto-apply where safe. The play deck is **shared, world-scoped, and depletes**: drawn cards do not return; only the GM can reset the deck. This is a deliberate deviation from the wikidot "cards fade and reappear" rule.
2. **Divination — Celtic Cross tarot spread** — deal 10 cards into the canonical positions (Heart of the Matter, Crossing, Crown, Foundation, Past, Future, Querent, Environment, Hopes & Fears, Outcome). The querent declares one of five categories (Person / Creature or Trap / Place / Treasure / Situation) before dealing; each card lands upright or reversed. Divination uses a fresh ephemeral deck and never touches the shared play deck.

## Install

Install by manifest URL in Foundry:

```
https://raw.githubusercontent.com/cory-johannsen/foundry-deck-of-many-things/main/module.json
```

Requires the `pf2e` system (minimum v6.0.0) and Foundry v13.

## Usage

- Open the deck from the scene-controls Token menu (Deck icon), or via a macro:
  ```js
  game.modules.get('deck-of-many-more-things').api.openDeck();
  ```
- Divination:
  ```js
  game.modules.get('deck-of-many-more-things').api.openDivination();
  ```
- Force a specific card (for testing / GM adjudication):
  ```js
  await game.modules.get('deck-of-many-more-things').api.drawForced('star', { actorId: 'ACTORID' });
  ```
- Reset the play deck (GM-only):
  ```js
  await game.modules.get('deck-of-many-more-things').api.resetDeck();
  ```

### Effect handling

The module auto-applies safe PF2e effects: HP changes, ability boosts (as `+1` to mod), conditions (Fatigued/Drained/Restrained/Dying), added speeds, save-penalty effects (Euryale), and long-rest restoration. Complex effects (Wish, Gate, summons, item grants, alignment flip, etc.) post a **GM adjudication chat card** rather than mutating the actor — see the `PF2e translation` section of `docs/…` for the mapping.

Toggle auto-apply in module settings: **"Auto-apply effects"**.

## Divination text transcription

Cory transcribes the 5 categories × 2 orientations = 10 divination texts per card (660 total) from his hard copy. Edit `data/cards.json` directly; every card's `divination` block has this shape:

```jsonc
"divination": {
  "person":           { "upright": "", "reversed": "" },
  "creature_or_trap": { "upright": "", "reversed": "" },
  "place":            { "upright": "", "reversed": "" },
  "treasure":         { "upright": "", "reversed": "" },
  "situation":        { "upright": "", "reversed": "" }
}
```

Empty slots render as *"(divination text not yet transcribed)"* at runtime, so the module is fully usable during transcription. Check progress:

```
npm run validate
node tools/validate-cards.mjs --verbose   # per-card breakdown
```

## Card sounds

Each card plays a sound when its effect is **applied** — not when it is drawn, so a
card waiting on GM approval stays quiet until the GM confirms it.

The 66 cards span 59 distinct `mechanics.kind` values, so sounds are keyed to the
*character* of the effect rather than the kind: a boon, a curse, a summoning. That
is 14 files instead of 66, and two cards that both hand you a magic item sound alike.

    node tools/sound-manifest.mjs             # what is needed, what is missing
    node tools/sound-manifest.mjs --missing   # bare filenames, one per line

Put the files in `assets/sounds/` under the names the manifest lists. Any card can
override its group by naming its own file in `data/cards.json`:

    { "id": "skull", "sound": "skull-laugh.ogg", ... }

A bare filename resolves under `assets/sounds/`; a path with a separator is used
as-is, relative to the module root. Going fully per-card just means giving all 66
cards a `sound`. Group mappings live in `scripts/card-sound.mjs`; a test fails if
any card would end up silent or any `mechanics.kind` lacks a group.

## Development

```
npm install
npm test               # Vitest — deck logic + card-effects handlers
npm run validate       # ajv schema + divination coverage
npm run art            # regenerate art via ComfyUI (see below)
npm run build:pack     # emit compendium source JSON
```

### Regenerating art

Cards art lives under `assets/cards/*.png`, generated from `card.art.prompt` in `cards.json` via a ComfyUI server.

```
COMFYUI_BASE_URL=https://comfyui.johannsen.cloud \
COMFYUI_CHECKPOINT=dreamshaperXL_lightningDPMSDE.safetensors \
node tools/generate-art.mjs                # only missing cards
node tools/generate-art.mjs --force        # regenerate all
node tools/generate-art.mjs --only skull   # single card
node tools/generate-art.mjs --shared       # include back + reading cloth
node tools/generate-art.mjs --dry-run      # print composed prompts only
```

### Building compendia (optional)

The runtime does not require compendia (data is loaded from `cards.json`). To ship compendium packs, generate source JSON with `npm run build:pack` and compile with the Foundry CLI:

```
npx @foundryvtt/foundryvtt-cli package pack --in packs/deck-of-many-more-things/_source --out packs/deck-of-many-more-things
npx @foundryvtt/foundryvtt-cli package pack --in packs/deck-macros/_source --out packs/deck-macros
```

## References

- Card list and effect summaries: https://dnd5e.wikidot.com/wondrous-items:deck-of-many-more-things
- Image prompts: https://github.com/cory-johannsen/haunted-melodies/blob/main/assets/deck/image-prompts.md
