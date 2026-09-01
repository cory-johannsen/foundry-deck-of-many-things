#!/usr/bin/env node
/**
 * Generate all card artwork via a ComfyUI server (comfyui.johannsen.cloud by default).
 *
 * Usage:
 *   node tools/generate-art.mjs                  # generate any missing card
 *   node tools/generate-art.mjs --force          # regenerate everything
 *   node tools/generate-art.mjs --only aberration,balance
 *   node tools/generate-art.mjs --shared         # also generate back + reading cloth
 *   node tools/generate-art.mjs --dry-run        # print composed prompts, do not enqueue
 *   node tools/generate-art.mjs --concurrency 2  # simultaneous jobs (default 1)
 *
 * Env:
 *   COMFYUI_BASE_URL   default https://comfyui.johannsen.cloud
 *   COMFYUI_CHECKPOINT default dreamshaperXL_lightningDPMSDE.safetensors
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');

const BASE = (process.env.COMFYUI_BASE_URL || 'https://comfyui.johannsen.cloud').replace(/\/$/, '');
const CHECKPOINT = process.env.COMFYUI_CHECKPOINT || 'dreamshaperXL_lightningDPMSDE.safetensors';

const args = process.argv.slice(2);
const flag = (n) => args.includes(n);
const arg = (n, dflt) => {
  const i = args.indexOf(n);
  return i >= 0 ? args[i + 1] : dflt;
};

const FORCE = flag('--force');
const DRY = flag('--dry-run');
const DO_SHARED = flag('--shared');
const CONCURRENCY = Math.max(1, parseInt(arg('--concurrency', '1'), 10));
const ONLY = (arg('--only', '') || '').split(',').filter(Boolean);

const cards = JSON.parse(readFileSync(resolve(root, 'data/cards.json'), 'utf8'));

const NEGATIVE = '(text:1.4), (title:1.4), (letters:1.4), (words:1.4), (title banner:1.3), (nameplate:1.3), watermark, signature, blurry, out of frame, extra limbs, low quality, jpeg artifacts, cartoon, chibi, 3d render';
const WIDTH = 832;
const HEIGHT = 1216;
const STEPS = 6;
const CFG = 2.0;
const SAMPLER = 'dpmpp_sde';
const SCHEDULER = 'karras';

const SHARED = [
  {
    id: 'back',
    outfile: 'assets/cards/back.png',
    prompt: 'A tarot card back design, intricate geometric mandala pattern in deep midnight blue and gold, eight-pointed star motif at center surrounded by layered filigree borders, corner ornaments, no text, dark fantasy aesthetic, ornate gold border, aged parchment texture, vertical portrait orientation'
  },
  {
    id: 'cloth',
    outfile: 'assets/cloth.png',
    prompt: 'A large dark velvet reading cloth spread on a stone table, deep midnight blue-black fabric with subtle gold thread constellations woven into it, scattered silver starlight, soft candlelight from off-frame illuminating the surface, a few wisps of incense smoke rising at the edges, moody atmospheric fantasy setting, widescreen 16:9',
    width: 1536,
    height: 864
  }
];

function buildWorkflow({ prompt, negative = NEGATIVE, width = WIDTH, height = HEIGHT, seed, filenamePrefix }) {
  return {
    '1': { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: CHECKPOINT } },
    '2': { class_type: 'CLIPTextEncode', inputs: { text: prompt, clip: ['1', 1] } },
    '3': { class_type: 'CLIPTextEncode', inputs: { text: negative, clip: ['1', 1] } },
    '4': { class_type: 'EmptyLatentImage', inputs: { width, height, batch_size: 1 } },
    '5': {
      class_type: 'KSampler',
      inputs: {
        seed,
        steps: STEPS,
        cfg: CFG,
        sampler_name: SAMPLER,
        scheduler: SCHEDULER,
        denoise: 1.0,
        model: ['1', 0],
        positive: ['2', 0],
        negative: ['3', 0],
        latent_image: ['4', 0]
      }
    },
    '6': { class_type: 'VAEDecode', inputs: { samples: ['5', 0], vae: ['1', 2] } },
    '7': { class_type: 'SaveImage', inputs: { filename_prefix: filenamePrefix, images: ['6', 0] } }
  };
}

async function enqueue(workflow) {
  const clientId = 'dommt-' + Math.random().toString(36).slice(2, 10);
  const res = await fetch(`${BASE}/prompt`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ prompt: workflow, client_id: clientId })
  });
  if (!res.ok) throw new Error(`enqueue failed: ${res.status} ${await res.text()}`);
  const body = await res.json();
  return body.prompt_id;
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

async function generateOne({ id, prompt, outfile, width, height }) {
  const absOut = resolve(root, outfile);
  if (!FORCE && existsSync(absOut)) {
    return { id, skipped: true };
  }
  const seed = Math.floor(Math.random() * 2 ** 32);
  const wf = buildWorkflow({
    prompt,
    width: width ?? WIDTH,
    height: height ?? HEIGHT,
    seed,
    filenamePrefix: `dommt/${id}`
  });
  if (DRY) {
    console.log(`[dry] ${id} → ${outfile}\n      prompt: ${prompt.slice(0, 120)}…`);
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
  const jobs = [];
  const cardTargets = ONLY.length ? cards.filter((c) => ONLY.includes(c.id)) : cards;
  for (const c of cardTargets) {
    jobs.push({ id: c.id, prompt: c.art.prompt, outfile: c.art.front.replace(/\.webp$/, '.png') });
  }
  if (DO_SHARED) jobs.push(...SHARED);

  console.log(`Targets: ${jobs.length}${FORCE ? ' (force)' : ''}, concurrency=${CONCURRENCY}, server=${BASE}, checkpoint=${CHECKPOINT}`);

  const queue = jobs.slice();
  const inFlight = new Set();
  let ok = 0, skipped = 0, failed = 0;

  async function worker() {
    while (queue.length) {
      const job = queue.shift();
      const start = Date.now();
      try {
        const r = await generateOne(job);
        if (r.skipped) { skipped++; process.stdout.write(`⏭  ${job.id.padEnd(14)} exists\n`); }
        else if (r.dry) { /* logged inline */ }
        else { ok++; process.stdout.write(`✅ ${job.id.padEnd(14)} ${((Date.now() - start) / 1000).toFixed(1)}s\n`); }
      } catch (err) {
        failed++;
        process.stdout.write(`❌ ${job.id.padEnd(14)} ${err.message}\n`);
      }
    }
  }

  await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()));
  console.log(`\nDone: ${ok} generated, ${skipped} skipped, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main().catch((err) => { console.error(err); process.exit(1); });
