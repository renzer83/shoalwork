"""Wake word sidecar of services/voice (ADR-017, research voice-local.md §3).

stdin: raw PCM s16le mono 16 kHz, read in frames of 1280 samples (80 ms). A partial frame at the end is dropped.
stdout: one JSON line per event, flushed at once:
  {"ready": true}                              once, when the model is loaded
  {"wake": "<model name>", "score": 0.93, "t": 160}   per frame whose score reaches the threshold
  `t` is milliseconds since the first frame received by this process.
Diagnostics go to stderr only, so the protocol on stdout is never polluted.
"""

from __future__ import annotations

import argparse
import json
import sys
from collections.abc import Sequence
from typing import BinaryIO, Protocol, TextIO

import numpy as np

FRAME_SAMPLES = 1280
FRAME_BYTES = FRAME_SAMPLES * 2
FRAME_MS = 80
DEFAULT_MODEL = "hey_jarvis"
DEFAULT_THRESHOLD = 0.5


class Predictor(Protocol):
    def predict(self, frame: np.ndarray) -> dict[str, float]: ...


def read_frame(source: BinaryIO) -> bytes | None:
    """Exactly one frame, or None at end of input (a trailing partial frame is dropped)."""
    buffer = bytearray()
    while len(buffer) < FRAME_BYTES:
        chunk = source.read(FRAME_BYTES - len(buffer))
        if not chunk:
            return None
        buffer += chunk
    return bytes(buffer)


def write_line(sink: TextIO, message: dict[str, object]) -> None:
    sink.write(json.dumps(message) + "\n")
    sink.flush()


def run(predictor: Predictor, threshold: float, source: BinaryIO, sink: TextIO) -> int:
    write_line(sink, {"ready": True})
    index = 0
    while True:
        raw = read_frame(source)
        if raw is None:
            return 0
        samples = np.frombuffer(raw, dtype="<i2").astype(np.int16)
        scores = predictor.predict(samples)
        t = index * FRAME_MS
        for name, score in scores.items():
            if score >= threshold:
                write_line(sink, {"wake": name, "score": round(float(score), 4), "t": t})
        index += 1


def load_model(model: str) -> Predictor:
    from openwakeword.model import Model

    return Model(wakeword_models=[model], inference_framework="onnx")


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="openWakeWord sidecar (stdin PCM, stdout JSON lines)")
    parser.add_argument("--model", default=DEFAULT_MODEL, help="path to an .onnx model or a pretrained name")
    parser.add_argument("--threshold", type=float, default=DEFAULT_THRESHOLD)
    args = parser.parse_args(argv)
    if not 0 < args.threshold <= 1:
        parser.error("--threshold must be in (0, 1]")

    protocol = sys.stdout
    # Library prints must not reach the protocol.
    sys.stdout = sys.stderr
    try:
        predictor = load_model(args.model)
    except Exception as cause:
        print(
            f"wake model could not be loaded ({type(cause).__name__}): {cause}. "
            "Run openwakeword.utils.download_models() once (research voice-local.md §3).",
            file=sys.stderr,
        )
        return 1
    return run(predictor, args.threshold, sys.stdin.buffer, protocol)


if __name__ == "__main__":
    raise SystemExit(main())
