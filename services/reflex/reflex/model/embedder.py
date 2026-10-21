"""Embedder: multilingual-e5-small in ONNX Runtime. encode() returns L2-normalised 384-d vectors (mean pooling).

e5 expects the "query: " or "passage: " prefix on every input; the prefix is part of the model contract, not a style.
"""

import hashlib
import os
import time
from collections.abc import Mapping, Sequence
from pathlib import Path
from typing import Literal

import numpy as np
import onnxruntime as ort
from transformers import AutoTokenizer, PreTrainedTokenizerBase

import threading

from reflex.model.cache import DEFAULT_CAPACITY, DEFAULT_MAX_ROWS, VectorCache, cache_key
from reflex.model.metrics import EmbedMetrics

Kind = Literal["query", "passage"]
DIMS = 384
BATCH_MAX = 64
MAX_LEN = 128
MAX_LEN_LIMIT = 512
EMBED_CACHE_ENV = "REFLEX_EMBED_CACHE"
MODEL_FILE = "model.onnx"
TOKENIZER_FILE = "tokenizer.json"
CPU_PROVIDERS = ["CPUExecutionProvider"]
KINDS: tuple[str, ...] = ("query", "passage")


class EmbedderError(RuntimeError):
    pass


def _load_tokenizer(directory: str) -> PreTrainedTokenizerBase:
    return AutoTokenizer.from_pretrained(directory)


def _load_session(path: str, providers: list[str]) -> ort.InferenceSession:
    return ort.InferenceSession(path, providers=providers)


# sha256 over the ONNX graph and the tokenizer: a new export of any model gets a new cache namespace.
def model_fingerprint(directory: Path) -> str:
    digest = hashlib.sha256()
    for name in (MODEL_FILE, TOKENIZER_FILE):
        path = directory / name
        if not path.is_file():
            continue
        digest.update(name.encode("utf-8") + b"\0")
        with path.open("rb") as handle:
            for block in iter(lambda: handle.read(1 << 20), b""):
                digest.update(block)
    return digest.hexdigest()


class Embedder:
    dims = DIMS

    def __init__(self, model_dir: str, providers: list[str] | None = None, max_len: int = MAX_LEN) -> None:
        if not 1 <= max_len <= MAX_LEN_LIMIT:
            raise ValueError(f"max_len must be between 1 and {MAX_LEN_LIMIT}, got {max_len}")
        directory = Path(model_dir)
        model_path = directory / MODEL_FILE
        if not model_path.is_file():
            raise EmbedderError(
                f"no {MODEL_FILE} in {directory}; run `uv run python -m reflex.model.cli export --out {directory}`"
            )
        self._max_len = max_len
        self._model_id = model_fingerprint(directory)
        self._tokenizer = _load_tokenizer(str(directory))
        self._session = _load_session(str(model_path), providers or CPU_PROVIDERS)
        self._input_names = [item.name for item in self._session.get_inputs()]
        # One inference at a time: tokenizer and ONNX session are not guaranteed reentrant across threads.
        self._infer_lock = threading.Lock()
        sqlite_path = os.environ.get(EMBED_CACHE_ENV, "").strip()
        self._cache = VectorCache(
            DEFAULT_CAPACITY,
            Path(sqlite_path) if sqlite_path else None,
            model_id=self._model_id,
            dims=DIMS,
            max_rows=DEFAULT_MAX_ROWS,
        )
        self.metrics = EmbedMetrics()

    @property
    def providers(self) -> list[str]:
        return self._session.get_providers()

    def encode(self, texts: list[str], kind: Kind = "query") -> np.ndarray:
        if kind not in KINDS:
            raise ValueError(f"kind must be one of {KINDS}, got {kind!r}")
        out = np.empty((len(texts), DIMS), dtype=np.float32)
        if not texts:
            return out
        started = time.perf_counter()
        keys = [cache_key(self._model_id, kind, text) for text in texts]
        resolved: dict[str, np.ndarray] = {}
        pending: dict[str, str] = {}
        for key, text in zip(keys, texts):
            if key in resolved or key in pending:
                # Repeated inside this call: served from the first occurrence, no inference.
                self.metrics.record_lookup(True)
                continue
            cached = self._cache.get(key)
            self.metrics.record_lookup(cached is not None)
            if cached is None:
                pending[key] = text
            else:
                resolved[key] = cached
        fresh = self._embed_pending(kind, pending)
        resolved.update(fresh)
        self._cache.put_many(list(fresh.items()))
        for index, key in enumerate(keys):
            out[index] = resolved[key]
        self.metrics.record_latency_ms((time.perf_counter() - started) * 1000 / len(texts))
        return out

    def _embed_pending(self, kind: Kind, pending: dict[str, str]) -> dict[str, np.ndarray]:
        keys = list(pending)
        result: dict[str, np.ndarray] = {}
        for start in range(0, len(keys), BATCH_MAX):
            chunk = keys[start : start + BATCH_MAX]
            vectors = self._infer([pending[key] for key in chunk], kind)
            for key, vector in zip(chunk, vectors):
                result[key] = vector
        return result

    # The exported graph takes token_type_ids; the tokenizer may not return it. One segment means all zeros.
    def _feed(self, batch: Mapping[str, np.ndarray]) -> dict[str, np.ndarray]:
        feed: dict[str, np.ndarray] = {}
        for name in self._input_names:
            if name in batch:
                feed[name] = np.asarray(batch[name])
            elif name == "token_type_ids":
                feed[name] = np.zeros_like(np.asarray(batch["input_ids"]))
            else:
                raise EmbedderError(f"model input {name!r} is not produced by the tokenizer")
        return feed

    def _infer(self, texts: Sequence[str], kind: Kind) -> np.ndarray:
        with self._infer_lock:
            batch = self._tokenizer(
                [f"{kind}: {text}" for text in texts],
                padding=True,
                truncation=True,
                max_length=self._max_len,
                return_tensors="np",
            )
            hidden = np.asarray(self._session.run(None, self._feed(batch))[0], dtype=np.float32)
        if hidden.ndim != 3 or hidden.shape[-1] != DIMS:
            raise EmbedderError(f"model output has shape {hidden.shape}, expected [batch, tokens, {DIMS}]")
        mask = np.asarray(batch["attention_mask"], dtype=np.float32)[:, :, None]
        pooled = (hidden * mask).sum(axis=1) / np.maximum(mask.sum(axis=1), 1e-9)
        norms = np.linalg.norm(pooled, axis=1, keepdims=True)
        return (pooled / np.maximum(norms, 1e-12)).astype(np.float32)
