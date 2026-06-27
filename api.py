#!/usr/bin/env python3
"""
api.py — API fina que dispara el job de preprocesado. NO procesa audio.

  POST /uploads        -> {key, upload_url}      presigned PUT a R2
  POST /jobs {key}     -> 202 {job_id}           ejecuta el Cloud Run Job
  GET  /jobs/{job_id}  -> {status, notes_url?}   polea el artefacto en R2

El trabajo pesado vive en el Job (worker_job.py), no acá. Esta API puede correr
en Cloud Run (Service) o, igual de bien, en un Worker de Cloudflare.

Env: R2_ENDPOINT, R2_BUCKET, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY,
     GCP_PROJECT, GCP_REGION, JOB_NAME
"""
import os
import uuid

import boto3
from botocore.exceptions import ClientError
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel
from google.cloud import run_v2

app = FastAPI()

BUCKET = os.environ["R2_BUCKET"]
UPLOAD_TTL = 600     # 10 min para subir
RESULT_TTL = 3600    # 1 h para leer el resultado


def _s3():
    # R2 es S3-compatible: mismo cliente, otro endpoint.
    return boto3.client(
        "s3",
        endpoint_url=os.environ["R2_ENDPOINT"],
        aws_access_key_id=os.environ["R2_ACCESS_KEY_ID"],
        aws_secret_access_key=os.environ["R2_SECRET_ACCESS_KEY"],
        region_name="auto",
    )


@app.post("/uploads")
def create_upload():
    # El navegador sube el MP3 DIRECTO a R2 con esta URL (los bytes no pasan
    # por la API).
    key = f"uploads/{uuid.uuid4().hex}.mp3"
    url = _s3().generate_presigned_url(
        "put_object",
        Params={"Bucket": BUCKET, "Key": key, "ContentType": "audio/mpeg"},
        ExpiresIn=UPLOAD_TTL,
    )
    return {"key": key, "upload_url": url}


class JobReq(BaseModel):
    key: str


@app.post("/jobs", status_code=202)
def create_job(req: JobReq):
    job_id = uuid.uuid4().hex
    job_name = (f"projects/{os.environ['GCP_PROJECT']}"
                f"/locations/{os.environ['GCP_REGION']}"
                f"/jobs/{os.environ['JOB_NAME']}")
    # Dispara la ejecución (fire-and-forget). El Job ya tiene su env estático
    # (R2_*, etc.) del deploy; acá sólo sobreescribimos lo que cambia por corrida.
    client = run_v2.JobsClient()
    client.run_job(request={
        "name": job_name,
        "overrides": {
            "container_overrides": [{
                "env": [
                    {"name": "INPUT_KEY", "value": req.key},
                    {"name": "RESULT_PREFIX", "value": f"results/{job_id}"},
                ]
            }]
        },
    })
    return {"job_id": job_id}


@app.get("/jobs/{job_id}")
def job_status(job_id: str):
    # Patrón "polear el artefacto": ¿existe ya results/<id>/notes.json?
    s3 = _s3()
    key = f"results/{job_id}/notes.json"
    try:
        s3.head_object(Bucket=BUCKET, Key=key)
    except ClientError as e:
        if e.response["Error"]["Code"] in ("404", "NoSuchKey", "NotFound"):
            return {"status": "processing"}
        raise HTTPException(502, "storage error")
    url = s3.generate_presigned_url(
        "get_object",
        Params={"Bucket": BUCKET, "Key": key},
        ExpiresIn=RESULT_TTL,
    )
    return {"status": "done", "notes_url": url}
