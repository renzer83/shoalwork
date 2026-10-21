from collections.abc import AsyncIterator
from pathlib import Path

import numpy as np
from fastapi.testclient import TestClient

from tts_server import create_app, pcm_s16le


class FakeSpeech:
    def __init__(self, chunks: list[np.ndarray]) -> None:
        self._chunks = chunks
        self.voices = {"pf_dora", "af_heart", "ef_dora"}
        self.calls: list[tuple[str, str, str, float]] = []

    def has_voice(self, name: str) -> bool:
        return name in self.voices

    async def stream(self, text: str, lang: str, voice: str, speed: float) -> AsyncIterator[np.ndarray]:
        self.calls.append((text, lang, voice, speed))
        for chunk in self._chunks:
            yield chunk


def test_health_is_ok_when_speech_is_loaded() -> None:
    client = TestClient(create_app(speech=FakeSpeech([])))

    response = client.get("/health")

    assert response.status_code == 200
    assert response.json() == {"ok": True}


def test_health_reports_unavailable_with_reason_when_model_files_are_missing(tmp_path: Path) -> None:
    with TestClient(create_app(kokoro_dir=tmp_path)) as client:
        response = client.get("/health")
        synth = client.post("/synthesize", json={"text": "teste", "language": "pt"})

    assert response.status_code == 503
    assert response.json()["ok"] is False
    assert "kokoro-v1.0.onnx" in response.json()["error"]
    assert synth.status_code == 503


def test_synthesize_streams_pcm_s16le_with_the_language_voice_and_lang_code() -> None:
    fake = FakeSpeech([np.array([0.0, 0.5, -0.5, 1.5], dtype=np.float32), np.array([-1.5], dtype=np.float32)])
    client = TestClient(create_app(speech=fake))

    response = client.post("/synthesize", json={"text": "teste", "language": "pt"})

    assert response.status_code == 200
    assert response.headers["content-type"] == "audio/pcm"
    expected = pcm_s16le(np.array([0.0, 0.5, -0.5, 1.5, -1.5], dtype=np.float32))
    assert response.content == expected
    assert fake.calls == [("teste", "pt-br", "pf_dora", 1.0)]


def test_synthesize_rejects_unknown_language_and_unknown_voice() -> None:
    client = TestClient(create_app(speech=FakeSpeech([])))

    bad_language = client.post("/synthesize", json={"text": "teste", "language": "fr"})
    bad_voice = client.post("/synthesize", json={"text": "teste", "language": "en", "voice": "nope"})

    assert bad_language.status_code == 422
    assert bad_voice.status_code == 400


def test_pcm_conversion_clips_to_the_s16_range_little_endian() -> None:
    samples = np.array([1.0, -1.0, 0.0, 2.0], dtype=np.float32)

    assert pcm_s16le(samples) == np.array([32767, -32767, 0, 32767], dtype="<i2").tobytes()
