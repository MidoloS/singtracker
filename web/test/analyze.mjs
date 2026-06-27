// Diagnose why pitch detection rate is so low on the real file.
// Usage: node test/analyze.mjs ../song.mp3

import { spawnSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { PitchDetector } from 'pitchy';

const SR = 44100;
const WINDOW = 2048;
const HOP_MS = 25;
const MIN_HZ = 65;
const MAX_HZ = 1100;

const arg = process.argv[2] ?? '../song.mp3';
const file = resolve(arg);
if (!existsSync(file)) {
  console.error(`No file at ${file}`);
  process.exit(1);
}

// Decode MP3 → 32-bit float mono PCM @ 44100Hz via ffmpeg.
const pcmPath = '/tmp/singimprove-song.pcm';
const ff = spawnSync(
  'ffmpeg',
  ['-y', '-i', file, '-ac', '1', '-ar', String(SR), '-f', 'f32le', pcmPath],
  { stdio: ['ignore', 'ignore', 'pipe'] },
);
if (ff.status !== 0) {
  console.error('ffmpeg failed:', ff.stderr.toString());
  process.exit(1);
}
const raw = readFileSync(pcmPath);
const mono = new Float32Array(raw.buffer, raw.byteOffset, raw.byteLength / 4);
console.log(`samples=${mono.length} (${(mono.length / SR).toFixed(1)}s @ ${SR}Hz)`);

// Peak + RMS before normalization.
let peak = 0;
let sumSq = 0;
for (let i = 0; i < mono.length; i++) {
  const a = Math.abs(mono[i]);
  if (a > peak) peak = a;
  sumSq += mono[i] * mono[i];
}
const rmsAll = Math.sqrt(sumSq / mono.length);
console.log(
  `pre-norm: peak=${peak.toFixed(3)} (${(20 * Math.log10(peak || 1e-12)).toFixed(1)} dBFS) ` +
    `rms=${rmsAll.toFixed(3)} (${(20 * Math.log10(rmsAll || 1e-12)).toFixed(1)} dBFS)`,
);

// Normalize like the app does.
if (peak > 0 && peak < 0.99) {
  const gain = 0.99 / peak;
  for (let i = 0; i < mono.length; i++) mono[i] *= gain;
  console.log(`normalized by gain=${gain.toFixed(2)}`);
}

// Sweep with several minVolumeDecibels settings; for each, record per-frame
// clarity + hz so we can answer "what would happen at threshold X?" without
// re-running.
const hop = Math.round((HOP_MS / 1000) * SR);
const detector = PitchDetector.forFloat32Array(WINDOW);
// Start with a very permissive volume floor so we see ALL frames; we'll
// re-filter in JS afterward.
detector.minVolumeDecibels = -120;

const frames = [];
for (let start = 0; start + WINDOW <= mono.length; start += hop) {
  const slice = mono.subarray(start, start + WINDOW);
  // RMS of this window in dBFS.
  let ss = 0;
  for (let i = 0; i < WINDOW; i++) ss += slice[i] * slice[i];
  const rms = Math.sqrt(ss / WINDOW);
  const dbfs = 20 * Math.log10(rms || 1e-12);
  const [hz, clarity] = detector.findPitch(slice, SR);
  frames.push({ hz, clarity, dbfs });
}
console.log(`frames=${frames.length} (hop=${HOP_MS}ms)`);

function pctValid(clarityMin, dbfsMin) {
  let n = 0;
  for (const f of frames) {
    if (f.clarity >= clarityMin && f.dbfs >= dbfsMin && f.hz >= MIN_HZ && f.hz <= MAX_HZ) n++;
  }
  return (n / frames.length) * 100;
}

console.log('\nDetection rate (%) at various (clarity, volume) thresholds:');
const clarities = [0.95, 0.9, 0.85, 0.8, 0.7, 0.6, 0.5, 0.4, 0.3];
const volumes = [-30, -40, -50, -55, -60, -70];
const header = ['clarity\\dB'].concat(volumes.map((v) => v.toString().padStart(6))).join(' ');
console.log(header);
for (const c of clarities) {
  const row = [c.toFixed(2).padStart(10)];
  for (const v of volumes) row.push(pctValid(c, v).toFixed(1).padStart(6));
  console.log(row.join(' '));
}

// Histograms.
function hist(values, buckets) {
  const counts = new Array(buckets.length - 1).fill(0);
  for (const v of values) {
    for (let b = 0; b < buckets.length - 1; b++) {
      if (v >= buckets[b] && v < buckets[b + 1]) {
        counts[b]++;
        break;
      }
    }
  }
  const total = values.length || 1;
  return counts.map((n, b) => ({
    range: `[${buckets[b].toFixed(2)},${buckets[b + 1].toFixed(2)})`,
    n,
    pct: ((n / total) * 100).toFixed(1),
  }));
}

console.log('\nClarity distribution (all frames):');
for (const row of hist(
  frames.map((f) => f.clarity),
  [0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1.001],
))
  console.log(`  ${row.range.padEnd(13)} ${row.pct.padStart(6)}%  (${row.n})`);

console.log('\nFrame volume (dBFS) distribution:');
for (const row of hist(
  frames.map((f) => f.dbfs),
  [-Infinity, -80, -60, -50, -40, -30, -20, -10, 0],
))
  console.log(`  ${row.range.padEnd(22)} ${row.pct.padStart(6)}%  (${row.n})`);

// What % of frames have a "musical-range" hz at all, regardless of clarity?
const inRange = frames.filter((f) => f.hz >= MIN_HZ && f.hz <= MAX_HZ).length;
console.log(
  `\nFrames where hz falls in [${MIN_HZ},${MAX_HZ}] (ignoring clarity/volume): ${(
    (inRange / frames.length) *
    100
  ).toFixed(1)}%`,
);

// Where DO the "clear" pitches actually land? Among frames with clarity ≥ 0.7,
// what's the hz distribution?
const clearOnly = frames.filter((f) => f.clarity >= 0.7);
console.log(`\nHz distribution among frames with clarity ≥ 0.7 (${clearOnly.length} frames):`);
for (const row of hist(
  clearOnly.map((f) => f.hz),
  [0, 30, 60, 90, 130, 200, 300, 500, 800, 1200, 2000, 5000],
))
  console.log(`  ${row.range.padEnd(14)} ${row.pct.padStart(6)}%  (${row.n})`);

// What if we widen the range?
console.log('\nDetection rate vs hz range (at clarity ≥ 0.5):');
for (const [lo, hi] of [
  [65, 1100],
  [40, 1100],
  [30, 1100],
  [40, 2000],
  [80, 1100],
  [100, 1100],
  [150, 1100],
  [200, 1100],
]) {
  const n = frames.filter((f) => f.clarity >= 0.5 && f.hz >= lo && f.hz <= hi).length;
  console.log(`  [${lo}, ${hi}] Hz → ${((n / frames.length) * 100).toFixed(1)}%`);
}

// What if we high-pass filter the audio first?
function highpass(samples, sr, cutoffHz) {
  // 2nd-order Butterworth biquad, designed via bilinear transform.
  const out = new Float32Array(samples.length);
  const w0 = (2 * Math.PI * cutoffHz) / sr;
  const cosw = Math.cos(w0);
  const sinw = Math.sin(w0);
  const Q = Math.SQRT1_2;
  const alpha = sinw / (2 * Q);
  const b0 = (1 + cosw) / 2;
  const b1 = -(1 + cosw);
  const b2 = (1 + cosw) / 2;
  const a0 = 1 + alpha;
  const a1 = -2 * cosw;
  const a2 = 1 - alpha;
  const nb0 = b0 / a0;
  const nb1 = b1 / a0;
  const nb2 = b2 / a0;
  const na1 = a1 / a0;
  const na2 = a2 / a0;
  let x1 = 0;
  let x2 = 0;
  let y1 = 0;
  let y2 = 0;
  for (let i = 0; i < samples.length; i++) {
    const x = samples[i];
    const y = nb0 * x + nb1 * x1 + nb2 * x2 - na1 * y1 - na2 * y2;
    x2 = x1;
    x1 = x;
    y2 = y1;
    y1 = y;
    out[i] = y;
  }
  return out;
}

console.log('\nWith a 2nd-order highpass on the input (clarity ≥ 0.7, hz ∈ [65, 1100]):');
for (const cutoff of [0, 80, 120, 150, 200, 250, 300]) {
  const filt = cutoff === 0 ? mono : highpass(mono, SR, cutoff);
  const det = PitchDetector.forFloat32Array(WINDOW);
  det.minVolumeDecibels = -120;
  let detected = 0;
  let total = 0;
  for (let start = 0; start + WINDOW <= filt.length; start += hop) {
    const slice = filt.subarray(start, start + WINDOW);
    const [hz, clarity] = det.findPitch(slice, SR);
    total++;
    if (clarity >= 0.7 && hz >= 65 && hz <= 1100) detected++;
  }
  console.log(`  cutoff=${String(cutoff).padStart(3)} Hz → ${((detected / total) * 100).toFixed(1)}%`);
}

console.log('\nGrid: highpass cutoff × (clarity, range) — % detected:');
const combos = [
  { c: 0.5, lo: 80, hi: 1100 },
  { c: 0.5, lo: 100, hi: 1100 },
  { c: 0.6, lo: 80, hi: 1100 },
  { c: 0.6, lo: 100, hi: 1100 },
  { c: 0.7, lo: 80, hi: 1100 },
  { c: 0.7, lo: 100, hi: 1100 },
];
const cutoffs = [0, 150, 200, 250, 300];
const head =
  'config'.padEnd(28) + cutoffs.map((c) => `hp${c}`.padStart(8)).join('');
console.log(head);
for (const { c, lo, hi } of combos) {
  const label = `clarity≥${c}, [${lo},${hi}]Hz`;
  const row = [label.padEnd(28)];
  for (const cutoff of cutoffs) {
    const filt = cutoff === 0 ? mono : highpass(mono, SR, cutoff);
    const det = PitchDetector.forFloat32Array(WINDOW);
    det.minVolumeDecibels = -120;
    let detected = 0;
    let total = 0;
    for (let start = 0; start + WINDOW <= filt.length; start += hop) {
      const slice = filt.subarray(start, start + WINDOW);
      const [hz, clarity] = det.findPitch(slice, SR);
      total++;
      if (clarity >= c && hz >= lo && hz <= hi) detected++;
    }
    row.push(`${((detected / total) * 100).toFixed(1)}%`.padStart(8));
  }
  console.log(row.join(''));
}

// Sanity check: how the CURRENT app config performs.
const APP_CLARITY = 0.7;
const APP_DBFS = -55;
console.log(
  `\nApp config (clarity≥${APP_CLARITY}, dB≥${APP_DBFS}) → ${pctValid(APP_CLARITY, APP_DBFS).toFixed(
    1,
  )}% detected`,
);
