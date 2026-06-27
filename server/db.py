"""SQLite DAO for practice sessions.

Single file at .cache/sessions.db. One row per recorded take. The frontend posts
the report metrics it already computed; we just persist them so the historial /
stats endpoints can answer "am I improving" questions over time.
"""
from __future__ import annotations

import sqlite3
import threading
import uuid
from contextlib import contextmanager
from pathlib import Path
from typing import Any, Iterator, Optional

# A single lock around all writes is fine for a local dev server.
_LOCK = threading.Lock()


_SCHEMA = """
CREATE TABLE IF NOT EXISTS sessions (
    id                    TEXT PRIMARY KEY,
    created_at            TEXT NOT NULL,        -- ISO8601 UTC
    file_name             TEXT NOT NULL,
    audio_hash            TEXT,                 -- nullable: old jobs without stems
    song_duration         REAL NOT NULL,
    elapsed               REAL NOT NULL,        -- seconds the user actually sang
    song_key              TEXT,                 -- e.g. "A mayor"
    notes_in_window       INTEGER NOT NULL,
    notes_hit             INTEGER NOT NULL,
    accuracy_pct          REAL NOT NULL,
    median_cents          REAL,                 -- signed; null if no data
    mean_cents            REAL,
    tendency              TEXT,                 -- alto | bajo | centrado | NULL
    top_sustained_midi    INTEGER,
    bottom_sustained_midi INTEGER,
    total_low_midi        INTEGER,
    total_high_midi       INTEGER
);
CREATE INDEX IF NOT EXISTS idx_sessions_created_at ON sessions(created_at);
CREATE INDEX IF NOT EXISTS idx_sessions_audio_hash ON sessions(audio_hash);
"""


def _connect(db_path: Path) -> sqlite3.Connection:
    conn = sqlite3.connect(str(db_path), detect_types=sqlite3.PARSE_DECLTYPES)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA foreign_keys=ON")
    return conn


def init(db_path: Path) -> None:
    with _LOCK:
        with _connect(db_path) as conn:
            conn.executescript(_SCHEMA)
            conn.commit()


@contextmanager
def open_db(db_path: Path) -> Iterator[sqlite3.Connection]:
    conn = _connect(db_path)
    try:
        yield conn
    finally:
        conn.close()


def insert_session(db_path: Path, row: dict[str, Any]) -> str:
    """Insert a new session row. Returns the id."""
    if not row.get("id"):
        row["id"] = uuid.uuid4().hex
    columns = [
        "id",
        "created_at",
        "file_name",
        "audio_hash",
        "song_duration",
        "elapsed",
        "song_key",
        "notes_in_window",
        "notes_hit",
        "accuracy_pct",
        "median_cents",
        "mean_cents",
        "tendency",
        "top_sustained_midi",
        "bottom_sustained_midi",
        "total_low_midi",
        "total_high_midi",
    ]
    placeholders = ",".join("?" * len(columns))
    values = [row.get(c) for c in columns]
    with _LOCK:
        with open_db(db_path) as conn:
            conn.execute(
                f"INSERT INTO sessions ({','.join(columns)}) VALUES ({placeholders})",
                values,
            )
            conn.commit()
    return row["id"]


def _date_clause(prefix: str, frm: Optional[str], to: Optional[str]) -> tuple[str, list[str]]:
    """Build a WHERE fragment for the optional date range. Uses created_at column."""
    clauses: list[str] = []
    params: list[str] = []
    if frm:
        clauses.append(f"{prefix}created_at >= ?")
        params.append(frm)
    if to:
        # `to` is inclusive end-of-day if it doesn't have a time component.
        end = to if "T" in to else f"{to}T23:59:59"
        clauses.append(f"{prefix}created_at <= ?")
        params.append(end)
    return (" AND ".join(clauses), params)


def list_sessions(
    db_path: Path,
    *,
    frm: Optional[str] = None,
    to: Optional[str] = None,
    audio_hash: Optional[str] = None,
    limit: int = 200,
) -> list[dict[str, Any]]:
    clauses: list[str] = []
    params: list[Any] = []
    date_clause, date_params = _date_clause("", frm, to)
    if date_clause:
        clauses.append(date_clause)
        params.extend(date_params)
    if audio_hash:
        clauses.append("audio_hash = ?")
        params.append(audio_hash)
    where = f"WHERE {' AND '.join(clauses)}" if clauses else ""
    sql = f"SELECT * FROM sessions {where} ORDER BY created_at DESC LIMIT ?"
    params.append(limit)
    with open_db(db_path) as conn:
        rows = conn.execute(sql, params).fetchall()
    return [dict(r) for r in rows]


def general_stats(
    db_path: Path, *, frm: Optional[str] = None, to: Optional[str] = None
) -> dict[str, Any]:
    """Aggregated metrics across all sessions in range."""
    date_clause, params = _date_clause("", frm, to)
    where = f"WHERE {date_clause}" if date_clause else ""
    with open_db(db_path) as conn:
        agg = conn.execute(
            f"""
            SELECT
                COUNT(*)                        AS sessions,
                COALESCE(SUM(elapsed), 0)       AS total_seconds_sung,
                COUNT(DISTINCT audio_hash)      AS unique_songs,
                AVG(accuracy_pct)               AS avg_accuracy,
                AVG(median_cents)               AS avg_median_cents,
                MAX(top_sustained_midi)         AS best_top_sustained,
                MIN(bottom_sustained_midi)      AS best_bottom_sustained,
                MAX(total_high_midi)            AS highest_touched,
                MIN(total_low_midi)             AS lowest_touched
            FROM sessions {where}
            """,
            params,
        ).fetchone()
        # Per-session timeline (small) for sparklines on the front.
        timeline = conn.execute(
            f"""
            SELECT created_at, accuracy_pct, top_sustained_midi, elapsed, audio_hash, file_name
            FROM sessions {where}
            ORDER BY created_at ASC
            """,
            params,
        ).fetchall()
    out = dict(agg) if agg else {}
    out["timeline"] = [dict(r) for r in timeline]
    return out


def song_stats(
    db_path: Path,
    audio_hash: str,
    *,
    frm: Optional[str] = None,
    to: Optional[str] = None,
) -> dict[str, Any]:
    """Aggregated metrics for one specific song."""
    clauses = ["audio_hash = ?"]
    params: list[Any] = [audio_hash]
    date_clause, date_params = _date_clause("", frm, to)
    if date_clause:
        clauses.append(date_clause)
        params.extend(date_params)
    where = f"WHERE {' AND '.join(clauses)}"
    with open_db(db_path) as conn:
        agg = conn.execute(
            f"""
            SELECT
                COUNT(*)                  AS sessions,
                AVG(accuracy_pct)         AS avg_accuracy,
                MAX(accuracy_pct)         AS best_accuracy,
                AVG(median_cents)         AS avg_median_cents,
                MAX(top_sustained_midi)   AS best_top_sustained,
                MIN(bottom_sustained_midi) AS best_bottom_sustained,
                MAX(elapsed)              AS longest_take
            FROM sessions {where}
            """,
            params,
        ).fetchone()
        timeline = conn.execute(
            f"""
            SELECT id, created_at, accuracy_pct, median_cents, elapsed,
                   top_sustained_midi, bottom_sustained_midi
            FROM sessions {where}
            ORDER BY created_at ASC
            """,
            params,
        ).fetchall()
        # Get the most recent file_name we've seen for this hash, as a label.
        label_row = conn.execute(
            "SELECT file_name FROM sessions WHERE audio_hash = ? ORDER BY created_at DESC LIMIT 1",
            [audio_hash],
        ).fetchone()
    out = dict(agg) if agg else {}
    out["timeline"] = [dict(r) for r in timeline]
    out["file_name"] = label_row["file_name"] if label_row else None
    return out


def known_songs(db_path: Path) -> list[dict[str, Any]]:
    """All songs (by hash) we've seen at least one session for."""
    with open_db(db_path) as conn:
        rows = conn.execute(
            """
            SELECT
                audio_hash,
                MAX(file_name)        AS file_name,
                COUNT(*)              AS sessions,
                MAX(created_at)       AS last_session,
                MAX(accuracy_pct)     AS best_accuracy
            FROM sessions
            WHERE audio_hash IS NOT NULL
            GROUP BY audio_hash
            ORDER BY last_session DESC
            """
        ).fetchall()
    return [dict(r) for r in rows]
