#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
analisis_canto.py  (v3)
=======================

Compara qué tan bien cantaste una canción contra la voz original.

Cambios de la v3:
  - COMPUERTA DE SILENCIO: descarta los frames de baja energía (intro, respiros,
    huecos instrumentales). Eso mata el fantasma "C2" que metía pyin cuando se
    pegaba a su piso de búsqueda en los silencios, y limpia el rango, el voicing
    y de paso el alineamiento. El piso de pyin además subió de C2 a E2.
  - GRÁFICO DE AFINACIÓN LEGIBLE: en vez de una línea de error que parece una
    tangente, dibujo tu melodía coloreada por afinación (verde=afinado,
    rojo=desafinado). Se ve la nota Y el acierto de un vistazo, sin picos raros.
  - GRÁFICO INTERACTIVE (HTML): scrolleable, con zoom, pan y tooltips. Se abre
    en el navegador. Necesita plotly (pip install plotly).
  - Métrica extra "en notas sostenidas": la afinación contando sólo notas
    mantenidas (sin las transiciones, que no son notas) — lo más musical.

Instalación
-----------
    # ffmpeg necesario para leer mp3 (sudo apt install ffmpeg)
    pip install demucs torch torchaudio torchcrepe librosa mir_eval matplotlib soundfile numpy scipy plotly

Uso
---
    python analisis_canto.py                  # ./song.mp3 y ./voice.mp3
    python analisis_canto.py --pitch pyin     # sin GPU (rápido en CPU)
    python analisis_canto.py --silence 0.05   # compuerta más agresiva si quedan silencios
    python analisis_canto.py --separate-voice # si grabaste con la pista de fondo
    python analisis_canto.py --no-detranspose # puntuar contra el tono LITERAL
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Optional, Tuple

import numpy as np
import librosa
import mir_eval
import soundfile as sf
from scipy.ndimage import median_filter

import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt  # noqa: E402


SR = 16_000
HOP = 160                 # 10 ms por frame
FRAME_SEC = HOP / SR
A4 = 440.0


# ============================================================================
# Conversión de pitch
# ============================================================================
def hz_to_midi(f0: np.ndarray) -> np.ndarray:
    out = np.full_like(f0, np.nan, dtype=float)
    m = f0 > 0
    out[m] = 69.0 + 12.0 * np.log2(f0[m] / A4)
    return out


def midi_to_note_name(midi) -> str:
    if midi is None or (isinstance(midi, float) and np.isnan(midi)):
        return "—"
    return librosa.midi_to_note(float(np.round(midi)), octave=True, unicode=False)


def cents_diff(f_est: np.ndarray, f_ref: np.ndarray) -> np.ndarray:
    out = np.full(f_ref.shape, np.nan, dtype=float)
    m = (f_est > 0) & (f_ref > 0)
    out[m] = 1200.0 * np.log2(f_est[m] / f_ref[m])
    return out


def wrap_cents(c) -> np.ndarray:
    """Envuelve el error a (-600, 600]: colapsa diferencias de octava."""
    return ((np.asarray(c) + 600.0) % 1200.0) - 600.0


def held_note_mask(f0_clean: np.ndarray, max_cents_per_frame: float = 30.0) -> np.ndarray:
    """
    Marca los frames de NOTA SOSTENIDA: donde el tono casi no se mueve. Deja
    afuera las transiciones (barridos rápidos entre notas), que disparan picos
    pero no son notas. Conserva el vibrato (oscilación lenta y chica).
    """
    midi = hz_to_midi(np.where(f0_clean > 0, f0_clean, np.nan))
    d = np.full(len(midi), np.nan)
    if len(midi) > 1:
        d[1:] = np.abs(np.diff(midi))
    held = (~np.isnan(midi)) & (d < max_cents_per_frame / 100.0)
    if len(midi) and not np.isnan(midi[0]):
        held[0] = True
    return held


# ============================================================================
# 1) Separación de voz
# ============================================================================
def separate_vocals(input_mp3: Path, out_dir: Path, model: str = "htdemucs") -> Path:
    stem_dir = out_dir / model / input_mp3.stem
    vocals_path = stem_dir / "vocals.wav"
    if vocals_path.exists():
        print(f"[demucs] Cache encontrado: {vocals_path}")
        return vocals_path

    print(f"[demucs] Separando voz de {input_mp3.name} (puede tardar)...")
    import torch
    from demucs.pretrained import get_model
    from demucs.apply import apply_model

    bag = get_model(model)
    bag.eval()
    model_sr = bag.samplerate
    n_ch = bag.audio_channels

    wav, _ = librosa.load(str(input_mp3), sr=model_sr, mono=(n_ch == 1))
    if wav.ndim == 1:
        wav = np.stack([wav] * n_ch)
    wav_t = torch.tensor(wav, dtype=torch.float32)

    ref = wav_t.mean(0)
    mean, std = ref.mean(), ref.std() + 1e-8
    wav_t = (wav_t - mean) / std

    with torch.no_grad():
        sources = apply_model(bag, wav_t[None], progress=True, device="cpu")[0]
    sources = sources * std + mean

    stems = bag.sources
    if "vocals" not in stems:
        sys.exit(f"[error] El modelo no tiene stem 'vocals' (tiene: {stems})")
    vocals = sources[stems.index("vocals")].cpu().numpy().T

    stem_dir.mkdir(parents=True, exist_ok=True)
    sf.write(str(vocals_path), vocals, model_sr, subtype="FLOAT")
    print(f"[demucs] Voz aislada guardada en {vocals_path}")
    return vocals_path


# ============================================================================
# 2) Extracción de F0 + compuerta de silencio + limpieza
# ============================================================================
def extract_f0(audio: np.ndarray, method: str = "crepe",
               conf_threshold: float = 0.5, silence_rel: float = 0.03
               ) -> Tuple[np.ndarray, np.ndarray]:
    """
    Devuelve (f0_hz, voiced_mask). La compuerta de silencio descarta frames cuya
    energía está por debajo de silence_rel * pico: ahí no estabas cantando.
    """
    if method == "crepe":
        try:
            import torch
            import torchcrepe
        except ImportError:
            sys.exit("[error] torchcrepe no está. Usá --pitch pyin o instalalo.")
        device = "cuda" if torch.cuda.is_available() else "cpu"
        tensor = torch.tensor(audio, dtype=torch.float32, device=device).unsqueeze(0)
        f0_t, periodicity = torchcrepe.predict(
            tensor, SR, hop_length=HOP, model="full",
            return_periodicity=True, device=device, batch_size=512)
        f0 = f0_t.squeeze(0).cpu().numpy()
        periodicity = median_filter(periodicity.squeeze(0).cpu().numpy(), size=3)
        voiced = periodicity > conf_threshold

    elif method == "pyin":
        f0, voiced_flag, _ = librosa.pyin(
            audio, sr=SR, hop_length=HOP,
            fmin=float(librosa.note_to_hz("E2")),   # subido de C2: ya no se pega tan abajo
            fmax=float(librosa.note_to_hz("C6")))
        f0 = np.nan_to_num(f0, nan=0.0)
        voiced = np.nan_to_num(voiced_flag, nan=0.0).astype(bool)
    else:
        raise ValueError(f"método de pitch desconocido: {method}")

    # --- Compuerta de energía: fuera silencios, respiros, intro instrumental ---
    rms = librosa.feature.rms(y=audio, frame_length=2 * HOP, hop_length=HOP, center=True)[0]
    m = min(len(rms), len(f0), len(voiced))
    f0, voiced, rms = f0[:m], voiced[:m], rms[:m]
    if rms.size:
        voiced = voiced & (rms > rms.max() * silence_rel)
    f0 = np.where(voiced, f0, 0.0)
    return f0, voiced


def clean_f0(f0: np.ndarray, med_win: int = 5) -> np.ndarray:
    """Filtro de mediana en notas: quita picos de 1-3 frames del detector."""
    midi = hz_to_midi(f0)
    voiced = ~np.isnan(midi)
    if voiced.sum() < 5:
        return f0.copy()
    idx = np.arange(len(midi))
    filled = np.interp(idx, idx[voiced], midi[voiced])
    filt = median_filter(filled, size=med_win)
    out = np.zeros_like(f0)
    out[voiced] = A4 * 2.0 ** ((filt[voiced] - 69) / 12.0)
    return out


# ============================================================================
# Cuantización a partitura (objetivo limpio del carril en vivo)
# ============================================================================
# El carril en vivo NO usa la F0 cruda (trae artefactos y saltos de octava del
# detector). Usa notas discretas {start, end, midi}, derivadas de la F0 ya
# limpia. La cruda se guarda aparte (reference.npz) para el reporte fino.

_PC_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"]

# Perfiles Krumhansl-Schmuckler para estimar la tonalidad.
_KS_MAJOR = np.array([6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88])
_KS_MINOR = np.array([6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17])

# Grados (semitonos sobre la tónica) de mayor y menor natural.
_SCALE_DEGREES = {"major": (0, 2, 4, 5, 7, 9, 11), "minor": (0, 2, 3, 5, 7, 8, 10)}


def quantize_to_notes(f0_clean: np.ndarray, frame_sec: float = FRAME_SEC, *,
                      min_dur: float = 0.10, merge_gap: float = 0.06,
                      median_frames: int = 5) -> list[dict]:
    """
    Convierte la F0 limpia (Hz; 0 = sin voz) en notas CROMÁTICAS
    [{start, end, midi}, ...] en segundos.

      1) cada frame con voz se redondea al semitono más cercano (MIDI entero);
      2) filtro de mediana corto sobre la melodía (mata el flicker de 1-2 frames
         en los bordes entre dos semitonos), aplicado dentro de cada tramo con voz;
      3) run-length encoding de tramos contiguos con el mismo MIDI;
      4) se descartan los tramos < min_dur (transiciones, no notas);
      5) se fusionan notas del mismo MIDI separadas por un hueco <= merge_gap
         (una nota sostenida con un bache breve de voicing).

    Cuantiza al semitono, NO a la escala: conserva cromatismos y notas de paso
    reales. El snap a tonalidad es aparte y opcional (snap_notes_to_scale).
    """
    midi = hz_to_midi(np.where(f0_clean > 0, f0_clean, np.nan))
    voiced = ~np.isnan(midi)
    if int(voiced.sum()) < 3:
        return []

    snapped = np.full(len(midi), np.nan)
    snapped[voiced] = np.round(midi[voiced])

    # Mediana sólo dentro de cada tramo con voz (los huecos cortan).
    w = median_frames if median_frames % 2 == 1 else median_frames + 1
    i, n = 0, len(snapped)
    while i < n:
        if voiced[i]:
            j = i
            while j < n and voiced[j]:
                j += 1
            if j - i >= w:
                snapped[i:j] = median_filter(snapped[i:j], size=w)
            i = j
        else:
            i += 1

    # RLE -> segmentos en frames: [start, end_exclusive, midi].
    segs: list[list] = []
    i = 0
    while i < n:
        if not voiced[i]:
            i += 1
            continue
        m = snapped[i]
        j = i
        while j < n and voiced[j] and snapped[j] == m:
            j += 1
        segs.append([i, j, int(m)])
        i = j

    # Descartar transiciones (tramos demasiado cortos).
    min_frames = max(1, int(round(min_dur / frame_sec)))
    segs = [s for s in segs if (s[1] - s[0]) >= min_frames]
    if not segs:
        return []

    # Fusionar notas iguales separadas por un hueco corto.
    merged = [segs[0]]
    for s in segs[1:]:
        prev = merged[-1]
        gap_sec = (s[0] - prev[1]) * frame_sec
        if s[2] == prev[2] and gap_sec <= merge_gap:
            prev[1] = s[1]
        else:
            merged.append(s)

    return [{"start": round(a * frame_sec, 3),
             "end": round(b * frame_sec, 3),
             "midi": mm} for a, b, mm in merged]


def detect_key(notes: list[dict]) -> dict:
    """Estima tonalidad (Krumhansl-Schmuckler) sobre el histograma de clases de
    altura ponderado por duración de cada nota."""
    unknown = {"tonic": None, "mode": None, "name": "—", "confidence": 0.0}
    if not notes:
        return unknown
    pcw = np.zeros(12)
    for nt in notes:
        pcw[int(nt["midi"]) % 12] += (nt["end"] - nt["start"])
    if pcw.sum() <= 0:
        return unknown

    best = (-2.0, 0, "major")
    for tonic in range(12):
        for mode, prof in (("major", _KS_MAJOR), ("minor", _KS_MINOR)):
            r = float(np.corrcoef(pcw, np.roll(prof, tonic))[0, 1])
            if r > best[0]:
                best = (r, tonic, mode)
    r, tonic, mode = best
    name = f"{_PC_NAMES[tonic]} {'mayor' if mode == 'major' else 'menor'}"
    return {"tonic": tonic, "mode": mode, "name": name, "confidence": round(r, 3)}


def snap_notes_to_scale(notes: list[dict], key: dict) -> list[dict]:
    """OPCIONAL y apagado por defecto. Lleva cada nota al grado de escala más
    cercano de la tonalidad. Es LOSSY: aplasta cromatismos y notas de paso
    reales. Usalo sólo si tu material es diatónico y querés un objetivo más
    'prolijo'."""
    if key.get("tonic") is None:
        return notes
    tonic = key["tonic"]
    degrees = np.array(_SCALE_DEGREES[key["mode"]])
    out = []
    for nt in notes:
        pc = (int(nt["midi"]) - tonic) % 12
        nearest = int(degrees[np.argmin(np.abs(degrees - pc))])
        out.append({**nt, "midi": int(nt["midi"]) - pc + nearest})
    return out


def build_notes_payload(notes: list[dict], f0_clean: np.ndarray,
                        key: dict, frame_sec: float = FRAME_SEC) -> dict:
    """JSON chico que se trae el front para dibujar el carril."""
    if notes:
        midis = [nt["midi"] for nt in notes]
        midi_min, midi_max = min(midis), max(midis)
    else:
        midi_min = midi_max = None
    return {
        "version": 1,
        "frame_sec": frame_sec,
        "duration": round(len(f0_clean) * frame_sec, 3),
        "key": key,
        "midi_min": midi_min,
        "midi_max": midi_max,
        "notes": [{"t": nt["start"], "d": round(nt["end"] - nt["start"], 3),
                   "midi": nt["midi"]} for nt in notes],
    }


# ============================================================================
# 3) Alineación temporal + tiempo
# ============================================================================
def align_dtw(ref_audio: np.ndarray, est_audio: np.ndarray) -> np.ndarray:
    ref_chroma = librosa.feature.chroma_cqt(y=ref_audio, sr=SR, hop_length=HOP)
    est_chroma = librosa.feature.chroma_cqt(y=est_audio, sr=SR, hop_length=HOP)
    _, wp = librosa.sequence.dtw(X=ref_chroma, Y=est_chroma, metric="cosine")
    return wp[::-1]


def warp_est_to_ref(est_f0: np.ndarray, wp: np.ndarray, n_ref_frames: int) -> np.ndarray:
    ref_to_est: dict[int, list[int]] = {}
    for r, e in wp:
        ref_to_est.setdefault(int(r), []).append(int(e))
    aligned = np.zeros(n_ref_frames, dtype=float)
    for r in range(n_ref_frames):
        if r in ref_to_est:
            e_idx = int(round(float(np.mean(ref_to_est[r]))))
            aligned[r] = est_f0[min(max(e_idx, 0), len(est_f0) - 1)]
    return aligned


def timing_metrics(wp: np.ndarray, ref_voiced: np.ndarray) -> dict:
    ref_idx = wp[:, 0].astype(float)
    est_idx = wp[:, 1].astype(float)
    sel = ref_voiced[np.clip(ref_idx.astype(int), 0, len(ref_voiced) - 1)]
    if sel.sum() < 10:
        return {"timing_looseness_ms": None, "timing_tempo_ratio": None}
    r, e = ref_idx[sel], est_idx[sel]
    A = np.vstack([r, np.ones_like(r)]).T
    coef, *_ = np.linalg.lstsq(A, e, rcond=None)
    resid_ms = (e - A @ coef) * FRAME_SEC * 1000.0
    return {"timing_looseness_ms": float(np.median(np.abs(resid_ms))),
            "timing_tempo_ratio": float(coef[0])}


# ============================================================================
# 4) Transposición
# ============================================================================
def estimate_transpose_semitones(ref_f0: np.ndarray, est_aligned_f0: np.ndarray) -> float:
    ref_midi = hz_to_midi(ref_f0)
    est_midi = hz_to_midi(est_aligned_f0)
    m = ~np.isnan(ref_midi) & ~np.isnan(est_midi)
    if m.sum() < 5:
        return 0.0
    return float(np.median(est_midi[m] - ref_midi[m]))


# ============================================================================
# 5) Afinación
# ============================================================================
def pitch_metrics(ref_f0: np.ndarray, est_f0: np.ndarray,
                  held_mask: Optional[np.ndarray] = None) -> dict:
    ref_time = np.arange(len(ref_f0)) * FRAME_SEC
    scores = mir_eval.melody.evaluate(ref_time, ref_f0, ref_time.copy(), est_f0)

    cents = cents_diff(est_f0, ref_f0)
    valid = ~np.isnan(cents)
    cw = wrap_cents(cents[valid]) if valid.any() else np.array([])
    raw = cents[valid] if valid.any() else np.array([])

    out = {
        "oct_inv_pct_within_50c": float(np.mean(np.abs(cw) < 50) * 100) if cw.size else None,
        "oct_inv_pct_within_100c": float(np.mean(np.abs(cw) < 100) * 100) if cw.size else None,
        "oct_inv_cents_median_abs": float(np.median(np.abs(cw))) if cw.size else None,
        "cents_bias": float(np.median(cw)) if cw.size else None,
        "raw_chroma_accuracy": float(scores["Raw Chroma Accuracy"]),
        "strict_pct_within_50c": float(np.mean(np.abs(raw) < 50) * 100) if raw.size else None,
        "raw_pitch_accuracy": float(scores["Raw Pitch Accuracy"]),
        "voicing_recall": float(scores["Voicing Recall"]),
        "voicing_false_alarm": float(scores["Voicing False Alarm"]),
    }
    if held_mask is not None:
        vh = valid & held_mask
        cwh = wrap_cents(cents[vh]) if vh.any() else np.array([])
        out["sustained_pct_within_50c"] = float(np.mean(np.abs(cwh) < 50) * 100) if cwh.size else None
        out["sustained_cents_median_abs"] = float(np.median(np.abs(cwh))) if cwh.size else None
    return out


# ============================================================================
# 6) Rango, vibrato, dinámica
# ============================================================================
def range_metrics(est_f0_clean: np.ndarray) -> dict:
    f = est_f0_clean[est_f0_clean > 0]
    if f.size < 5:
        return {}
    midi = hz_to_midi(f)
    floor = float(np.percentile(midi, 5))
    ceil = float(np.percentile(midi, 95))
    win = max(1, int(round(0.25 / FRAME_SEC)))
    mfull = hz_to_midi(np.where(est_f0_clean > 0, est_f0_clean, np.nan))
    sustained = np.nan
    for i in range(len(mfull) - win):
        seg = mfull[i:i + win]
        if np.isnan(seg).any():
            continue
        if np.std(seg) < 0.5:
            sustained = np.nanmax([sustained, np.mean(seg)])
    return {"highest_sustained_note": midi_to_note_name(sustained),
            "ceiling_note": midi_to_note_name(ceil),
            "floor_note": midi_to_note_name(floor),
            "working_range_semitones": float(round(ceil - floor, 1))}


def vibrato_metrics(est_f0_clean: np.ndarray) -> dict:
    mfull = hz_to_midi(np.where(est_f0_clean > 0, est_f0_clean, np.nan))
    voiced = ~np.isnan(mfull)
    runs, i, n = [], 0, len(mfull)
    while i < n:
        if voiced[i]:
            j = i
            while j < n and voiced[j]:
                j += 1
            if (j - i) * FRAME_SEC >= 0.5:
                runs.append((i, j))
            i = j
        else:
            i += 1
    rates, extents, fs = [], [], 1.0 / FRAME_SEC
    w = max(3, int(0.15 / FRAME_SEC))
    w = w if w % 2 == 1 else w + 1
    for a, b in runs:
        seg = mfull[a:b]
        osc = (seg - median_filter(seg, size=w)) * 100.0
        if len(osc) < 8:
            continue
        spec = np.abs(np.fft.rfft(osc * np.hanning(len(osc))))
        freqs = np.fft.rfftfreq(len(osc), d=1.0 / fs)
        band = (freqs >= 4) & (freqs <= 8)
        if not band.any() or spec[band].max() == 0:
            continue
        rate = float(freqs[band][np.argmax(spec[band])])
        extent = float(np.std(osc) * np.sqrt(2))
        if 20 <= extent <= 150:
            rates.append(rate)
            extents.append(extent)
    if len(rates) < 2:
        return {"detected": False}
    return {"detected": True,
            "vibrato_rate_hz": round(float(np.median(rates)), 2),
            "vibrato_extent_cents": round(float(np.median(extents)), 1)}


def dynamics_correlation(ref_audio: np.ndarray, est_audio: np.ndarray) -> Optional[float]:
    ref_rms = librosa.feature.rms(y=ref_audio, hop_length=HOP)[0]
    est_rms = librosa.feature.rms(y=est_audio, hop_length=HOP)[0]
    n = min(len(ref_rms), len(est_rms))
    if n < 5:
        return None
    r = np.corrcoef(ref_rms[:n], est_rms[:n])[0, 1]
    return float(r) if not np.isnan(r) else None


# ============================================================================
# Gráfico estático (PNG)
# ============================================================================
def make_plots(ref_f0: np.ndarray, est_scored: np.ndarray,
               est_real: np.ndarray, out_path: Path) -> None:
    t = np.arange(len(ref_f0)) * FRAME_SEC
    ref_midi = hz_to_midi(np.where(ref_f0 > 0, ref_f0, np.nan))
    est_midi = hz_to_midi(np.where(est_scored > 0, est_scored, np.nan))

    fig, axes = plt.subplots(3, 1, figsize=(13, 12))

    # (1) Contornos: las dos melodías
    ax = axes[0]
    ax.plot(t, ref_midi, label="Original (referencia)", linewidth=1.6)
    ax.plot(t, est_midi, label="Tu voz (alineada)", linewidth=1.2, alpha=0.85)
    ax.set_title("1) Melodías superpuestas — ¿qué notas cantó cada uno?")
    ax.set_xlabel("Tiempo (s)"); ax.set_ylabel("Nota (MIDI)")
    ax.legend(); ax.grid(alpha=0.3)

    # (2) Afinación por nota: TU melodía coloreada por acierto (verde->rojo)
    ax = axes[1]
    err = wrap_cents(cents_diff(est_scored, ref_f0))
    held = held_note_mask(est_scored)
    mask = held & ~np.isnan(est_midi) & ~np.isnan(err)
    ax.plot(t, ref_midi, color="0.82", linewidth=1.0, label="objetivo", zorder=1)
    sc = ax.scatter(t[mask], est_midi[mask], c=np.abs(err[mask]),
                    cmap="RdYlGn_r", vmin=0, vmax=100, s=7, zorder=2)
    cbar = fig.colorbar(sc, ax=ax)
    cbar.set_label("error (cents): 0=afinado, 100=un semitono")
    ax.set_title("2) Afinación por nota — verde=afinado, rojo=desafinado")
    ax.set_xlabel("Tiempo (s)"); ax.set_ylabel("Nota (MIDI)")
    ax.legend(loc="upper right"); ax.grid(alpha=0.3)

    # (3) Tu rango
    ax = axes[2]
    real = hz_to_midi(est_real[est_real > 0])
    if real.size:
        ax.hist(real, bins=40, color="#2E86AB")
        ax.set_title("3) Tu rango cantado (notas reales)")
        ax.set_xlabel("Nota (MIDI)"); ax.set_ylabel("Frames"); ax.grid(alpha=0.3)

    fig.tight_layout()
    fig.savefig(out_path, dpi=120)
    plt.close(fig)
    print(f"[plot] Gráfico estático guardado en {out_path}")


# ============================================================================
# Gráfico interactivo (HTML scrolleable)
# ============================================================================
def make_interactive_html(ref_f0: np.ndarray, est_scored: np.ndarray, out_path: Path) -> None:
    try:
        import plotly.graph_objects as go
        from plotly.subplots import make_subplots
    except ImportError:
        print("[html] plotly no instalado; salteo el interactivo (pip install plotly)")
        return

    t = np.arange(len(ref_f0)) * FRAME_SEC
    midi_e = hz_to_midi(np.where(est_scored > 0, est_scored, np.nan))
    midi_r = hz_to_midi(np.where(ref_f0 > 0, ref_f0, np.nan))
    err = wrap_cents(cents_diff(est_scored, ref_f0))
    held = held_note_mask(est_scored)
    mask = held & ~np.isnan(midi_e) & ~np.isnan(err)
    idx = np.where(mask)[0]

    fig = make_subplots(
        rows=2, cols=1, shared_xaxes=True, vertical_spacing=0.07,
        row_heights=[0.62, 0.38],
        subplot_titles=("Afinación por nota (color = error en cents)",
                        "Error en cents — franja verde = afinado (±50)"))

    fig.add_trace(go.Scatter(
        x=t, y=midi_r, mode="lines", line=dict(color="lightgray", width=1),
        name="objetivo", hoverinfo="skip"), row=1, col=1)

    hover = [f"{midi_to_note_name(midi_e[i])}  {err[i]:+.0f} cents" for i in idx]
    fig.add_trace(go.Scatter(
        x=t[mask], y=midi_e[mask], mode="markers",
        marker=dict(size=4, color=np.abs(err[mask]), colorscale="RdYlGn_r",
                    cmin=0, cmax=100, colorbar=dict(title="cents", len=0.5, y=0.78)),
        text=hover, hovertemplate="t=%{x:.1f}s<br>%{text}<extra></extra>",
        name="tu voz"), row=1, col=1)

    fig.add_trace(go.Scatter(
        x=t[mask], y=err[mask], mode="markers", marker=dict(size=3, color="firebrick"),
        name="error", hovertemplate="t=%{x:.1f}s<br>%{y:+.0f} cents<extra></extra>"),
        row=2, col=1)
    fig.add_hrect(y0=-50, y1=50, fillcolor="green", opacity=0.12, line_width=0, row=2, col=1)
    fig.add_hline(y=0, line=dict(color="black", width=1), row=2, col=1)

    fig.update_yaxes(title_text="Nota (MIDI)", row=1, col=1)
    fig.update_yaxes(title_text="Cents", range=[-200, 200], row=2, col=1)
    fig.update_xaxes(title_text="Tiempo (s)", rangeslider=dict(visible=True), row=2, col=1)
    fig.update_layout(height=720, hovermode="closest",
                      title="Análisis de afinación — arrastrá para mover, scroll para zoom")
    fig.write_html(str(out_path), include_plotlyjs=True)
    print(f"[html] Gráfico interactivo guardado en {out_path}  (abrilo en el navegador)")


# ============================================================================
# Reporte
# ============================================================================
def print_report(pm: dict, rm: dict, vm: dict, tim: dict, dyn, offset: float) -> None:
    def p(x): return f"{x:5.1f}%" if x is not None else "  n/a"
    def num(x, u=""): return f"{x:.1f}{u}" if x is not None else "n/a"
    def pct100(x): return p(x * 100 if x is not None else None)

    print("\n" + "=" * 60)
    print("            REPORTE DE CANTO (v3)")
    print("=" * 60)

    dirtxt = "más grave" if offset < 0 else "más agudo"
    print(f"\n  Tonalidad: cantaste ~{abs(offset):.1f} semitonos {dirtxt} que el original.")

    print("\n  AFINACIÓN (octava-invariante)")
    print(f"    En notas sostenidas (±50c) .... {p(pm.get('sustained_pct_within_50c'))}  <- lo más musical")
    print(f"    Todas las notas (±50c) ........ {p(pm.get('oct_inv_pct_within_50c'))}")
    print(f"    Todas las notas (±100c) ....... {p(pm.get('oct_inv_pct_within_100c'))}")
    print(f"    Error mediano ................. {num(pm.get('oct_inv_cents_median_abs'),' cents')}")
    b = pm.get("cents_bias")
    if b is not None:
        print(f"    Tendencia ..................... {num(b,' cents')} ({'tirás alto' if b>0 else 'tirás bajo'})")

    print("\n  RANGO (tu voz — hasta dónde llegás)")
    print(f"    Más aguda SOSTENIDA ........... {rm.get('highest_sustained_note','—')}  <- tu techo firme")
    print(f"    Techo (percentil 95) ......... {rm.get('ceiling_note','—')}")
    print(f"    Piso (percentil 5) ........... {rm.get('floor_note','—')}")
    print(f"    Rango de trabajo ............. {num(rm.get('working_range_semitones'),' semitonos')}")

    print("\n  TIEMPO (aproximado)")
    print(f"    Soltura local ................ {num(tim.get('timing_looseness_ms'),' ms')}")
    tr = tim.get("timing_tempo_ratio")
    if tr is not None:
        print(f"    Ritmo global vs original ..... {tr:.2f}x  (1.00 = misma velocidad)")

    if vm.get("detected"):
        print("\n  VIBRATO")
        print(f"    Velocidad .................... {num(vm.get('vibrato_rate_hz'),' Hz')}")
        print(f"    Amplitud ..................... {num(vm.get('vibrato_extent_cents'),' cents')}")
    else:
        print("\n  VIBRATO ........................ no detectado con claridad")

    if dyn is not None:
        print("\n  DINÁMICA")
        print(f"    Correlación de matices ....... {dyn:.2f}  (1.0 = seguís los subes/bajas)")

    print("\n" + "=" * 60)
    print("  Mirá analisis_out/analisis.html (interactivo) para explorar la")
    print("  afinación con zoom y scroll.")
    print("=" * 60 + "\n")


# ============================================================================
# Main
# ============================================================================
def load_mono(path: Path) -> np.ndarray:
    audio, _ = librosa.load(str(path), sr=SR, mono=True)
    return audio.astype(np.float32)


def run_compare(args) -> None:
    song, voice = Path(args.song), Path(args.voice)
    for pth in (song, voice):
        if not pth.exists():
            sys.exit(f"[error] No existe el archivo: {pth}")
    work = Path(args.workdir)
    work.mkdir(exist_ok=True)

    ref_audio = load_mono(separate_vocals(song, work / "demucs"))
    if args.separate_voice:
        est_audio = load_mono(separate_vocals(voice, work / "demucs"))
    else:
        est_audio = load_mono(voice)

    print(f"[pitch] Extrayendo F0 con '{args.pitch}' (compuerta de silencio = {args.silence})...")
    ref_f0_raw, ref_voiced = extract_f0(ref_audio, method=args.pitch, silence_rel=args.silence)
    est_f0_raw, _ = extract_f0(est_audio, method=args.pitch, silence_rel=args.silence)
    ref_f0 = clean_f0(ref_f0_raw)
    est_f0 = clean_f0(est_f0_raw)

    print("[align] Alineando con DTW sobre chroma...")
    wp = align_dtw(ref_audio, est_audio)
    est_aligned = warp_est_to_ref(est_f0, wp, len(ref_f0))
    tim = timing_metrics(wp, ref_voiced)

    offset = 0.0 if args.no_detranspose else estimate_transpose_semitones(ref_f0, est_aligned)
    est_scored = np.where(est_aligned > 0, est_aligned * (2.0 ** (-offset / 12.0)), 0.0)

    held = held_note_mask(est_scored)
    pm = pitch_metrics(ref_f0, est_scored, held_mask=held)
    rm = range_metrics(est_f0)
    vm = vibrato_metrics(est_f0)
    dyn = dynamics_correlation(ref_audio, est_audio)

    print_report(pm, rm, vm, tim, dyn, offset)
    make_plots(ref_f0, est_scored, est_f0, work / "analisis.png")
    make_interactive_html(ref_f0, est_scored, work / "analisis.html")

    report = {"transpose_semitones": offset, "pitch": pm, "timing": tim,
              "range": rm, "vibrato": vm, "dynamics_corr": dyn}
    (work / "reporte.json").write_text(json.dumps(report, indent=2, ensure_ascii=False))
    print(f"[json] Reporte guardado en {work / 'reporte.json'}")


# ============================================================================
# Modo preprocesado: emite el objetivo del carril en vivo + F0 para el reporte
# ============================================================================
def run_preprocess(args) -> None:
    song = Path(args.song)
    if not song.exists():
        sys.exit(f"[error] No existe el archivo: {song}")
    work = Path(args.workdir)
    work.mkdir(exist_ok=True)

    ref_audio = load_mono(separate_vocals(song, work / "demucs"))
    print(f"[pitch] Extrayendo F0 de la referencia con '{args.pitch}' "
          f"(compuerta de silencio = {args.silence})...")
    ref_f0_raw, _ = extract_f0(ref_audio, method=args.pitch, silence_rel=args.silence)
    ref_f0 = clean_f0(ref_f0_raw)

    notes = quantize_to_notes(ref_f0, FRAME_SEC,
                              min_dur=args.min_note, merge_gap=args.merge_gap)
    key = detect_key(notes)
    if args.snap_to_key:
        notes = snap_notes_to_scale(notes, key)
    payload = build_notes_payload(notes, ref_f0, key)

    notes_path = work / "notes.json"
    notes_path.write_text(json.dumps(payload, ensure_ascii=False, separators=(",", ":")))
    ref_path = work / "reference.npz"
    np.savez_compressed(ref_path, f0=ref_f0.astype(np.float32),
                        frame_sec=np.float32(FRAME_SEC))

    voiced_pct = float(np.mean(ref_f0 > 0) * 100)
    print("\n" + "=" * 60)
    print("            PREPROCESADO (objetivo del carril en vivo)")
    print("=" * 60)
    print(f"  Duración ........... {payload['duration']:.1f} s")
    print(f"  Tonalidad .......... {key['name']}  (conf. {key['confidence']:.2f})")
    print(f"  Notas detectadas ... {len(payload['notes'])}")
    if payload["midi_min"] is not None:
        print(f"  Rango objetivo ..... {midi_to_note_name(payload['midi_min'])} "
              f"- {midi_to_note_name(payload['midi_max'])}")
    print(f"  Frames con voz ..... {voiced_pct:.1f}%")
    print(f"\n  notes.json ......... {notes_path}   <- lo trae el front")
    print(f"  reference.npz ...... {ref_path}   <- F0 cruda para el reporte")
    print("=" * 60 + "\n")


def main() -> None:
    ap = argparse.ArgumentParser(description="Análisis de canto vs voz original (v3).")
    ap.add_argument("--preprocess", action="store_true",
                    help="Modo preprocesado: separa la voz de --song y emite "
                         "notes.json (objetivo del carril) + reference.npz. No usa --voice.")
    ap.add_argument("--song", default="song.mp3")
    ap.add_argument("--voice", default="voice.mp3")
    ap.add_argument("--pitch", choices=["crepe", "pyin"], default="crepe")
    ap.add_argument("--silence", type=float, default=0.03,
                    help="umbral de compuerta de silencio (fracción del pico de energía)")
    ap.add_argument("--separate-voice", action="store_true")
    ap.add_argument("--no-detranspose", action="store_true")
    ap.add_argument("--workdir", default="./analisis_out")
    ap.add_argument("--min-note", type=float, default=0.10,
                    help="[preprocess] duración mínima de nota en s (más bajo deja "
                         "pasar notas rápidas; más alto ignora más transiciones)")
    ap.add_argument("--merge-gap", type=float, default=0.06,
                    help="[preprocess] huecos <= este valor (s) entre notas del "
                         "mismo tono se fusionan")
    ap.add_argument("--snap-to-key", action="store_true",
                    help="[preprocess] LOSSY: lleva cada nota a la escala de la "
                         "tonalidad. Apagado por defecto (aplasta cromatismos).")
    args = ap.parse_args()

    if args.preprocess:
        run_preprocess(args)
    else:
        run_compare(args)


if __name__ == "__main__":
    main()
