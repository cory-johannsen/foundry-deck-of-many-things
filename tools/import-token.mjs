#!/usr/bin/env node
/**
 * Take a token image drawn somewhere else and put it where the module wants it.
 *
 *   node tools/import-token.mjs ~/Downloads/whatever.jpg ooze-cube
 *   npm run tokens:import -- ~/Downloads/whatever.jpg ooze-cube
 *
 * The ComfyUI generator is not the only source of this art — some of it is
 * drawn in Gemini from the prompts in docs/token-prompts.md and handed over as
 * a file. The steps after that are the same either way and are easy to get
 * subtly wrong: the destination is a webp at 512 with a name the handler code
 * already refers to, not whatever the file arrived as.
 *
 * The name is checked against the subject list rather than taken on trust,
 * because a token saved under a name no card looks for is invisible — the
 * summons simply arrives with the system's default silhouette and nothing
 * anywhere says why.
 *
 * The same background measure runs afterwards, so a picture that will not sit
 * on a dark map is rejected here rather than discovered on the map.
 */
import { existsSync, unlinkSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join, basename, resolve } from 'node:path';
import { SUBJECTS, CREATURES, TOKEN_PX } from './generate-token-art.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const PY = join(root, '.venv/bin/python3');
const OUT_DIR = join(root, 'assets/tokens');

const ALL = [
  ...SUBJECTS.map((s) => ({ ...s, file: `warrior-${s.id}` })),
  ...CREATURES
];

/** The file a token id writes to, or null if nothing claims that name. */
export function fileFor(name) {
  const hit = ALL.find((s) => s.id === name || s.file === name);
  return hit ? hit.file : null;
}

const [src, name] = process.argv.slice(2);

if (!src || !name) {
  console.error('usage: node tools/import-token.mjs <image> <token>\n'
    + `tokens: ${ALL.map((s) => s.id).join(', ')}`);
  process.exit(1);
}
if (!existsSync(src)) {
  console.error(`no such file: ${src}`);
  process.exit(1);
}

const file = fileFor(name);
if (!file) {
  console.error(`nothing is named "${name}", so no card would ever load it.\n`
    + `tokens: ${ALL.map((s) => s.id).join(', ')}`);
  process.exit(1);
}

const dest = join(OUT_DIR, `${file}.webp`);

// Square first, then down to token size. A picture that arrives oblong is
// centre-cropped rather than squashed, since a token is drawn in a square hole
// and a stretched face looks wrong in a way that is hard to place.
const convert = `
from PIL import Image
import sys
src, dest, px = sys.argv[1], sys.argv[2], int(sys.argv[3])
im = Image.open(src).convert('RGB')
w, h = im.size
if w != h:
    s = min(w, h)
    im = im.crop(((w - s) // 2, (h - s) // 2, (w + s) // 2, (h + s) // 2))
    print(f'cropped {w}x{h} to square {s}x{s}')
im.resize((px, px), Image.LANCZOS).save(dest, 'WEBP', quality=90, method=6)
`;

execFileSync(PY, ['-c', convert, src, dest, String(TOKEN_PX)], { stdio: 'inherit' });
console.log(`${basename(src)} -> assets/tokens/${file}.webp (${TOKEN_PX}px)`);

// Report the same measure the checker uses, so a bad background is caught now.
try {
  execFileSync('node', [join(root, 'tools/check-token-art.mjs')], { stdio: 'pipe', encoding: 'utf8' });
} catch (err) {
  const line = String(err.stdout ?? '').split('\n').find((l) => l.startsWith(`${file}.webp`));
  if (line) {
    console.error(`\n${line.trim()}\n`
      + 'That background will read as a square tile on a dark map. '
      + 'The original is untouched, so it can be redrawn and imported again.');
    process.exit(1);
  }
}
console.log('background clean');

// Only once it is known good: the source file has served its purpose and
// leaving it in the working tree is how it ends up committed by accident.
// resolve() first: the path is usually typed relative to the repo, and a bare
// startsWith on that never matches, so the file quietly stayed behind.
if (process.argv.includes('--keep')) process.exit(0);
if (resolve(src).startsWith(root)) {
  unlinkSync(src);
  console.log(`removed ${basename(src)}`);
} else {
  console.log(`left ${basename(src)} where it was`);
}
