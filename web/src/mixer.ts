// Mixed playback: instrumental + (original vocals * (1-vocalAtten)) + user voice.
// Lazy-decodes buffers, then drives them from a shared AudioContext clock.

export type MixSources = {
  instrumental: AudioBuffer;
  vocals: AudioBuffer;
  user?: AudioBuffer;
};

async function fetchBuffer(ctx: AudioContext, url: string): Promise<AudioBuffer> {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`fetch ${url} → ${r.status}`);
  const ab = await r.arrayBuffer();
  return ctx.decodeAudioData(ab);
}

async function blobToBuffer(ctx: AudioContext, blob: Blob): Promise<AudioBuffer> {
  const ab = await blob.arrayBuffer();
  return ctx.decodeAudioData(ab);
}

export async function loadSources(
  ctx: AudioContext,
  vocalsUrl: string,
  instrumentalUrl: string,
  userBlob?: Blob,
): Promise<MixSources> {
  const [instrumental, vocals, user] = await Promise.all([
    fetchBuffer(ctx, instrumentalUrl),
    fetchBuffer(ctx, vocalsUrl),
    userBlob ? blobToBuffer(ctx, userBlob).catch(() => undefined) : Promise.resolve(undefined),
  ]);
  return { instrumental, vocals, user };
}

export class Mixer {
  private ctx: AudioContext;
  private sources: MixSources;
  private vocalsGain: GainNode;
  private userGain: GainNode;
  private instGain: GainNode;
  // Active nodes when playing; we tear them down on stop/seek.
  private activeNodes: AudioBufferSourceNode[] = [];
  private startCtxTime = 0;
  private startOffset = 0;
  private _playing = false;

  constructor(ctx: AudioContext, sources: MixSources) {
    this.ctx = ctx;
    this.sources = sources;
    this.instGain = ctx.createGain();
    this.vocalsGain = ctx.createGain();
    this.userGain = ctx.createGain();
    this.instGain.gain.value = 1;
    this.vocalsGain.gain.value = 1;
    this.userGain.gain.value = 1;
    this.instGain.connect(ctx.destination);
    this.vocalsGain.connect(ctx.destination);
    this.userGain.connect(ctx.destination);
  }

  get playing(): boolean {
    return this._playing;
  }

  /** Seconds since the song started, regardless of pause state. */
  currentTime(): number {
    if (!this._playing) return this.startOffset;
    return this.startOffset + (this.ctx.currentTime - this.startCtxTime);
  }

  get duration(): number {
    return this.sources.instrumental.duration;
  }

  /** 0..1 — how much the original vocals are attenuated. 1 = fully removed. */
  setVocalAttenuation(value: number) {
    const clamped = Math.max(0, Math.min(1, value));
    this.vocalsGain.gain.setValueAtTime(1 - clamped, this.ctx.currentTime);
  }

  setUserGain(value: number) {
    this.userGain.gain.setValueAtTime(Math.max(0, value), this.ctx.currentTime);
  }

  play(fromSeconds?: number) {
    if (this._playing) this.stopInternal();
    const offset = Math.max(0, Math.min(this.duration, fromSeconds ?? this.startOffset));
    this.startOffset = offset;
    this.startCtxTime = this.ctx.currentTime;
    this._playing = true;
    this.spawn(this.sources.instrumental, this.instGain, offset);
    this.spawn(this.sources.vocals, this.vocalsGain, offset);
    if (this.sources.user) this.spawn(this.sources.user, this.userGain, offset);
  }

  pause() {
    if (!this._playing) return;
    const at = this.currentTime();
    this.stopInternal();
    this.startOffset = at;
  }

  seek(t: number) {
    const wasPlaying = this._playing;
    this.stopInternal();
    this.startOffset = Math.max(0, Math.min(this.duration, t));
    if (wasPlaying) this.play();
  }

  dispose() {
    this.stopInternal();
    this.instGain.disconnect();
    this.vocalsGain.disconnect();
    this.userGain.disconnect();
  }

  private spawn(buffer: AudioBuffer, gain: GainNode, offset: number) {
    const node = this.ctx.createBufferSource();
    node.buffer = buffer;
    node.connect(gain);
    node.start(0, offset);
    node.onended = () => {
      // Only handle a "natural end" for the longest source.
      if (buffer === this.sources.instrumental && this._playing) {
        this.stopInternal();
        this.startOffset = this.duration;
      }
    };
    this.activeNodes.push(node);
  }

  private stopInternal() {
    for (const n of this.activeNodes) {
      try {
        n.stop();
      } catch {
        // already stopped
      }
      n.disconnect();
    }
    this.activeNodes = [];
    this._playing = false;
  }
}
