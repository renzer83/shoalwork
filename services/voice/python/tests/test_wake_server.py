import io
import json

import numpy as np
import pytest

from wake_server import FRAME_BYTES, FRAME_SAMPLES, main, read_frame, run

MARKER = 1234


class FakePredictor:
    """Stands in for openWakeWord: a frame whose first sample is MARKER scores 0.93, any other 0.01."""

    def __init__(self) -> None:
        self.frames: list[np.ndarray] = []

    def predict(self, frame: np.ndarray) -> dict[str, float]:
        self.frames.append(frame)
        return {"hey_test": 0.93 if int(frame[0]) == MARKER else 0.01}


def frame_bytes(first: int) -> bytes:
    samples = np.zeros(FRAME_SAMPLES, dtype="<i2")
    samples[0] = first
    return samples.tobytes()


def decode_lines(sink: io.StringIO) -> list[dict[str, object]]:
    return [json.loads(line) for line in sink.getvalue().splitlines()]


def test_emits_ready_then_one_line_per_detection_with_its_timestamp() -> None:
    source = io.BytesIO(frame_bytes(0) + frame_bytes(MARKER) + frame_bytes(0) + frame_bytes(MARKER))
    sink = io.StringIO()

    code = run(FakePredictor(), 0.5, source, sink)

    assert code == 0
    assert decode_lines(sink) == [
        {"ready": True},
        {"wake": "hey_test", "score": 0.93, "t": 80},
        {"wake": "hey_test", "score": 0.93, "t": 240},
    ]


def test_threshold_is_inclusive_and_scores_below_it_are_silent() -> None:
    source = io.BytesIO(frame_bytes(MARKER))
    sink = io.StringIO()

    run(FakePredictor(), 0.93, source, sink)
    below = io.StringIO()
    run(FakePredictor(), 0.94, io.BytesIO(frame_bytes(MARKER)), below)

    assert decode_lines(sink)[1:] == [{"wake": "hey_test", "score": 0.93, "t": 0}]
    assert decode_lines(below) == [{"ready": True}]


def test_feeds_each_frame_as_1280_little_endian_int16_samples() -> None:
    predictor = FakePredictor()
    samples = np.arange(-640, 640, dtype="<i2")
    source = io.BytesIO(samples.tobytes())

    run(predictor, 0.5, source, io.StringIO())

    assert len(predictor.frames) == 1
    assert predictor.frames[0].dtype == np.int16
    assert predictor.frames[0].tolist() == samples.tolist()


def test_a_trailing_partial_frame_is_dropped() -> None:
    predictor = FakePredictor()
    source = io.BytesIO(frame_bytes(0) + b"\x01" * 100)

    run(predictor, 0.5, source, io.StringIO())

    assert len(predictor.frames) == 1


def test_read_frame_returns_none_at_end_of_input() -> None:
    assert read_frame(io.BytesIO(b"")) is None
    assert read_frame(io.BytesIO(b"\x00" * (FRAME_BYTES - 1))) is None
    assert read_frame(io.BytesIO(b"\x00" * FRAME_BYTES)) == b"\x00" * FRAME_BYTES


def test_rejects_a_threshold_outside_zero_to_one() -> None:
    with pytest.raises(SystemExit) as excinfo:
        main(["--threshold", "1.5"])

    assert excinfo.value.code == 2


def test_missing_model_exits_with_a_reason_on_stderr(capsys: pytest.CaptureFixture[str]) -> None:
    code = main(["--model", "/nonexistent/shoalwork-wake.onnx"])

    captured = capsys.readouterr()
    assert code == 1
    assert "wake model could not be loaded" in captured.err
    assert "download_models" in captured.err
    assert captured.out == ""
