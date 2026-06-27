import { useEffect, useMemo, useState } from 'preact/hooks';
import {
  generalStats,
  knownSongs,
  listSessions,
  songStats,
  type DateRange,
  type GeneralStats,
  type KnownSong,
  type SessionRow,
  type SongStats,
} from './history';
import { midiToNoteName } from './pitch';

type Panel = 'general' | 'song';

export function HistoryView() {
  const [panel, setPanel] = useState<Panel>('general');
  const [range, setRange] = useState<DateRange>({});

  return (
    <div class="history">
      <div class="history-controls">
        <div class="panel-tabs">
          <button
            class={`tab ${panel === 'general' ? 'active' : ''}`}
            onClick={() => setPanel('general')}
          >
            General
          </button>
          <button
            class={`tab ${panel === 'song' ? 'active' : ''}`}
            onClick={() => setPanel('song')}
          >
            Por canción
          </button>
        </div>
        <DateRangeControls range={range} onChange={setRange} />
      </div>

      {panel === 'general' ? (
        <GeneralPanel range={range} />
      ) : (
        <SongPanel range={range} />
      )}
    </div>
  );
}

function DateRangeControls({
  range,
  onChange,
}: {
  range: DateRange;
  onChange: (r: DateRange) => void;
}) {
  const presets: Array<[string, () => DateRange]> = [
    ['Todo', () => ({})],
    ['7 días', () => ({ from: daysAgo(7) })],
    ['30 días', () => ({ from: daysAgo(30) })],
    ['90 días', () => ({ from: daysAgo(90) })],
  ];
  return (
    <div class="date-range">
      <label class="date-input">
        Desde
        <input
          type="date"
          value={range.from ?? ''}
          onInput={(e) =>
            onChange({ ...range, from: (e.currentTarget as HTMLInputElement).value || undefined })
          }
        />
      </label>
      <label class="date-input">
        Hasta
        <input
          type="date"
          value={range.to ?? ''}
          onInput={(e) =>
            onChange({ ...range, to: (e.currentTarget as HTMLInputElement).value || undefined })
          }
        />
      </label>
      <div class="presets">
        {presets.map(([label, build]) => (
          <button class="preset" onClick={() => onChange(build())}>
            {label}
          </button>
        ))}
      </div>
    </div>
  );
}

function daysAgo(n: number): string {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.toISOString().slice(0, 10);
}

// ---- General panel ---------------------------------------------------------

function GeneralPanel({ range }: { range: DateRange }) {
  const [stats, setStats] = useState<GeneralStats | null>(null);
  const [sessions, setSessions] = useState<SessionRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>('');
  const key = `${range.from ?? ''}|${range.to ?? ''}`;

  useEffect(() => {
    let canceled = false;
    setLoading(true);
    setError('');
    Promise.all([generalStats(range), listSessions(range)])
      .then(([s, l]) => {
        if (canceled) return;
        setStats(s);
        setSessions(l);
        setLoading(false);
      })
      .catch((e) => {
        if (canceled) return;
        setError(e?.message ?? 'error');
        setLoading(false);
      });
    return () => {
      canceled = true;
    };
  }, [key]);

  if (loading) return <div class="card">Cargando…</div>;
  if (error) return <div class="err">{error}</div>;
  if (!stats || stats.sessions === 0)
    return (
      <div class="card">
        <div class="card-title">Sin sesiones todavía</div>
        <div class="card-sub">Cantá una canción y volvé acá.</div>
      </div>
    );

  return (
    <div class="card report">
      <div class="card-title">Resumen general</div>
      <div class="stats">
        <StatCell label="Sesiones" value={String(stats.sessions)} />
        <StatCell label="Canciones únicas" value={String(stats.unique_songs)} />
        <StatCell label="Tiempo total" value={formatDuration(stats.total_seconds_sung)} />
        <StatCell
          label="Afinación promedio"
          value={stats.avg_accuracy != null ? `${stats.avg_accuracy.toFixed(0)}%` : '—'}
          tone={
            stats.avg_accuracy != null && stats.avg_accuracy >= 60
              ? 'good'
              : stats.avg_accuracy != null && stats.avg_accuracy >= 30
                ? 'warn'
                : 'bad'
          }
        />
      </div>

      <div class="range">
        <div class="range-title">Rango histórico (en todas las sesiones)</div>
        <div class="range-grid">
          <StatCell
            label="Techo sostenido"
            value={stats.best_top_sustained != null ? midiToNoteName(stats.best_top_sustained) : '—'}
            tone={stats.best_top_sustained != null ? 'good' : undefined}
          />
          <StatCell
            label="Piso sostenido"
            value={
              stats.best_bottom_sustained != null
                ? midiToNoteName(stats.best_bottom_sustained)
                : '—'
            }
          />
          <StatCell
            label="Más alto tocado"
            value={stats.highest_touched != null ? midiToNoteName(stats.highest_touched) : '—'}
          />
        </div>
      </div>

      <Sparkline
        title="Afinación por sesión"
        points={stats.timeline.map((p) => ({ x: p.created_at, y: p.accuracy_pct }))}
        unit="%"
      />
      <Sparkline
        title="Techo sostenido por sesión"
        points={stats.timeline
          .filter((p) => p.top_sustained_midi != null)
          .map((p) => ({ x: p.created_at, y: p.top_sustained_midi as number }))}
        unit="MIDI"
        formatY={(v) => `${midiToNoteName(Math.round(v))} (${v})`}
      />

      <div class="range-title" style={{ marginTop: 8 }}>
        Sesiones ({sessions.length})
      </div>
      <SessionTable rows={sessions} />
    </div>
  );
}

// ---- Per-song panel --------------------------------------------------------

function SongPanel({ range }: { range: DateRange }) {
  const [songs, setSongs] = useState<KnownSong[]>([]);
  const [hash, setHash] = useState<string>('');
  const [stats, setStats] = useState<SongStats | null>(null);
  const [sessions, setSessions] = useState<SessionRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    let canceled = false;
    knownSongs()
      .then((ss) => {
        if (canceled) return;
        setSongs(ss);
        if (ss.length && !hash) setHash(ss[0].audio_hash);
        if (!ss.length) setLoading(false);
      })
      .catch((e) => {
        if (canceled) return;
        setError(e?.message ?? 'error');
        setLoading(false);
      });
    return () => {
      canceled = true;
    };
  }, []);

  const key = `${hash}|${range.from ?? ''}|${range.to ?? ''}`;
  useEffect(() => {
    if (!hash) return;
    let canceled = false;
    setLoading(true);
    Promise.all([
      songStats(hash, range),
      listSessions({ ...range, hash }),
    ])
      .then(([s, l]) => {
        if (canceled) return;
        setStats(s);
        setSessions(l);
        setLoading(false);
      })
      .catch((e) => {
        if (canceled) return;
        setError(e?.message ?? 'error');
        setLoading(false);
      });
    return () => {
      canceled = true;
    };
  }, [key]);

  if (!songs.length)
    return (
      <div class="card">
        <div class="card-title">Sin canciones todavía</div>
        <div class="card-sub">Cantá una canción y volvé acá.</div>
      </div>
    );

  return (
    <div class="card report">
      <label class="song-picker">
        Canción
        <select value={hash} onChange={(e) => setHash((e.currentTarget as HTMLSelectElement).value)}>
          {songs.map((s) => (
            <option value={s.audio_hash}>
              {s.file_name} ({s.sessions} {s.sessions === 1 ? 'sesión' : 'sesiones'})
            </option>
          ))}
        </select>
      </label>

      {loading && <div class="card-sub">Cargando…</div>}
      {error && <div class="err">{error}</div>}

      {stats && stats.sessions > 0 && (
        <>
          <div class="stats">
            <StatCell label="Sesiones" value={String(stats.sessions)} />
            <StatCell
              label="Afinación promedio"
              value={stats.avg_accuracy != null ? `${stats.avg_accuracy.toFixed(0)}%` : '—'}
              tone={
                stats.avg_accuracy != null && stats.avg_accuracy >= 60
                  ? 'good'
                  : stats.avg_accuracy != null && stats.avg_accuracy >= 30
                    ? 'warn'
                    : 'bad'
              }
            />
            <StatCell
              label="Mejor afinación"
              value={stats.best_accuracy != null ? `${stats.best_accuracy.toFixed(0)}%` : '—'}
              tone="good"
            />
            <StatCell
              label="Toma más larga"
              value={stats.longest_take != null ? formatDuration(stats.longest_take) : '—'}
            />
          </div>

          <div class="range">
            <div class="range-title">Rango histórico en esta canción</div>
            <div class="range-grid">
              <StatCell
                label="Techo sostenido"
                value={
                  stats.best_top_sustained != null
                    ? midiToNoteName(stats.best_top_sustained)
                    : '—'
                }
                tone={stats.best_top_sustained != null ? 'good' : undefined}
              />
              <StatCell
                label="Piso sostenido"
                value={
                  stats.best_bottom_sustained != null
                    ? midiToNoteName(stats.best_bottom_sustained)
                    : '—'
                }
              />
              <StatCell
                label="Error mediano prom."
                value={
                  stats.avg_median_cents != null
                    ? `${stats.avg_median_cents > 0 ? '+' : ''}${stats.avg_median_cents.toFixed(0)}¢`
                    : '—'
                }
              />
            </div>
          </div>

          <Sparkline
            title="Afinación a lo largo del tiempo"
            points={stats.timeline.map((p) => ({ x: p.created_at, y: p.accuracy_pct }))}
            unit="%"
          />
          <Sparkline
            title="Error mediano (centavos)"
            points={stats.timeline
              .filter((p) => p.median_cents != null)
              .map((p) => ({ x: p.created_at, y: p.median_cents as number }))}
            unit="¢"
            referenceLine={0}
          />

          <div class="range-title" style={{ marginTop: 8 }}>
            Sesiones ({sessions.length})
          </div>
          <SessionTable rows={sessions} />
        </>
      )}
    </div>
  );
}

// ---- Shared bits -----------------------------------------------------------

function StatCell({
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

function formatDuration(seconds: number): string {
  if (!seconds || seconds < 1) return '0s';
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

function SessionTable({ rows }: { rows: SessionRow[] }) {
  if (!rows.length) return <div class="card-sub">Sin sesiones en este rango.</div>;
  return (
    <div class="table-wrap">
      <table class="session-table">
        <thead>
          <tr>
            <th>Fecha</th>
            <th>Canción</th>
            <th>Transp.</th>
            <th>Duración</th>
            <th>Afinación</th>
            <th>Error med.</th>
            <th>Techo sost.</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr>
              <td>{formatDate(r.created_at)}</td>
              <td>{r.file_name}</td>
              <td>
                {r.transpose_semitones === 0
                  ? '—'
                  : `${r.transpose_semitones > 0 ? '+' : ''}${r.transpose_semitones} st`}
              </td>
              <td>{formatDuration(r.elapsed)}</td>
              <td>{r.accuracy_pct.toFixed(0)}%</td>
              <td>
                {r.median_cents != null
                  ? `${r.median_cents > 0 ? '+' : ''}${r.median_cents.toFixed(0)}¢`
                  : '—'}
              </td>
              <td>
                {r.top_sustained_midi != null ? midiToNoteName(r.top_sustained_midi) : '—'}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function formatDate(iso: string): string {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso;
  return d.toLocaleString('es-AR', {
    day: '2-digit',
    month: '2-digit',
    year: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function Sparkline({
  title,
  points,
  unit,
  referenceLine,
  formatY,
}: {
  title: string;
  points: Array<{ x: string; y: number }>;
  unit?: string;
  referenceLine?: number;
  formatY?: (v: number) => string;
}) {
  const view = useMemo(() => {
    if (!points.length) return null;
    const w = 600;
    const h = 120;
    const pad = 24;
    const ys = points.map((p) => p.y);
    if (referenceLine !== undefined) ys.push(referenceLine);
    const yMin = Math.min(...ys);
    const yMax = Math.max(...ys);
    const yRange = yMax - yMin || 1;
    const xs = points.map((p) => new Date(p.x).getTime());
    const xMin = Math.min(...xs);
    const xMax = Math.max(...xs);
    const xRange = xMax - xMin || 1;
    const sx = (x: number) => pad + ((x - xMin) / xRange) * (w - pad * 2);
    const sy = (y: number) => h - pad - ((y - yMin) / yRange) * (h - pad * 2);
    const path = points
      .map((p, i) => `${i === 0 ? 'M' : 'L'} ${sx(new Date(p.x).getTime()).toFixed(1)} ${sy(p.y).toFixed(1)}`)
      .join(' ');
    return { w, h, pad, path, sx, sy, yMin, yMax, xs, points, referenceLine };
  }, [points, referenceLine]);

  if (!view) return null;
  const last = points[points.length - 1];
  const lastLabel = formatY ? formatY(last.y) : `${last.y.toFixed(1)}${unit ?? ''}`;

  return (
    <div class="sparkline">
      <div class="sparkline-head">
        <span>{title}</span>
        <span class="time">último: {lastLabel}</span>
      </div>
      <svg viewBox={`0 0 ${view.w} ${view.h}`} width="100%" height={view.h}>
        {view.referenceLine !== undefined && (
          <line
            x1={view.pad}
            x2={view.w - view.pad}
            y1={view.sy(view.referenceLine)}
            y2={view.sy(view.referenceLine)}
            stroke="#374151"
            stroke-dasharray="3 3"
          />
        )}
        <path d={view.path} fill="none" stroke="#3b82f6" stroke-width="2" />
        {view.points.map((p) => (
          <circle
            cx={view.sx(new Date(p.x).getTime())}
            cy={view.sy(p.y)}
            r="3"
            fill="#fbbf24"
          />
        ))}
        <text x={view.pad} y={view.pad - 6} fill="#6b7280" font-size="10">
          {view.yMax.toFixed(0)}{unit ?? ''}
        </text>
        <text x={view.pad} y={view.h - 6} fill="#6b7280" font-size="10">
          {view.yMin.toFixed(0)}{unit ?? ''}
        </text>
      </svg>
    </div>
  );
}
