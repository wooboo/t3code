"""Prototype loopback STT endpoint, using the pilot's cached MLX Parakeet model.

Run with the speech-to-speech Python environment plus python-multipart.
Both A and B can target this endpoint to hold ASR weights constant.
"""
import argparse
import io
import threading

import mlx.core as mx
import numpy as np
import soundfile as sf
import uvicorn
from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from mlx_audio.stt.generate import load_model
from scipy.signal import resample_poly
from math import gcd

parser = argparse.ArgumentParser()
parser.add_argument("--port", type=int, default=18090)
parser.add_argument("--model", default="mlx-community/parakeet-tdt-0.6b-v3")
args = parser.parse_args()
model = load_model(args.model)
lock = threading.Lock()
app = FastAPI()


@app.get("/health")
def health():
    return {"ok": True, "model": args.model, "language": "auto"}


@app.post("/v1/audio/transcriptions")
def transcribe(file: UploadFile = File(...), model_name: str = Form("", alias="model")):
    if model_name and model_name != args.model:
        raise HTTPException(400, "Model does not match the loaded Parakeet model")
    audio, rate = sf.read(io.BytesIO(file.file.read(16 * 1024 * 1024)), dtype="float32")
    if audio.ndim > 1:
        audio = audio.mean(axis=1)
    if rate != 16000:
        factor = gcd(rate, 16000)
        audio = resample_poly(audio, 16000 // factor, rate // factor).astype(np.float32)
    with lock:
        text = model.decode_chunk(mx.array(audio), verbose=False).text.strip()
    return {"text": text}


if __name__ == "__main__":
    uvicorn.run(app, host="127.0.0.1", port=args.port)
