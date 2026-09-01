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

const CARD_W = 140;
const CARD_H = 205;

// (cx, cy) is the CENTER of the card on the scene canvas.
// `rotation` is the base rotation for the position (Challenge lies across the Significator at 90°).
// `sort` controls z-order for the crossing card so it sits above the Significator.
const LAYOUT = {
  significator: { cx:  500, cy: 400, rotation:  0, sort:  0 },
  challenge:    { cx:  500, cy: 400, rotation: 90, sort: 10 },
  foundation:   { cx:  500, cy: 620, rotation:  0, sort:  0 },
  recent_past:  { cx:  300, cy: 400, rotation:  0, sort:  0 },
  crown:        { cx:  500, cy: 180, rotation:  0, sort:  0 },
  near_future:  { cx:  700, cy: 400, rotation:  0, sort:  0 },
  self:         { cx: 1300, cy: 720, rotation:  0, sort:  0 },
  environment:  { cx: 1300, cy: 540, rotation:  0, sort:  0 },
  hopes_fears:  { cx: 1300, cy: 360, rotation:  0, sort:  0 },
  outcome:      { cx: 1300, cy: 180, rotation:  0, sort:  0 }
};

const DEAL_DELAY_MS = 600;

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
    width: SCENE_WIDTH,
    height: SCENE_HEIGHT,
    padding: 0,
    grid: { type: 0, size: 100, alpha: 0, distance: 5, units: 'ft' },
    tokenVision: false,
    fogExploration: false,
    initial: { x: SCENE_WIDTH / 2, y: SCENE_HEIGHT / 2, scale: 0.6 },
    levels: [{
      _id: 'defaultLevel0000',
      name: 'Level',
      elevation: { bottom: 0, top: 20 },
      background: { src: CLOTH_PATH, tint: '#ffffff', alphaThreshold: 0.75 },
      foreground: { src: null, tint: '#ffffff', alphaThreshold: 0.75 },
      sort: 0
    }],
    flags: { [MODULE_ID]: { role: SCENE_ROLE, backgroundVersion: 2 } }
  };
}

async function migrateExistingScene(scene) {
  const alreadyOk = scene.getFlag(MODULE_ID, 'backgroundVersion') >= 2;
  if (alreadyOk) return scene;
  const levels = scene.levels?.contents ?? scene.levels ?? [];
  const defaultLevel = levels[0];
  const needsBackground = !defaultLevel?.background?.src;
  if (!needsBackground && alreadyOk) return scene;
  try {
    await scene.update({
      background: { src: CLOTH_PATH, tint: '#ffffff' },
      levels: [{
        _id: defaultLevel?._id ?? defaultLevel?.id ?? 'defaultLevel0000',
        name: defaultLevel?.name ?? 'Level',
        elevation: defaultLevel?.elevation ?? { bottom: 0, top: 20 },
        background: { src: CLOTH_PATH, tint: '#ffffff', alphaThreshold: 0.75 },
        foreground: defaultLevel?.foreground ?? { src: null, tint: '#ffffff', alphaThreshold: 0.75 },
        sort: defaultLevel?.sort ?? 0
      }],
      flags: { [MODULE_ID]: { role: SCENE_ROLE, backgroundVersion: 2 } }
    });
  } catch (e) {
    console.warn(`${MODULE_ID} | migrateExistingScene failed`, e);
  }
  return scene;
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
    buttons: [{ action: 'next', label: isLast ? 'Finish' : 'Next card', default: true }],
    rejectClose: false
  });
}

export async function performDivinationOnTable() {
  if (!game.user.isGM) {
    ui.notifications.warn('Only the GM can perform a divination on the table.');
    return;
  }

  const category = await chooseCategory();
  if (!category || category === 'cancel') return;

  const scene = await ensureDivinationScene();
  await clearReadingTiles(scene);
  await scene.view();
  await new Promise((r) => setTimeout(r, 400));

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
    const isReversed = slot.orientation === 'reversed';
    const tileRotation = layout.rotation + (isReversed ? 180 : 0);
    await scene.createEmbeddedDocuments('Tile', [{
      texture: { src: `modules/${MODULE_ID}/${card.art.front}` },
      x: layout.cx - CARD_W / 2,
      y: layout.cy - CARD_H / 2,
      width: CARD_W,
      height: CARD_H,
      rotation: tileRotation,
      sort: layout.sort,
      flags: { [MODULE_ID]: { kind: TILE_KIND, position: slot.position, orientation: slot.orientation, cardId: card.id } }
    }]);
    await new Promise((r) => setTimeout(r, DEAL_DELAY_MS));

    const displayOrientation = slot.position === 'challenge' ? 'upright' : slot.orientation;
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
}

export async function clearDivinationTable() {
  if (!game.user.isGM) return;
  const scene = game.scenes.find((s) => s.getFlag(MODULE_ID, 'role') === SCENE_ROLE);
  if (!scene) return;
  await clearReadingTiles(scene);
}
