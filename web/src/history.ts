// Client for the SQLite-backed history endpoints.
import { SERVER } from './notes';
import type { Report } from './report';

export type SessionRow = {
  id: string;
  created_at: string;
  file_name: string;
  audio_hash: string | null;
  song_duration: number;
  elapsed: number;
  song_key: string | null;
  notes_in_window: number;
  notes_hit: number;
  accuracy_pct: number;
  median_cents: number | null;
  mean_cents: number | null;
  tendency: string | null;
  top_sustained_midi: number | null;
  bottom_sustained_midi: number | null;
  total_low_midi: number | null;
  total_high_midi: number | null;
  transpose_semitones: number;
};

export type TimelinePoint = {
  created_at: string;
  accuracy_pct: number;
  top_sustained_midi: number | null;
  elapsed: number;
  audio_hash?: string | null;
  file_name?: string | null;
};

export type GeneralStats = {
  sessions: number;
  total_seconds_sung: number;
  unique_songs: number;
  avg_accuracy: number | null;
  avg_median_cents: number | null;
  best_top_sustained: number | null;
  best_bottom_sustained: number | null;
  highest_touched: number | null;
  lowest_touched: number | null;
  timeline: TimelinePoint[];
};

export type SongStats = {
  sessions: number;
  avg_accuracy: number | null;
  best_accuracy: number | null;
  avg_median_cents: number | null;
  best_top_sustained: number | null;
  best_bottom_sustained: number | null;
  longest_take: number | null;
  timeline: Array<
    Pick<
      SessionRow,
      | 'id'
      | 'created_at'
      | 'accuracy_pct'
      | 'median_cents'
      | 'elapsed'
      | 'top_sustained_midi'
      | 'bottom_sustained_midi'
    >
  >;
  file_name: string | null;
};

export type KnownSong = {
  audio_hash: string;
  file_name: string;
  sessions: number;
  last_session: string;
  best_accuracy: number | null;
};

export type DateRange = { from?: string; to?: string };

function qs(params: Record<string, string | undefined>): string {
  const parts: string[] = [];
  for (const [k, v] of Object.entries(params)) {
    if (v) parts.push(`${encodeURIComponent(k)}=${encodeURIComponent(v)}`);
  }
  return parts.length ? `?${parts.join('&')}` : '';
}

export async function saveSession(
  report: Report,
  meta: {
    file_name: string;
    audio_hash?: string;
    song_duration: number;
    song_key?: string | null;
    transpose_semitones?: number;
  },
): Promise<{ id: string; created_at: string }> {
  const body = {
    file_name: meta.file_name,
    audio_hash: meta.audio_hash ?? null,
    song_duration: meta.song_duration,
    song_key: meta.song_key ?? null,
    elapsed: report.elapsed,
    notes_in_window: report.notesInWindow,
    notes_hit: report.hit,
    accuracy_pct: report.accuracyPct,
    median_cents: report.medianCents,
    mean_cents: report.meanCents,
    tendency: report.tendency,
    top_sustained_midi: report.topSustainedMidi,
    bottom_sustained_midi: report.bottomSustainedMidi,
    total_low_midi: report.totalLowMidi,
    total_high_midi: report.totalHighMidi,
    transpose_semitones: meta.transpose_semitones ?? 0,
  };
  const r = await fetch(`${SERVER}/sessions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`save session ${r.status}: ${await r.text()}`);
  return r.json();
}

export async function listSessions(range: DateRange & { hash?: string } = {}): Promise<SessionRow[]> {
  const r = await fetch(
    `${SERVER}/sessions${qs({ frm: range.from, to: range.to, hash: range.hash })}`,
  );
  if (!r.ok) throw new Error(`list ${r.status}`);
  const j = await r.json();
  return j.sessions;
}

export async function generalStats(range: DateRange = {}): Promise<GeneralStats> {
  const r = await fetch(`${SERVER}/stats${qs({ frm: range.from, to: range.to })}`);
  if (!r.ok) throw new Error(`stats ${r.status}`);
  return r.json();
}

export async function songStats(hash: string, range: DateRange = {}): Promise<SongStats> {
  const r = await fetch(
    `${SERVER}/stats/song/${hash}${qs({ frm: range.from, to: range.to })}`,
  );
  if (!r.ok) throw new Error(`song stats ${r.status}`);
  return r.json();
}

export async function knownSongs(): Promise<KnownSong[]> {
  const r = await fetch(`${SERVER}/songs`);
  if (!r.ok) throw new Error(`songs ${r.status}`);
  const j = await r.json();
  return j.songs;
}
