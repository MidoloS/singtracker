#!/usr/bin/env python3
"""
local_server.py — FastAPI mínima para correr el pipeline de script.py en local.

Sin R2, sin GCP, sin colas. Un solo proceso, jobs en memoria, cache en disco
por hash del archivo. Pensado para `python -m server.local_server` desde la
raíz del repo, escuchando en http://127.0.0.1:8765.

  POST /jobs           multipart MP3        -> {job_id}
  GET  /jobs/{id}      polling              -> {status, phase?, notes?, error?}

El front (Vite en :5173) lo llama directo; CORS abierto.
"""
from __future__ import annotations

import hashlib
import json
import os
import sys
import threading
import time
import traceback
import uuid
from pathlib import Path
from types import SimpleNamespace
from typing import Any, Optional

import numpy as np
import librosa
import soundfile as sf
from datetime import datetime, timezone
from fastapi import FastAPI, HTTPException, UploadFile, File
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, FileResponse
from pydantic import BaseModel

from . import db as sessions_db

# Importar script.py desde la raíz del repo.
ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
import script  # noqa: E402

CACHE_DIR = ROOT / ".cache"
CACHE_DIR.mkdir(exist_ok=True)
DB_PATH = CACHE_DIR / "sessions.db"
sessions_db.init(DB_PATH)

app = FastAPI(title="singimprove local")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

# Estado en memoria. Suficiente para un proceso local.
JOBS: dict[str, dict[str, Any]] = {}
JOBS_LOCK = threading.Lock()


def _set(job_id: str, **fields: Any) -> None:
    with JOBS_LOCK:
        JOBS.setdefault(job_id, {}).update(fields)


def _build_stems(mp3_path: Path, vocals_wav: Path, cache_dir: Path) -> None:
    """Copy vocals.wav + derive instrumental = (original - vocals). Both 44.1k stereo."""
    sr = 44100
    # Load original and vocals at the same SR / channel layout.
    original, _ = librosa.load(str(mp3_path), sr=sr, mono=False)
    vocals, vsr = sf.read(str(vocals_wav), always_2d=True)
    if vsr != sr:
        vocals = librosa.resample(vocals.T, orig_sr=vsr, target_sr=sr).T
    # original is (channels, samples); vocals is (samples, channels). Normalize to (samples, channels).
    if original.ndim == 1:
        original = np.stack([original, original], axis=0)
    original = original.T  # → (samples, channels)
    if original.shape[1] == 1:
        original = np.repeat(original, 2, axis=1)
    if vocals.shape[1] == 1:
        vocals = np.repeat(vocals, 2, axis=1)
    n = min(len(original), len(vocals))
    original = original[:n]
    vocals = vocals[:n]
    instrumental = original - vocals
    sf.write(str(cache_dir / "vocals.wav"), vocals, sr, subtype="PCM_16")
    sf.write(str(cache_dir / "instrumental.wav"), instrumental, sr, subtype="PCM_16")


def _run_preprocess(job_id: str, mp3_path: Path, work: Path, file_hash: str) -> None:
    """Corre script.run_preprocess y escribe el resultado en cache/<hash>/notes.json."""
    try:
        _set(job_id, status="running", phase="separating vocals (demucs)")
        args = SimpleNamespace(
            song=str(mp3_path),
            workdir=str(work),
            pitch="pyin",          # rápido en CPU, sin GPU
            silence=0.03,
            min_note=0.10,
            merge_gap=0.06,
            snap_to_key=False,
        )

        # Phase progress is best-effort: run_preprocess no expone callbacks.
        # Inferimos las fases mirando archivos en disco mientras el thread corre.
        def watch():
            stem_dir = work / "demucs"
            vocals_done = False
            while not _is_done(job_id):
                if not vocals_done and any(stem_dir.rglob("vocals.wav")):
                    vocals_done = True
                    _set(job_id, phase="extracting pitch + notes")
                time.sleep(0.5)

        watcher = threading.Thread(target=watch, daemon=True)
        watcher.start()

        script.run_preprocess(args)

        notes_src = work / "notes.json"
        if not notes_src.exists():
            raise RuntimeError("run_preprocess no produjo notes.json")
        cache_dir = CACHE_DIR / file_hash
        cache_dir.mkdir(parents=True, exist_ok=True)
        notes_dst = cache_dir / "notes.json"
        notes_dst.write_bytes(notes_src.read_bytes())

        # Derivar y guardar los stems para la mezcla en el front.
        vocals_src = next(work.rglob("vocals.wav"), None)
        if vocals_src is not None:
            _set(job_id, phase="building stems")
            _build_stems(mp3_path, vocals_src, cache_dir)

        payload = json.loads(notes_dst.read_text())
        _set(job_id, status="done", phase="done", notes=payload, audio_hash=file_hash)
    except Exception as e:  # noqa: BLE001
        traceback.print_exc()
        _set(job_id, status="error", error=str(e))


def _is_done(job_id: str) -> bool:
    with JOBS_LOCK:
        return JOBS.get(job_id, {}).get("status") in ("done", "error")


@app.post("/jobs")
async def create_job(file: UploadFile = File(...)) -> dict[str, str]:
    if not file.filename:
        raise HTTPException(400, "missing filename")
    raw = await file.read()
    if not raw:
        raise HTTPException(400, "empty file")

    file_hash = hashlib.sha1(raw).hexdigest()[:16]
    cached = CACHE_DIR / file_hash / "notes.json"
    job_id = uuid.uuid4().hex

    if cached.exists():
        # Cache hit: no hace falta procesar de nuevo.
        payload = json.loads(cached.read_text())
        _set(job_id, status="done", phase="cached", notes=payload, audio_hash=file_hash)
        return {"job_id": job_id}

    # Guardar el MP3 en un workdir efímero.
    work = CACHE_DIR / f"work-{job_id}"
    work.mkdir(parents=True, exist_ok=True)
    mp3_path = work / "input.mp3"
    mp3_path.write_bytes(raw)

    _set(job_id, status="queued", phase="queued")
    t = threading.Thread(
        target=_run_preprocess,
        args=(job_id, mp3_path, work, file_hash),
        daemon=True,
    )
    t.start()
    return {"job_id": job_id}


@app.get("/jobs/{job_id}")
def get_job(job_id: str) -> JSONResponse:
    with JOBS_LOCK:
        job = JOBS.get(job_id)
    if job is None:
        raise HTTPException(404, "job not found")
    # No mandamos `notes` en cada poll hasta que terminó (puede ser grande).
    body: dict[str, Any] = {
        "status": job["status"],
        "phase": job.get("phase"),
    }
    if job["status"] == "done":
        body["notes"] = job["notes"]
        if "audio_hash" in job:
            body["audio_hash"] = job["audio_hash"]
    if job["status"] == "error":
        body["error"] = job.get("error")
    return JSONResponse(body)


@app.get("/audio/{audio_hash}/{kind}")
def get_audio(audio_hash: str, kind: str) -> FileResponse:
    if kind not in ("vocals", "instrumental"):
        raise HTTPException(404, "unknown kind")
    path = CACHE_DIR / audio_hash / f"{kind}.wav"
    if not path.exists():
        raise HTTPException(404, "audio not cached for this song")
    return FileResponse(str(path), media_type="audio/wav")


# ---------------------------------------------------------------------------
# Sessions + stats (SQLite).
# ---------------------------------------------------------------------------


class SessionIn(BaseModel):
    file_name: str
    audio_hash: Optional[str] = None
    song_duration: float
    elapsed: float
    song_key: Optional[str] = None
    notes_in_window: int
    notes_hit: int
    accuracy_pct: float
    median_cents: Optional[float] = None
    mean_cents: Optional[float] = None
    tendency: Optional[str] = None
    top_sustained_midi: Optional[int] = None
    bottom_sustained_midi: Optional[int] = None
    total_low_midi: Optional[int] = None
    total_high_midi: Optional[int] = None


@app.post("/sessions")
def create_session(payload: SessionIn) -> dict[str, str]:
    row = payload.model_dump()
    row["created_at"] = datetime.now(timezone.utc).isoformat(timespec="seconds")
    sid = sessions_db.insert_session(DB_PATH, row)
    return {"id": sid, "created_at": row["created_at"]}


@app.get("/sessions")
def list_sessions(
    frm: Optional[str] = None,
    to: Optional[str] = None,
    hash: Optional[str] = None,
    limit: int = 200,
) -> dict[str, Any]:
    rows = sessions_db.list_sessions(DB_PATH, frm=frm, to=to, audio_hash=hash, limit=limit)
    return {"sessions": rows}


@app.get("/stats")
def stats_general(frm: Optional[str] = None, to: Optional[str] = None) -> dict[str, Any]:
    return sessions_db.general_stats(DB_PATH, frm=frm, to=to)


@app.get("/stats/song/{audio_hash}")
def stats_song(
    audio_hash: str, frm: Optional[str] = None, to: Optional[str] = None
) -> dict[str, Any]:
    return sessions_db.song_stats(DB_PATH, audio_hash, frm=frm, to=to)


@app.get("/songs")
def list_known_songs() -> dict[str, Any]:
    return {"songs": sessions_db.known_songs(DB_PATH)}


@app.get("/health")
def health() -> dict[str, str]:
    return {"ok": "yes"}


if __name__ == "__main__":
    import uvicorn

    host = os.environ.get("HOST", "127.0.0.1")
    port = int(os.environ.get("PORT", "8765"))
    uvicorn.run(app, host=host, port=port, log_level="info")
