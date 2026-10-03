"""Local streaming bridge: OpenAI audio/speech -> ElevenLabs Flash.

Launched by scripts/voice-front/compare.mjs using the speech Python environment.
Credentials are read from ~/.config/elevenlabs/api-key, never from requests.
"""

import os
from contextlib import asynccontextmanager
from pathlib import Path

import anyio
import httpx
import uvicorn
from fastapi import FastAPI, HTTPException
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field

VOICE = os.environ["VOICE_COMPARE_TTS_VOICE"]
MODEL = os.environ.get("VOICE_COMPARE_TTS_MODEL", "eleven_flash_v2_5")


@asynccontextmanager
async def lifespan(app):
    key = (Path.home() / ".config/elevenlabs/api-key").read_text().strip()
    async with httpx.AsyncClient(
        base_url="https://api.elevenlabs.io", headers={"xi-api-key": key}, timeout=30
    ) as client:
        app.state.client = client
        yield


app = FastAPI(lifespan=lifespan)


class SpeechInput(BaseModel):
    input: str = Field(min_length=1, max_length=40000)
    response_format: str = "pcm"
    voice: str = VOICE
    model: str = MODEL


@app.get("/health")
async def health():
    return {"ok": True, "model": MODEL, "voice": VOICE, "sample_rate": 16000}


@app.post("/v1/audio/speech")
async def speech(body: SpeechInput):
    if body.response_format != "pcm":
        raise HTTPException(400, "Only PCM is supported")
    if body.voice != VOICE or body.model != MODEL:
        raise HTTPException(400, "Use the configured comparison voice and model")
    client = app.state.client
    request = client.build_request(
        "POST", f"/v1/text-to-speech/{VOICE}/stream",
        params={"output_format": "pcm_16000"},
        json={"text": body.input, "model_id": MODEL},
    )
    try:
        response = await client.send(request, stream=True)
    except httpx.HTTPError:
        raise HTTPException(502, "ElevenLabs transport failed") from None
    if response.status_code != 200:
        status = response.status_code
        await response.aclose()
        raise HTTPException(502, f"ElevenLabs returned HTTP {status}")

    async def audio():
        try:
            async for chunk in response.aiter_bytes():
                yield chunk
        finally:
            # Runs on completion and client disconnect (barge-in cancellation).
            with anyio.CancelScope(shield=True):
                await response.aclose()

    return StreamingResponse(audio(), media_type="audio/pcm")


if __name__ == "__main__":
    uvicorn.run(app, host="127.0.0.1", port=18092)
