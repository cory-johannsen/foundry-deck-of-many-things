#!/usr/bin/env node
/**
 * Compose finished cards: full-bleed art + decorative frame + name plate.
 *
 * Raw generated art lives in assets/cards/<id>.png and is never modified.
 * Composed output goes to assets/cards-labeled/<id>.png, which is what
 * `art.front` points at and what Foundry loads. Keeping them separate means
 * the frame or plate can be redesigned without regenerating any art.
 *
 * Supersedes tools/label-cards.mjs, which only did the plate.
 *
 * Usage:
 *   node tools/compose-cards.mjs jester beast
 *   node tools/compose-cards.mjs --all
 */
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');
const cards = JSON.parse(readFileSync(resolve(root, 'data/cards.json'), 'utf8'));

const RAW_DIR = 'assets/cards';
const OUT_DIR = 'assets/cards-labeled';

const args = process.argv.slice(2);
const outIdx = args.indexOf('--out');
const outDir = outIdx >= 0 ? args[outIdx + 1] : resolve(root, OUT_DIR);
const ids = args.includes('--all')
  ? cards.map((c) => c.id)
  : args.filter((a) => !a.startsWith('--') && a !== outDir);

if (!ids.length) {
  console.error('Usage: node tools/compose-cards.mjs <cardId...|--all> [--out DIR]');
  process.exit(1);
}

if (!existsSync(resolve(root, 'assets/frame.png'))) {
  console.error('Missing assets/frame.png — the composited decorative border.');
  process.exit(1);
}

const jobs = ids.map((id) => {
  const card = cards.find((c) => c.id === id);
  if (!card) {
    console.error(`Unknown card id: ${id}`);
    process.exit(1);
  }
  const src = resolve(root, RAW_DIR, `${card.id}.png`);
  if (!existsSync(src)) {
    console.error(`Missing raw art: ${src} — run tools/generate-art.mjs first`);
    process.exit(1);
  }
  return { id: card.id, name: card.name, src, out: resolve(outDir, `${card.id}.png`) };
});

const py = process.env.PILLOW_PYTHON || 'python3';
const r = spawnSync(py, [resolve(__dirname, 'compose_cards.py')], {
  input: JSON.stringify(jobs),
  cwd: root,
  stdio: ['pipe', 'inherit', 'inherit']
});
process.exit(r.status ?? 1);
