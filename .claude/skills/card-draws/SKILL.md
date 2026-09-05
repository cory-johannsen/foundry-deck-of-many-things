---
name: card-draws
description: Use when working on drawing cards from the play deck in this module — the deck's state and house rules, adding or changing a card's mechanics, writing an effect handler, or anything touching plan/confirm/cancel, extra draws, terminators or Tower's keep-one.
---

# Drawing from the play deck

## The house rule that shapes everything

The play deck is **shared and depleting**. One deck for the whole table, and a card drawn is gone until the deck is reset. It does not reshuffle when it empties; drawing from an empty deck warns and stops.

So a draw is not repeatable and not undoable. `resetDeck` is the only way back and it discards the campaign's whole draw history. Never draw to test something — see *Testing against a live world* below.

## State

Two world settings hold everything:

- `playDeck` — `{ remaining: [cardId], drawn: [{cardId, actorId, at}], seed }`
- `worldSeed` — the string the shuffle came from

`remaining` is the shuffled order; drawing shifts off the front.

**The deck persists after every single card**, not once at the end of a run. A handler that throws or a dialog that blocks would otherwise leave the deck believing nothing had been drawn, and every card already turned over could come up again.

## The live draw loop is `runDraws`

`scripts/draw-run.mjs`. Everything that turns cards over goes through it — the deck app, the macro, and `api.draw()`.

It holds a **budget** that grows as cards that grant draws come up, so Fool's two extra follow from Fool being drawn rather than waiting on a confirmation. Within the loop:

- `rules.draw_terminating` breaks it, and nothing further is drawn
- `mechanics.kind === 'draw_two_keep_one'` (Tower) hands off to `drawTwoKeepOne` and continues
- a GM resolution that returns `extraDraws` adds to the budget
- `extraDrawsFor(card)` reads `params.additional_draws`, but excludes `bonus_draws` and `draw_two_keep_one`, whose draws are taken elsewhere

**`drawMany` in `deck.mjs` is not this.** Nothing in production calls it; only tests do. It also contains a dead branch where both arms increment identically, so Fool's `counts_as_one` is computed and discarded. Do not reach for it as a model of how drawing works, and do not fix a draw bug there expecting it to change behaviour.

## Writing a handler

Registered by `mechanics.kind` in the `HANDLERS` table in `scripts/card-effects.mjs`.

```js
export async function applyThing({ actor, params, api, card, rng }) {
  return { mode: 'auto', log: 'what the player sees', meta: { … } };
}
```

- `mode: 'auto'` — it happened. `mode: 'gm'` — it needs a person; say why in `log`.
- `log` is **public**. Anything the players must not know goes in a `whisperGM` chat card and `gmNote`, never in `log`. See Flames and Rogue.
- `meta` and `gmNote` are not rendered in the chat card; only `narration`, `rules.full` and `log` are.
- Use `api` for every read and write. Touching `game` or `actor.update` directly breaks planning.

## Plan, confirm, cancel

A handler is run twice: once against a recording api that captures writes and passes reads through, then — on confirmation — by replaying exactly the calls that were recorded.

This is why **a handler must pick while planning**. A card granting "a random magic weapon" chooses the weapon during the plan, so the name shown is the one that lands. Re-running the handler would roll again and hand over something else.

Consequences when writing one:

- Any randomness must come from the injected `rng`, never `Math.random`.
- Reads may happen twice; writes happen once, on replay.
- A write method must exist in `WRITE_METHODS` in `foundry-api.mjs` or the plan cannot replay it.

## Adding or changing a card

1. `data/cards.json` — `mechanics.kind`, `mechanics.params`, and `rules` (`summary`, `full`, `narration`, `draw_terminating`).
2. A handler for that `kind`, unless one already fits.
3. `npm run validate` — checks the schema, all 660 divination slots, and that the summary agrees with the params. A summary saying "level 12 or lower" while the params say otherwise fails here.
4. `npm test`.

**Card text is PF2e-only.** No 5e terms, no XP thresholds from another game, no alignment. The validator catches mismatches with params but not tone.

**A param nobody reads is the recurring bug in this module.** `size_min`, `counts_as_one`, the deck-flow flags and Prisoner's spellcasting override were all written into `cards.json` and never read, so the card silently did nothing or did the wrong thing. When adding a param, grep for it and confirm a handler actually consumes it.

## Testing against a live world

Drawing spends the card permanently. Prefer, in order:

1. `npm test` — handlers are pure given a stubbed api.
2. `planCardEffect` — runs the handler and reports what it *would* write, writing nothing.
3. `api.drawForced(cardId, { actorId })` — only with explicit permission, and say first that it consumes the card.

Settings cannot be written through the REST relay, so a spent deck cannot be restored that way either. See the `foundry-rest` skill.
