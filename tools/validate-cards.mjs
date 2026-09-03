#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import Ajv from 'ajv';
import { checkCards } from './card-text-checks.mjs';
import addFormats from 'ajv-formats';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');

const schema = JSON.parse(readFileSync(resolve(root, 'data/schema/cards.schema.json'), 'utf8'));
const cards = JSON.parse(readFileSync(resolve(root, 'data/cards.json'), 'utf8'));

const ajv = new Ajv({ allErrors: true, strict: false });
addFormats(ajv);
const validate = ajv.compile(schema);

const ok = validate(cards);
if (!ok) {
  console.error('Schema validation failed:');
  for (const err of validate.errors) {
    console.error(`  ${err.instancePath} ${err.message}`);
  }
  process.exit(1);
}
console.log(`OK: ${cards.length} cards validate against schema`);

const CATEGORIES = ['person', 'creature_or_trap', 'place', 'treasure', 'situation'];
const ORIENTATIONS = ['upright', 'reversed'];
const TOTAL_SLOTS = cards.length * CATEGORIES.length * ORIENTATIONS.length;

let filled = 0;
const perCard = [];
for (const c of cards) {
  let cardFilled = 0;
  for (const cat of CATEGORIES) {
    for (const or of ORIENTATIONS) {
      if (c.divination[cat][or].trim().length > 0) {
        cardFilled++;
        filled++;
      }
    }
  }
  perCard.push({ id: c.id, name: c.name, filled: cardFilled });
}

const pct = ((filled / TOTAL_SLOTS) * 100).toFixed(1);
console.log(`Divination coverage: ${filled}/${TOTAL_SLOTS} slots filled (${pct}%)`);

// The schema checks shapes and the tests check handlers; neither reads the
// sentence the player is shown. This does.
const textProblems = checkCards(cards);
if (textProblems.length) {
  console.error(`\nCard text disagrees with itself or with its params (${textProblems.length}):`);
  for (const p of textProblems) console.error(`  ${p.card.padEnd(14)} [${p.kind}] ${p.detail}`);
  process.exit(1);
}
console.log('Card text agrees with mechanics params');

if (process.argv.includes('--verbose')) {
  const incomplete = perCard.filter(c => c.filled < 10);
  if (incomplete.length) {
    console.log('\nIncomplete cards:');
    for (const c of incomplete) {
      console.log(`  ${c.name.padEnd(14)} ${c.filled}/10`);
    }
  }
}
