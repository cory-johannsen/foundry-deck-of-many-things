# Bug Tracker

## Divination

### BUG-1: Dealt cards sit too high on the reading cloth
**Severity:** medium
**Status:** fixed
**Category:** Divination
**Description:** Every dealt card rendered half a card-height above (and half a card-width left of) its intended position, so the spread sat high on the cloth with the top row jammed against the edge.
**Steps:** Run the divination macro and compare the ten dealt cards against the cloth's centre line and decorative border.
**Fix:** **Foundry v14 anchors a Tile on its centre, not its top-left corner.** The code applied the v13 convention, subtracting `CARD_W/2, CARD_H/2` to convert centre→top-left, which v14 then re-centred — shifting every card up by half its height. Proved with `execute-js` by comparing each placeable's `document.y` against its rendered `bounds.y`: the gap was exactly `height/2` for all ten tiles, and exactly `108/2 = 54` for the 90°-rotated Challenge card whose rotated height differs. At the original 205px card height that is a 102px upward shift. Fix: pass the centre straight through as `x`/`y`.

A second, independent defect was fixed at the same time: the authored spread was taller than the scene, so cards could run off the image. `layoutTransform()` now measures the spread's bounding box, scales it uniformly to fit within `SPREAD_MARGIN` (0.94) of the scene rect, and centres it there. Overlapping the cloth's woven border is accepted by design — only the image edge is respected. Verified against live rendered bounds: spread y 26–838 in an 864 scene, cards 127×186.

The layout was also reworked into derived constants while fixing this: the cross and staff now share `SPREAD_CY` (previously the staff hung 50px lower), positions 7–10 use `STAFF_SPACING` 230 for a 23px gap where they had overlapped by 19px, and `STAFF_CX` derives from Near Future so `STAFF_GAP` holds the two columns exactly one card width apart.

Two earlier theories were disproved and should not be revisited: scene `padding` is `0`, not Foundry's default `0.25`; and the canvas is **not** rounded up to whole grid squares despite 1536×864 being 15.36 × 8.64 squares at grid size 100 (`dimensions` returns `sceneX/sceneY 0`, `1536×864`, `size 100`).

### BUG-2: Area around the cloth renders grey instead of black
**Severity:** low
**Status:** fixed
**Category:** Divination
**Description:** The scene background visible around the reading cloth was Foundry's default grey rather than black.
**Steps:** Open the divination scene and look at the area surrounding the cloth image.
**Fix:** Confirmed against the live scene document over the Foundry REST API: `levels[0].background.color` is `"#999999"`, Foundry's default. Note this is **not** the top-level `backgroundColor` field — Foundry 14 reads the canvas fill from the per-level background, and the top-level property is absent from the v14 document entirely. `SCENE_BACKGROUND_COLOR = '#000000'` is now written to both spellings (top-level for v13, `levels[0].background.color` for v14) in the create data and the migration. Not related to BUG-1.

### BUG-3: Divination scene does not activate for players
**Severity:** medium
**Status:** fixed
**Category:** Divination
**Description:** Running the divination macro moved only the GM to the scene; players had to be pulled in by activating the scene manually.
**Steps:** As GM with at least one player connected, run the divination macro and observe that players remain on their previous scene. Confirmed against the live world: the scene document reports `active: false` after a reading.
**Fix:** `performDivinationOnTable()` called `scene.view()`, which is a local view change only. It now calls `scene.activate()` when the scene is not already active, which marks it active and pulls all players, falling back to `view()` when it is already active.
