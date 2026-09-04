#!/usr/bin/env node
/**
 * Token art for the warriors Knight summons.
 *
 *   node tools/generate-token-art.mjs            # everything missing
 *   node tools/generate-token-art.mjs dwarf orc  # just these
 *   node tools/generate-token-art.mjs --force    # redo what exists
 *
 * The compendium has no token art to offer — not one of the sampled martial
 * NPCs has any, the system's own Knight included — so a summoned warrior would
 * arrive as the default silhouette. These are generated instead.
 *
 * Square, because a token is square, and framed as a bust rather than a
 * full figure: a token is displayed small, and a whole armoured body at that
 * size is a smudge. The style matches the card art so the summons looks like
 * it came out of the same deck.
 */
import { writeFileSync, readFileSync, existsSync, mkdirSync, unlinkSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = join(root, 'assets/tokens');
const BASE = (process.env.COMFYUI_BASE_URL || 'https://comfyui.johannsen.cloud').replace(/\/$/, '');
const CHECKPOINT = process.env.COMFYUI_CHECKPOINT || 'sd_xl_base_1.0.safetensors';
const STEPS = parseInt(process.env.COMFYUI_STEPS || '28', 10);
const CFG = parseFloat(process.env.COMFYUI_CFG || '7.0');
const SAMPLER = process.env.COMFYUI_SAMPLER || 'dpmpp_sde';
const SCHEDULER = process.env.COMFYUI_SCHEDULER || 'karras';
export const SIZE = 1024;
export const TOKEN_PX = 512;

// No "aged parchment texture" here, though the card art uses it. On a token it
// invites the model to draw the parchment — the tengu came back on a bordered
// sheet, which reads as a square tile on a map instead of blending into dark
// ground. The background instruction is repeated and placed last, where it
// carries more weight.
export const STYLE = 'dark fantasy illustration, intricate linework, rich jewel-tone colors, '
  + 'dramatic rim lighting, centered bust portrait, isolated on a plain solid black background, '
  + 'black background, no scenery, no backdrop';

export const NEGATIVE = 'text, letters, words, watermark, signature, logo, frame, border, ornate border, '
  + 'parchment, paper texture, scroll, background scenery, landscape, architecture, interior, '
  + 'multiple figures, crowd, full body, tiny figure, blurry, deformed hands, extra limbs, '
  + 'modern clothing, firearms, photograph, 3d render';

/**
 * A style for creatures that have no head to make a bust of.
 *
 * "Centered bust portrait" is right for a warrior and actively wrong for an
 * ooze: asked for living tar, the model produced a woman's face, and asked for
 * a blob it produced a mouth full of teeth. It was obeying the style, not the
 * prompt. The background checker passed all three, because a wrong subject on
 * a clean black field is still a clean black field.
 *
 * The second attempt got the shape right and the setting wrong: the tar came
 * back as a waterfall between canyon walls, which the corner check also passed
 * because the corners were black and the scenery was in the middle. Hence
 * "floating in empty black space" here — a creature with nothing under it
 * cannot be standing in a landscape.
 */
export const SHAPELESS_STYLE = 'dark fantasy illustration, intricate linework, rich jewel-tone colors, '
  + 'dramatic rim lighting, one single creature alone, floating in empty black space with '
  + 'nothing around it, isolated on a plain solid black background, black background, '
  + 'no scenery, no ground, no backdrop';

export const SHAPELESS_NEGATIVE = `${NEGATIVE}, face, head, eyes, mouth, teeth, fangs, portrait, `
  + 'person, humanoid, creature with a face, glass tank, aquarium, jar, container, display case, '
  + 'glass, wireframe, outline box, diagram, cutaway, cliff, canyon, rocks, cave, waterfall, '
  + 'ground, floor, terrain, horizon';

/**
 * One entry per ancestry we expect to see, plus a fallback.
 *
 * Ordered as the table plays: the party's own ancestries first, then the rest
 * of the Player Core common eight. Each description names the features that
 * actually distinguish the ancestry, because "a dwarf warrior" alone tends to
 * produce a man with a beard whatever you asked for.
 */
export const SUBJECTS = [
  // The party.
  { id: 'dwarf',    who: 'a dwarf warrior, broad and heavily built, long braided beard, deep-set eyes under a heavy brow' },
  { id: 'human',    who: 'a human warrior, weathered and scarred, close-cropped hair' },
  // 'Tengu' pulls Japanese aesthetics hard enough to override the armour, so
  // the plate is named again in the subject rather than left to the suffix.
  { id: 'tengu',    who: 'a tengu warrior in European steel plate armour, a crow-headed humanoid with a long black beak, glossy black feathers, bright bird eyes' },
  // The rest of the Player Core common ancestries.
  { id: 'elf',      who: 'an elf warrior, tall and narrow-featured, long pointed ears, sharp cheekbones, long pale hair' },
  { id: 'gnome',    who: 'a gnome warrior, small and wiry with an oversized head, enormous eyes, wild brightly-coloured hair' },
  { id: 'goblin',   who: 'a goblin warrior, small and green-skinned, enormous pointed ears, wide mouth of sharp teeth, no hair' },
  { id: 'halfling', who: 'a halfling warrior, small and round-cheeked with curly hair and large bare feet, cheerful weathered face' },
  // A leshy is not a green man. Asked for one plainly, the model drew a
  // bearded human face wreathed in leaves inside a heraldic border, which is
  // the folk motif it has far more of. The gourd has to be insisted on and the
  // human face named as something to avoid.
  { id: 'leshy',    who: 'a leshy warrior, a small plant creature whose entire head is a carved wooden gourd with holes cut through it for eyes and mouth, body of bound vines and leaves',
                    avoid: 'human face, beard, moustache, human skin, antlers, laurel wreath, heraldic crest, symmetrical emblem, coat of arms' },
  { id: 'orc',      who: 'an orc warrior, heavy green-grey brow and jutting tusks from the lower jaw, thick corded neck' },
  // Anyone else.
  { id: 'generic',  who: 'an armoured warrior, face shadowed within a closed steel helm' }
];

/**
 * Creatures other cards summon, which the compendium also has no art for.
 * These are not warriors, so they carry their own prompt rather than the
 * plate-and-longsword suffix.
 */
export const CREATURES = [
  { id: 'homunculus', file: 'homunculus',
    prompt: 'A tiny homunculus, a small artificial creature of stitched clay and hammered copper '
      + 'with little leathery bat wings and glowing eyes, perched and alert, looking up at its maker' },
  // Dragon scales with the drawer, so it needs a picture per age band rather
  // than one: a drake at low levels is not an ancient wyrm at high ones.
  // The generic "border" in the negative list was not enough: the drake came
  // back curled inside an ornate ring, which passed the background check
  // because the ring is dark. A roundel is what a small coiled creature
  // invites, so it is ruled out by name.
  { id: 'drake', file: 'dragon-drake',
    prompt: 'A small drake, a lesser dragon the size of a large dog, lean and quick with bright '
      + 'scales and folded leathery wings, head cocked and watchful',
    avoid: 'circular border, ring, roundel, medallion, decorative surround, wreath, '
      + 'coiled into a circle, ouroboros' },
  { id: 'young-dragon', file: 'dragon-young',
    prompt: 'A young dragon, sleek and dangerous with gleaming scales, horned head raised, '
      + 'wings half-furled, coiled and alert' },
  { id: 'elder-dragon', file: 'dragon-elder',
    prompt: 'An ancient dragon, vast and scarred with heavy horns and battered scales, '
      + 'head lowered toward the viewer, ancient and unhurried' },
  // Ooze scales the same way, and none of the system's oozes ship any art at
  // all. "Bust portrait" means nothing for a creature with no head, so these
  // say what shape the thing is instead and let the style carry the rest.
  { id: 'ooze-cube', file: 'ooze-cube', shapeless: true,
    prompt: 'A solid block of translucent green acidic jelly in the shape of a cube, the jelly '
      + 'itself forming every face and edge with nothing holding it, soft and quivering, bones '
      + 'and coins suspended half-dissolved deep inside the green' },
  // A black creature on a black field is a contradiction: four rerolls all
  // came back with the tar on white, because the model needed the contrast
  // somewhere. It is right — a matte black token is a smudge on a dark map —
  // so the tar is given the oil-slick sheen that real tar has, and the colour
  // lives on the creature instead of behind it.
  { id: 'ooze-tar', file: 'ooze-tar', shapeless: true,
    prompt: 'A thick column of living tar rising out of a spreading puddle of itself, heavy and '
      + 'viscous and dripping, its wet black surface shot through with an iridescent oil-slick '
      + 'sheen of violet, teal and gold, lit from the side against darkness' },
  // Skull's avatar is built, not found, so nothing in PF2e depicts it.
  { id: 'avatar-of-death', file: 'avatar-of-death',
    prompt: 'A ghostly humanoid skeleton shrouded in a tattered black robe, its hood empty but '
      + 'for two points of cold light, a scythe held across its shoulder',
    avoid: 'flesh, skin, hair, living face, jack-o-lantern, cartoon' },
  // Monstrosity draws a creature at random and most of them have their own
  // picture; this stands in only where one has none, so it says "something
  // large and wrong" rather than depicting any particular monster.
  { id: 'monstrosity', file: 'monstrosity',
    prompt: 'A huge nameless monster looming forward, heavy hunched shoulders, too many eyes and '
      + 'a mouth of uneven teeth, hide mottled and scarred, wrong in a way that is hard to place',
    avoid: 'recognisable animal, dragon, wings, humanoid, armour, weapon' },
  { id: 'ooze-blob', file: 'ooze-blob', shapeless: true,
    prompt: 'A vast mound of translucent pink and grey devouring slime, veined and pulsing, '
      + 'its leading edge curling forward over itself in a slow breaking wave' }
];

const promptFor = (s) => s.prompt
  ? `${s.prompt}, ${s.shapeless ? SHAPELESS_STYLE : STYLE}`
  : `Portrait bust of ${s.who}, wearing full plate armour, `
    + `a longsword held upright at the shoulder, stern and watchful, sworn to service, ${STYLE}`;

const negativeFor = (s) => {
  const base = s.shapeless ? SHAPELESS_NEGATIVE : NEGATIVE;
  return s.avoid ? `${base}, ${s.avoid}` : base;
};

/** Every subject, warriors and creatures alike, with the file each writes. */
const ALL = [
  ...SUBJECTS.map((s) => ({ ...s, file: `warrior-${s.id}` })),
  ...CREATURES.map((c) => ({ ...c, file: c.file }))
];

const build = (prompt, seed, prefix, negative = NEGATIVE) => ({
  '1': { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: CHECKPOINT } },
  '2': { class_type: 'CLIPTextEncode', inputs: { text: prompt, clip: ['1', 1] } },
  '3': { class_type: 'CLIPTextEncode', inputs: { text: negative, clip: ['1', 1] } },
  '4': { class_type: 'EmptyLatentImage', inputs: { width: SIZE, height: SIZE, batch_size: 1 } },
  '5': { class_type: 'KSampler',
         inputs: { seed, steps: STEPS, cfg: CFG, sampler_name: SAMPLER, scheduler: SCHEDULER,
                   denoise: 1.0, model: ['1', 0], positive: ['2', 0], negative: ['3', 0],
                   latent_image: ['4', 0] } },
  '6': { class_type: 'VAEDecode', inputs: { samples: ['5', 0], vae: ['1', 2] } },
  '7': { class_type: 'SaveImage', inputs: { filename_prefix: prefix, images: ['6', 0] } }
});

async function enqueue(workflow) {
  const res = await fetch(`${BASE}/prompt`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ prompt: workflow, client_id: 'dommt-token-' + Math.random().toString(36).slice(2, 8) })
  });
  if (!res.ok) throw new Error(`enqueue failed: ${res.status} ${await res.text()}`);
  return (await res.json()).prompt_id;
}

async function waitFor(promptId, { timeoutMs = 420_000 } = {}) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const res = await fetch(`${BASE}/history/${promptId}`);
    if (res.ok) {
      const entry = (await res.json())[promptId];
      const images = Object.values(entry?.outputs ?? {}).flatMap((o) => o.images ?? []);
      if (images.length) return images[0];
      if (entry?.status?.status_str === 'error') throw new Error('generation failed');
    }
    await new Promise((r) => setTimeout(r, 2500));
  }
  throw new Error(`timed out after ${timeoutMs}ms`);
}

async function fetchImage({ filename, subfolder = '', type = 'output' }) {
  const url = `${BASE}/view?filename=${encodeURIComponent(filename)}`
    + `&subfolder=${encodeURIComponent(subfolder)}&type=${type}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`fetch failed: ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

/**
 * How much background an image has, as one number to reroll against.
 *
 * This measured the four corners until the oozes got past it three times over:
 * a canyon with black sky in the corners, then a white halo with the corners
 * still black. It now matches tools/check-token-art.mjs — a ring right round
 * the outside, and a penalty for pale pixels anywhere — so the generator stops
 * keeping images the checker will reject afterwards.
 */
function backgroundScore(path) {
  const py = join(root, '.venv/bin/python3');
  const script = `
from PIL import Image
import sys
import numpy as np
a = np.asarray(Image.open(sys.argv[1]).convert('L'), dtype=float)
h, w = a.shape
r = max(1, int(min(w, h) * 0.10))
ring = np.concatenate([a[:r,:].ravel(), a[-r:,:].ravel(), a[:,:r].ravel(), a[:,-r:].ravel()])
bright = (a > 200).mean() * 100
# A pale backdrop is worth as much as a bright edge; the worse fault wins.
print(max(ring.mean(), bright * 2.5))
`;
  try {
    return parseFloat(execFileSync(py, ['-c', script, path], { encoding: 'utf8' }).trim());
  } catch {
    return null;                       // no Pillow: accept whatever came back
  }
}

/** Store at token size, not generation size. */
function shrink(src, dest) {
  const py = join(root, '.venv/bin/python3');
  const script = `
from PIL import Image
import sys
Image.open(sys.argv[1]).convert('RGB').resize((512, 512), Image.LANCZOS) \
  .save(sys.argv[2], 'WEBP', quality=88, method=6)
`;
  try { execFileSync(py, ['-c', script, src, dest]); }
  catch { writeFileSync(dest, readFileSync(src)); }   // no Pillow: keep the png bytes
}

const CLEAN_THRESHOLD = 45;      // stay under the checker's 50
const MAX_ATTEMPTS = 4;

async function main() {
  const args = process.argv.slice(2);
  const force = args.includes('--force');
  const reroll = parseInt(args.find((a) => a.startsWith('--reroll='))?.split('=')[1] ?? '0', 10);
  const only = args.filter((a) => !a.startsWith('--'));
  mkdirSync(OUT_DIR, { recursive: true });

  const wanted = ALL.filter((s) => (!only.length || only.includes(s.id)));
  for (const s of wanted) {
    const dest = join(OUT_DIR, `${s.file}.png`);
    const final = join(OUT_DIR, `${s.file}.webp`);
    if (existsSync(final) && !force) { console.log(`${s.id.padEnd(10)} exists, skipping`); continue; }
    const prompt = promptFor(s);
    // The same prompt produces a plain background on some rolls and a lit
    // interior on others, so this rerolls rather than accepting the first
    // answer. The seed is derived from the ancestry and the attempt, so a
    // rerun reproduces the same sequence.
    const base = ([...s.id].reduce((a, c) => a * 31 + c.charCodeAt(0), 7)
      + reroll * 104_729) % 2_000_000_000;
    let best = null;
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
      process.stdout.write(`${s.id.padEnd(10)} attempt ${attempt + 1}… `);
      const id = await enqueue(build(prompt, (base + attempt * 7919) % 2_000_000_000,
                                     `dommt-token-${s.id}`, negativeFor(s)));
      writeFileSync(dest, await fetchImage(await waitFor(id)));
      const score = backgroundScore(dest);
      if (score === null) { console.log('(unmeasured) kept'); best = { score: 0 }; break; }
      console.log(`background ${score.toFixed(0)}`);
      if (!best || score < best.score) {
        best = { score, buf: null };
        writeFileSync(join(OUT_DIR, `.best-${s.file}.png`), readFileSync(dest));
      }
      if (score < CLEAN_THRESHOLD) break;
    }
    // Keep the darkest of the attempts if none came back clean.
    const bestPath = join(OUT_DIR, `.best-${s.file}.png`);
    if (existsSync(bestPath)) {
      writeFileSync(dest, readFileSync(bestPath));
      unlinkSync(bestPath);
    }
    const kept = backgroundScore(dest);
    // ComfyUI returns a 1024 png; a token is drawn at a couple of hundred
    // pixels, so it is stored at 512 as webp — 1.5 MB becomes about 50 KB.
    shrink(dest, final);
    unlinkSync(dest);
    console.log(`${' '.repeat(10)} kept background ${kept === null ? '?' : kept.toFixed(0)}`
      + ` -> assets/tokens/${s.file}.webp`);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) await main();
