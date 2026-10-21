"""Embedding cache: an in-memory LRU, optionally backed by SQLite (REFLEX_EMBED_CACHE).

Keys are sha256(model_id + kind + text), where model_id is the fingerprint of the ONNX files, so vectors from one
model are never served for another. The SQLite file keeps at most `max_rows` rows, evicting the least recently used,
and drops the rows of any other model when it is opened.
"""

import hashlib
import sqlite3
import threading
from collections import OrderedDict
from collections.abc import Sequence
from pathlib import Path

import numpy as np

DEFAULT_CAPACITY = 10_000
DEFAULT_MAX_ROWS = 200_000
DEFAULT_DIMS = 384
# A new table name: files written by an earlier layout are ignored instead of misread.
TABLE = "embeddings_v2"
SCHEMA = f"""
CREATE TABLE IF NOT EXISTS {TABLE} (
    key TEXT PRIMARY KEY,
    model_id TEXT NOT NULL,
    vec BLOB NOT NULL,
    last_used INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS {TABLE}_last_used ON {TABLE} (last_used);
"""


def cache_key(model_id: str, kind: str, text: str) -> str:
    # model_id is a fixed-length hex digest, so the concatenation cannot be split two ways.
    return hashlib.sha256((model_id + kind + text).encode("utf-8")).hexdigest()


class VectorCache:
    def __init__(
        self,
        capacity: int = DEFAULT_CAPACITY,
        sqlite_path: Path | None = None,
        *,
        model_id: str = "",
        dims: int = DEFAULT_DIMS,
        max_rows: int = DEFAULT_MAX_ROWS,
    ) -> None:
        if capacity < 1 or max_rows < 1 or dims < 1:
            raise ValueError("capacity, max_rows and dims must be at least 1")
        self._capacity = capacity
        self._dims = dims
        self._max_rows = max_rows
        self._model_id = model_id
        self._lru: OrderedDict[str, np.ndarray] = OrderedDict()
        self._lock = threading.Lock()
        self._clock = 0
        self._db: sqlite3.Connection | None = None
        if sqlite_path is not None:
            if not model_id:
                raise ValueError("a SQLite cache needs the model id")
            # The embedder is called from FastAPI worker threads, so the connection is shared under self._lock.
            self._db = sqlite3.connect(sqlite_path, check_same_thread=False)
            self._db.executescript(SCHEMA)
            self._db.execute(f"DELETE FROM {TABLE} WHERE model_id != ?", (model_id,))
            row = self._db.execute(f"SELECT COALESCE(MAX(last_used), 0) FROM {TABLE}").fetchone()
            self._clock = int(row[0])
            self._db.commit()

    def get(self, key: str) -> np.ndarray | None:
        with self._lock:
            vec = self._lru.get(key)
            if vec is not None:
                self._lru.move_to_end(key)
                return vec
            if self._db is None:
                return None
            row = self._db.execute(f"SELECT vec FROM {TABLE} WHERE key = ?", (key,)).fetchone()
            if row is None:
                return None
            vec = self._decode(row[0])
            if vec is None:
                # A row of the wrong size is corrupt: it is removed, and the caller recomputes.
                self._db.execute(f"DELETE FROM {TABLE} WHERE key = ?", (key,))
                self._db.commit()
                return None
            self._clock += 1
            self._db.execute(f"UPDATE {TABLE} SET last_used = ? WHERE key = ?", (self._clock, key))
            self._db.commit()
            self._remember(key, vec)
            return vec

    def put_many(self, items: Sequence[tuple[str, np.ndarray]]) -> None:
        if not items:
            return
        stored: list[tuple[str, np.ndarray]] = []
        for key, vec in items:
            array = np.asarray(vec, dtype=np.float32)
            if array.shape != (self._dims,):
                raise ValueError(f"vector has shape {array.shape}, expected ({self._dims},)")
            stored.append((key, array.copy()))
        with self._lock:
            for key, vec in stored:
                self._remember(key, vec)
            if self._db is not None:
                rows = []
                for key, vec in stored:
                    self._clock += 1
                    rows.append((key, self._model_id, vec.tobytes(), self._clock))
                self._db.executemany(
                    f"INSERT OR REPLACE INTO {TABLE} (key, model_id, vec, last_used) VALUES (?, ?, ?, ?)", rows
                )
                self._evict_over_limit()
                self._db.commit()

    def close(self) -> None:
        with self._lock:
            if self._db is not None:
                self._db.close()
                self._db = None

    def _decode(self, blob: bytes) -> np.ndarray | None:
        if len(blob) != self._dims * np.dtype(np.float32).itemsize:
            return None
        return np.frombuffer(blob, dtype=np.float32).copy()

    def _evict_over_limit(self) -> None:
        assert self._db is not None
        (count,) = self._db.execute(f"SELECT COUNT(*) FROM {TABLE}").fetchone()
        excess = int(count) - self._max_rows
        if excess > 0:
            # Subquery form: DELETE ... ORDER BY ... LIMIT needs a SQLite build option that is not guaranteed.
            self._db.execute(
                f"DELETE FROM {TABLE} WHERE key IN (SELECT key FROM {TABLE} ORDER BY last_used LIMIT ?)", (excess,)
            )

    def _remember(self, key: str, vec: np.ndarray) -> None:
        self._lru[key] = vec
        self._lru.move_to_end(key)
        while len(self._lru) > self._capacity:
            self._lru.popitem(last=False)
