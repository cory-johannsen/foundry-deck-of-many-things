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
const SILENCE_FLOOR = '-50dB';
const QUALITY = '5';            // ~112–128 kbps stereo vorbis

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

execFileSync(ffmpeg, [
  '-hide_banner', '-loglevel', 'error', '-y',
  '-i', source,
  '-af', `${trim},${second}`,
  '-ac', '2', '-ar', '44100',
  '-c:a', 'libvorbis', '-q:a', QUALITY,
  outPath
], { stdio: 'inherit' });

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
console.log(`  trimmed, normalised to ${LUFS} LUFS, ogg vorbis q${QUALITY}`);
