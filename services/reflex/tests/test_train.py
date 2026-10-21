"""Training publishes an artifact whole or not at all, records selective accuracy; CLI refusals exit 1."""

from datetime import UTC, datetime
from pathlib import Path

import numpy as np
import pytest
from conftest import FakeEncoder, copy_artifact, replace_head

from reflex.model import embedder as embedder_module
from reflex.model.artifact import Artifact
from reflex.model.calibrate import predictions
from reflex.model.cli import main
from reflex.model.heads import Head, class_key
from reflex.model.train import TrainConfig, TrainError, read_split, train_all

NOW = datetime(2026, 10, 21, 12, 0, tzinfo=UTC)


@pytest.fixture(scope="module")
def trained(dataset: Path, tmp_path_factory: pytest.TempPathFactory) -> Path:
    out = tmp_path_factory.mktemp("models") / "reflex-v1"
    train_all(dataset, out, FakeEncoder(), version=1, now=NOW)
    return out


@pytest.fixture
def fake_embedder(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(embedder_module, "Embedder", lambda directory: FakeEncoder())


def test_a_failed_run_publishes_nothing_and_leaves_no_staging_directory(
    dataset: Path, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    def broken(self: Head, path: Path) -> None:
        raise OSError("disk full")

    monkeypatch.setattr(Head, "save", broken)
    with pytest.raises(OSError, match="disk full"):
        train_all(dataset, tmp_path / "reflex-v1", FakeEncoder(), 1, now=NOW)
    assert list(tmp_path.iterdir()) == []


def test_heads_are_written_to_a_sibling_staging_directory_not_to_the_output(
    dataset: Path, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    seen: list[tuple[str, bool]] = []
    original = Head.save

    def spy(self: Head, path: Path) -> None:
        seen.append((path.parent.parent.name, (tmp_path / "reflex-v1").exists()))
        original(self, path)

    monkeypatch.setattr(Head, "save", spy)
    train_all(dataset, tmp_path / "reflex-v1", FakeEncoder(), 1, now=NOW)
    assert len(seen) == 3
    assert all(name.startswith("reflex-v1.tmp-") and not exists for name, exists in seen)
    assert [p.name for p in tmp_path.iterdir()] == ["reflex-v1"]


def test_a_run_that_finds_its_output_taken_fails_with_a_message_and_cleans_up(
    dataset: Path, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    out = tmp_path / "reflex-v1"
    original = Head.save

    def taken_meanwhile(self: Head, path: Path) -> None:
        original(self, path)
        if not out.exists():
            out.mkdir()
            (out / "marker").write_text("other run", encoding="utf-8")

    monkeypatch.setattr(Head, "save", taken_meanwhile)
    with pytest.raises(TrainError, match="concurrent run"):
        train_all(dataset, out, FakeEncoder(), 1, now=NOW)
    assert [p.name for p in tmp_path.iterdir()] == ["reflex-v1"]
    assert (out / "marker").read_text(encoding="utf-8") == "other run"


def test_a_concurrent_run_on_the_same_output_is_refused_with_a_message(dataset: Path, tmp_path: Path) -> None:
    other = tmp_path / "reflex-v1.tmp-4242"
    other.mkdir()
    with pytest.raises(TrainError, match="another training run"):
        train_all(dataset, tmp_path / "reflex-v1", FakeEncoder(), 1, now=NOW)
    assert other.is_dir() and not (tmp_path / "reflex-v1").exists()


def test_a_question_with_too_few_calibration_rows_is_disabled_with_a_reason(dataset: Path, tmp_path: Path) -> None:
    manifest = train_all(dataset, tmp_path / "reflex-v1", FakeEncoder(), 1, TrainConfig(min_calib=10_000), NOW)
    for entry in manifest.questions.values():
        assert entry.disabled and entry.sha256 is None
        assert "calibration rows" in (entry.reason or "")
        assert entry.metrics.selective_accuracy is None
    assert Artifact.load(tmp_path / "reflex-v1").heads == {}


def test_min_calib_is_inclusive_at_the_calibration_size(dataset: Path, tmp_path: Path) -> None:
    calib_rows = len(read_split(dataset / "urgent", "calib")[0])
    passed = train_all(dataset, tmp_path / "at", FakeEncoder(), 1, TrainConfig(min_calib=calib_rows), NOW)
    assert not passed.questions["urgent"].disabled
    refused = train_all(dataset, tmp_path / "above", FakeEncoder(), 1, TrainConfig(min_calib=calib_rows + 1), NOW)
    assert refused.questions["urgent"].disabled


def test_the_manifest_records_the_selective_accuracy_of_the_answered_test_rows(trained: Path, dataset: Path) -> None:
    artifact = Artifact.load(trained)
    encoder = FakeEncoder()
    for question_id, head in artifact.heads.items():
        texts, labels = read_split(dataset / question_id, "test")
        found = predictions(head, encoder.encode(texts))
        answered = found.confidence >= head.tau
        truth = [class_key(label) for label in labels]
        expected = float(np.mean([guess == real for guess, real, kept in zip(found.labels, truth, answered) if kept]))
        assert artifact.manifest.questions[question_id].metrics.selective_accuracy == pytest.approx(expected)


def test_cli_eval_refuses_a_corrupt_head_with_a_message_and_exit_1(
    trained: Path, dataset: Path, tmp_path: Path, fake_embedder: None, capsys: pytest.CaptureFixture[str]
) -> None:
    copy = copy_artifact(trained, tmp_path / "reflex-v1")
    replace_head(copy, "urgent", b"\x00not a pickle")
    assert main(["eval", str(copy), str(dataset)]) == 1
    err = capsys.readouterr().err
    assert "reflex-model:" in err and "urgent.joblib" in err and "Traceback" not in err


def test_cli_train_refuses_an_existing_output_with_a_message_and_exit_1(
    trained: Path, dataset: Path, fake_embedder: None, capsys: pytest.CaptureFixture[str]
) -> None:
    assert main(["train", str(dataset), "--out", str(trained)]) == 1
    assert "immutable" in capsys.readouterr().err
