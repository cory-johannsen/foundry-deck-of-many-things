#!/usr/bin/env node
/**
 * Bring a downloaded sound into the module.
 *
 *   node tools/import-sound.mjs <source-file> <group|filename> [--keep]
 *   node tools/import-sound.mjs freesound-12345.wav boon
 *   node tools/import-sound.mjs whatever.mp3 skull-laugh.ogg
 *
 * Sources come from Kenney, Freesound and the like at wildly different
 * lengths, levels and formats, and would otherwise land in the module as
 * multi-megabyte 32-bit wavs of varying loudness. Everything is therefore:
 *
 *   - trimmed of leading and trailing silence, so the sting starts on the beat
 *     the card lands rather than after a beat of nothing
 *   - loudness-normalised to a common target, so no one card is startling
 *   - encoded to Ogg Vorbis, which every browser Foundry supports can play
 *
 * `--trim=<dB>` moves the silence threshold for one file. The default of -50dB
 * suits a sound that starts abruptly, but a reversed or swelling one has no
 * silence to speak of — only a long quiet ramp — and would keep all five
 * seconds of it. Raising the threshold cuts into the ramp instead.
 *
 * `--keep` leaves the source file in place; by default it is left alone too,
 * and only ever read.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, basename } from 'node:path';
import ffmpeg from 'ffmpeg-static';
import { SOUND_GROUPS } from '../scripts/card-sound.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = join(root, 'assets/sounds');

// Game SFX sit comfortably here; -1.5 dBTP leaves headroom so the boom on a
// loud card does not clip once Foundry applies its own volume on top.
const LUFS = '-16';
const TRUE_PEAK = '-1.5';
const DEFAULT_SILENCE_FLOOR = '-50dB';
const QUALITY = '5';            // ~112–128 kbps stereo vorbis

const flags = process.argv.slice(2).filter((a) => a.startsWith('--'));
const trimFlag = flags.find((a) => a.startsWith('--trim='))?.split('=')[1];
const SILENCE_FLOOR = trimFlag
  ? (/dB$/i.test(trimFlag) ? trimFlag : `${trimFlag}dB`)
  : DEFAULT_SILENCE_FLOOR;

const [source, target] = process.argv.slice(2).filter((a) => !a.startsWith('--'));
if (!source || !target) {
  console.error('usage: node tools/import-sound.mjs <source-file> <group|filename>');
  console.error(`groups: ${Object.keys(SOUND_GROUPS).join(', ')}`);
  process.exit(1);
}
if (!existsSync(source)) {
  console.error(`No such file: ${source}`);
  process.exit(1);
}

const outName = SOUND_GROUPS[target] ?? (target.endsWith('.ogg') ? target : `${target}.ogg`);
const outPath = join(outDir, outName);
mkdirSync(outDir, { recursive: true });

// areverse+silenceremove twice is how ffmpeg trims the tail: strip the head,
// reverse, strip the head again, reverse back.
const trim = [
  'silenceremove=start_periods=1:start_silence=0.02:start_threshold=' + SILENCE_FLOOR,
  'areverse',
  'silenceremove=start_periods=1:start_silence=0.02:start_threshold=' + SILENCE_FLOOR,
  'areverse'
].join(',');
const norm = `loudnorm=I=${LUFS}:TP=${TRUE_PEAK}:LRA=11`;

/**
 * Two passes, not one. Single-pass loudnorm estimates loudness as it goes and
 * drifts from the target; the first pass here only measures, and the second is
 * told what was measured. It brought the boon sting from -16.8 to -16.3 LUFS.
 *
 * It cannot rescue everything. A sound whose true peak already sits at the
 * ceiling cannot be raised further without limiting it, so a short, spiky
 * sting may land below target and should: the curse sound measures -18.1 LUFS
 * with a -1.9 dBFS peak, and lifting it 2 dB would mean squashing the very
 * transient that makes it land. Perceived level for a sting that short tracks
 * the peak more than the integrated figure, so it is left alone.
 */
function measure() {
  // loudnorm prints its JSON to stderr and ffmpeg exits 0, so this reads
  // stderr regardless of exit status rather than only on failure.
  const r = spawnSync(ffmpeg, [
    '-hide_banner', '-y', '-i', source,
    '-af', `${trim},${norm}:print_format=json`,
    '-f', 'null', '-'
  ], { encoding: 'utf8' });
  const out = `${r.stderr ?? ''}`;
  const start = out.lastIndexOf('{');
  const end = out.lastIndexOf('}');
  if (start === -1 || end <= start) return null;
  try { return JSON.parse(out.slice(start, end + 1)); } catch { return null; }
}

const m = measure();
const second = m
  ? `${norm}:measured_I=${m.input_i}:measured_TP=${m.input_tp}`
    + `:measured_LRA=${m.input_lra}:measured_thresh=${m.input_thresh}`
    + `:offset=${m.target_offset}:linear=true`
  : norm;
if (!m) console.warn('  (could not measure; falling back to single-pass)');

const encode = (extraGain) => execFileSync(ffmpeg, [
  '-hide_banner', '-loglevel', 'error', '-y',
  '-i', source,
  '-af', extraGain ? `${trim},${second},volume=${extraGain.toFixed(1)}dB` : `${trim},${second}`,
  '-ac', '2', '-ar', '44100',
  '-c:a', 'libvorbis', '-q:a', QUALITY,
  outPath
], { stdio: 'inherit' });

encode(0);

/**
 * loudnorm is conservative about inter-sample peaks and can stop well short of
 * the target while leaving real headroom — a card-shuffle sting landed at
 * -22.7 LUFS with its peak still at -4.5 dBFS, 7 dB under target with 3 dB
 * spare. Sparse, transient material does this: the gate sees mostly quiet
 * between the clicks. So measure what actually came out and take whatever
 * headroom is left, capped by the true-peak ceiling rather than by the
 * loudness target, which is the limit that must not be crossed.
 */
function loudnessOf(file) {
  const r = spawnSync(ffmpeg, [
    '-hide_banner', '-nostats', '-i', file,
    '-af', 'ebur128=peak=true:framelog=quiet', '-f', 'null', '-'
  ], { encoding: 'utf8' });
  const grab = (label, unit) => {
    const m = new RegExp(`${label}[\\s\\S]{0,80}?(-?\\d+\\.\\d+) ${unit}`).exec(`${r.stderr}`);
    return m ? Number(m[1]) : null;
  };
  return { I: grab('Integrated loudness', 'LUFS'), TP: grab('True peak', 'dBFS') };
}

const got = loudnessOf(outPath);
let claimed = 0;
if (got.I != null && got.TP != null) {
  const wanted = Number(LUFS) - got.I;              // negative when too loud
  const room = Number(TRUE_PEAK) - got.TP;          // how far the peak can rise
  // Turning a sound down is always safe; turning it up is capped by the peak.
  // The correction used to run one way only, so a source that came out of
  // loudnorm above target simply stayed loud — a level-up sting landed at
  // -14.3 against a -16 target and would have sat louder than every other card.
  claimed = wanted < 0 ? wanted : Math.min(wanted, room);
  if (Math.abs(claimed) > 0.5) encode(claimed);
  else claimed = 0;
}

// ffmpeg reports duration on stderr and exits non-zero with no output file.
const dur = (file) => {
  try {
    execFileSync(ffmpeg, ['-hide_banner', '-i', file], { stdio: ['ignore', 'ignore', 'pipe'] });
  } catch (e) {
    const m = /Duration: (\d+:\d+:\d+\.\d+)/.exec(String(e.stderr));
    return m ? m[1] : '?';
  }
  return '?';
};

const kb = (p) => `${(statSync(p).size / 1024).toFixed(0)} KB`;
console.log(`${basename(source)}  ->  assets/sounds/${outName}`);
console.log(`  ${dur(source)} ${kb(source)}   ->   ${dur(outPath)} ${kb(outPath)}`);
const final = loudnessOf(outPath);
console.log(`  trimmed at ${SILENCE_FLOOR}, ogg vorbis q${QUALITY}, `
  + `I=${final.I} LUFS TP=${final.TP} dBFS`
  + (claimed
    ? `  (${claimed > 0 ? '+' : ''}${claimed.toFixed(1)} dB correction)`
    : ''));
