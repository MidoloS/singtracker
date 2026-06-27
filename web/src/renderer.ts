import type { Note, NotesPayload } from './notes';
import { midiToNoteName } from './pitch';

export type UserSample = { t: number; midi: number };

export type RendererOptions = {
  canvas: HTMLCanvasElement;
  notes: NotesPayload;
  /** Seconds shown to the LEFT of the "now" line (past). */
  pastSeconds?: number;
  /** Seconds shown to the RIGHT of the "now" line (upcoming). */
  futureSeconds?: number;
  /** Semitones of vertical window centered on the active reference note. */
  semitoneWindow?: number;
  /** ±cents counted as "in tune". Generous in live; tight analysis happens later. */
  toleranceCents?: number;
};

const NOW_X_RATIO = 0.28;

export class LaneRenderer {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private opts: Required<Omit<RendererOptions, 'canvas' | 'notes'>> & {
    canvas: HTMLCanvasElement;
    notes: NotesPayload;
  };
  private userHistory: UserSample[] = [];
  private dpr = 1;
  private currentCenter = 60;
  private lastInTune = false;

  constructor(options: RendererOptions) {
    this.canvas = options.canvas;
    const filled = {
      pastSeconds: 1.2,
      futureSeconds: 3,
      semitoneWindow: 18,
      toleranceCents: 75,
      ...options,
    };
    this.opts = filled as typeof this.opts;
    const ctx = options.canvas.getContext('2d');
    if (!ctx) throw new Error('No 2D context');
    this.ctx = ctx;
    // Reasonable starting center.
    const ns = options.notes.notes;
    if (ns.length) this.currentCenter = ns[0].midi;
    this.resize();
    window.addEventListener('resize', () => this.resize());
  }

  private resize() {
    const c = this.canvas;
    const dpr = window.devicePixelRatio || 1;
    const rect = c.getBoundingClientRect();
    c.width = Math.max(1, Math.floor(rect.width * dpr));
    c.height = Math.max(1, Math.floor(rect.height * dpr));
    this.dpr = dpr;
  }

  pushUserSample(s: UserSample) {
    this.userHistory.push(s);
    const cutoff = s.t - this.opts.pastSeconds - 0.5;
    while (this.userHistory.length && this.userHistory[0].t < cutoff) {
      this.userHistory.shift();
    }
  }

  /** Find the active or upcoming note around time `t`. */
  private activeNote(t: number): Note | undefined {
    const ns = this.opts.notes.notes;
    if (!ns.length) return;
    // Active note covers t.
    for (let i = 0; i < ns.length; i++) {
      const n = ns[i];
      if (t >= n.t && t < n.t + n.d) return n;
      if (n.t > t) return n; // next upcoming
    }
    return ns[ns.length - 1];
  }

  draw(nowT: number, liveMidi: number, liveClarity: number) {
    const { ctx, dpr } = this;
    const w = this.canvas.width / dpr;
    const h = this.canvas.height / dpr;
    ctx.save();
    ctx.scale(dpr, dpr);

    ctx.fillStyle = '#0b0d10';
    ctx.fillRect(0, 0, w, h);

    // Smoothly track the active note's pitch as the vertical center.
    const active = this.activeNote(nowT);
    const targetCenter = active ? active.midi : this.currentCenter;
    this.currentCenter += (targetCenter - this.currentCenter) * 0.08;
    const halfWin = this.opts.semitoneWindow / 2;
    const midiToY = (m: number) => {
      const norm = (m - (this.currentCenter - halfWin)) / this.opts.semitoneWindow;
      return h - norm * h;
    };

    const nowX = w * NOW_X_RATIO;
    const pxPerSec = (w - nowX) / this.opts.futureSeconds;
    const timeToX = (t: number) => nowX + (t - nowT) * pxPerSec;

    // Semitone grid + octave labels.
    ctx.strokeStyle = '#1a1f26';
    ctx.lineWidth = 1;
    ctx.font = `11px ui-sans-serif, system-ui, sans-serif`;
    ctx.textBaseline = 'middle';
    const topM = Math.ceil(this.currentCenter + halfWin);
    const botM = Math.floor(this.currentCenter - halfWin);
    for (let m = botM; m <= topM; m++) {
      const y = midiToY(m);
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(w, y);
      ctx.stroke();
      if (m % 12 === 0) {
        ctx.fillStyle = '#4a5562';
        ctx.fillText(midiToNoteName(m), 4, y - 8);
      }
    }

    // Notes in window, drawn as horizontal bars.
    const tStart = nowT - this.opts.pastSeconds;
    const tEnd = nowT + this.opts.futureSeconds;
    const barHeight = Math.max(8, h / this.opts.semitoneWindow - 4);
    for (const n of this.opts.notes.notes) {
      const a = n.t;
      const b = n.t + n.d;
      if (b < tStart) continue;
      if (a > tEnd) break;
      const x1 = timeToX(Math.max(a, tStart));
      const x2 = timeToX(Math.min(b, tEnd));
      const y = midiToY(n.midi);
      const isActive = nowT >= a && nowT < b;
      const isPast = b < nowT;
      ctx.fillStyle = isActive ? '#22d3ee' : isPast ? 'rgba(59,130,246,0.3)' : '#3b82f6';
      roundRect(ctx, x1, y - barHeight / 2, Math.max(2, x2 - x1), barHeight, 4);
      ctx.fill();
    }

    // User pitch trace (octave-folded onto the active note's octave).
    if (this.userHistory.length) {
      ctx.lineWidth = 3;
      ctx.strokeStyle = '#fbbf24';
      ctx.beginPath();
      let drawing = false;
      for (const s of this.userHistory) {
        if (!s.midi) {
          drawing = false;
          continue;
        }
        const folded = foldToOctaveOf(s.midi, this.currentCenter);
        const x = timeToX(s.t);
        const y = midiToY(folded);
        if (x > nowX + 1) break;
        if (!drawing) {
          ctx.moveTo(x, y);
          drawing = true;
        } else {
          ctx.lineTo(x, y);
        }
      }
      ctx.stroke();
    }

    // "Now" line.
    ctx.strokeStyle = '#e5e7eb';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(nowX, 0);
    ctx.lineTo(nowX, h);
    ctx.stroke();

    // Live cursor at the now line.
    if (liveMidi) {
      const folded = foldToOctaveOf(liveMidi, this.currentCenter);
      let inTune = false;
      if (active) {
        const diffCents = (folded - active.midi) * 100;
        inTune = Math.abs(diffCents) <= this.opts.toleranceCents;
      }
      this.lastInTune = inTune;
      const y = midiToY(folded);
      ctx.fillStyle = inTune ? '#22c55e' : '#ef4444';
      ctx.beginPath();
      ctx.arc(nowX, y, 8 + Math.min(6, liveClarity * 6), 0, Math.PI * 2);
      ctx.fill();
      if (inTune) {
        ctx.strokeStyle = 'rgba(34,197,94,0.35)';
        ctx.lineWidth = 3;
        ctx.beginPath();
        ctx.arc(nowX, y, 18, 0, Math.PI * 2);
        ctx.stroke();
      }
    }

    // HUD.
    ctx.textBaseline = 'top';
    ctx.font = `600 13px ui-sans-serif, system-ui, sans-serif`;
    if (active) {
      ctx.fillStyle = '#9ca3af';
      ctx.fillText(`objetivo: ${midiToNoteName(active.midi)}`, 10, 8);
    }
    if (liveMidi) {
      ctx.fillStyle = this.lastInTune ? '#22c55e' : '#ef4444';
      ctx.fillText(`vos: ${midiToNoteName(liveMidi)}`, 10, 26);
    }

    ctx.restore();
  }
}

/** Move `midi` to the octave nearest `center`. Octave-invariant comparison. */
function foldToOctaveOf(midi: number, center: number): number {
  let m = midi;
  while (m - center > 6) m -= 12;
  while (center - m > 6) m += 12;
  return m;
}

function roundRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
) {
  const rr = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.lineTo(x + w - rr, y);
  ctx.arcTo(x + w, y, x + w, y + rr, rr);
  ctx.lineTo(x + w, y + h - rr);
  ctx.arcTo(x + w, y + h, x + w - rr, y + h, rr);
  ctx.lineTo(x + rr, y + h);
  ctx.arcTo(x, y + h, x, y + h - rr, rr);
  ctx.lineTo(x, y + rr);
  ctx.arcTo(x, y, x + rr, y, rr);
  ctx.closePath();
}
