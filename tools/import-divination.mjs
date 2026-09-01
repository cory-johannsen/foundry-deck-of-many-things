#!/usr/bin/env node
/**
 * Import transcribed flavor text and divination meanings into data/cards.json.
 *
 * Source is card-text-images/card-meanings.json, OCR'd from the hardcopy
 * card-meanings appendix. That file uses camelCase category keys and groups by
 * orientation; cards.json uses snake_case categories and groups by category, so
 * the shape is transposed here.
 *
 * NOTE: card-text-images/ is deliberately untracked (see .gitignore) — it was
 * scratch input for the one-time transcription, and data/cards.json is now the
 * source of truth. This script therefore only runs on a checkout that still has
 * that directory locally; it is kept for provenance and for re-importing if the
 * transcription is ever corrected.
 *
 * Idempotent: re-run after correcting the OCR source to refresh the slots.
 *
 * Usage:
 *   node tools/import-divination.mjs [--dry-run]
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');
const dryRun = process.argv.includes('--dry-run');

const cardsPath = resolve(root, 'data/cards.json');
const meaningsPath = resolve(root, 'card-text-images/card-meanings.json');
if (!existsSync(meaningsPath)) {
  console.error(`Transcription source not found: ${meaningsPath}`);
  console.error('card-text-images/ is untracked; data/cards.json is the source of truth.');
  process.exit(1);
}
const cards = JSON.parse(readFileSync(cardsPath, 'utf8'));
const meanings = JSON.parse(readFileSync(meaningsPath, 'utf8'));

// cards.json category key -> card-meanings.json category key
const CATEGORIES = {
  person: 'person',
  creature_or_trap: 'creatureOrTrap',
  place: 'place',
  treasure: 'treasure',
  situation: 'situation',
};
const ORIENTATIONS = ['upright', 'reversed'];

const byName = new Map(meanings.map((m) => [m.name, m]));

const unmatched = cards.filter((c) => !byName.has(c.name)).map((c) => c.name);
const extra = meanings.filter((m) => !cards.some((c) => c.name === m.name)).map((m) => m.name);
if (unmatched.length || extra.length) {
  if (unmatched.length) console.error(`No transcription for: ${unmatched.join(', ')}`);
  if (extra.length) console.error(`No card matches transcription: ${extra.join(', ')}`);
  process.exit(1);
}

let written = 0;
let changed = 0;
const out = [];
for (const card of cards) {
  const src = byName.get(card.name);

  if (typeof src.flavor !== 'string' || src.flavor.trim().length === 0) {
    console.error(`Missing flavor text: ${card.name}`);
    process.exit(1);
  }
  if (card.flavor !== src.flavor) changed++;
  // Rebuild so `flavor` sits after `name`, matching the schema's property order.
  const { id, number, name, ...rest } = card;
  delete rest.flavor;
  out.push({ id, number, name, flavor: src.flavor, ...rest });
  written++;

  for (const [destCat, srcCat] of Object.entries(CATEGORIES)) {
    for (const orientation of ORIENTATIONS) {
      const text = src[orientation][srcCat];
      if (typeof text !== 'string' || text.trim().length === 0) {
        console.error(`Empty slot: ${card.name} / ${destCat} / ${orientation}`);
        process.exit(1);
      }
      if (card.divination[destCat][orientation] !== text) changed++;
      card.divination[destCat][orientation] = text;
      written++;
    }
  }
}

const summary = `${written} fields across ${cards.length} cards (${changed} changed)`;
if (dryRun) {
  console.log(`Dry run: ${summary} would be written.`);
} else {
  writeFileSync(cardsPath, `${JSON.stringify(out, null, 2)}\n`);
  console.log(`Wrote ${summary}.`);
}
