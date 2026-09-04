#!/usr/bin/env node
/**
 * Does each token sit on a plain dark background?
 *
 *   .venv/bin/python3 is required (Pillow).
 *
 * Written because eyeballing two of six was not enough: the dwarf and human
 * looked right, so the parchment backgrounds on four others went unnoticed
 * until they were measured. A token with scenery behind it reads as a square
 * tile on a map instead of blending into the ground.
 */
import { execFileSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const dir = join(root, 'assets/tokens');
const PY = join(root, '.venv/bin/python3');

const script = `
from PIL import Image, ImageStat
import sys, json
out = {}
for path in sys.argv[1:]:
    im = Image.open(path).convert('L')
    w, h = im.size
    b = int(min(w, h) * 0.14)
    corners = [im.crop((0,0,b,b)), im.crop((w-b,0,w,b)),
               im.crop((0,h-b,b,h)), im.crop((w-b,h-b,w,h))]
    out[path] = sum(ImageStat.Stat(c).mean[0] for c in corners) / 4
print(json.dumps(out))
`;

const files = readdirSync(dir).filter((f) => f.endsWith('.webp')).map((f) => join(dir, f));
if (!files.length) { console.log('no tokens yet'); process.exit(0); }
const means = JSON.parse(execFileSync(PY, ['-c', script, ...files], { encoding: 'utf8' }));

let bad = 0;
for (const [path, mean] of Object.entries(means)) {
  const name = path.split('/').pop();
  const verdict = mean < 40 ? 'clean' : mean < 80 ? 'borderline' : 'HAS BACKGROUND';
  if (mean >= 40) bad += 1;
  console.log(`${name.padEnd(24)}${mean.toFixed(1).padStart(8)}   ${verdict}`);
}
console.log(bad ? `\n${bad} token(s) need regenerating` : '\nall clean');
process.exit(bad ? 1 : 0);
