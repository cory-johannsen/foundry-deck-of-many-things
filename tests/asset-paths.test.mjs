import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Every module asset the code points at must exist.
 *
 * This whole class of mistake is silent. Foundry asks for a file, does not get
 * it, and draws its default silhouette or a blank square; nothing is logged
 * and no card reports a fault. The homunculus, the dragons and the oozes were
 * each wired up by hand, and the macro icons moved from Foundry's own SVGs to
 * files in this repository — any one of those paths could have been a typo
 * that only showed up as a token with no picture, mid-session.
 */
// Paths are written both ways in the source — as a literal and through the
// MODULE_ID constant — and the constant is by far the commoner. Matching only
// the literal found four references and would have checked almost nothing.
// The path must end in a real extension. Without that, `assets/tokens/ooze-`
// matches the literal half of `ooze-${rung}.webp` and is reported missing —
// a file that was never meant to exist under that name. Paths assembled at
// runtime are left to the unit tests of the functions that assemble them.
const REFERENCE = /modules\/(?:deck-of-many-more-things|\$\{MODULE_ID\})\/(assets\/[\w./-]+\.\w{2,5})/g;

const sources = ['scripts', 'templates']
  .flatMap((dir) => readdirSync(join(root, dir)).map((f) => join(dir, f)))
  .filter((f) => /\.(mjs|hbs|css)$/.test(f));

describe('every module asset referenced in code exists', () => {
  const referenced = new Map();
  for (const file of sources) {
    const text = readFileSync(join(root, file), 'utf8');
    for (const [, path] of text.matchAll(REFERENCE)) {
      // Template literals leave `${...}` behind; those are built at runtime.
      if (path.includes('$')) continue;
      if (!referenced.has(path)) referenced.set(path, file);
    }
  }

  it('finds asset references to check at all', () => {
    // A guard on the guard: if the regex stops matching, the rest of this
    // file passes by testing nothing.
    expect(referenced.size).toBeGreaterThan(5);
  });

  it.each([...referenced].map(([path, from]) => [path, from]))(
    '%s (referenced by %s)', (path) => {
      expect(existsSync(join(root, path))).toBe(true);
    });
});

describe('the hotbar macros point at the module\'s own icons', () => {
  const source = readFileSync(join(root, 'scripts/module.mjs'), 'utf8');

  it('no longer uses Foundry\'s stock SVGs', () => {
    // They were card-hand, eye and regen: flat grey line drawings a GM had to
    // hover over to tell apart.
    const defs = source.slice(source.indexOf('const MACRO_DEFS'),
                              source.indexOf('async function ensureWorldMacros'));
    expect(defs).not.toMatch(/icons\/svg\//);
    expect(defs.match(/assets\/icons\/macro-[\w-]+\.webp/g)).toHaveLength(3);
  });

  it('treats a changed icon as a reason to update an installed macro', () => {
    // It compared commands only, so a macro already on someone's hotbar kept
    // its old picture for ever unless the code behind it happened to change.
    expect(source).toMatch(/existing\.img !== def\.img/);
  });
});
