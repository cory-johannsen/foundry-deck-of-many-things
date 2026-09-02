# Card Art Label Audit

> **Historical.** This audit describes art generated before the pipeline was reworked; that art no longer exists. Its finding — that the literal word "tarot" in the prompt was being rendered into the label cartouche — drove the move to composited labels. See [card-art-pipeline.md](card-art-pipeline.md) for the current pipeline.


Scan of all 66 card faces plus `back.png` in `assets/cards/`, checking the label
cartouche below the artwork and the matching position above it.

**Not one card carries its own name.** All 66 are defective: 26 have no label at
all, 40 have a wrong one. A further 7 also have unwanted text at the top.

## Root cause

Every prompt begins with the literal string `Tarot card:` and repeats
`tarot card illustration` later; none of them says what the label should read.
Only 2 of 66 mention a label at all, and only 28 happen to contain their own card
name anywhere in the text. The generator reserves a cartouche in the border and
fills it with the most salient word available — `TAROT` — or a garbling of it
(`TARCT`, `TARRT`, `TAIRORT`, `TART`, `TARIOD`).

The two failure modes follow directly:

- **Wrong label** — the model rendered `TAROT` where the card name belongs.
- **Missing label** — the model drew the cartouche but left it empty, or omitted
  it, having been given no text to place.

Fixing this needs the prompt to state the label text explicitly and to stop
feeding the word "tarot" in as a candidate string.

## Missing label — 26 cards

No text in the bottom cartouche, or no cartouche at all.

balance, book, celestial, comet, door, euryale, fates, flames, fool, gem,
jester, key, map, maze, mine, moon, pit, puzzle, ring, staff, stairway, star,
throne, tower, tree, well

## Incorrect label — 40 cards

| Card | Renders as | | Card | Renders as |
|---|---|---|---|---|
| aberration | `TAROT` | | path | `TAIRORT` |
| beast | `TARCT` | | plant | `TAROT` |
| bridge | `AT IAROPD.` | | priest | `TAROT` |
| campfire | `THE CAMBIRL` | | prisoner | `TAROT` |
| cavern | `A TAROT` | | rogue | `TAROT` |
| construct | `TAROT` | | ruin | `AKRIDA` / `DMACK` |
| corpse | `TAROT` | | sage | `TAROT` + garbled subtitle |
| crossroads | `TART` | | shield | `TAR.OT` |
| donjon | `TAROT` | | ship | `TAROT` |
| dragon | `WARLNG` | | skull | `TAROT` |
| elemental | `TAROT` | | statue | `TAROT` + garbled subtitle |
| expert | `SHKBEFXT` | | sun | `THE TAROT` + `5920` |
| fey | `TAGCS` | | talons | `TARCT` |
| fiend | `FIT AND` | | tavern | `TAROT` |
| giant | `TAROT` + garbled subtitle | | temple | `TAROT` |
| humanoid | `TAI…V16DL` | | tomb | `TARIOD HIIS CATOD.` |
| knight | `TAROT` | | undead | `TARRT` |
| lance | `TAROT` | | void | `TAROT` |
| mage | `TAROCT` + garbled | | warrior | `TAROT` |
| monstrosity | `TAROT` | | | |
| ooze | `TAROT` | | | |

`campfire` is the closest any card gets — `THE CAMBIRL` is a garbled attempt at
CAMPFIRE, and its prompt is one of the few containing its own card name.

## Unwanted text at the top — 7 cards

These need the top band cleared as well as the bottom label fixed. All seven are
also in the incorrect-label list.

| Card | Top reads |
|---|---|
| crossroads | `ARO` |
| elemental | `TAROT` |
| expert | `TAROT` |
| ooze | `TAROT` |
| prisoner | `Y TARCT G` |
| sage | `ATARIT` / `ARART` |
| warrior | `TIMT. AGRD` |

## Minor — decorative medallions

Several cards carry small border medallions holding single letter- or
numeral-like glyphs rather than banner text: `moon` (`I` top, `6` bottom),
`plant` (`I`), `priest` (`B`/`E`), `throne` (`T`), `tomb` (`T`). These read as
ornament rather than mangled words. Listed for completeness; no action assumed.

## back.png

Correct. Purely ornamental, no text anywhere — which is right for a card back.

## Suggested prompt changes

1. Drop the `Tarot card:` prefix and the `tarot card illustration` phrase, or
   replace with wording that carries no renderable word (e.g. "occult divination
   card"). The literal word is what is being drawn.
2. State the label explicitly and exactly once, e.g. *a banner at the bottom
   bearing only the word BEAST in serif capitals*.
3. State that the top border carries **no** text, to suppress the second band.
4. Expect residual garbling regardless — diffusion models render short words far
   more reliably than long ones, so `ABERRATION` and `MONSTROSITY` are higher
   risk than `GEM` or `KEY`. Compositing the label in afterwards (Pillow, over a
   deliberately blank cartouche) would be far more reliable than prompting for
   it, if it is worth the extra pipeline step.
