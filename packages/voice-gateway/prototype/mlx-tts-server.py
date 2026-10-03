"""Single-request local MLX TTS endpoint for the transport comparison.

Run using the isolated MLX environment, e.g.:
/tmp/t3-breeze-eval/.venv/bin/python packages/voice-gateway/prototype/mlx-tts-server.py
Both arms must use this URL, model, voice=neutral, and PCM sample rate=24000.
"""
import json
import os
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from threading import Lock
from concurrent.futures import ThreadPoolExecutor

import numpy as np

MODEL = os.environ.get("VOICE_MLX_TTS_MODEL", "mlx-community/Breeze-TTS-2-mlx-4bit")
PORT = int(os.environ.get("VOICE_MLX_TTS_PORT", "18091"))
def load_local_model():
    from mlx_audio.tts.utils import load_model
    return load_model(MODEL)


# MLX streams are thread-local: load and run the model on the same worker.
inference = ThreadPoolExecutor(max_workers=1)
model = inference.submit(load_local_model).result()
model_lock = Lock()


class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        if self.path != "/health":
            self.send_error(404)
            return
        payload = json.dumps({"model": MODEL, "sample_rate": 24000, "inference": "local"}).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def do_POST(self):
        if self.path != "/v1/audio/speech":
            self.send_error(404)
            return
        try:
            size = int(self.headers.get("Content-Length", "0"))
            if not 0 < size <= 65536:
                raise ValueError("Invalid request size")
            body = json.loads(self.rfile.read(size))
            text = body.get("input")
            if not isinstance(text, str) or not 0 < len(text) <= 4000:
                raise ValueError("input must contain 1–4000 characters")
            if body.get("model", MODEL) != MODEL or body.get("response_format", "pcm") != "pcm":
                raise ValueError("Use the configured model and PCM output")
            if body.get("voice", "neutral") != "neutral":
                raise ValueError("Only the neutral test voice is configured")
        except (ValueError, TypeError):
            self.send_error(400, "Invalid speech request")
            return
        if not model_lock.acquire(timeout=90):
            self.send_error(503, "Local TTS is busy; retry after the current utterance")
            return
        return inference.submit(self.synthesize, text).result()

    def synthesize(self, text):
        started = False
        try:
            for chunk in model.generate(text=text, instruct="A clear, calm, neutral adult speaker.",
                                        seed=42, stream=True, streaming_interval=1.0):
                if chunk.sample_rate != 24000:
                    raise ValueError("Model sample rate must be 24000 Hz")
                pcm = (np.clip(np.asarray(chunk.audio), -1, 1) * 32767).astype("<i2").tobytes()
                if not started:
                    self.send_response(200)
                    self.send_header("Content-Type", "application/octet-stream")
                    self.send_header("Connection", "close")
                    self.end_headers()
                    started = True
                self.wfile.write(pcm)
                self.wfile.flush()
            if not started:
                self.send_error(502, "Model returned no audio")
        except (BrokenPipeError, ConnectionResetError):
            pass
        except Exception as error:
            print(f"TTS failed: {type(error).__name__}: {error}", flush=True)
            if not started:
                self.send_error(502, "Local TTS failed")
        finally:
            model_lock.release()
            self.close_connection = True


print(f"Local MLX TTS {MODEL}: http://127.0.0.1:{PORT}/v1", flush=True)
ThreadingHTTPServer(("127.0.0.1", PORT), Handler).serve_forever()
