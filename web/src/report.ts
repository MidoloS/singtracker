// Post-session metrics. Local-only, computed from in-memory mic samples.
// This is the fast/coarse report — the fine-grained one would run server-side
// over the recorded audio (see §4 of the README).

import type { Note, NotesPayload } from './notes';
import { midiToNoteName } from './pitch';

export type Sample = { t: number; midi: number };

export type NoteEval = {
  note: Note;
  /** Median cents error across samples inside the note (octave-invariant). null if no samples. */
  medianCents: number | null;
  /** Fraction of samples inside the note that were within ±tolerance cents. */
  hitFraction: number;
  hit: boolean;
};

export type Report = {
  /** Seconds covered (last sample t, or stopTime, whichever exists). */
  elapsed: number;
  /** Notes whose start fell within `elapsed`. */
  notesInWindow: number;
  /** Of those, how many we even attempted (any user sample during the note). */
  attempted: number;
  /** Of attempted, how many we consider hit (≥50% samples within tolerance). */
  hit: number;
  /** hit / notesInWindow (not over attempted — penalizes silence). */
  accuracyPct: number;
  /** Median cents error across all attempted samples (signed). */
  medianCents: number | null;
  meanCents: number | null;
  /** "alto" = positive bias (sharp), "bajo" = negative (flat). */
  tendency: 'alto' | 'bajo' | 'centrado' | null;
  /** MIDI of highest sustained user note (cum. ≥0.4s on the same semitone). */
  topSustainedMidi: number | null;
  topSustainedName: string | null;
  /** MIDI of lowest sustained user note. */
  bottomSustainedMidi: number | null;
  bottomSustainedName: string | null;
  /** Lowest detected pitch (any duration). */
  totalLowMidi: number | null;
  totalLowName: string | null;
  /** Highest detected pitch (any duration). */
  totalHighMidi: number | null;
  totalHighName: string | null;
  /** Total range in semitones (totalHigh - totalLow). */
  totalRangeSemitones: number | null;
  /** Distribution of evaluations per note (sorted by t). */
  perNote: NoteEval[];
  /** Quality flag: too little data to trust. */
  thin: boolean;
};

const TOLERANCE_CENTS = 50;

/** ((m - center + 600) mod 1200) - 600 — distance in cents, octave-invariant. */
function foldedCents(userMidi: number, targetMidi: number): number {
  const diff = (userMidi - targetMidi) * 100;
  let r = ((diff + 600) % 1200 + 1200) % 1200 - 600;
  // Edge case when r === -600: equivalent to +600, but the sign choice doesn't matter
  // for |r|; for tendency we treat -600 as 0 by clamping.
  if (r === -600) r = 600;
  return r;
}

function median(xs: number[]): number | null {
  if (!xs.length) return null;
  const s = xs.slice().sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

function evaluateNote(note: Note, samples: Sample[]): NoteEval {
  const a = note.t;
  const b = note.t + note.d;
  const inside: number[] = [];
  for (const s of samples) {
    if (s.t < a) continue;
    if (s.t >= b) break;
    inside.push(foldedCents(s.midi, note.midi));
  }
  if (!inside.length) {
    return { note, medianCents: null, hitFraction: 0, hit: false };
  }
  const within = inside.filter((c) => Math.abs(c) <= TOLERANCE_CENTS).length;
  const hitFraction = within / inside.length;
  return {
    note,
    medianCents: median(inside),
    hitFraction,
    hit: hitFraction >= 0.5,
  };
}

/**
 * Vocal-range analysis from the user's mic samples.
 *
 * Two views:
 *  - sustained: per-semitone cumulative time of "continuous" pitch (gap ≤ 0.2s,
 *    drift ≤ ±1 semitone — allows vibrato). A semitone counts as sustained if
 *    its cumulative time ≥ `minSustainSec`. Returns the highest/lowest such.
 *  - total: min/max of any detected pitch, regardless of duration (the
 *    "extensión total" of the README).
 *
 * The sustained ceiling is the README's "star data" — what the singer can
 * actually hold, not what they grazed for an instant.
 */
function vocalRange(samples: Sample[], minSustainSec = 0.4): {
  topSustained: number | null;
  bottomSustained: number | null;
  totalLow: number | null;
  totalHigh: number | null;
} {
  if (samples.length < 2) {
    return { topSustained: null, bottomSustained: null, totalLow: null, totalHigh: null };
  }

  let totalLow = Infinity;
  let totalHigh = -Infinity;
  // Cumulative seconds spent on each rounded semitone, only counting time
  // between consecutive samples that don't break continuity.
  const cumulative = new Map<number, number>();

  for (let i = 0; i < samples.length; i++) {
    const midiRounded = Math.round(samples[i].midi);
    if (midiRounded < totalLow) totalLow = midiRounded;
    if (midiRounded > totalHigh) totalHigh = midiRounded;
    if (i === 0) continue;
    const dt = samples[i].t - samples[i - 1].t;
    if (dt <= 0 || dt > 0.2) continue; // gap too large → new attack
    const prev = Math.round(samples[i - 1].midi);
    if (Math.abs(samples[i].midi - samples[i - 1].midi) > 1) continue; // big jump
    cumulative.set(prev, (cumulative.get(prev) ?? 0) + dt);
  }

  let topSustained: number | null = null;
  let bottomSustained: number | null = null;
  for (const [midi, time] of cumulative) {
    if (time < minSustainSec) continue;
    if (topSustained === null || midi > topSustained) topSustained = midi;
    if (bottomSustained === null || midi < bottomSustained) bottomSustained = midi;
  }

  return {
    topSustained,
    bottomSustained,
    totalLow: isFinite(totalLow) ? totalLow : null,
    totalHigh: isFinite(totalHigh) ? totalHigh : null,
  };
}

export function computeReport(
  samples: Sample[],
  payload: NotesPayload,
  stopTime?: number,
): Report {
  const elapsed = stopTime ?? (samples.length ? samples[samples.length - 1].t : 0);
  const notesInWindow = payload.notes.filter((n) => n.t < elapsed);
  const evals = notesInWindow.map((n) => evaluateNote(n, samples));
  const attempted = evals.filter((e) => e.medianCents !== null).length;
  const hit = evals.filter((e) => e.hit).length;
  const accuracyPct = notesInWindow.length ? (hit / notesInWindow.length) * 100 : 0;

  const allCents: number[] = [];
  for (const e of evals) if (e.medianCents !== null) allCents.push(e.medianCents);
  const med = median(allCents);
  const mean = allCents.length ? allCents.reduce((a, b) => a + b, 0) / allCents.length : null;
  let tendency: Report['tendency'] = null;
  if (med !== null) {
    if (med > 10) tendency = 'alto';
    else if (med < -10) tendency = 'bajo';
    else tendency = 'centrado';
  }

  const { topSustained, bottomSustained, totalLow, totalHigh } = vocalRange(samples);

  return {
    elapsed,
    notesInWindow: notesInWindow.length,
    attempted,
    hit,
    accuracyPct,
    medianCents: med,
    meanCents: mean,
    tendency,
    topSustainedMidi: topSustained,
    topSustainedName: topSustained !== null ? midiToNoteName(topSustained) : null,
    bottomSustainedMidi: bottomSustained,
    bottomSustainedName: bottomSustained !== null ? midiToNoteName(bottomSustained) : null,
    totalLowMidi: totalLow,
    totalLowName: totalLow !== null ? midiToNoteName(totalLow) : null,
    totalHighMidi: totalHigh,
    totalHighName: totalHigh !== null ? midiToNoteName(totalHigh) : null,
    totalRangeSemitones:
      totalLow !== null && totalHigh !== null ? totalHigh - totalLow : null,
    perNote: evals,
    thin: attempted < 5 || elapsed < 5,
  };
}
