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
 * Raw art is written to assets/cards/<id>.png. The finished card that Foundry
 * loads is assets/cards-labeled/<id>.png, produced by tools/compose-cards.mjs,
 * which adds the decorative frame and the name plate.
 *
 * Env:
 *   COMFYUI_BASE_URL   default https://comfyui.johannsen.cloud
 *   COMFYUI_CHECKPOINT default sd_xl_base_1.0.safetensors
 *   COMFYUI_STEPS      default 28   (lightning checkpoints want ~6)
 *   COMFYUI_CFG        default 7.0  (lightning checkpoints want ~2.0)
 *   COMFYUI_SAMPLER    default dpmpp_sde
 *   COMFYUI_SCHEDULER  default karras
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync, copyFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');

const BASE = (process.env.COMFYUI_BASE_URL || 'https://comfyui.johannsen.cloud').replace(/\/$/, '');
// sd_xl_base, not a lightning checkpoint. Lightning runs in ~26s/card but
// follows the prompt weakly at the CFG it requires (~2.0): scenes lost their
// named elements and drifted photo-real despite the style tags. sd_xl_base at
// CFG 7 / 28 steps costs ~106s/card and holds both style and scene far better.
const CHECKPOINT = process.env.COMFYUI_CHECKPOINT || 'sd_xl_base_1.0.safetensors';

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

// Text terms are weighted high because the model kept inventing a title
// cartouche and filling it with gibberish. Frame/border terms are here because
// the decorative frame is composited afterwards by tools/compose-cards.mjs —
// art must be full-bleed so the model's own frame does not clash with ours.
const NEGATIVE = '(text:1.5), (title:1.5), (letters:1.5), (words:1.5), (gibberish text:1.5), ' +
  '(cartouche:1.4), (plaque:1.4), (banner:1.4), (inscription:1.4), (caption:1.4), (label:1.4), ' +
  '(nameplate:1.4), (title banner:1.4), (ornate border:1.3), (decorative frame:1.3), ' +
  '(picture frame:1.3), (vignette:1.2), (matte border:1.2), ' +
  // "aged parchment texture" + "intricate linework" in the positive suffix can
  // collapse into a monochrome woodcut on subjects with no strong colour cue —
  // Fates came back as a sepia engraving with the jewel tones lost entirely.
  // Suppressed here rather than by editing the positive suffix, which would
  // shift the style of all 66 cards.
  '(monochrome:1.4), (greyscale:1.4), (black and white:1.4), (sepia:1.3), ' +
  '(engraving:1.3), (woodcut:1.3), (etching:1.3), (line art:1.2), (desaturated:1.3), ' +
  'watermark, signature, blurry, out of frame, extra limbs, extra fingers, malformed hands, ' +
  'low quality, jpeg artifacts, cartoon, chibi, 3d render';
const WIDTH = 832;
const HEIGHT = 1216;
// Lightning checkpoints need few steps and very low CFG. A full checkpoint
// (e.g. sd_xl_base_1.0) needs ~25-30 steps at CFG 6-8 and follows the prompt
// far more closely — override via env when scene fidelity matters more than
// speed. See COMFYUI_CHECKPOINT / COMFYUI_STEPS / COMFYUI_CFG.
const STEPS = parseInt(process.env.COMFYUI_STEPS || '28', 10);
const CFG = parseFloat(process.env.COMFYUI_CFG || '7.0');
const SAMPLER = process.env.COMFYUI_SAMPLER || 'dpmpp_sde';
const SCHEDULER = process.env.COMFYUI_SCHEDULER || 'karras';

const SHARED = [
  {
    id: 'back',
    outfile: 'assets/cards/back.png',
    prompt: 'A tarot card back design, intricate geometric mandala pattern in deep midnight blue and gold, eight-pointed star motif at center surrounded by layered filigree borders, corner ornaments, no text, dark fantasy aesthetic, ornate gold border, aged parchment texture, vertical portrait orientation'
  },
  {
    id: 'cloth',
    outfile: 'assets/cloth.png',
    prompt: 'Orthographic top-down bird\'s-eye view directly overhead of a large dark velvet reading cloth spread flat on a wooden table, the cloth fills most of the frame edge to edge, deep midnight blue-black fabric with subtle gold thread constellations woven throughout it, scattered silver starlight embroidery, warm candlelight glow around the perimeter of the cloth, subtle dark wood grain visible only at the very corners outside the cloth, tabletop surface viewed straight down from above, no perspective, no horizon, no walls, no ceiling, no figures, no cards, empty flat surface ready for a tarot reading, moody atmospheric fantasy setting, widescreen 16:9',
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

async function generateOne({ id, prompt, negative, outfile, width, height, card }) {
  const absOut = resolve(root, outfile);
  if (!FORCE && existsSync(absOut)) {
    return { id, skipped: true };
  }
  // Iterative review means art gets re-rolled repeatedly and a re-roll is not
  // always an improvement. Keep the outgoing image so a better earlier version
  // is never lost — git only holds whatever was last committed.
  if (existsSync(absOut)) {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const histDir = resolve(root, 'assets/.card-history');
    mkdirSync(histDir, { recursive: true });
    const v = card?.art?.version ?? 0;
    copyFileSync(absOut, resolve(histDir, `${id}-v${v}-${stamp}.png`));
  }
  const seed = Math.floor(Math.random() * 2 ** 32);
  const wf = buildWorkflow({
    prompt,
    negative: negative ?? NEGATIVE,
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
  // Bump only after the image is safely on disk, so the number always reflects
  // how many images this card actually has, and persist immediately — an
  // interrupted run must not leave versions claiming more than exists.
  if (card) {
    card.art.version = (card.art.version ?? 0) + 1;
    writeFileSync(resolve(root, 'data/cards.json'), `${JSON.stringify(cards, null, 2)}\n`);
  }
  return { id, outfile, version: card?.art?.version };
}

async function main() {
  const jobs = [];
  const cardTargets = ONLY.length ? cards.filter((c) => ONLY.includes(c.id)) : cards;
  for (const c of cardTargets) {
    // Hand-picked art (chosen from ComfyUI's output history rather than rolled
    // from the prompt) is not reproducible, so --force must not overwrite it.
    // --repin regenerates pinned cards deliberately.
    if (c.art.pinned && !flag('--repin')) {
      process.stdout.write(`\uD83D\uDCCC ${c.id.padEnd(14)} pinned, skipped\n`);
      continue;
    }
    // Raw art always goes to assets/cards/<id>.png. NOT to c.art.front — that
    // now points at assets/cards-labeled/, the composed output, and writing raw
    // art there would clobber the frame and plate.
    jobs.push({
      id: c.id,
      prompt: c.art.prompt,
      // Optional per-card suppression, appended to the shared negative. Used
      // where the model reliably invents something the flavor does not have —
      // most often a human figure on a card whose subject is an object.
      negative: c.art.negative ? `${NEGATIVE}, ${c.art.negative}` : NEGATIVE,
      outfile: `assets/cards/${c.id}.png`,
      card: c
    });
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
        else { ok++; process.stdout.write(`✅ ${job.id.padEnd(14)} ${((Date.now() - start) / 1000).toFixed(1)}s${r.version ? `  v${r.version}` : ''}\n`); }
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
