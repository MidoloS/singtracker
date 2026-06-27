// Pitch detection. Only used for the live mic input — the reference melody is
// pre-analyzed server-side (see /server) and arrives as quantized notes.
import { PitchDetector } from 'pitchy';

const MIN_HZ = 65;       // ~C2
const MAX_HZ = 1100;     // ~C6
const LIVE_MIN_CLARITY = 0.85;
const LIVE_MIN_VOL_DB = -45;

export function hzToMidi(hz: number): number {
  return 69 + 12 * Math.log2(hz / 440);
}

export function midiToHz(midi: number): number {
  return 440 * Math.pow(2, (midi - 69) / 12);
}

export function midiToNoteName(midi: number): string {
  if (!isFinite(midi)) return '—';
  const names = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
  const rounded = Math.round(midi);
  return `${names[((rounded % 12) + 12) % 12]}${Math.floor(rounded / 12) - 1}`;
}

/** Shift a key name (e.g. "A mayor", "C# menor") by `semitones`. Returns the
 *  original string if it doesn't match the expected pattern. */
export function transposeKeyName(name: string | undefined | null, semitones: number): string {
  if (!name) return '?';
  if (!semitones) return name;
  const names = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
  const m = name.match(/^([A-G][#b]?)(.*)$/);
  if (!m) return name;
  const [, root, rest] = m;
  // Normalize flats to sharps for indexing.
  const flatToSharp: Record<string, string> = {
    Db: 'C#', Eb: 'D#', Gb: 'F#', Ab: 'G#', Bb: 'A#',
  };
  const r = flatToSharp[root] ?? root;
  const idx = names.indexOf(r);
  if (idx === -1) return name;
  const newRoot = names[((idx + semitones) % 12 + 12) % 12];
  return `${newRoot}${rest}`;
}

/**
 * Real-time pitch detector reading from an AnalyserNode.
 * Call `read()` once per animation frame.
 */
export class LivePitch {
  private analyser: AnalyserNode;
  private sampleRate: number;
  private detector: PitchDetector<Float32Array>;
  private buf: Float32Array<ArrayBuffer>;

  constructor(analyser: AnalyserNode, sampleRate: number, windowSize = 2048) {
    this.analyser = analyser;
    this.sampleRate = sampleRate;
    this.detector = PitchDetector.forFloat32Array(windowSize);
    this.detector.minVolumeDecibels = LIVE_MIN_VOL_DB;
    this.buf = new Float32Array(new ArrayBuffer(windowSize * 4));
  }

  read(): { hz: number; midi: number; clarity: number } {
    this.analyser.getFloatTimeDomainData(this.buf);
    const [hz, clarity] = this.detector.findPitch(this.buf, this.sampleRate);
    const valid = clarity >= LIVE_MIN_CLARITY && hz >= MIN_HZ && hz <= MAX_HZ;
    return {
      hz: valid ? hz : 0,
      midi: valid ? hzToMidi(hz) : 0,
      clarity,
    };
  }
}
