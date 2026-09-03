#!/usr/bin/env node
/**
 * What sound files the deck needs, which are present, and which are missing.
 *
 *   node tools/sound-manifest.mjs           # grouped report
 *   node tools/sound-manifest.mjs --missing # just the filenames still needed
 *
 * Drop files into assets/sounds/ under the names shown. To give one card its
 * own sound instead of its group's, add `"sound": "<filename>.ogg"` to that
 * card in data/cards.json.
 */
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { SOUND_GROUPS, GROUP_BY_KIND, groupForCard } from '../scripts/card-sound.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const cards = JSON.parse(readFileSync(join(root, 'data/cards.json')));
const soundDir = join(root, 'assets/sounds');

/** Search terms for each group, for Kenney / Freesound. */
const SEARCH_TERMS = {
  boon: 'magic sparkle chime, positive power-up, blessing',
  treasure: 'coins jingle, gold pile, treasure chest open',
  item: 'item pickup, equip weapon, magic item shimmer',
  restore: 'healing chime, warm restore, revive',
  transform: 'transformation whoosh, morph, body shift',
  arcane: 'arcane spell cast, reality warp, time stop',
  query: 'mystical whisper, oracle, soft revelation',
  meta: 'card flip, shuffle flourish, deck riffle',
  summon_ally: 'friendly summon, portal arrival, ally appears',
  summon_hostile: 'monster growl, ominous summon, creature roar',
  teleport: 'teleport whoosh, portal, dimensional rip',
  curse: 'dark curse sting, hex, ominous debuff',
  loss: 'drain, power down, magic dissipate',
  calamity: 'heavy body fall thud, impact, disaster'
};

const usage = new Map();          // group -> card names
for (const c of cards) {
  if (c.sound) continue;          // covered by its own file
  const g = groupForCard(c);
  if (!usage.has(g)) usage.set(g, []);
  usage.get(g).push(c.name);
}

const rows = Object.entries(SOUND_GROUPS).map(([group, file]) => ({
  group,
  file,
  present: existsSync(join(soundDir, file)),
  cards: usage.get(group) ?? []
}));

// `sound` is either a filename or a map of voice variants, so a card can
// contribute more than one file.
const filesOf = (sound) => (typeof sound === 'string' ? [sound] : Object.values(sound ?? {}));

const overrides = cards.flatMap((c) => filesOf(c.sound).map((file) => ({
  name: c.name,
  file,
  present: existsSync(join(soundDir, file.split('/').pop()))
})));

if (process.argv.includes('--missing')) {
  const missing = rows.filter((r) => !r.present && r.cards.length).map((r) => r.file)
    .concat(overrides.filter((o) => !o.present).map((o) => o.file));
  console.log(missing.join('\n'));
  process.exit(0);
}

const kinds = new Set(cards.map((c) => c.mechanics.kind));
console.log(`Deck sounds — ${cards.length} cards, ${kinds.size} mechanics kinds, `
  + `${rows.filter((r) => r.cards.length).length} group files needed\n`);

for (const r of rows.sort((a, b) => b.cards.length - a.cards.length)) {
  if (!r.cards.length) continue;
  console.log(`${r.present ? '[ok]     ' : '[MISSING]'} ${r.file.padEnd(24)} ${String(r.cards.length).padStart(2)} cards`);
  console.log(`          search: ${SEARCH_TERMS[r.group] ?? r.group}`);
  console.log(`          ${r.cards.join(', ')}\n`);
}

if (overrides.length) {
  console.log('Per-card overrides:');
  for (const o of overrides) console.log(`${o.present ? '[ok]     ' : '[MISSING]'} ${o.file.padEnd(24)} ${o.name}`);
  console.log();
}

const missingCount = rows.filter((r) => !r.present && r.cards.length).length
  + overrides.filter((o) => !o.present).length;
console.log(missingCount
  ? `${missingCount} file(s) still needed. Put them in assets/sounds/.`
  : 'All sounds present.');
