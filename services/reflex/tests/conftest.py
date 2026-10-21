"""Shared fixtures for the head/predictor tests: a deterministic fake encoder and a synthetic decisions dataset."""

import hashlib
import json
import random
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Literal

import numpy as np
import pytest

from reflex.config import load_rules_config
from reflex.data.build import build_dataset
from reflex.rules import RulesConfig

DIMS = 384
START = datetime(2026, 1, 1, tzinfo=timezone.utc)

# Per question: class -> signal words. A row shows two words of its class (or, with `noise`, of another class).
VOCAB: dict[str, dict[str, list[str]]] = {
    "urgent": {"true": ["agora", "urgente", "rapido"], "false": ["depois", "tranquilo", "semana"]},
    "bot": {
        "bot_a": ["fatura", "pagamento", "boleto"],
        "bot_b": ["relatorio", "grafico", "planilha"],
        "bot_c": ["deploy", "servidor", "build"],
    },
    "priority": {
        "0": ["opcional", "talvez"],
        "1": ["baixa", "quando"],
        "2": ["normal", "rotina"],
        "3": ["alta", "cliente"],
        "4": ["critica", "incidente"],
    },
}
KINDS = {"urgent": "noul", "bot": "choice", "priority": "score"}


class FakeEncoder:
    """Bag of words: each token has a fixed pseudo-random direction; the text vector is their normalised sum."""

    dims = DIMS

    def __init__(self) -> None:
        self.calls: list[tuple[list[str], str]] = []

    @staticmethod
    def _token_vector(token: str) -> np.ndarray:
        seed = int.from_bytes(hashlib.sha256(token.encode("utf-8")).digest()[:8], "big")
        return np.random.default_rng(seed).standard_normal(DIMS)

    def encode(self, texts: list[str], kind: Literal["query", "passage"] = "query") -> np.ndarray:
        self.calls.append((list(texts), kind))
        out = np.zeros((len(texts), DIMS), dtype=np.float32)
        for row, text in enumerate(texts):
            total = sum((self._token_vector(t) for t in text.lower().split()), np.zeros(DIMS))
            norm = np.linalg.norm(total)
            out[row] = total / norm if norm else total
        return out


def _value(question: str, label: str) -> bool | str | int:
    if question == "urgent":
        return label == "true"
    return int(label) if question == "priority" else label


def decision_lines(per_question: dict[str, int], noise: float, seed: int = 11) -> list[str]:
    rng = random.Random(seed)
    lines: list[str] = []
    index = 0
    for question, count in per_question.items():
        classes = VOCAB[question]
        for _ in range(count):
            label = rng.choice(sorted(classes))
            source = rng.choice(sorted(classes)) if rng.random() < noise else label
            words = rng.sample(classes[source], 2) + rng.sample(["ok", "msg", "por", "favor", "ver", "isso"], 3)
            rng.shuffle(words)
            index += 1
            row = {
                "decisionId": f"dec_{index:05d}",
                "ts": (START + timedelta(minutes=index)).isoformat().replace("+00:00", "Z"),
                "facts": {"text": " ".join(words), "channel": "api", "userId": "user_12345678901", "language": "pt"},
                "question": {"id": question, "kind": KINDS[question]},
                "answer": {"value": _value(question, label), "confidence": 0.9, "source": "rule"},
                "outcome": "correct",
            }
            lines.append(json.dumps(row))
    return lines


def write_dataset(directory: Path, per_question: dict[str, int], noise: float = 0.0) -> Path:
    source = directory / "decisions.jsonl"
    source.write_text("\n".join(decision_lines(per_question, noise)) + "\n", encoding="utf-8")
    out = directory / "data"
    build_dataset(source, out, min_per_class=1)
    return out


@pytest.fixture
def encoder() -> FakeEncoder:
    return FakeEncoder()


# 3 questions, 400 rows (100 + 100 + 200), 15% of rows show another class's words.
@pytest.fixture(scope="module")
def dataset(tmp_path_factory: pytest.TempPathFactory) -> Path:
    return write_dataset(tmp_path_factory.mktemp("synthetic"), {"urgent": 100, "bot": 100, "priority": 200}, noise=0.15)


YAML_PATH = Path(__file__).resolve().parents[3] / "config" / "reflex.config.yaml"


@pytest.fixture(scope="session")
def rules_config_path() -> Path:
    return YAML_PATH


@pytest.fixture(scope="session")
def rules_config() -> RulesConfig:
    return load_rules_config(YAML_PATH)
