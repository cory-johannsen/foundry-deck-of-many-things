#!/usr/bin/env node
/**
 * Emit compendium-source JSON for later compilation with `fvtt package pack`.
 *
 * We do NOT ship a LevelDB compendium in v0.0.1: the module reads cards.json at
 * runtime and does not require a compendium to function. This script produces the
 * `packs/deck-of-many-more-things/_source/*.json` and `packs/deck-macros/_source/*.json`
 * layouts that the Foundry CLI expects if/when a compendium is desired.
 *
 * Usage:
 *   node tools/build-pack.mjs
 *   # then, if you have the fvtt CLI installed:
 *   fvtt package pack --in packs/deck-of-many-more-things/_source --out packs/deck-of-many-more-things
 *   fvtt package pack --in packs/deck-macros/_source --out packs/deck-macros
 */
import { readFileSync, writeFileSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');
const cards = JSON.parse(readFileSync(resolve(root, 'data/cards.json'), 'utf8'));

const cardsPackDir = resolve(root, 'packs/deck-of-many-more-things/_source');
const macrosPackDir = resolve(root, 'packs/deck-macros/_source');
if (existsSync(cardsPackDir)) rmSync(cardsPackDir, { recursive: true, force: true });
if (existsSync(macrosPackDir)) rmSync(macrosPackDir, { recursive: true, force: true });
mkdirSync(cardsPackDir, { recursive: true });
mkdirSync(macrosPackDir, { recursive: true });

function foundryId(seed) {
  return seed.replace(/[^a-z0-9]/gi, '').padEnd(16, 'x').slice(0, 16);
}

// One Cards document containing all 66 cards as faces.
const cardsDocId = foundryId('dommt-deck');
const cardsDoc = {
  _id: cardsDocId,
  name: 'Deck of Many More Things',
  type: 'deck',
  description: 'The complete 66-card Deck of Many More Things.',
  img: 'modules/deck-of-many-more-things/assets/cards/back.webp',
  cards: cards.map((c, i) => ({
    _id: foundryId(`card-${c.id}`),
    name: c.name,
    type: 'base',
    description: c.rules.summary,
    faces: [
      {
        img: `modules/deck-of-many-more-things/${c.art.front}`,
        text: c.rules.full
      }
    ],
    face: 0,
    back: {
      img: 'modules/deck-of-many-more-things/assets/cards/back.webp',
      text: ''
    },
    value: c.number,
    sort: c.number,
    flags: { 'deck-of-many-more-things': { id: c.id, set: c.set } }
  })),
  flags: { 'deck-of-many-more-things': { source: 'cards.json', version: 1 } }
};

writeFileSync(resolve(cardsPackDir, `${cardsDoc.name.replace(/\s+/g, '_')}_${cardsDocId}.json`),
  JSON.stringify(cardsDoc, null, 2));

const macros = [
  {
    _id: foundryId('macro-play'),
    name: 'DOMMT: Play the Deck',
    type: 'script',
    scope: 'global',
    author: null,
    img: 'icons/svg/card-hand.svg',
    command: `game.modules.get('deck-of-many-more-things').api.openDeck();`,
    flags: {}
  },
  {
    _id: foundryId('macro-divine'),
    name: 'DOMMT: Divine — Celtic Cross',
    type: 'script',
    scope: 'global',
    author: null,
    img: 'icons/svg/eye.svg',
    command: `game.modules.get('deck-of-many-more-things').api.openDivination();`,
    flags: {}
  },
  {
    _id: foundryId('macro-reset'),
    name: 'DOMMT: Reset Play Deck (GM)',
    type: 'script',
    scope: 'global',
    author: null,
    img: 'icons/svg/regen.svg',
    command: `if (!game.user.isGM) return ui.notifications.warn('GM only'); await game.modules.get('deck-of-many-more-things').api.resetDeck(); ui.notifications.info('Deck reset');`,
    flags: {}
  }
];

for (const m of macros) {
  writeFileSync(resolve(macrosPackDir, `${m.name.replace(/[^a-z0-9]+/gi, '_')}_${m._id}.json`),
    JSON.stringify(m, null, 2));
}

console.log(`Wrote 1 Cards source doc and ${macros.length} macro source docs.`);
console.log('To compile into LevelDB compendia, run:');
console.log('  npx @foundryvtt/foundryvtt-cli package pack --in packs/deck-of-many-more-things/_source --out packs/deck-of-many-more-things');
console.log('  npx @foundryvtt/foundryvtt-cli package pack --in packs/deck-macros/_source --out packs/deck-macros');
