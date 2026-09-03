import { loadCards, loadCelticCross } from './data-loader.mjs';
import {
  dealCelticCross,
  readingFromSpread,
  makeCardsById,
  DIVINATION_CATEGORIES
} from './deck.mjs';

const MODULE_ID = 'deck-of-many-more-things';
const SCENE_ROLE = 'divination-table';
const TILE_KIND = 'divination-card';

const SCENE_WIDTH = 1536;
const SCENE_HEIGHT = 864;

// Foundry defaults an unset scene background to #999999. The reading cloth is
// dark, so anything visible around it must be black, not grey.
const SCENE_BACKGROUND_COLOR = '#000000';

// Bumped whenever buildSceneCreateData() changes in a way an already-created
// scene needs applied to it. migrateExistingScene() replays the full set.
const SCENE_DATA_VERSION = 3;

const CARD_W = 140;
const CARD_H = 205;

// Fraction of the scene the spread may occupy. Overlapping the cloth's woven
// border is fine; this only keeps the outer cards from reaching the very edge
// of the image.
const SPREAD_MARGIN = 0.94;

// Centre-to-centre spacing. Anything above CARD_H leaves a visible gap between
// neighbours; at or below it the cards overlap.
const STAFF_SPACING = 230;   // 205 card + 25 gap, for positions 7-10
const CROSS_SPACING = 220;   // Crown / Heart / Foundation

// Vertical centre shared by both the cross and the staff, so the two columns
// line up with each other rather than the staff hanging lower.
const SPREAD_CY = 450;

// Horizontal geometry. The staff (7-10) is placed relative to Near Future (6),
// the cross's rightmost card, so the clear space between the two columns stays
// exactly STAFF_GAP however the cross is sized or moved.
const CROSS_CX = 500;
const CROSS_ARM = 200;                       // Recent Past / Near Future offset
const STAFF_GAP = CARD_W;                    // one card width of clear cloth
const STAFF_CX = CROSS_CX + CROSS_ARM + CARD_W + STAFF_GAP;

// (cx, cy) is the CENTER of the card within the LAYOUT's own design space.
// These are NOT canvas coordinates: placeTiles() measures the bounding box of
// the whole spread and centres it inside the scene rect, so the numbers below
// only need to be correct relative to each other.
// `rotation` is the base rotation for the position (Challenge lies across the Heart card at 90°).
// `sort` controls z-order for the crossing card so it sits above the Heart card.
// The staff (7-10) reads bottom to top: Self lowest, Outcome highest.
const staffCy = (fromBottom) => SPREAD_CY + (1.5 - fromBottom) * STAFF_SPACING;

const LAYOUT = {
  heart:        { cx: CROSS_CX,              cy: SPREAD_CY,                 rotation:  0, sort:  0 },
  challenge:    { cx: CROSS_CX,              cy: SPREAD_CY,                 rotation: 90, sort: 10 },
  foundation:   { cx: CROSS_CX,              cy: SPREAD_CY + CROSS_SPACING, rotation:  0, sort:  0 },
  recent_past:  { cx: CROSS_CX - CROSS_ARM,  cy: SPREAD_CY,                 rotation:  0, sort:  0 },
  crown:        { cx: CROSS_CX,              cy: SPREAD_CY - CROSS_SPACING, rotation:  0, sort:  0 },
  near_future:  { cx: CROSS_CX + CROSS_ARM,  cy: SPREAD_CY,                 rotation:  0, sort:  0 },
  self:         { cx: STAFF_CX,              cy: staffCy(0),                rotation:  0, sort:  0 },
  environment:  { cx: STAFF_CX,              cy: staffCy(1),                rotation:  0, sort:  0 },
  hopes_fears:  { cx: STAFF_CX,              cy: staffCy(2),                rotation:  0, sort:  0 },
  outcome:      { cx: STAFF_CX,              cy: staffCy(3),                rotation:  0, sort:  0 }
};

const DEAL_DELAY_MS = 600;

const SOUNDS = {
  // Played once as the table comes up.
  open: `modules/${MODULE_ID}/assets/sounds/card-fan-1.ogg`,
  // Played as each card lands.
  place: `modules/${MODULE_ID}/assets/sounds/card-place-1.ogg`
};
const SOUND_VOLUME = 0.7;

/**
 * Fire-and-forget so audio can never stall or break a reading — a missing file
 * or a browser autoplay block should cost the sound, not the deal. The `true`
 * broadcasts to every connected client so the whole table hears it, not just
 * the GM running the macro.
 */
function playSound(src) {
  try {
    const played = foundry.audio.AudioHelper.play(
      { src, volume: SOUND_VOLUME, autoplay: true, loop: false }, true);
    if (played?.catch) played.catch((e) => console.warn(`${MODULE_ID} | sound failed: ${src}`, e));
  } catch (e) {
    console.warn(`${MODULE_ID} | sound failed: ${src}`, e);
  }
}

const CLOTH_PATH = `modules/${MODULE_ID}/assets/cloth.png`;

/**
 * The Foundry v14 Scene document stores the background image inside a
 * per-level structure: `scene.levels[0].background.src`. Older Foundry
 * versions (v11–v13) accept a top-level `background: { src }` field. We
 * include both so the create call works across versions.
 */
function buildSceneCreateData() {
  return {
    name: 'Celtic Cross — Divination Table',
    background: { src: CLOTH_PATH, tint: '#ffffff' },
    backgroundColor: SCENE_BACKGROUND_COLOR,
    width: SCENE_WIDTH,
    height: SCENE_HEIGHT,
    // Must stay 0: the cloth is sized to the scene rect exactly, so any padding
    // shows as a band of backgroundColor around it.
    padding: 0,
    grid: { type: 0, size: 100, alpha: 0, distance: 5, units: 'ft' },
    tokenVision: false,
    fogExploration: false,
    initial: { x: SCENE_WIDTH / 2, y: SCENE_HEIGHT / 2, scale: 0.6 },
    levels: [{
      _id: 'defaultLevel0000',
      name: 'Level',
      elevation: { bottom: 0, top: 20 },
      background: {
        src: CLOTH_PATH,
        // v14 reads the canvas fill from levels[0].background.color; the
        // top-level backgroundColor above is the v13 spelling. Set both.
        color: SCENE_BACKGROUND_COLOR,
        tint: '#ffffff',
        alphaThreshold: 0.75
      },
      foreground: { src: null, tint: '#ffffff', alphaThreshold: 0.75 },
      sort: 0
    }],
    flags: { [MODULE_ID]: { role: SCENE_ROLE, backgroundVersion: SCENE_DATA_VERSION } }
  };
}

/**
 * Bring an already-created scene up to SCENE_DATA_VERSION.
 *
 * Earlier versions only replayed the background, which left `padding` at
 * whatever the scene was created with. A scene still carrying Foundry's default
 * 0.25 padding renders the cloth inset from the canvas origin, so every tile
 * placed in canvas coordinates lands high and to the left of the cloth, with a
 * grey band around it. Replay the full geometry, not just the background.
 */
async function migrateExistingScene(scene) {
  if (scene.getFlag(MODULE_ID, 'backgroundVersion') >= SCENE_DATA_VERSION) return scene;
  const levels = scene.levels?.contents ?? scene.levels ?? [];
  const defaultLevel = levels[0];
  try {
    await scene.update({
      background: { src: CLOTH_PATH, tint: '#ffffff' },
      backgroundColor: SCENE_BACKGROUND_COLOR,
      width: SCENE_WIDTH,
      height: SCENE_HEIGHT,
      padding: 0,
      levels: [{
        _id: defaultLevel?._id ?? defaultLevel?.id ?? 'defaultLevel0000',
        name: defaultLevel?.name ?? 'Level',
        elevation: defaultLevel?.elevation ?? { bottom: 0, top: 20 },
        background: {
          src: CLOTH_PATH,
          color: SCENE_BACKGROUND_COLOR,
          tint: '#ffffff',
          alphaThreshold: 0.75
        },
        foreground: defaultLevel?.foreground ?? { src: null, tint: '#ffffff', alphaThreshold: 0.75 },
        sort: defaultLevel?.sort ?? 0
      }],
      flags: { [MODULE_ID]: { role: SCENE_ROLE, backgroundVersion: SCENE_DATA_VERSION } }
    });
  } catch (e) {
    console.warn(`${MODULE_ID} | migrateExistingScene failed`, e);
  }
  return scene;
}

/**
 * Fit the LAYOUT design space onto the cloth's inner field.
 *
 * Two things this has to get right:
 *
 * 1. Scale. The authored layout is taller than the scene, so scale the whole
 *    spread uniformly to fit within SPREAD_MARGIN of the scene rect. Cards may
 *    overlap the cloth's woven border; they just must not reach the image edge.
 * 2. Origin. Tile x/y are canvas coordinates, which include the scene's padding
 *    offset, whereas the background is drawn from the scene rect origin. Read
 *    sceneX/sceneY rather than assuming zero padding.
 *
 * Returns the scale factor plus a transform from design space to canvas space.
 */
function layoutTransform(scene) {
  const dim = scene.dimensions ?? {};
  const originX = dim.sceneX ?? 0;
  const originY = dim.sceneY ?? 0;

  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const slot of Object.values(LAYOUT)) {
    // A card rotated 90° swaps its footprint; 180° (reversed) does not.
    const quarterTurned = Math.abs(slot.rotation % 180) === 90;
    const halfW = (quarterTurned ? CARD_H : CARD_W) / 2;
    const halfH = (quarterTurned ? CARD_W : CARD_H) / 2;
    minX = Math.min(minX, slot.cx - halfW);
    maxX = Math.max(maxX, slot.cx + halfW);
    minY = Math.min(minY, slot.cy - halfH);
    maxY = Math.max(maxY, slot.cy + halfH);
  }
  const spreadW = maxX - minX;
  const spreadH = maxY - minY;

  const rectW = dim.sceneWidth ?? SCENE_WIDTH;
  const rectH = dim.sceneHeight ?? SCENE_HEIGHT;

  // Never scale up: a spread that already fits keeps its authored size.
  const scale = Math.min(1, rectW / spreadW, rectH / spreadH) * SPREAD_MARGIN;

  // Centre the scaled spread on the scene rect, then offset into canvas space.
  const fieldCx = rectW / 2;
  const fieldCy = rectH / 2;
  const spreadCx = (minX + maxX) / 2;
  const spreadCy = (minY + maxY) / 2;

  return {
    scale,
    cardW: CARD_W * scale,
    cardH: CARD_H * scale,
    toCanvasX: (cx) => originX + fieldCx + (cx - spreadCx) * scale,
    toCanvasY: (cy) => originY + fieldCy + (cy - spreadCy) * scale
  };
}

export async function ensureDivinationScene() {
  const existing = game.scenes.find((s) => s.getFlag(MODULE_ID, 'role') === SCENE_ROLE);
  if (existing) return migrateExistingScene(existing);
  const scene = await Scene.create(buildSceneCreateData());
  return scene;
}

async function clearReadingTiles(scene) {
  const tileIds = scene.tiles
    .filter((t) => t.getFlag(MODULE_ID, 'kind') === TILE_KIND)
    .map((t) => t.id);
  if (tileIds.length) await scene.deleteEmbeddedDocuments('Tile', tileIds);
}

async function chooseCategory() {
  const { DialogV2 } = foundry.applications.api;
  const options = DIVINATION_CATEGORIES
    .map((c) => `<option value="${c}">${game.i18n.localize(`DOMMT.Divination.Category.${c}`)}</option>`)
    .join('');
  return DialogV2.wait({
    window: { title: game.i18n.localize('DOMMT.Divination.Title') },
    content: `
      <form>
        <div class="form-group">
          <label>${game.i18n.localize('DOMMT.Divination.CategoryLabel')}</label>
          <select name="category" style="width:100%;">${options}</select>
        </div>
      </form>`,
    buttons: [
      {
        action: 'deal',
        label: game.i18n.localize('DOMMT.Divination.DealButton'),
        default: true,
        callback: (_event, _button, dialog) => dialog.element.querySelector('[name="category"]').value
      },
      { action: 'cancel', label: 'Cancel' }
    ],
    rejectClose: false
  });
}

async function showCardDialog({ order, positionMeta, card, orientationLabel, category, text, isLast, isReversed }) {
  const { DialogV2 } = foundry.applications.api;
  const emptyMsg = game.i18n.localize('DOMMT.Divination.EmptySlot');
  const bodyText = text && text.trim().length ? text : `<em>${emptyMsg}</em>`;
  const rotStyle = isReversed ? 'transform:rotate(180deg);' : '';
  await DialogV2.wait({
    window: { title: `${order}. ${positionMeta.label} — ${card.name} (${orientationLabel})` },
    position: { width: 520 },
    content: `
      <div style="display:flex; gap:0.75rem; align-items:flex-start;">
        <img src="modules/${MODULE_ID}/${card.art.front}"
             alt="${card.name}"
             style="width:140px; height:auto; border-radius:6px; ${rotStyle}"/>
        <div style="flex:1; min-width:0;">
          <p style="margin:0 0 0.4rem;"><em>${positionMeta.meaning}</em></p>
          <hr/>
          <p style="margin:0 0 0.2rem;"><strong>${category} · ${orientationLabel}</strong></p>
          <p style="margin:0;">${bodyText}</p>
        </div>
      </div>`,
    buttons: [{ action: 'next', label: isLast ? 'End reading' : 'Next card', default: true }],
    rejectClose: false
  });
}

export async function performDivinationOnTable() {
  if (!game.user.isGM) {
    ui.notifications.warn('Only the GM can perform a divination on the table.');
    return;
  }

  // The table comes up first, then the category is chosen — so the sound and
  // the scene change land together and the querent picks with the cloth already
  // in front of them.
  const scene = await ensureDivinationScene();

  // Remember where the table was so the reading can put everyone back, whether
  // it is cancelled at the category prompt or ended after the last card.
  // Captured before activation, and null when we were already on the divination
  // scene so ending a reading never re-activates the table we are leaving.
  const priorScene = game.scenes.active ?? null;
  const priorSceneId = priorScene && priorScene.id !== scene.id ? priorScene.id : null;

  async function restorePriorScene() {
    if (!priorSceneId) return;
    // Re-resolve rather than holding the document: the scene may have been
    // deleted while the reading ran.
    const prior = game.scenes.get(priorSceneId);
    if (!prior) return;
    try {
      await prior.activate();
    } catch (e) {
      console.warn(`${MODULE_ID} | could not return to the prior scene`, e);
    }
  }

  await clearReadingTiles(scene);
  playSound(SOUNDS.open);
  // activate(), not view(): view() only moves this client, leaving players on
  // whatever scene they were already on. activate() makes it the active scene
  // and pulls everyone, and views it for the GM as well.
  if (!scene.active) await scene.activate();
  else await scene.view();
  await new Promise((r) => setTimeout(r, 400));

  const category = await chooseCategory();
  if (!category || category === 'cancel') {
    await restorePriorScene();
    return;
  }

  const fit = layoutTransform(scene);

  const cards = await loadCards();
  const byId = makeCardsById(cards);
  const positions = await loadCelticCross();
  const positionsById = new Map(positions.map((p) => [p.id, p]));

  const seed = String(Date.now()) + '-' + Math.random().toString(36).slice(2);
  const { spread } = dealCelticCross(cards, { seed, category });
  const reading = readingFromSpread(cards, byId, { category, spread });

  for (let i = 0; i < reading.positions.length; i++) {
    const slot = reading.positions[i];
    const layout = LAYOUT[slot.position];
    const card = byId.get(slot.card.id);
    const positionMeta = positionsById.get(slot.position);
    // The Crossing is read upright however it was dealt — deck.mjs already does
    // this for its text — so it must also be *shown* upright. Deriving this from
    // the raw dealt orientation instead produced a dialog captioned "Upright"
    // over a card rendered upside-down, and a tile rotated to match.
    const displayOrientation = slot.position === 'challenge' ? 'upright' : slot.orientation;
    const isReversed = displayOrientation === 'reversed';
    const tileRotation = layout.rotation + (isReversed ? 180 : 0);
    await scene.createEmbeddedDocuments('Tile', [{
      texture: { src: `modules/${MODULE_ID}/${card.art.front}` },
      // Foundry v14 anchors a Tile on its CENTRE, not its top-left corner:
      // placeable.bounds.y comes back as document.y - height/2. Pass the centre
      // straight through. Subtracting half the size here (the v13 convention)
      // renders every card half a card high and half a card left.
      x: fit.toCanvasX(layout.cx),
      y: fit.toCanvasY(layout.cy),
      width: fit.cardW,
      height: fit.cardH,
      rotation: tileRotation,
      sort: layout.sort,
      flags: { [MODULE_ID]: { kind: TILE_KIND, position: slot.position, orientation: slot.orientation, cardId: card.id } }
    }]);
    playSound(SOUNDS.place);
    await new Promise((r) => setTimeout(r, DEAL_DELAY_MS));

    const orientationLabel = game.i18n.localize(`DOMMT.Divination.Orientation.${displayOrientation}`);
    const displayText = card.divination[category][displayOrientation];
    await showCardDialog({
      order: slot.order,
      positionMeta,
      card,
      orientationLabel,
      category: game.i18n.localize(`DOMMT.Divination.Category.${category}`),
      text: displayText,
      isLast: i === reading.positions.length - 1,
      isReversed
    });
  }

  // "End reading" on the last card returns everyone to where they were. The
  // spread is deliberately left on the table so it can be revisited; use the
  // clear-table macro to take it down.
  await restorePriorScene();
}

export async function clearDivinationTable() {
  if (!game.user.isGM) return;
  const scene = game.scenes.find((s) => s.getFlag(MODULE_ID, 'role') === SCENE_ROLE);
  if (!scene) return;
  await clearReadingTiles(scene);
}
