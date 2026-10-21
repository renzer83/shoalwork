from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from reflex.app import MODEL_VERSION, create_app
from reflex.config import load_rules_config
from reflex.model.metrics import EmbedMetrics
from reflex.rules import RulesConfig

YAML_PATH = Path(__file__).resolve().parents[3] / "config" / "reflex.config.yaml"


@pytest.fixture
def config() -> RulesConfig:
    return load_rules_config(YAML_PATH)


def test_health_keeps_the_v0_shape_without_an_embedder(config: RulesConfig) -> None:
    body = TestClient(create_app(config, token=None)).get("/health").json()
    assert body == {"ok": True, "modelVersion": MODEL_VERSION}


def test_health_reports_embedding_metrics_when_attached(config: RulesConfig) -> None:
    metrics = EmbedMetrics()
    metrics.record_latency_ms(2.0)
    metrics.record_latency_ms(10.0)
    metrics.record_latency_ms(4.0)
    metrics.record_lookup(True)
    metrics.record_lookup(False)
    body = TestClient(create_app(config, token=None, embed_metrics=metrics)).get("/health").json()
    assert body == {"ok": True, "modelVersion": MODEL_VERSION, "embed_p50_ms": 4.0, "cache_hit_ratio": 0.5}


def test_hit_ratio_covers_only_the_last_1000_lookups() -> None:
    metrics = EmbedMetrics()
    for _ in range(1000):
        metrics.record_lookup(False)
    for _ in range(1000):
        metrics.record_lookup(True)
    assert metrics.snapshot()["cache_hit_ratio"] == 1.0


def test_empty_metrics_are_null_not_zero() -> None:
    assert EmbedMetrics().snapshot() == {"embed_p50_ms": None, "cache_hit_ratio": None}
