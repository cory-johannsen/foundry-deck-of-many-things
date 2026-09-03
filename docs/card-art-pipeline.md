# Card Art Pipeline

How the 66 card images are produced, and why each stage works the way it does.
Every decision here was forced by a failure; the failures are recorded because
several of them look like obvious things to "fix" back the other way.

## The pipeline

```
data/cards.json  art.prompt
        │
        ▼  tools/generate-art.mjs        sd_xl_base_1.0, CFG 7, 28 steps
assets/cards/<id>.png                    raw art, full bleed, no frame, no text
        │
        ▼  tools/compose-cards.mjs       + assets/frame.png  + name plate
assets/cards-labeled/<id>.png            what art.front points at; Foundry loads this
```

Raw and composed art are kept in separate directories so the frame or the name
plate can be redesigned without regenerating a single image, and so a
regeneration can never clobber a finished card. `generate-art.mjs` derives its
output path from the card id rather than from `art.front`, precisely so that
repointing `art.front` at the composed directory does not send raw art there.

## Stage 1 — prompts

`tools/rewrite-prompts-hybrid.mjs` owns all 66 scenes and writes them into
`data/cards.json`. Re-run it to change wording; do not hand-edit prompts.

**Hybrid direction**: the scene comes from the card's `flavor` field — the
illustration printed in the hardcopy book — and the card's mechanic appears as
mood or a secondary detail, usually the clause after the semicolon. Tower is
the clearest example: a black stone tower on a desolate waste (flavor), with
two faint paths diverging from its base (`draw_two_keep_one`).

The prompts originally came from `mechanics.kind` alone, so the art depicted
game effects rather than the printed scenes — 30 of 66 conflicted outright.

**Prompts must not ask for a card name or a border.** Both are composited in
stage 2. Three separate attempts to prompt for them all failed:

| Attempt | Result |
|---|---|
| `Tarot card:` prefix | the literal word TAROT rendered into a cartouche on 40 cards, blank cartouche on 26 |
| prefix removed | text fixed, but ~9% of cards lost their border entirely |
| `Ornate framed card illustration:` prefix | border restored, but a *card*-noun in title position brought gibberish cartouches back on 12 of 66 |
| `ornate gold border` in the style tags | absorbed into the subject — a glass tank on Ooze, a hung picture frame on Staff, the building's own facade on Temple |

The pattern: a noun in **title position** gets rendered as lettering, and a
border adjective gets treated as part of the scene. Neither is fixable by
prompt wording, which is why both moved to compositing.

`generate-art.mjs` carries the other half of this in its negative prompt —
text, cartouche, banner, nameplate terms at weight 1.4–1.5, plus frame and
border terms so the model's own frame cannot clash with the composited one.

## Stage 2 — compositing

`tools/compose-cards.mjs` (driver) and `tools/compose_cards.py` (Pillow).

**Frame.** `assets/frame.png` is generated gold ornament on a flat black field.
Its alpha is keyed on **chroma** (red minus blue), not luminance: the gold is
warm (chroma 72–97) while the field is neutral (chroma ≤ 7), so chroma
separates them cleanly. Luminance does not — the field carries a faint radial
gradient peaking near 66, which would fog the art beneath it.

**Name plate.** Drawn from `card.name`, so it is exact on every card and cannot
disagree with the card data. Type auto-fits, so MONSTROSITY and KEY sit at the
same optical weight. Geometry constants are at the top of `compose_cards.py`.

## Stage 3 — verification

`tools/audit_card_art.py` screens for missing borders and rendered text.

**Treat it as a ranker, not an oracle.** Measured against human review it
produced false results in both directions: it passed cards whose art bled to
every edge (ornate in-scene architecture satisfies its symmetry test) and
flagged framed cards as borderless. It also flags subject-matter writing — a
book's pages, runes on a staff — which is not a defect. Two earlier metrics
were tried and discarded: edge-strip *uniformity* fails because these frames
are dense filigree with high variance, and *pixel-level* mirror symmetry fails
because diffusion frames are symmetric in structure but not pixel-for-pixel.

Anything it flags needs eyes on it, and a clean screen does not mean a clean
card.

## Model choice

`sd_xl_base_1.0` at CFG 7 / 28 steps, ~106s per card.

The deck was previously generated on `dreamshaperXL_lightningDPMSDE` at CFG 2 /
6 steps (~26s). Lightning checkpoints require very low CFG, and at that guidance
the model follows the prompt weakly: scenes dropped their named elements (Map
with no X, Balance with no scales, Mine with no pick) and drifted photo-real
despite the style tags. The same Mine prompt on `sd_xl_base` came back properly
illustrated in the intended palette.

All four settings are env-overridable — `COMFYUI_CHECKPOINT`, `COMFYUI_STEPS`,
`COMFYUI_CFG`, `COMFYUI_SAMPLER` — so dropping back to lightning for a fast
iteration is one variable. Expect the fidelity loss above if you do.

## Running it

```bash
node tools/rewrite-prompts-hybrid.mjs        # regenerate prompts from scenes
node tools/generate-art.mjs --force          # all 66, ~2 hours
node tools/generate-art.mjs --only tower,mine --force
node tools/compose-cards.mjs --all           # frame + plate onto every card
python3 tools/audit_card_art.py assets/cards # screen, then look at what it flags
```

`compose-cards.mjs` needs a Python with Pillow and numpy; set `PILLOW_PYTHON`
if the default `python3` lacks them.
