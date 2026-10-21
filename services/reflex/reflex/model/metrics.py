"""Rolling serving metrics of the embedder, read by GET /health.

Stdlib only: the HTTP layer imports this module, so it must not pull in the ONNX runtime.
"""

import statistics
import threading
from collections import deque

WINDOW = 1000


class EmbedMetrics:
    def __init__(self, window: int = WINDOW) -> None:
        self._latencies: deque[float] = deque(maxlen=window)
        self._lookups: deque[bool] = deque(maxlen=window)
        self._hits = 0
        self._lock = threading.Lock()

    def record_latency_ms(self, ms_per_text: float) -> None:
        with self._lock:
            self._latencies.append(ms_per_text)

    def record_lookup(self, hit: bool) -> None:
        with self._lock:
            lookups = self._lookups
            if len(lookups) == lookups.maxlen and lookups[0]:
                self._hits -= 1
            lookups.append(hit)
            if hit:
                self._hits += 1

    def snapshot(self) -> dict[str, float | None]:
        with self._lock:
            p50 = statistics.median(self._latencies) if self._latencies else None
            ratio = self._hits / len(self._lookups) if self._lookups else None
        return {
            "embed_p50_ms": None if p50 is None else round(p50, 3),
            "cache_hit_ratio": None if ratio is None else round(ratio, 4),
        }
