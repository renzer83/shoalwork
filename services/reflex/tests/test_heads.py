import json
from datetime import UTC, datetime
from pathlib import Path

import numpy as np
import pytest
from conftest import FakeEncoder, write_dataset

from reflex.model.artifact import SCHEMA_VERSION, Artifact, ArtifactError, head_path
from reflex.model.calibrate import choose_tau, ece, predictions
from reflex.model.cli import format_eval
from reflex.model.heads import CALIB_FOLDS, Head, HeadError, class_key
from reflex.model.train import (
    TrainConfig,
    TrainError,
    dataset_sha256,
    eval_artifact,
    read_split,
    train_all,
)

NOW = datetime(2026, 10, 21, 12, 0, tzinfo=UTC)


def split(data: Path, question: str, name: str, encoder: FakeEncoder) -> tuple[np.ndarray, list[str]]:
    texts, labels = read_split(data / question, name)
    return encoder.encode(texts), [class_key(label) for label in labels]


@pytest.fixture(scope="module")
def trained(dataset: Path, tmp_path_factory: pytest.TempPathFactory) -> Path:
    out = tmp_path_factory.mktemp("models") / "reflex-v1"
    train_all(dataset, out, FakeEncoder(), version=1, now=NOW)
    return out


def test_train_all_writes_a_manifest_with_one_head_per_question(trained: Path, dataset: Path) -> None:
    artifact = Artifact.load(trained)
    manifest = artifact.manifest
    assert manifest.version == "reflex-v1"
    assert manifest.schema_version == SCHEMA_VERSION
    assert manifest.created_at == "2026-10-21T12:00:00+00:00"
    assert manifest.dataset_sha256 == dataset_sha256(dataset, ["urgent", "bot", "priority"])
    assert sorted(manifest.questions) == ["bot", "priority", "urgent"]
    assert sorted(artifact.heads) == ["bot", "priority", "urgent"]
    for entry in manifest.questions.values():
        assert not entry.disabled and 0.5 < entry.tau < 1.0
        assert entry.metrics.n_train > 0 and entry.metrics.n_test > 0 and entry.metrics.ece is not None
    assert manifest.questions["priority"].classes == ["0", "1", "2", "3", "4"]
    assert manifest.questions["priority"].metrics.qwk is not None
    assert manifest.questions["urgent"].metrics.qwk is None


def test_calibration_reduces_ece_against_the_raw_head(tmp_path: Path) -> None:
    data = write_dataset(tmp_path, {"urgent": 2000}, noise=0.15)
    encoder = FakeEncoder()
    X_train, y_train = split(data, "urgent", "train", encoder)
    X_calib, y_calib = split(data, "urgent", "calib", encoder)
    X_test, y_test = split(data, "urgent", "test", encoder)
    head = Head("urgent", "noul", ["false", "true"])
    head.fit(X_train[:300], y_train[:300])
    head.calibrate(X_calib, y_calib)

    def error_of(proba: np.ndarray) -> float:
        best = proba.argmax(axis=1)
        correct = np.array([head.classes[b] == truth for b, truth in zip(best, y_test)], dtype=float)
        return ece(proba.max(axis=1), correct)

    assert head.method == "sigmoid"
    assert error_of(head.predict_proba(X_test)) < error_of(head.predict_proba_raw(X_test))


def test_isotonic_is_used_from_one_thousand_calibration_rows(tmp_path: Path) -> None:
    data = write_dataset(tmp_path, {"urgent": 8000}, noise=0.15)
    encoder = FakeEncoder()
    X_train, y_train = split(data, "urgent", "train", encoder)
    X_calib, y_calib = split(data, "urgent", "calib", encoder)
    head = Head("urgent", "noul", ["false", "true"])
    head.fit(X_train[:400], y_train[:400])
    head.calibrate(X_calib, y_calib)
    assert len(y_calib) >= 1000 and head.method == "isotonic"


def test_tau_keeps_the_target_accuracy_with_enough_coverage_on_calib(trained: Path, dataset: Path) -> None:
    artifact = Artifact.load(trained)
    encoder = FakeEncoder()
    for question_id, head in artifact.heads.items():
        X, y = split(dataset, question_id, "calib", encoder)
        found = predictions(head, X)
        kept = found.confidence >= head.tau
        correct = np.array([a == b for a, b in zip(found.labels, y)])
        assert kept.mean() >= 0.5
        assert correct[kept].mean() >= 0.90


def test_choose_tau_is_the_smallest_qualifying_threshold_and_none_when_impossible() -> None:
    confidence = np.array([0.95, 0.9, 0.8, 0.7, 0.6, 0.55])
    correct = np.array([1, 1, 1, 1, 0, 0], dtype=float)
    assert choose_tau(confidence, correct, 0.9, 0.5) == 0.7
    assert choose_tau(confidence, np.zeros(6), 0.9, 0.5) is None
    assert choose_tau(np.array([]), np.array([]), 0.9, 0.5) is None
    # Reaching the accuracy needs a threshold above the coverage floor.
    assert choose_tau(confidence, np.array([0, 0, 0, 1, 1, 1], dtype=float), 0.9, 0.5) is None


def test_question_with_two_examples_is_disabled_and_has_no_head(tmp_path: Path) -> None:
    data = write_dataset(tmp_path, {"urgent": 300, "bot": 2}, noise=0.1)
    out = tmp_path / "models" / "reflex-v1"
    manifest = train_all(data, out, FakeEncoder(), version=1, now=NOW)
    assert manifest.questions["bot"].disabled and manifest.questions["bot"].sha256 is None
    assert not head_path(out, "bot").exists()
    assert not manifest.questions["urgent"].disabled
    assert sorted(Artifact.load(out).heads) == ["urgent"]


def test_unreachable_target_accuracy_disables_the_question_but_keeps_the_head(dataset: Path, tmp_path: Path) -> None:
    out = tmp_path / "reflex-v1"
    manifest = train_all(dataset, out, FakeEncoder(), 1, TrainConfig(target_accuracy=1.0, min_coverage=0.99), NOW)
    assert all(entry.disabled and entry.tau == 1.0 for entry in manifest.questions.values())
    assert all("no threshold" in (entry.reason or "") for entry in manifest.questions.values())
    assert sorted(Artifact.load(out).heads) == ["bot", "priority", "urgent"]


def test_load_reproduces_the_probabilities_of_the_trained_heads(dataset: Path, tmp_path: Path) -> None:
    encoder = FakeEncoder()
    first, second = tmp_path / "reflex-v1", tmp_path / "reflex-v2"
    train_all(dataset, first, encoder, 1, now=NOW)
    train_all(dataset, second, encoder, 2, now=NOW)
    for question_id in ("urgent", "bot", "priority"):
        X, _ = split(dataset, question_id, "test", encoder)
        loaded = Artifact.load(first).heads[question_id]
        again = Artifact.load(first).heads[question_id]
        retrained = Artifact.load(second).heads[question_id]
        assert np.array_equal(loaded.predict_proba(X), again.predict_proba(X))
        assert np.array_equal(loaded.predict_proba(X), retrained.predict_proba(X))
        assert loaded.tau == retrained.tau


def edit_manifest(directory: Path, **changes: object) -> None:
    path = directory / "manifest.json"
    manifest = json.loads(path.read_text(encoding="utf-8"))
    manifest.update(changes)
    path.write_text(json.dumps(manifest), encoding="utf-8")


@pytest.mark.parametrize(
    ("changes", "message"),
    [
        ({"schema_version": SCHEMA_VERSION + 1}, "incompatible schema"),
        ({"version": "v1"}, "incompatible version"),
        ({"version": "reflex-v0"}, "incompatible version"),
        ({"embedder": "bge-m3"}, "encoder"),
        ({"sklearn": "0.1.0"}, "scikit-learn"),
        ({"surprise": 1}, "invalid manifest"),
    ],
)
def test_load_refuses_an_incompatible_manifest(
    trained: Path, tmp_path: Path, changes: dict[str, object], message: str
) -> None:
    copy = tmp_path / "copy"
    copy.mkdir()
    (copy / "heads").mkdir()
    for source in [trained / "manifest.json", *(trained / "heads").iterdir()]:
        target = copy / source.relative_to(trained)
        target.write_bytes(source.read_bytes())
    edit_manifest(copy, **changes)
    with pytest.raises(ArtifactError, match=message):
        Artifact.load(copy)


def test_load_refuses_a_head_file_that_does_not_match_the_manifest_hash(trained: Path, tmp_path: Path) -> None:
    copy = tmp_path / "copy"
    (copy / "heads").mkdir(parents=True)
    (copy / "manifest.json").write_bytes((trained / "manifest.json").read_bytes())
    for source in (trained / "heads").iterdir():
        (copy / "heads" / source.name).write_bytes(source.read_bytes())
    (copy / "heads" / "urgent.joblib").write_bytes(b"not a head")
    with pytest.raises(ArtifactError, match="hash"):
        Artifact.load(copy)
    with pytest.raises(ArtifactError, match="cannot read manifest"):
        Artifact.load(tmp_path / "missing")


def test_train_refuses_to_overwrite_an_existing_artifact(trained: Path, dataset: Path) -> None:
    with pytest.raises(TrainError, match="immutable"):
        train_all(dataset, trained, FakeEncoder(), 1)
    with pytest.raises(TrainError, match="at least 1"):
        train_all(dataset, trained.parent / "reflex-v0", FakeEncoder(), 0)


def test_calibration_needs_every_class_in_the_calibration_rows() -> None:
    rng = np.random.default_rng(0)
    X = rng.standard_normal((30, 4))
    y = ["a", "b", "c"] * 10
    head = Head("q", "choice", ["a", "b", "c"])
    head.fit(X, y)
    with pytest.raises(HeadError, match=f"at least {CALIB_FOLDS} rows"):
        head.calibrate(X[:8], ["a", "a", "b", "b", "c", "a", "b", "a"])
    with pytest.raises(HeadError, match="not fitted"):
        Head("q", "choice", ["a", "b"]).predict_proba(X)
    with pytest.raises(HeadError, match="two classes"):
        Head("q", "choice", ["a", "b"]).fit(X, ["a"] * 30)


def test_eval_writes_eval_json_and_the_table_lists_every_question(trained: Path, dataset: Path) -> None:
    report = eval_artifact(Artifact.load(trained), dataset, FakeEncoder())
    assert json.loads((trained / "eval.json").read_text(encoding="utf-8")).keys() == report.keys()
    table = format_eval(report)
    assert table.splitlines()[0].startswith("question")
    assert all(name in table for name in ("urgent", "bot", "priority"))
    assert report["priority"]["metrics"]["qwk"] is not None
