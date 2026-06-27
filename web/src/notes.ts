// Schema produced by script.build_notes_payload (server-side).
export type Note = { t: number; d: number; midi: number };

export type Key = { name: string; confidence: number; tonic?: number; mode?: string };

export type NotesPayload = {
  version: number;
  frame_sec: number;
  duration: number;
  key: Key;
  midi_min: number | null;
  midi_max: number | null;
  notes: Note[];
};

export type JobStatus =
  | { status: 'queued' | 'running'; phase?: string }
  | { status: 'done'; phase?: string; notes: NotesPayload; audio_hash?: string }
  | { status: 'error'; phase?: string; error: string };

export const SERVER = (import.meta as any).env?.VITE_SERVER ?? 'http://127.0.0.1:8765';

export function audioUrl(audioHash: string, kind: 'vocals' | 'instrumental'): string {
  return `${SERVER}/audio/${audioHash}/${kind}`;
}

export async function submitFile(file: File): Promise<string> {
  const fd = new FormData();
  fd.append('file', file);
  const r = await fetch(`${SERVER}/jobs`, { method: 'POST', body: fd });
  if (!r.ok) throw new Error(`server ${r.status}: ${await r.text()}`);
  const { job_id } = await r.json();
  return job_id as string;
}

export async function getJob(jobId: string): Promise<JobStatus> {
  const r = await fetch(`${SERVER}/jobs/${jobId}`);
  if (!r.ok) throw new Error(`server ${r.status}: ${await r.text()}`);
  return (await r.json()) as JobStatus;
}

/** Poll until the job finishes. Calls `onPhase` whenever the phase changes. */
export async function waitForJob(
  jobId: string,
  onPhase?: (phase: string) => void,
  intervalMs = 1500,
): Promise<{ notes: NotesPayload; audioHash?: string }> {
  let lastPhase = '';
  while (true) {
    const s = await getJob(jobId);
    if (s.phase && s.phase !== lastPhase) {
      lastPhase = s.phase;
      onPhase?.(s.phase);
    }
    if (s.status === 'done') return { notes: s.notes, audioHash: s.audio_hash };
    if (s.status === 'error') throw new Error(s.error);
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}
