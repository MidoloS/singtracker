// Full-song overview canvas: reference notes + user pitch trace, scrollable
// horizontally, with a playhead that can be driven by the playback engine.

import type { NotesPayload } from './notes';
import type { Sample } from './report';
import { midiToNoteName } from './pitch';

export type OverviewOptions = {
  canvas: HTMLCanvasElement;
  notes: NotesPayload;
  samples: Sample[];
  pxPerSecond?: number;
  toleranceCents?: number;
};

export class OverviewRenderer {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private notes: NotesPayload;
  private samples: Sample[];
  private pxPerSecond: number;
  private dpr = 1;
  private playhead = 0;

  constructor(opts: OverviewOptions) {
    this.canvas = opts.canvas;
    const ctx = this.canvas.getContext('2d');
    if (!ctx) throw new Error('No 2D context');
    this.ctx = ctx;
    this.notes = opts.notes;
    this.samples = opts.samples;
    this.pxPerSecond = opts.pxPerSecond ?? 28;
    this.resize();
  }

  /** Total content width in CSS pixels (used by the scroll container). */
  width(): number {
    return Math.ceil(this.notes.duration * this.pxPerSecond);
  }

  resize() {
    const dpr = window.devicePixelRatio || 1;
    const wCss = this.width();
    const rect = this.canvas.getBoundingClientRect();
    const hCss = Math.max(160, rect.height || 200);
    this.canvas.style.width = `${wCss}px`;
    this.canvas.style.height = `${hCss}px`;
    this.canvas.width = Math.floor(wCss * dpr);
    this.canvas.height = Math.floor(hCss * dpr);
    this.dpr = dpr;
    this.draw();
  }

  setPlayhead(t: number) {
    this.playhead = t;
    this.draw();
  }

  draw() {
    const ctx = this.ctx;
    const dpr = this.dpr;
    const w = this.canvas.width / dpr;
    const h = this.canvas.height / dpr;
    ctx.save();
    ctx.scale(dpr, dpr);

    ctx.fillStyle = '#0b0d10';
    ctx.fillRect(0, 0, w, h);

    // Vertical pitch mapping: cover the full song's midi range with a small pad.
    const lo = (this.notes.midi_min ?? 48) - 2;
    const hi = (this.notes.midi_max ?? 72) + 2;
    const span = Math.max(6, hi - lo);
    const midiToY = (m: number) => h - ((m - lo) / span) * h;
    const timeToX = (t: number) => t * this.pxPerSecond;

    // Octave gridlines.
    ctx.strokeStyle = '#1a1f26';
    ctx.lineWidth = 1;
    ctx.fillStyle = '#4a5562';
    ctx.font = `11px ui-sans-serif, system-ui, sans-serif`;
    ctx.textBaseline = 'middle';
    for (let m = Math.ceil(lo); m <= Math.floor(hi); m++) {
      if (m % 12 !== 0) continue;
      const y = midiToY(m);
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(w, y);
      ctx.stroke();
      ctx.fillText(midiToNoteName(m), 2, y - 7);
    }

    // Reference notes as bars.
    const barH = Math.max(3, h / span - 2);
    for (const n of this.notes.notes) {
      const x = timeToX(n.t);
      const ww = Math.max(2, timeToX(n.t + n.d) - x);
      const y = midiToY(n.midi);
      ctx.fillStyle = 'rgba(59,130,246,0.55)';
      ctx.fillRect(x, y - barH / 2, ww, barH);
    }

    // User pitch trace, octave-folded onto the song's range.
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = '#fbbf24';
    ctx.beginPath();
    let drawing = false;
    for (let i = 0; i < this.samples.length; i++) {
      const s = this.samples[i];
      if (!s.midi) {
        drawing = false;
        continue;
      }
      const folded = foldToRange(s.midi, lo, hi);
      const x = timeToX(s.t);
      const y = midiToY(folded);
      if (!drawing) {
        ctx.moveTo(x, y);
        drawing = true;
      } else {
        const prev = this.samples[i - 1];
        // Break the trace on gaps to avoid drawing across silences.
        if (s.t - prev.t > 0.18) {
          ctx.stroke();
          ctx.beginPath();
          ctx.moveTo(x, y);
        } else {
          ctx.lineTo(x, y);
        }
      }
    }
    ctx.stroke();

    // Playhead.
    if (this.playhead > 0) {
      const x = timeToX(this.playhead);
      ctx.strokeStyle = '#e5e7eb';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, h);
      ctx.stroke();
    }

    ctx.restore();
  }
}

function foldToRange(midi: number, lo: number, hi: number): number {
  const center = (lo + hi) / 2;
  let m = midi;
  while (m - center > (hi - lo) / 2) m -= 12;
  while (center - m > (hi - lo) / 2) m += 12;
  return m;
}
