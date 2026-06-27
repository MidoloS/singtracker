import { useEffect, useRef, useState } from 'preact/hooks';
import './app.css';
import { LivePitch } from './pitch';
import { LaneRenderer } from './renderer';
import { submitFile, waitForJob, audioUrl, type NotesPayload } from './notes';
import { computeReport, type Report, type Sample } from './report';
import { OverviewRenderer } from './overview';
import { loadSources, Mixer } from './mixer';
import { saveSession } from './history';
import { HistoryView } from './historyView';

type Stage =
  | { kind: 'idle' }
  | { kind: 'uploading'; fileName: string }
  | { kind: 'processing'; fileName: string; phase: string }
  | {
      kind: 'ready';
      fileName: string;
      buffer: AudioBuffer;
      notes: NotesPayload;
      audioHash?: string;
    }
  | {
      kind: 'playing';
      fileName: string;
      buffer: AudioBuffer;
      notes: NotesPayload;
      audioHash?: string;
    }
  | {
      kind: 'done';
      fileName: string;
      buffer: AudioBuffer;
      notes: NotesPayload;
      audioHash?: string;
      report: Report;
      samples: Sample[];
      userBlob?: Blob;
    };

async function decodeFile(file: File): Promise<AudioBuffer> {
  const buf = await file.arrayBuffer();
  const ctx = new OfflineAudioContext(1, 1, 44100);
  return ctx.decodeAudioData(buf);
}

export function App() {
  const [view, setView] = useState<'practice' | 'history'>('practice');
  const [stage, setStage] = useState<Stage>({ kind: 'idle' });
  const [error, setError] = useState<string | null>(null);

  async function handleFile(file: File) {
    setError(null);
    setStage({ kind: 'uploading', fileName: file.name });
    try {
      const [jobId, buffer] = await Promise.all([submitFile(file), decodeFile(file)]);
      setStage({ kind: 'processing', fileName: file.name, phase: 'queued' });
      const { notes, audioHash } = await waitForJob(jobId, (phase) => {
        setStage({ kind: 'processing', fileName: file.name, phase });
      });
      setStage({ kind: 'ready', fileName: file.name, buffer, notes, audioHash });
    } catch (e: any) {
      console.error(e);
      setError(e?.message ?? 'No se pudo procesar el archivo');
      setStage({ kind: 'idle' });
    }
  }

  return (
    <div class="app">
      <header class="hdr">
        <h1>singimprove · local</h1>
        <span class="sub">server local + Demucs en :8765</span>
        <nav class="tabs">
          <button
            class={view === 'practice' ? 'tab active' : 'tab'}
            onClick={() => setView('practice')}
          >
            Practicar
          </button>
          <button
            class={view === 'history' ? 'tab active' : 'tab'}
            onClick={() => setView('history')}
          >
            Historial
          </button>
        </nav>
      </header>

      {view === 'history' ? (
        <HistoryView />
      ) : (
        <PracticeView
          stage={stage}
          setStage={setStage}
          error={error}
          handleFile={handleFile}
        />
      )}
    </div>
  );
}

function PracticeView({
  stage,
  setStage,
  error,
  handleFile,
}: {
  stage: Stage;
  setStage: (s: Stage) => void;
  error: string | null;
  handleFile: (f: File) => void;
}) {
  return (
    <>
      {error && <div class="err">{error}</div>}

      {stage.kind === 'idle' && <Uploader onFile={handleFile} />}

      {stage.kind === 'uploading' && (
        <Card title="Subiendo…" sub={stage.fileName}>
          <div class="bar indeterminate" />
        </Card>
      )}

      {stage.kind === 'processing' && (
        <Card title="Procesando en el server" sub={`${stage.fileName} · ${stage.phase}`}>
          <div class="bar indeterminate" />
          <p class="hint">
            Demucs separa la voz del resto. Tarda 1-4 min según la duración y CPU.
            La próxima vez que subas la misma canción es instantáneo (cache).
          </p>
        </Card>
      )}

      {stage.kind === 'ready' && (
        <Ready
          fileName={stage.fileName}
          notes={stage.notes}
          onStart={() =>
            setStage({
              kind: 'playing',
              fileName: stage.fileName,
              buffer: stage.buffer,
              notes: stage.notes,
              audioHash: stage.audioHash,
            })
          }
          onReset={() => setStage({ kind: 'idle' })}
        />
      )}

      {stage.kind === 'playing' && (
        <LiveView
          buffer={stage.buffer}
          notes={stage.notes}
          onStop={(samples, elapsed, userBlob) => {
            const report = computeReport(samples, stage.notes, elapsed);
            setStage({
              kind: 'done',
              fileName: stage.fileName,
              buffer: stage.buffer,
              notes: stage.notes,
              audioHash: stage.audioHash,
              report,
              samples,
              userBlob,
            });
          }}
        />
      )}

      {stage.kind === 'done' && (
        <Done
          fileName={stage.fileName}
          notes={stage.notes}
          report={stage.report}
          samples={stage.samples}
          userBlob={stage.userBlob}
          audioHash={stage.audioHash}
          onAgain={() =>
            setStage({
              kind: 'playing',
              fileName: stage.fileName,
              buffer: stage.buffer,
              notes: stage.notes,
              audioHash: stage.audioHash,
            })
          }
          onReset={() => setStage({ kind: 'idle' })}
        />
      )}
    </>
  );
}

function Card(props: { title: string; sub?: string; children?: any }) {
  return (
    <div class="card">
      <div class="card-title">{props.title}</div>
      {props.sub && <div class="card-sub">{props.sub}</div>}
      {props.children}
    </div>
  );
}

function Uploader({ onFile }: { onFile: (f: File) => void }) {
  const [hover, setHover] = useState(false);
  return (
    <label
      class={`drop ${hover ? 'hover' : ''}`}
      onDragOver={(e) => {
        e.preventDefault();
        setHover(true);
      }}
      onDragLeave={() => setHover(false)}
      onDrop={(e) => {
        e.preventDefault();
        setHover(false);
        const f = e.dataTransfer?.files?.[0];
        if (f) onFile(f);
      }}
    >
      <div class="drop-title">Subí un MP3</div>
      <div class="drop-sub">o arrastralo acá</div>
      <input
        type="file"
        accept="audio/mpeg,audio/mp3,audio/*"
        onChange={(e) => {
          const f = (e.currentTarget as HTMLInputElement).files?.[0];
          if (f) onFile(f);
        }}
      />
    </label>
  );
}

function Ready({
  fileName,
  notes,
  onStart,
  onReset,
}: {
  fileName: string;
  notes: NotesPayload;
  onStart: () => void;
  onReset: () => void;
}) {
  return (
    <div class="card">
      <div class="card-title">Listo para cantar</div>
      <div class="card-sub">
        {fileName} · {notes.notes.length} notas · {notes.duration.toFixed(1)}s · tonalidad{' '}
        {notes.key?.name ?? '?'}
      </div>
      <div class="row">
        <button class="primary" onClick={onStart}>
          Empezar
        </button>
        <button class="ghost" onClick={onReset}>
          Otra canción
        </button>
      </div>
      <p class="hint">
        Te va a pedir permiso de micrófono. Usá auriculares para que la canción
        no se cuele en el mic.
      </p>
    </div>
  );
}

function LiveView({
  buffer,
  notes,
  onStop,
}: {
  buffer: AudioBuffer;
  notes: NotesPayload;
  onStop: (samples: Sample[], elapsed: number, userBlob?: Blob) => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [status, setStatus] = useState<string>('preparando…');
  // Live data lives in refs so the cleanup function can read them at unmount
  // time without racing the React render cycle.
  const samplesRef = useRef<Sample[]>([]);
  const elapsedRef = useRef<number>(0);
  const stoppedRef = useRef<boolean>(false);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const recordedChunksRef = useRef<Blob[]>([]);

  function finish() {
    if (stoppedRef.current) return;
    stoppedRef.current = true;
    const rec = recorderRef.current;
    if (rec && rec.state !== 'inactive') {
      // Wait for the final dataavailable before resolving.
      rec.addEventListener(
        'stop',
        () => {
          const blob = recordedChunksRef.current.length
            ? new Blob(recordedChunksRef.current, { type: rec.mimeType || 'audio/webm' })
            : undefined;
          onStop(samplesRef.current, elapsedRef.current, blob);
        },
        { once: true },
      );
      rec.stop();
    } else {
      onStop(samplesRef.current, elapsedRef.current);
    }
  }

  useEffect(() => {
    let canceled = false;
    let raf = 0;
    let audioCtx: AudioContext | null = null;
    let micStream: MediaStream | null = null;
    let source: AudioBufferSourceNode | null = null;
    let renderer: LaneRenderer | null = null;
    let livePitch: LivePitch | null = null;
    let startTime = 0;

    (async () => {
      try {
        audioCtx = new AudioContext();

        setStatus('pidiendo micrófono…');
        micStream = await navigator.mediaDevices.getUserMedia({
          audio: {
            echoCancellation: false,
            noiseSuppression: false,
            autoGainControl: false,
          },
        });
        if (canceled) return;
        const micSrc = audioCtx.createMediaStreamSource(micStream);
        const analyser = audioCtx.createAnalyser();
        analyser.fftSize = 2048;
        micSrc.connect(analyser);
        livePitch = new LivePitch(analyser, audioCtx.sampleRate);

        // Record the raw mic stream so we can replay the user's take in the report.
        try {
          const mime = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
            ? 'audio/webm;codecs=opus'
            : MediaRecorder.isTypeSupported('audio/webm')
              ? 'audio/webm'
              : '';
          const rec = mime ? new MediaRecorder(micStream, { mimeType: mime }) : new MediaRecorder(micStream);
          rec.ondataavailable = (e) => {
            if (e.data && e.data.size) recordedChunksRef.current.push(e.data);
          };
          recorderRef.current = rec;
        } catch (e) {
          console.warn('MediaRecorder no disponible:', e);
        }

        if (!canvasRef.current) throw new Error('Canvas no disponible');
        renderer = new LaneRenderer({ canvas: canvasRef.current, notes });

        for (let i = 3; i > 0; i--) {
          if (canceled) return;
          setStatus(`${i}…`);
          // eslint-disable-next-line no-await-in-loop
          await new Promise((r) => setTimeout(r, 700));
        }
        setStatus('cantá!');

        source = audioCtx.createBufferSource();
        source.buffer = buffer;
        source.connect(audioCtx.destination);
        startTime = audioCtx.currentTime + 0.05;
        source.start(startTime);
        recorderRef.current?.start();
        source.onended = () => {
          if (!canceled) finish();
        };

        const loop = () => {
          if (canceled || !audioCtx || !renderer || !livePitch) return;
          const t = audioCtx.currentTime - startTime;
          elapsedRef.current = t;
          const { hz, midi, clarity } = livePitch.read();
          if (midi) {
            samplesRef.current.push({ t, midi });
            renderer.pushUserSample({ t, midi });
          }
          renderer.draw(t, midi, clarity);
          if (hz) setStatus(`${hz.toFixed(1)} Hz`);
          raf = requestAnimationFrame(loop);
        };
        raf = requestAnimationFrame(loop);
      } catch (e: any) {
        console.error(e);
        setStatus(`error: ${e?.message ?? e}`);
      }
    })();

    return () => {
      canceled = true;
      cancelAnimationFrame(raf);
      try {
        source?.stop();
      } catch {
        // source may not have started yet
      }
      micStream?.getTracks().forEach((t) => t.stop());
      audioCtx?.close();
    };
  }, [buffer, notes]);

  return (
    <div class="live">
      <div class="live-bar">
        <span class="status">{status}</span>
        <button class="ghost" onClick={finish}>
          Cortar
        </button>
      </div>
      <canvas ref={canvasRef} class="lane" />
      <p class="hint">
        Barras = melodía a cantar. Punto = tu voz (verde = afinado, rojo = fuera).
        Comparación octava-invariante.
      </p>
    </div>
  );
}

function Done({
  fileName,
  notes,
  report,
  samples,
  userBlob,
  audioHash,
  onAgain,
  onReset,
}: {
  fileName: string;
  notes: NotesPayload;
  report: Report;
  samples: Sample[];
  userBlob?: Blob;
  audioHash?: string;
  onAgain: () => void;
  onReset: () => void;
}) {
  const mm = Math.floor(report.elapsed / 60);
  const ss = Math.floor(report.elapsed % 60)
    .toString()
    .padStart(2, '0');
  const [saveState, setSaveState] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  const [saveError, setSaveError] = useState<string>('');

  // Save the session to SQLite once when this view appears. The effect deps
  // are stable for the lifetime of the Done stage.
  useEffect(() => {
    let canceled = false;
    setSaveState('saving');
    saveSession(report, {
      file_name: fileName,
      audio_hash: audioHash,
      song_duration: notes.duration,
      song_key: notes.key?.name ?? null,
    })
      .then(() => {
        if (!canceled) setSaveState('saved');
      })
      .catch((e) => {
        if (canceled) return;
        setSaveError(e?.message ?? 'error');
        setSaveState('error');
      });
    return () => {
      canceled = true;
    };
  }, []);

  return (
    <div class="card report">
      <div class="card-title">
        Reporte
        <span class={`save-pill ${saveState}`}>
          {saveState === 'saving' && 'guardando…'}
          {saveState === 'saved' && '✓ guardado en historial'}
          {saveState === 'error' && `× no se guardó (${saveError})`}
        </span>
      </div>
      <div class="card-sub">
        {fileName} · {mm}:{ss} de canto · tonalidad {notes.key?.name ?? '?'}
      </div>

      {report.thin && (
        <div class="hint thin">
          Muy poco material para sacar conclusiones firmes (cortaste muy temprano
          o no se detectó tu voz). Las cifras de abajo igualmente reflejan lo que
          se midió.
        </div>
      )}

      <div class="stats">
        <Stat
          label="Afinación"
          value={`${report.accuracyPct.toFixed(0)}%`}
          sub={`${report.hit}/${report.notesInWindow} notas dentro de ±50¢`}
          tone={
            report.accuracyPct >= 60
              ? 'good'
              : report.accuracyPct >= 30
                ? 'warn'
                : 'bad'
          }
        />
        <Stat
          label="Error mediano"
          value={
            report.medianCents === null
              ? '—'
              : `${report.medianCents > 0 ? '+' : ''}${report.medianCents.toFixed(0)}¢`
          }
          sub={
            report.tendency === 'alto'
              ? 'tirás alto (sostenido)'
              : report.tendency === 'bajo'
                ? 'tirás bajo (calado)'
                : report.tendency === 'centrado'
                  ? 'centrado'
                  : 'sin datos'
          }
        />
      </div>

      <div class="range">
        <div class="range-title">Rango vocal</div>
        <div class="range-grid">
          <Stat
            label="Techo sostenido"
            value={report.topSustainedName ?? '—'}
            sub={
              report.topSustainedMidi !== null
                ? 'lo más alto que mantuviste'
                : 'no se detectó nada ≥0.4s'
            }
            tone={report.topSustainedMidi !== null ? 'good' : undefined}
          />
          <Stat
            label="Piso sostenido"
            value={report.bottomSustainedName ?? '—'}
            sub={
              report.bottomSustainedMidi !== null
                ? 'lo más bajo que mantuviste'
                : '—'
            }
          />
          <Stat
            label="Extensión total"
            value={
              report.totalLowName && report.totalHighName
                ? `${report.totalLowName} – ${report.totalHighName}`
                : '—'
            }
            sub={
              report.totalRangeSemitones !== null
                ? `${report.totalRangeSemitones} semitonos (${(
                    report.totalRangeSemitones / 12
                  ).toFixed(1)} oct)`
                : 'sin datos'
            }
          />
        </div>
      </div>

      <Playback notes={notes} samples={samples} userBlob={userBlob} audioHash={audioHash} />

      <div class="row">
        <button class="primary" onClick={onAgain}>
          Otra vez
        </button>
        <button class="ghost" onClick={onReset}>
          Otra canción
        </button>
      </div>

      <p class="hint">
        Reporte rápido y local (octava-invariante). El análisis fino (vibrato,
        dinámica, tiempo) corre sobre la grabación completa server-side — no está
        cableado todavía.
      </p>
    </div>
  );
}

function Playback({
  notes,
  samples,
  userBlob,
  audioHash,
}: {
  notes: NotesPayload;
  samples: Sample[];
  userBlob?: Blob;
  audioHash?: string;
}) {
  const overviewCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const overviewRef = useRef<OverviewRenderer | null>(null);
  const scrollerRef = useRef<HTMLDivElement | null>(null);
  const mixerRef = useRef<Mixer | null>(null);
  const ctxRef = useRef<AudioContext | null>(null);
  const rafRef = useRef<number>(0);

  const [loadState, setLoadState] = useState<'idle' | 'loading' | 'ready' | 'error'>(
    audioHash ? 'idle' : 'error',
  );
  const [loadError, setLoadError] = useState<string>('');
  const [playing, setPlaying] = useState(false);
  const [position, setPosition] = useState(0);
  const [vocalAtten, setVocalAtten] = useState(0.7);
  const [userGain, setUserGain] = useState(1);
  const [hasUser, setHasUser] = useState(false);

  // Init the overview canvas.
  useEffect(() => {
    if (!overviewCanvasRef.current) return;
    const ov = new OverviewRenderer({
      canvas: overviewCanvasRef.current,
      notes,
      samples,
    });
    overviewRef.current = ov;
    return () => {
      overviewRef.current = null;
    };
  }, [notes, samples]);

  // Lazy-load + decode the audio sources when the user requests playback.
  async function ensureLoaded(): Promise<Mixer | null> {
    if (mixerRef.current) return mixerRef.current;
    if (!audioHash) {
      setLoadState('error');
      setLoadError('Sin stems disponibles para esta canción.');
      return null;
    }
    try {
      setLoadState('loading');
      const ctx = new AudioContext();
      ctxRef.current = ctx;
      const sources = await loadSources(
        ctx,
        audioUrl(audioHash, 'vocals'),
        audioUrl(audioHash, 'instrumental'),
        userBlob,
      );
      const mixer = new Mixer(ctx, sources);
      mixer.setVocalAttenuation(vocalAtten);
      mixer.setUserGain(userGain);
      mixerRef.current = mixer;
      setHasUser(!!sources.user);
      setLoadState('ready');
      return mixer;
    } catch (e: any) {
      console.error(e);
      setLoadError(e?.message ?? 'error cargando audio');
      setLoadState('error');
      return null;
    }
  }

  async function toggle() {
    const mixer = await ensureLoaded();
    if (!mixer) return;
    if (mixer.playing) {
      mixer.pause();
      setPlaying(false);
      cancelAnimationFrame(rafRef.current);
    } else {
      mixer.play();
      setPlaying(true);
      const tick = () => {
        const m = mixerRef.current;
        if (!m) return;
        const t = m.currentTime();
        setPosition(t);
        overviewRef.current?.setPlayhead(t);
        // Auto-scroll the overview so the playhead stays in view.
        const sc = scrollerRef.current;
        if (sc && overviewRef.current) {
          const pxPerSec = overviewRef.current.width() / m.duration;
          const x = t * pxPerSec;
          if (x < sc.scrollLeft + 80 || x > sc.scrollLeft + sc.clientWidth - 80) {
            sc.scrollLeft = Math.max(0, x - sc.clientWidth * 0.3);
          }
        }
        if (m.playing) {
          rafRef.current = requestAnimationFrame(tick);
        } else {
          setPlaying(false);
        }
      };
      rafRef.current = requestAnimationFrame(tick);
    }
  }

  function onVocalAttenChange(v: number) {
    setVocalAtten(v);
    mixerRef.current?.setVocalAttenuation(v);
  }
  function onUserGainChange(v: number) {
    setUserGain(v);
    mixerRef.current?.setUserGain(v);
  }

  function onScrub(e: Event) {
    const m = mixerRef.current;
    if (!m) return;
    const target = e.currentTarget as HTMLInputElement;
    const t = parseFloat(target.value);
    m.seek(t);
    setPosition(t);
    overviewRef.current?.setPlayhead(t);
  }

  // Cleanup on unmount.
  useEffect(() => {
    return () => {
      cancelAnimationFrame(rafRef.current);
      mixerRef.current?.dispose();
      ctxRef.current?.close();
    };
  }, []);

  const duration = notes.duration;
  const mm = (s: number) =>
    `${Math.floor(s / 60)}:${Math.floor(s % 60).toString().padStart(2, '0')}`;

  return (
    <div class="playback">
      <div class="playback-head">
        <div class="card-sub">
          Tu performance
          {audioHash && (
            <span class="hint" style={{ marginLeft: 8 }}>
              hash {audioHash.slice(0, 6)}…
            </span>
          )}
        </div>
        {loadState === 'error' && audioHash && (
          <span class="hint thin">audio: {loadError}</span>
        )}
        {!audioHash && (
          <span class="hint thin">
            sin audio_hash → hard-reload (Ctrl+Shift+R) y volvé a subir la canción
          </span>
        )}
      </div>

      <div ref={scrollerRef} class="overview-scroll">
        <canvas ref={overviewCanvasRef} class="overview-canvas" />
      </div>

      {audioHash && (
        <>
          <div class="player-row">
            <button class="primary" onClick={toggle} disabled={loadState === 'loading'}>
              {loadState === 'loading' ? 'cargando…' : playing ? 'Pausa' : 'Escuchar'}
            </button>
            <input
              type="range"
              class="scrub"
              min={0}
              max={duration}
              step={0.05}
              value={position}
              onInput={onScrub}
              disabled={loadState !== 'ready'}
            />
            <span class="time">
              {mm(position)} / {mm(duration)}
            </span>
          </div>

          <div class="sliders">
            <label class="slider">
              <div class="slider-head">
                <span>Bajar voz del artista</span>
                <span class="time">{Math.round(vocalAtten * 100)}%</span>
              </div>
              <input
                type="range"
                min={0}
                max={1}
                step={0.01}
                value={vocalAtten}
                onInput={(e) =>
                  onVocalAttenChange(parseFloat((e.currentTarget as HTMLInputElement).value))
                }
              />
            </label>
            <label class={`slider ${hasUser ? '' : 'disabled'}`}>
              <div class="slider-head">
                <span>Volumen tu voz</span>
                <span class="time">{Math.round(userGain * 100)}%</span>
              </div>
              <input
                type="range"
                min={0}
                max={2}
                step={0.01}
                value={userGain}
                disabled={!hasUser && loadState === 'ready'}
                onInput={(e) =>
                  onUserGainChange(parseFloat((e.currentTarget as HTMLInputElement).value))
                }
              />
            </label>
          </div>
        </>
      )}
    </div>
  );
}

function Stat({
  label,
  value,
  sub,
  tone,
}: {
  label: string;
  value: string;
  sub?: string;
  tone?: 'good' | 'warn' | 'bad';
}) {
  return (
    <div class={`stat ${tone ?? ''}`}>
      <div class="stat-label">{label}</div>
      <div class="stat-value">{value}</div>
      {sub && <div class="stat-sub">{sub}</div>}
    </div>
  );
}
