import sqlite3
from pathlib import Path

import numpy as np
import pytest

from reflex.model.cache import TABLE, VectorCache, cache_key

DIMS = 4


def vec(value: float) -> np.ndarray:
    return np.full(DIMS, value, dtype=np.float32)


def row_count(path: Path) -> int:
    with sqlite3.connect(path) as db:
        (count,) = db.execute(f"SELECT COUNT(*) FROM {TABLE}").fetchone()
    return int(count)


def test_cache_key_is_deterministic_and_separates_model_kind_and_text() -> None:
    assert cache_key("m1", "query", "olá") == cache_key("m1", "query", "olá")
    assert cache_key("m1", "query", "olá") != cache_key("m1", "passage", "olá")
    assert cache_key("m1", "query", "olá") != cache_key("m2", "query", "olá")
    assert cache_key("m1", "query", "olá") != cache_key("m1", "query", "ola")
    assert len(cache_key("m1", "query", "olá")) == 64


def test_lru_evicts_the_least_recently_used_entry() -> None:
    cache = VectorCache(capacity=2, dims=DIMS)
    cache.put_many([("a", vec(1.0)), ("b", vec(2.0))])
    assert cache.get("a") is not None  # touching "a" makes "b" the eviction candidate
    cache.put_many([("c", vec(3.0))])
    assert cache.get("b") is None
    assert cache.get("a") is not None
    assert cache.get("c") is not None


def test_sqlite_backing_keeps_float32_vectors_across_instances(tmp_path: Path) -> None:
    path = tmp_path / "cache.sqlite"
    original = np.arange(DIMS, dtype=np.float32) / DIMS
    first = VectorCache(capacity=1, sqlite_path=path, model_id="m", dims=DIMS)
    first.put_many([("k1", original), ("k2", vec(9.0))])  # "k1" leaves the LRU, so only SQLite can serve it
    first.close()
    reopened = VectorCache(capacity=1, sqlite_path=path, model_id="m", dims=DIMS)
    restored = reopened.get("k1")
    assert restored is not None
    assert restored.dtype == np.float32
    assert np.array_equal(restored, original)
    reopened.close()


def test_missing_key_is_none_without_sqlite(tmp_path: Path) -> None:
    assert VectorCache(dims=DIMS).get("absent") is None
    assert VectorCache(sqlite_path=tmp_path / "empty.sqlite", model_id="m", dims=DIMS).get("absent") is None


def test_put_rejects_a_vector_of_the_wrong_shape() -> None:
    with pytest.raises(ValueError, match="shape"):
        VectorCache(dims=DIMS).put_many([("k", np.zeros(DIMS + 1, dtype=np.float32))])


def test_sqlite_row_limit_evicts_the_least_recently_used_rows(tmp_path: Path) -> None:
    path = tmp_path / "cache.sqlite"
    cache = VectorCache(capacity=1, sqlite_path=path, model_id="m", dims=DIMS, max_rows=3)
    for index in range(5):
        cache.put_many([(f"k{index}", vec(float(index)))])
    cache.close()
    assert row_count(path) == 3
    reopened = VectorCache(capacity=1, sqlite_path=path, model_id="m", dims=DIMS, max_rows=3)
    assert reopened.get("k0") is None and reopened.get("k1") is None
    assert reopened.get("k4") is not None
    reopened.close()


def test_a_row_read_from_disk_is_protected_from_eviction(tmp_path: Path) -> None:
    path = tmp_path / "cache.sqlite"
    seed = VectorCache(capacity=1, sqlite_path=path, model_id="m", dims=DIMS, max_rows=2)
    seed.put_many([("old", vec(1.0)), ("newer", vec(2.0))])
    seed.close()
    reader = VectorCache(capacity=1, sqlite_path=path, model_id="m", dims=DIMS, max_rows=2)
    assert reader.get("old") is not None  # touches "old" on disk
    reader.put_many([("fresh", vec(3.0))])  # over the limit: "newer" is now the oldest row
    reader.close()
    survivors = VectorCache(capacity=1, sqlite_path=path, model_id="m", dims=DIMS, max_rows=2)
    assert survivors.get("newer") is None
    assert survivors.get("old") is not None
    assert survivors.get("fresh") is not None
    survivors.close()


def test_opening_with_another_model_purges_the_old_model_rows(tmp_path: Path) -> None:
    path = tmp_path / "cache.sqlite"
    first = VectorCache(sqlite_path=path, model_id="model-a", dims=DIMS)
    first.put_many([("k", vec(1.0))])
    first.close()
    second = VectorCache(sqlite_path=path, model_id="model-b", dims=DIMS)
    assert row_count(path) == 0
    second.close()


def test_wrong_size_row_is_a_miss_and_is_deleted(tmp_path: Path) -> None:
    path = tmp_path / "cache.sqlite"
    VectorCache(sqlite_path=path, model_id="m", dims=DIMS).close()
    with sqlite3.connect(path) as db:
        db.execute(
            f"INSERT INTO {TABLE} (key, model_id, vec, last_used) VALUES (?, ?, ?, ?)",
            ("bad", "m", np.zeros(DIMS + 1, dtype=np.float32).tobytes(), 1),
        )
    cache = VectorCache(sqlite_path=path, model_id="m", dims=DIMS)
    assert cache.get("bad") is None
    cache.close()
    assert row_count(path) == 0


def test_sqlite_cache_requires_a_model_id(tmp_path: Path) -> None:
    with pytest.raises(ValueError, match="model id"):
        VectorCache(sqlite_path=tmp_path / "x.sqlite", dims=DIMS)
