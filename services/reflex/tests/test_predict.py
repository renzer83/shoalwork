import logging
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

import numpy as np
import pytest
from conftest import FakeEncoder
from fastapi.testclient import TestClient

from reflex.app import MODEL_VERSION, build_default_app, create_app
from reflex.contract import Answer, Facts, Question
from reflex.model import embedder as embedder_module
from reflex.model.artifact import Artifact, ArtifactError
from reflex.model.predict import MODEL_DIR_ENV, Predictor, load_predictor
from reflex.model.train import train_all
from reflex.rules import RulesConfig

NOW = datetime(2026, 10, 21, 12, 0, tzinfo=UTC)
URGENT = Question(id="urgent", kind="noul")
BOT = Question(id="bot", kind="choice", options=["bot_a", "bot_b", "bot_c"])
PRIORITY = Question(id="priority", kind="score", scale=(0, 4))
EASY = {"urgent": "agora urgente ok", "bot": "fatura pagamento ok", "priority": "critica incidente ok"}


def facts(text: str) -> Facts:
    return Facts(text=text, channel="api", userId="42", bots=[], executors=[])


def rule(question: Question) -> Answer:
    return Answer(id=question.id, value="rule-value", confidence=0.11, source="rule")


@pytest.fixture(scope="module")
def trained(dataset: Path, tmp_path_factory: pytest.TempPathFactory) -> Path:
    out = tmp_path_factory.mktemp("models") / "reflex-v1"
    train_all(dataset, out, FakeEncoder(), version=1, now=NOW)
    return out


@pytest.fixture
def predictor(trained: Path, encoder: FakeEncoder) -> Predictor:
    return Predictor(Artifact.load(trained), encoder)


def test_confident_cases_are_answered_by_the_model(predictor: Predictor) -> None:
    answers = predictor.answer(facts("agora urgente ok"), [URGENT], rule)
    assert [(a.id, a.value, a.source, a.abstained) for a in answers] == [("urgent", True, "model", False)]
    assert predictor.artifact.heads["urgent"].tau <= answers[0].confidence <= 1.0

    by_id = {q.id: predictor.answer(facts(EASY[q.id]), [q], rule)[0] for q in (BOT, PRIORITY)}
    assert (by_id["bot"].value, by_id["bot"].source) == ("bot_a", "model")
    assert (by_id["priority"].value, by_id["priority"].source) == (4, "model")


def test_below_tau_the_rule_answers_and_the_abstention_is_marked(predictor: Predictor) -> None:
    # No signal words: urgent falls under its tau by itself; the other heads are pushed above any probability.
    predictor.artifact.heads["bot"].tau = 2.0
    predictor.artifact.heads["priority"].tau = 2.0
    answers = predictor.answer(facts("zzz yyy xxx"), [URGENT, BOT, PRIORITY], rule)
    assert [a.source for a in answers] == ["rule", "rule", "rule"]
    assert all(a.abstained and a.value == "rule-value" and a.confidence == 0.11 for a in answers)


def test_the_message_is_embedded_once_for_all_questions(predictor: Predictor, encoder: FakeEncoder) -> None:
    predictor.answer(facts("agora urgente fatura pagamento"), [URGENT, BOT, PRIORITY], rule)
    assert len(encoder.calls) == 1 and encoder.calls[0][1] == "query" and len(encoder.calls[0][0]) == 1


def test_the_text_is_anonymized_like_the_training_rows(predictor: Predictor, encoder: FakeEncoder) -> None:
    predictor.answer(facts("agora urgente a@b.com https://x.io/y"), [URGENT], rule)
    assert encoder.calls[0][0] == ["agora urgente <email> <url>"]


def test_without_an_active_head_nothing_is_embedded_and_no_abstention_is_claimed(
    predictor: Predictor, encoder: FakeEncoder
) -> None:
    unknown = Question(id="intent", kind="choice", options=["chat", "code"])
    wrong_kind = Question(id="urgent", kind="choice", options=["a", "b"])
    answers = predictor.answer(facts("agora urgente"), [unknown, wrong_kind], rule)
    assert [(a.source, a.abstained) for a in answers] == [("rule", False), ("rule", False)]
    assert encoder.calls == []


def test_a_disabled_head_is_never_used(trained: Path, encoder: FakeEncoder) -> None:
    artifact = Artifact.load(trained)
    manifest = artifact.manifest
    entries = {**manifest.questions, "urgent": manifest.questions["urgent"].model_copy(update={"disabled": True})}
    disabled = Artifact(artifact.directory, manifest.model_copy(update={"questions": entries}), artifact.heads)
    answer = Predictor(disabled, encoder).answer(facts("agora urgente ok"), [URGENT], rule)[0]
    assert (answer.source, answer.abstained) == ("rule", False)


def test_an_option_outside_the_request_or_a_value_outside_the_scale_abstains(predictor: Predictor) -> None:
    narrowed = BOT.model_copy(update={"options": ["bot_b", "bot_c"]})
    assert predictor.answer(facts(EASY["bot"]), [narrowed], rule)[0].abstained
    unscaled = PRIORITY.model_copy(update={"scale": None})
    assert predictor.answer(facts(EASY["priority"]), [unscaled], rule)[0].abstained
    small = PRIORITY.model_copy(update={"scale": (0, 3)})
    assert predictor.answer(facts(EASY["priority"]), [small], rule)[0].abstained


def test_an_encoder_failure_falls_back_to_the_rules(
    trained: Path, caplog: pytest.LogCaptureFixture
) -> None:
    class Broken:
        dims = 384

        def encode(self, texts: list[str], kind: str = "query") -> np.ndarray:
            raise RuntimeError("onnx exploded")

    with caplog.at_level(logging.ERROR, logger="reflex"):
        predictor = Predictor(Artifact.load(trained), Broken())  # type: ignore[arg-type]
        answer = predictor.answer(facts("agora urgente"), [URGENT], rule)[0]
    assert (answer.source, answer.abstained) == ("rule", True)
    assert "embedding failed" in caplog.text


def test_an_encoder_of_another_width_is_refused(trained: Path) -> None:
    class Narrow:
        dims = 16

        def encode(self, texts: list[str], kind: str = "query") -> np.ndarray:
            return np.zeros((len(texts), 16), dtype=np.float32)

    with pytest.raises(ArtifactError, match="16-d"):
        Predictor(Artifact.load(trained), Narrow())  # type: ignore[arg-type]


def post(client: TestClient, text: str) -> dict[str, Any]:
    questions = [{"id": "urgent", "kind": "noul"}, {"id": "language", "kind": "choice", "options": ["pt", "en"]}]
    facts_body = {"text": text, "channel": "api", "userId": "42", "bots": [], "executors": []}
    payload = {"facts": facts_body, "questions": questions}
    response = client.post("/v1/systemone", json=payload)
    assert response.status_code == 200
    return response.json()


def test_the_endpoint_answers_from_the_model_where_a_head_is_confident(
    predictor: Predictor, rules_config: RulesConfig
) -> None:
    client = TestClient(create_app(rules_config, token=None, predictor=predictor))
    body = post(client, "agora urgente ok")
    by_id = {a["id"]: a for a in body["answers"]}
    assert by_id["urgent"]["source"] == "model" and by_id["urgent"]["value"] is True
    assert by_id["language"]["source"] == "rule"
    assert body["modelVersion"] == "reflex-v1"
    assert client.get("/v1/version").json()["modelVersion"] == "reflex-v1"
    health = client.get("/health").json()
    assert health["ok"] is True and health["modelVersion"] == "reflex-v1"
    abstained = {a["id"]: a for a in post(client, "zzz yyy")["answers"]}
    assert abstained["urgent"]["source"] == "rule" and abstained["urgent"]["abstained"] is True


def test_without_a_predictor_the_service_is_the_rules_as_before(rules_config: RulesConfig) -> None:
    client = TestClient(create_app(rules_config, token=None))
    body = post(client, "agora urgente ok")
    assert body["modelVersion"] == MODEL_VERSION
    assert {a["source"] for a in body["answers"]} == {"rule"}
    assert client.get("/health").json() == {"ok": True, "modelVersion": MODEL_VERSION}


def test_model_dir_is_optional_and_a_bad_one_stops_the_boot(
    trained: Path, tmp_path: Path, monkeypatch: pytest.MonkeyPatch, rules_config_path: Path
) -> None:
    assert load_predictor({}) is None and load_predictor({MODEL_DIR_ENV: "  "}) is None
    monkeypatch.setattr(embedder_module, "Embedder", lambda directory: FakeEncoder())
    loaded = load_predictor({MODEL_DIR_ENV: str(trained)})
    assert loaded is not None and loaded.version == "reflex-v1"
    with pytest.raises(RuntimeError, match=MODEL_DIR_ENV):
        load_predictor({MODEL_DIR_ENV: str(tmp_path / "missing")})
    environ = {"REFLEX_CONFIG": str(rules_config_path), MODEL_DIR_ENV: str(trained)}
    client = TestClient(build_default_app({**environ, "REFLEX_TOKEN": "t"}, ["uvicorn"]))
    assert client.get("/v1/version").json()["modelVersion"] == "reflex-v1"
    plain = TestClient(build_default_app({"REFLEX_CONFIG": str(rules_config_path)}, ["uvicorn"]))
    assert plain.get("/v1/version").json()["modelVersion"] == MODEL_VERSION
