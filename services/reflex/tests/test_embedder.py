"""Embedder behaviour with a fake tokenizer and ONNX session: no network, no real model.

The real export is checked by `reflex-model bench` (see the CLI), not by pytest.
"""

import threading
import time
import zlib
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from typing import Any

import numpy as np
import pytest

from reflex.model import embedder as embedder_module
from reflex.model.embedder import BATCH_MAX, DIMS, EMBED_CACHE_ENV, Embedder, EmbedderError

VOCAB = 997
# One fixed vector per token id: the fake model's "hidden states" are rows of this table.
TABLE = np.random.default_rng(7).standard_normal((VOCAB, DIMS)).astype(np.float32)


def token_ids(text: str, max_length: int) -> list[int]:
    return [zlib.crc32(token.encode("utf-8")) % VOCAB for token in text.split()][:max_length]


class FakeTokenizer:
    def __init__(self) -> None:
        self.seen: list[list[str]] = []

    def __call__(
        self, texts: list[str], padding: bool, truncation: bool, max_length: int, return_tensors: str
    ) -> dict[str, np.ndarray]:
        self.seen.append(list(texts))
        rows = [token_ids(text, max_length) for text in texts]
        width = max(len(row) for row in rows)
        input_ids = np.zeros((len(rows), width), dtype=np.int64)
        attention_mask = np.zeros((len(rows), width), dtype=np.int64)
        for index, row in enumerate(rows):
            input_ids[index, : len(row)] = row
            attention_mask[index, : len(row)] = 1
        return {"input_ids": input_ids, "attention_mask": attention_mask}


class _Input:
    def __init__(self, name: str) -> None:
        self.name = name


class FakeSession:
    def __init__(self) -> None:
        self.batch_sizes: list[int] = []
        self.feeds: list[dict[str, np.ndarray]] = []

    def get_inputs(self) -> list[_Input]:
        return [_Input("input_ids"), _Input("attention_mask"), _Input("token_type_ids")]

    def get_providers(self) -> list[str]:
        return ["CPUExecutionProvider"]

    def run(self, outputs: None, feed: dict[str, np.ndarray]) -> list[np.ndarray]:
        self.batch_sizes.append(feed["input_ids"].shape[0])
        self.feeds.append(feed)
        return [TABLE[feed["input_ids"]]]


@pytest.fixture
def fakes(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> tuple[FakeTokenizer, FakeSession, Path]:
    model_dir = tmp_path / "e5-small"
    model_dir.mkdir()
    (model_dir / "model.onnx").write_bytes(b"stand-in: the fake session never reads it")
    tokenizer = FakeTokenizer()
    session = FakeSession()
    monkeypatch.setattr(embedder_module, "_load_tokenizer", lambda directory: tokenizer)
    monkeypatch.setattr(embedder_module, "_load_session", lambda path, providers: session)
    monkeypatch.delenv(EMBED_CACHE_ENV, raising=False)
    return tokenizer, session, model_dir


def expected_vector(text: str, prefix: str, max_len: int = 128) -> np.ndarray:
    ids = token_ids(f"{prefix}: {text}", max_len)
    pooled = TABLE[ids].mean(axis=0)
    return (pooled / np.linalg.norm(pooled)).astype(np.float32)


def test_encode_returns_unit_vectors_of_384_dims(fakes: tuple[FakeTokenizer, FakeSession, Path]) -> None:
    _, _, model_dir = fakes
    vectors = Embedder(str(model_dir)).encode(["olá", "hello"])
    assert vectors.shape == (2, 384)
    assert vectors.dtype == np.float32
    assert np.allclose(np.linalg.norm(vectors, axis=1), 1.0, atol=1e-5)


def test_mean_pooling_ignores_padding_and_matches_the_reference(fakes: tuple[FakeTokenizer, FakeSession, Path]) -> None:
    _, _, model_dir = fakes
    embedder = Embedder(str(model_dir))
    alone = embedder.encode(["alpha beta"])
    padded = Embedder(str(model_dir)).encode(["alpha beta", "one two three four five six seven"])
    assert np.allclose(alone[0], padded[0], atol=1e-6)
    assert np.allclose(alone[0], expected_vector("alpha beta", "query"), atol=1e-5)


def test_token_type_ids_are_zero_when_the_tokenizer_omits_them(fakes: tuple[FakeTokenizer, FakeSession, Path]) -> None:
    _, session, model_dir = fakes
    Embedder(str(model_dir)).encode(["um", "dois três"])
    feed = session.feeds[0]
    assert set(feed) == {"input_ids", "attention_mask", "token_type_ids"}
    assert feed["token_type_ids"].shape == feed["input_ids"].shape
    assert not feed["token_type_ids"].any()


def test_query_and_passage_prefixes_reach_the_tokenizer_and_change_the_vector(
    fakes: tuple[FakeTokenizer, FakeSession, Path],
) -> None:
    tokenizer, _, model_dir = fakes
    embedder = Embedder(str(model_dir))
    query = embedder.encode(["olá"], kind="query")
    passage = embedder.encode(["olá"], kind="passage")
    assert tokenizer.seen[0] == ["query: olá"]
    assert tokenizer.seen[1] == ["passage: olá"]
    assert not np.allclose(query, passage)


def test_same_text_twice_in_one_call_is_one_inference(fakes: tuple[FakeTokenizer, FakeSession, Path]) -> None:
    _, session, model_dir = fakes
    embedder = Embedder(str(model_dir))
    first = embedder.encode(["repetida", "repetida"])
    again = embedder.encode(["repetida"])
    assert session.batch_sizes == [1]
    assert np.array_equal(first[0], first[1])
    assert np.array_equal(first[0], again[0])


def test_inference_batches_are_capped_at_64(fakes: tuple[FakeTokenizer, FakeSession, Path]) -> None:
    _, session, model_dir = fakes
    texts = [f"texto número {index}" for index in range(150)]
    vectors = Embedder(str(model_dir)).encode(texts)
    assert session.batch_sizes == [BATCH_MAX, BATCH_MAX, 22]
    assert vectors.shape == (150, 384)


def test_text_longer_than_max_len_is_truncated_without_error(fakes: tuple[FakeTokenizer, FakeSession, Path]) -> None:
    _, session, model_dir = fakes
    vectors = Embedder(str(model_dir), max_len=128).encode(["palavra " * 300])
    assert vectors.shape == (1, 384)
    assert session.feeds[0]["input_ids"].shape[1] <= 128


def test_empty_input_returns_an_empty_matrix_without_inference(fakes: tuple[FakeTokenizer, FakeSession, Path]) -> None:
    _, session, model_dir = fakes
    vectors = Embedder(str(model_dir)).encode([])
    assert vectors.shape == (0, 384)
    assert session.batch_sizes == []


def test_missing_model_file_is_an_embedder_error(tmp_path: Path) -> None:
    with pytest.raises(EmbedderError, match="model.onnx"):
        Embedder(str(tmp_path / "absent"))


def test_sqlite_cache_serves_a_new_embedder_without_inference(
    fakes: tuple[FakeTokenizer, FakeSession, Path], monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    _, session, model_dir = fakes
    monkeypatch.setenv(EMBED_CACHE_ENV, str(tmp_path / "cache.sqlite"))
    first = Embedder(str(model_dir)).encode(["persistido"])
    second_embedder = Embedder(str(model_dir))
    second = second_embedder.encode(["persistido"])
    assert session.batch_sizes == [1]
    assert np.array_equal(first, second)
    assert second_embedder.metrics.snapshot()["cache_hit_ratio"] == 1.0


def test_sqlite_cache_is_not_shared_between_different_models(
    fakes: tuple[FakeTokenizer, FakeSession, Path], monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    _, session, model_dir = fakes
    monkeypatch.setenv(EMBED_CACHE_ENV, str(tmp_path / "cache.sqlite"))
    Embedder(str(model_dir)).encode(["mesmo texto"])
    other_dir = tmp_path / "other-model"
    other_dir.mkdir()
    (other_dir / "model.onnx").write_bytes(b"a different export")
    Embedder(str(other_dir)).encode(["mesmo texto"])
    assert session.batch_sizes == [1, 1]


def test_metrics_report_latency_and_hit_ratio(fakes: tuple[FakeTokenizer, FakeSession, Path]) -> None:
    _, _, model_dir = fakes
    embedder = Embedder(str(model_dir))
    assert embedder.metrics.snapshot() == {"embed_p50_ms": None, "cache_hit_ratio": None}
    embedder.encode(["mesma"])
    embedder.encode(["mesma"])
    snapshot = embedder.metrics.snapshot()
    assert snapshot["cache_hit_ratio"] == 0.5
    assert isinstance(snapshot["embed_p50_ms"], float)


class TrackingTokenizer(FakeTokenizer):
    """Counts how many tokenizer calls overlap; a short sleep makes an unlocked overlap likely."""

    def __init__(self) -> None:
        super().__init__()
        self.guard = threading.Lock()
        self.active = 0
        self.peak = 0

    def __call__(self, texts: list[str], **kwargs: Any) -> dict[str, np.ndarray]:
        with self.guard:
            self.active += 1
            self.peak = max(self.peak, self.active)
        try:
            time.sleep(0.005)
            return super().__call__(texts, **kwargs)
        finally:
            with self.guard:
                self.active -= 1


def test_concurrent_encode_calls_never_run_inference_at_the_same_time(
    fakes: tuple[FakeTokenizer, FakeSession, Path], monkeypatch: pytest.MonkeyPatch
) -> None:
    _, session, model_dir = fakes
    tracking = TrackingTokenizer()
    monkeypatch.setattr(embedder_module, "_load_tokenizer", lambda directory: tracking)
    embedder = Embedder(str(model_dir))
    texts = [f"texto concorrente {index}" for index in range(16)]
    with ThreadPoolExecutor(max_workers=8) as pool:
        results = list(pool.map(lambda text: embedder.encode([text]), texts))
    assert tracking.peak == 1
    assert sum(session.batch_sizes) == 16
    assert all(result.shape == (1, 384) for result in results)


@pytest.mark.parametrize("max_len", [0, 513])
def test_max_len_outside_1_to_512_is_rejected(fakes: tuple[FakeTokenizer, FakeSession, Path], max_len: int) -> None:
    _, _, model_dir = fakes
    with pytest.raises(ValueError, match="max_len"):
        Embedder(str(model_dir), max_len=max_len)


def test_unknown_kind_is_rejected(fakes: tuple[FakeTokenizer, FakeSession, Path]) -> None:
    _, session, model_dir = fakes
    unknown = "document"
    with pytest.raises(ValueError, match="kind"):
        Embedder(str(model_dir)).encode(["x"], kind=unknown)
    assert session.batch_sizes == []
