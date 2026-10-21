"""Kokoro TTS sidecar of services/voice (ADR-017).

POST /synthesize {text, language, voice?, speed?} -> audio/pcm: PCM s16le mono 24 kHz, chunked.
GET /health -> {"ok": true} once the model is loaded; 503 with the reason otherwise.
Model files are read from KOKORO_DIR (kokoro-v1.0.onnx, voices-v1.0.bin).
"""

from __future__ import annotations

import os
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from dataclasses import dataclass
from pathlib import Path
from typing import Literal, Protocol

import numpy as np
from fastapi import FastAPI, Response
from fastapi.responses import JSONResponse, StreamingResponse
from kokoro_onnx import Kokoro
from pydantic import BaseModel, Field

SAMPLE_RATE = 24_000
MODEL_FILE = "kokoro-v1.0.onnx"
VOICES_FILE = "voices-v1.0.bin"

# kokoro-onnx takes espeak language names; the default voice per language is the one the research picked.
ESPEAK_LANG: dict[str, str] = {"pt": "pt-br", "en": "en-us", "es": "es"}
DEFAULT_VOICE: dict[str, str] = {"pt": "pf_dora", "en": "af_heart", "es": "ef_dora"}

Language = Literal["pt", "en", "es"]


class SynthesizeBody(BaseModel):
    text: str = Field(min_length=1)
    language: Language
    voice: str | None = None
    speed: float | None = Field(default=None, gt=0)


class Speech(Protocol):
    def has_voice(self, name: str) -> bool: ...

    def stream(self, text: str, lang: str, voice: str, speed: float) -> AsyncIterator[np.ndarray]: ...


class KokoroSpeech:
    def __init__(self, model_path: Path, voices_path: Path) -> None:
        self._kokoro = Kokoro(str(model_path), str(voices_path))

    def has_voice(self, name: str) -> bool:
        try:
            self._kokoro.get_voice_style(name)
        except KeyError:
            return False
        return True

    async def stream(self, text: str, lang: str, voice: str, speed: float) -> AsyncIterator[np.ndarray]:
        async for samples, _rate in self._kokoro.create_stream(text, voice, speed, lang=lang):
            yield samples


def default_kokoro_dir() -> Path:
    configured = os.environ.get("KOKORO_DIR", "").strip()
    return Path(configured).expanduser() if configured else Path.home() / ".app" / "voice" / "kokoro"


def load_speech(kokoro_dir: Path) -> KokoroSpeech:
    model = kokoro_dir / MODEL_FILE
    voices = kokoro_dir / VOICES_FILE
    for required in (model, voices):
        if not required.is_file():
            raise FileNotFoundError(f"missing {required.name} in {kokoro_dir}")
    return KokoroSpeech(model, voices)


def pcm_s16le(samples: np.ndarray) -> bytes:
    clipped = np.clip(np.asarray(samples, dtype=np.float32), -1.0, 1.0)
    return (clipped * 32767.0).astype("<i2").tobytes()


@dataclass
class _State:
    speech: Speech | None
    error: str | None = None


def create_app(speech: Speech | None = None, kokoro_dir: Path | None = None) -> FastAPI:
    state = _State(speech=speech, error=None if speech is not None else "model not loaded")

    @asynccontextmanager
    async def lifespan(_app: FastAPI) -> AsyncIterator[None]:
        if state.speech is None:
            try:
                state.speech = load_speech(kokoro_dir or default_kokoro_dir())
                state.error = None
            except (OSError, RuntimeError, ValueError) as cause:
                # Kept as a health reason, so the supervisor sees "unavailable" instead of a crash loop.
                state.error = str(cause)
        yield

    app = FastAPI(lifespan=lifespan)

    @app.get("/health")
    def health() -> Response:
        if state.speech is None:
            return JSONResponse({"ok": False, "error": state.error or "model not loaded"}, status_code=503)
        return JSONResponse({"ok": True})

    @app.post("/synthesize")
    async def synthesize(body: SynthesizeBody) -> Response:
        speech = state.speech
        if speech is None:
            return JSONResponse({"error": state.error or "model not loaded"}, status_code=503)
        voice = body.voice or DEFAULT_VOICE[body.language]
        # Checked before streaming starts: once the 200 is sent, an error could not change the status.
        if not speech.has_voice(voice):
            return JSONResponse({"error": f"unknown voice {voice}"}, status_code=400)
        speed = body.speed if body.speed is not None else 1.0
        lang = ESPEAK_LANG[body.language]

        async def chunks() -> AsyncIterator[bytes]:
            async for samples in speech.stream(body.text, lang, voice, speed):
                yield pcm_s16le(samples)

        return StreamingResponse(chunks(), media_type="audio/pcm")

    return app


app = create_app()
