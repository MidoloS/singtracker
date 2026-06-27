#!/usr/bin/env python3
"""
worker_job.py — entrypoint del Cloud Run Job (preprocesado).

Adapta el motor (script.py) de "archivos locales" a "R2 in, R2 out":
  1) baja el MP3 de R2 (INPUT_KEY) a /tmp,
  2) corre el preprocesado del motor (separa voz, F0, cuantiza a notas),
  3) sube notes.json + reference.npz a R2 bajo RESULT_PREFIX,
  4) borra el upload temporal (privacidad: no guardamos el audio crudo).

No es un servidor HTTP: es el cuerpo de un job batch que corre hasta terminar.
La API que lo dispara es otra pieza (api.py).

Env del Job (estático, del deploy): R2_ENDPOINT, R2_BUCKET, R2_ACCESS_KEY_ID,
  R2_SECRET_ACCESS_KEY, y opcionales PITCH / SILENCE / MIN_NOTE / MERGE_GAP.
Env por corrida (override de la API): INPUT_KEY, RESULT_PREFIX.
"""
import os
import tempfile
from pathlib import Path
from types import SimpleNamespace

import boto3

import script  # el motor; importarlo NO dispara su main()


def _s3():
    return boto3.client(
        "s3",
        endpoint_url=os.environ["R2_ENDPOINT"],
        aws_access_key_id=os.environ["R2_ACCESS_KEY_ID"],
        aws_secret_access_key=os.environ["R2_SECRET_ACCESS_KEY"],
        region_name="auto",
    )


def main() -> None:
    bucket = os.environ["R2_BUCKET"]
    input_key = os.environ["INPUT_KEY"]
    result_prefix = os.environ["RESULT_PREFIX"].rstrip("/")
    s3 = _s3()

    work = Path(tempfile.mkdtemp(prefix="job_"))
    mp3 = work / "input.mp3"
    print(f"[r2] get s3://{bucket}/{input_key} -> {mp3}")
    s3.download_file(bucket, input_key, str(mp3))

    out = work / "out"
    # Reusa exactamente la orquestación del motor (no duplicamos lógica).
    args = SimpleNamespace(
        song=str(mp3),
        workdir=str(out),
        pitch=os.environ.get("PITCH", "pyin"),     # pyin: rápido en CPU
        silence=float(os.environ.get("SILENCE", "0.03")),
        min_note=float(os.environ.get("MIN_NOTE", "0.10")),
        merge_gap=float(os.environ.get("MERGE_GAP", "0.06")),
        snap_to_key=os.environ.get("SNAP_TO_KEY", "") == "1",
    )
    script.run_preprocess(args)   # escribe notes.json + reference.npz en out/

    for fname, ctype in (("notes.json", "application/json"),
                         ("reference.npz", "application/octet-stream")):
        src = out / fname
        dst = f"{result_prefix}/{fname}"
        print(f"[r2] put {src} -> s3://{bucket}/{dst}")
        s3.upload_file(str(src), bucket, dst, ExtraArgs={"ContentType": ctype})

    s3.delete_object(Bucket=bucket, Key=input_key)
    print("[done] preprocesado subido; upload borrado")


if __name__ == "__main__":
    main()
