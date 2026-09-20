#!/usr/bin/env node
/**
 * Generate cover-item art (#96: crate, barrel, rubble pile) via the same
 * local ComfyUI server and Z-Image Base/GGUF pipeline tools/generate-art.mjs
 * already uses for card art -- see docs/card-art-pipeline.md for why that
 * model was chosen over sdxl. A separate script rather than a generic mode
 * added to generate-art.mjs: different subject matter (a top-down object on
 * a plain dark floor, not a full-bleed illustration), different aspect
 * ratio (square, not portrait), and no dependency on data/cards.json or its
 * version-bump bookkeeping -- reusing the request/poll/download primitives
 * without dragging card-specific concerns into either script.
 *
 * Usage:
 *   node tools/generate-cover-art.mjs                # generate any missing cover item
 *   node tools/generate-cover-art.mjs --force         # regenerate everything
 *   node tools/generate-cover-art.mjs --only crate,barrel
 *   node tools/generate-cover-art.mjs --dry-run
 *
 * Env: same COMFYUI_BASE_URL / COMFYUI_ZIMAGE_* variables as generate-art.mjs.
 *
 * Output: assets/cover/<id>.png, referenced by scripts/cover-items.mjs.
 */
import { writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');

const BASE = (process.env.COMFYUI_BASE_URL || 'https://comfyui.johannsen.cloud').replace(/\/$/, '');
const ZIMAGE_UNET = process.env.COMFYUI_ZIMAGE_UNET || 'z_image-Q8_0.gguf';
const ZIMAGE_CLIP = process.env.COMFYUI_ZIMAGE_CLIP || 'Qwen3-4B-UD-Q6_K_XL.gguf';
const ZIMAGE_CLIP_TYPE = process.env.COMFYUI_ZIMAGE_CLIP_TYPE || 'lumina2';
const ZIMAGE_VAE = process.env.COMFYUI_ZIMAGE_VAE || 'z-image-ae.safetensors';
const ZIMAGE_LORA = process.env.COMFYUI_ZIMAGE_LORA || 'Z-Image-Fun-Lora-Distill-8-Steps_ComfyUI.safetensors';
const ZIMAGE_LORA_STRENGTH = parseFloat(process.env.COMFYUI_ZIMAGE_LORA_STRENGTH || '0.7');
const ZIMAGE_STEPS = parseInt(process.env.COMFYUI_ZIMAGE_STEPS || '8', 10);
const ZIMAGE_CFG = parseFloat(process.env.COMFYUI_ZIMAGE_CFG || '1');
const ZIMAGE_SAMPLER = process.env.COMFYUI_ZIMAGE_SAMPLER || 'sa_solver_pece';
const ZIMAGE_SCHEDULER = process.env.COMFYUI_ZIMAGE_SCHEDULER || 'simple';

const args = process.argv.slice(2);
const flag = (n) => args.includes(n);
const arg = (n, dflt) => {
  const i = args.indexOf(n);
  return i >= 0 ? args[i + 1] : dflt;
};
const FORCE = flag('--force');
const DRY = flag('--dry-run');
const ONLY = (arg('--only', '') || '').split(',').filter(Boolean);

// Square, top-down, plain dark floor -- these sit as freestanding objects on
// a dungeon-room Tile, so a busy/scenic background would fight the room art
// underneath it rather than reading as one object sitting on the floor.
const WIDTH = 768;
const HEIGHT = 768;
const NEGATIVE = '(text:1.5), (letters:1.5), (words:1.5), (watermark:1.4), (signature:1.4), ' +
  '(character:1.3), (person:1.3), (creature:1.3), (hand:1.3), (multiple objects:1.2), ' +
  'scenery, landscape, horizon, wall, ceiling, room interior, furniture other than the subject, ' +
  'blurry, out of frame, low quality, jpeg artifacts, cartoon, 3d render, photograph';

const ITEMS = [
  {
    id: 'crate',
    outfile: 'assets/cover/crate.png',
    prompt: 'Orthographic top-down view directly overhead of a single sturdy wooden shipping '
      + 'crate, weathered dark timber planks with iron corner bands and visible wood grain, '
      + 'sitting alone on a plain dark stone dungeon floor, dramatic single-source rim lighting, '
      + 'dark fantasy illustration with rich jewel-tone colour accents and intricate linework, '
      + 'the crate fills most of the frame, no other objects, no characters, square 1:1 aspect ratio'
  },
  {
    id: 'barrel',
    outfile: 'assets/cover/barrel.png',
    prompt: 'Orthographic top-down view directly overhead of a single sturdy wooden barrel with '
      + 'iron hoop bands, dark aged timber staves, sitting alone on a plain dark stone dungeon '
      + 'floor, dramatic single-source rim lighting, dark fantasy illustration with rich '
      + 'jewel-tone colour accents and intricate linework, the barrel fills most of the frame, '
      + 'no other objects, no characters, square 1:1 aspect ratio'
  },
  {
    id: 'rubble',
    outfile: 'assets/cover/rubble.png',
    prompt: 'Orthographic top-down view directly overhead of a pile of broken stone rubble and '
      + 'collapsed masonry blocks, jagged grey and dark stone fragments with sharp shadows, '
      + 'sitting alone on a plain dark stone dungeon floor, dramatic single-source rim lighting, '
      + 'dark fantasy illustration with intricate linework, the rubble pile fills most of the '
      + 'frame, no other objects, no characters, square 1:1 aspect ratio'
  }
];

function buildWorkflow({ prompt, seed, filenamePrefix }) {
  return {
    '1': { class_type: 'UnetLoaderGGUF', inputs: { unet_name: ZIMAGE_UNET } },
    '2': {
      class_type: 'LoraLoaderModelOnly',
      inputs: { model: ['1', 0], lora_name: ZIMAGE_LORA, strength_model: ZIMAGE_LORA_STRENGTH }
    },
    '3': { class_type: 'CLIPLoaderGGUF', inputs: { clip_name: ZIMAGE_CLIP, type: ZIMAGE_CLIP_TYPE } },
    '4': { class_type: 'CLIPTextEncode', inputs: { text: prompt, clip: ['3', 0] } },
    '5': { class_type: 'CLIPTextEncode', inputs: { text: NEGATIVE, clip: ['3', 0] } },
    '6': { class_type: 'VAELoader', inputs: { vae_name: ZIMAGE_VAE } },
    '7': { class_type: 'EmptySD3LatentImage', inputs: { width: WIDTH, height: HEIGHT, batch_size: 1 } },
    '8': {
      class_type: 'KSampler',
      inputs: {
        seed, steps: ZIMAGE_STEPS, cfg: ZIMAGE_CFG, sampler_name: ZIMAGE_SAMPLER, scheduler: ZIMAGE_SCHEDULER,
        denoise: 1.0, model: ['2', 0], positive: ['4', 0], negative: ['5', 0], latent_image: ['7', 0]
      }
    },
    '9': { class_type: 'VAEDecode', inputs: { samples: ['8', 0], vae: ['6', 0] } },
    '10': { class_type: 'SaveImage', inputs: { filename_prefix: filenamePrefix, images: ['9', 0] } }
  };
}

async function enqueue(workflow) {
  const clientId = 'dommt-cover-' + Math.random().toString(36).slice(2, 10);
  const res = await fetch(`${BASE}/prompt`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ prompt: workflow, client_id: clientId })
  });
  if (!res.ok) throw new Error(`enqueue failed: ${res.status} ${await res.text()}`);
  return (await res.json()).prompt_id;
}

async function pollHistory(promptId, { timeoutMs = 300_000, intervalMs = 2000 } = {}) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const res = await fetch(`${BASE}/history/${promptId}`);
    if (res.ok) {
      const data = await res.json();
      const entry = data[promptId];
      if (entry && entry.outputs) return entry;
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(`timeout waiting for ${promptId}`);
}

function firstImageOutput(entry) {
  for (const nodeId of Object.keys(entry.outputs)) {
    const out = entry.outputs[nodeId];
    if (out.images && out.images.length) return out.images[0];
  }
  return null;
}

async function downloadImage({ filename, subfolder = '', type = 'output' }, destPath) {
  const url = `${BASE}/view?filename=${encodeURIComponent(filename)}&subfolder=${encodeURIComponent(subfolder)}&type=${encodeURIComponent(type)}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`download failed: ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  mkdirSync(dirname(destPath), { recursive: true });
  writeFileSync(destPath, buf);
}

async function generateOne({ id, prompt, outfile }) {
  const absOut = resolve(root, outfile);
  if (!FORCE && existsSync(absOut)) return { id, skipped: true };

  const seed = Math.floor(Math.random() * 2 ** 32);
  const wf = buildWorkflow({ prompt, seed, filenamePrefix: `dommt-cover/${id}` });
  if (DRY) {
    console.log(`[dry] ${id} -> ${outfile}\n      prompt: ${prompt.slice(0, 120)}...`);
    return { id, dry: true };
  }
  const promptId = await enqueue(wf);
  const entry = await pollHistory(promptId);
  const img = firstImageOutput(entry);
  if (!img) throw new Error(`${id}: no image in outputs`);
  await downloadImage(img, absOut);
  return { id, outfile };
}

async function main() {
  const items = ONLY.length ? ITEMS.filter((i) => ONLY.includes(i.id)) : ITEMS;
  for (const item of items) {
    const result = await generateOne(item);
    if (result.skipped) console.log(`skip ${result.id} (exists, use --force to regenerate)`);
    else if (result.dry) continue;
    else console.log(`done ${result.id} -> ${result.outfile}`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
