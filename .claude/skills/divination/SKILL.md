---
name: divination
description: Use when working on the Celtic Cross divination in this module — the ten positions and their dealing order, the five categories and two orientations, writing or auditing the 660 divination texts, or the table scene that deals the cards.
---

# Celtic Cross divination

A reading is separate from play. It answers a question; it does not apply mechanics, and **it does not touch the play deck** — it shuffles its own copy of all 66 cards, so a reading costs nothing and can be repeated.

## The shape of the data

Every card carries `divination`, keyed by category then orientation:

```json
"divination": {
  "person":           { "upright": "…", "reversed": "…" },
  "creature_or_trap": { "upright": "…", "reversed": "…" },
  "place":            { "upright": "…", "reversed": "…" },
  "treasure":         { "upright": "…", "reversed": "…" },
  "situation":        { "upright": "…", "reversed": "…" }
}
```

66 cards × 5 categories × 2 orientations = **660 texts**. `npm run validate` reports coverage and must stay at 100%; an empty string counts as unfilled.

The querent picks one category for the whole reading, so all ten positions are read down the same column. A category with a gap produces a blank slot in the middle of a spread.

## The ten positions

Dealt in this order, defined in `CELTIC_CROSS_ORDER` (`scripts/deck.mjs`), with labels and meanings in `data/celtic-cross.json`:

```
1 heart         6 near_future
2 challenge     7 self
3 crown         8 environment
4 foundation    9 hopes_fears
5 recent_past  10 outcome
```

**The order is traditional and has been wrong before.** Crown is 3 — what is conscious, the goal, what sits above the situation — and Foundation is 4, the unconscious root beneath it, with Past at 5. An earlier version dealt 3=foundation, 4=past, 5=crown. Changing this order changes every reading's meaning, so treat it as fixed.

## Challenge is always read upright

`readingFromSpread` overrides the orientation for the `challenge` position only:

```js
const effectiveOrientation = slot.position === 'challenge' ? 'upright' : slot.orientation;
```

The crossing card has no reversal in the traditional spread — it opposes the heart whichever way it falls. Its `reversed` text is therefore never displayed in a reading, but must still be written: it is one of the 660, and the validator counts it.

## Dealing is seeded

`dealCelticCross(cards, { seed, category })` shuffles with `splitmix32` and picks each orientation from the same stream, so a seed reproduces a whole reading exactly — the cards, their order and which fell reversed. Pass a seed in tests; production seeds from the clock.

## Writing the texts

Each is one or two sentences a GM can lift straight into play, read through the lens of its category:

- `person` — who this is
- `creature_or_trap` — what it is, or what the hazard does
- `place` — where
- `treasure` — what is found
- `situation` — what is happening

Reversed is not the negation of upright. It is the other face of the same idea — the same force turned inward, thwarted, or misapplied — and it should read as its own answer rather than "not the above".

Keep them **PF2e-only**: no 5e creature types, no alignment, no mechanics from another edition. The text describes fiction, not rules; if it names a game term, name a Pathfinder one.

## The table scene

`scripts/scene-divination.mjs`. `performDivinationOnTable()` is GM-only and does, in order: build or find the scene, remember the active scene, clear old tiles, play the opening sound, **activate** the table, then ask for the category, then deal.

Two things there are deliberate and easy to undo by accident:

- **`activate()`, not `view()`.** `view()` moves only the calling client, leaving the players wherever they were. The reading is for the table, so everyone is pulled to it.
- **The prior scene is captured before activation and restored afterwards**, including when the category prompt is cancelled. It is re-resolved by id at the end rather than held, because the scene may have been deleted while the reading ran; and it is null when the table was already active, so ending a reading never re-activates the scene being left.

The category is asked *after* the table appears so the querent chooses with the cloth in front of them.
