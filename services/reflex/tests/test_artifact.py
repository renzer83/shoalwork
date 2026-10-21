"""Artifact loading refuses what the hash cannot catch: paths leaving the directory, links, bad pickles."""

import io
import json
import shutil
from collections.abc import Callable
from datetime import UTC, datetime
from pathlib import Path

import joblib
import pytest
from conftest import FakeEncoder, copy_artifact, replace_head

from reflex.model import artifact as artifact_module
from reflex.model.artifact import Artifact, ArtifactError
from reflex.model.train import train_all

NOW = datetime(2026, 10, 21, 12, 0, tzinfo=UTC)


@pytest.fixture(scope="module")
def trained(dataset: Path, tmp_path_factory: pytest.TempPathFactory) -> Path:
    out = tmp_path_factory.mktemp("models") / "reflex-v1"
    train_all(dataset, out, FakeEncoder(), version=1, now=NOW)
    return out


@pytest.fixture
def copy(trained: Path, tmp_path: Path) -> Path:
    return copy_artifact(trained, tmp_path / "reflex-v1")


def _joblib_bytes(state: object) -> bytes:
    buffer = io.BytesIO()
    joblib.dump(state, buffer)
    return buffer.getvalue()


def _head_state(**changes: object) -> dict[str, object]:
    state: dict[str, object] = {
        "question_id": "urgent",
        "kind": "noul",
        "classes": ["false", "true"],
        "tau": 0.8,
        "method": "sigmoid",
        "classifier": "not an estimator",
        "calibrated": None,
    }
    state.update(changes)
    return state


def test_a_question_id_with_path_traversal_is_refused(copy: Path) -> None:
    path = copy / "manifest.json"
    manifest = json.loads(path.read_text(encoding="utf-8"))
    manifest["questions"]["../x"] = manifest["questions"].pop("urgent")
    path.write_text(json.dumps(manifest), encoding="utf-8")
    with pytest.raises(ArtifactError, match="cannot be used as a file name"):
        Artifact.load(copy)


def test_a_head_that_is_a_symlink_is_refused(copy: Path, trained: Path) -> None:
    head = copy / "heads" / "urgent.joblib"
    head.unlink()
    head.symlink_to(trained / "heads" / "urgent.joblib")
    with pytest.raises(ArtifactError, match="symlinks are refused"):
        Artifact.load(copy)


def test_a_head_that_resolves_outside_the_artifact_is_refused(copy: Path, trained: Path, tmp_path: Path) -> None:
    elsewhere = tmp_path / "elsewhere"
    elsewhere.mkdir()
    shutil.copy(trained / "heads" / "urgent.joblib", elsewhere / "urgent.joblib")
    shutil.rmtree(copy / "heads")
    (copy / "heads").symlink_to(elsewhere)
    with pytest.raises(ArtifactError, match="resolves outside the artifact directory"):
        Artifact.load(copy)


@pytest.mark.parametrize(
    ("data", "message"),
    [
        pytest.param(b"\x00not a pickle", "cannot be loaded", id="not-a-pickle"),
        pytest.param(b"\x80\x02cno_such_module_reflex\nThing\nq\x00.", "cannot be loaded", id="missing-module"),
        pytest.param(b"\x80\x02creflex.model.heads\nNoSuchHead\nq\x00.", "cannot be loaded", id="missing-attribute"),
        pytest.param(_joblib_bytes({"x": 1}), "not a head file", id="not-a-head"),
        pytest.param(_joblib_bytes(_head_state()), "not a LogisticRegression", id="foreign-estimator"),
    ],
)
def test_a_head_that_does_not_unpickle_into_a_head_is_an_artifact_error_even_with_the_right_hash(
    copy: Path, data: bytes, message: str
) -> None:
    replace_head(copy, "urgent", data)
    with pytest.raises(ArtifactError, match=message):
        Artifact.load(copy)


def test_each_head_is_read_once_and_loaded_from_those_bytes(copy: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    reads: list[str] = []
    original: Callable[[Path, str], bytes] = artifact_module._read_head

    def counting(directory: Path, question_id: str) -> bytes:
        reads.append(question_id)
        return original(directory, question_id)

    monkeypatch.setattr(artifact_module, "_read_head", counting)
    artifact = Artifact.load(copy)
    assert sorted(reads) == sorted(artifact.heads) == ["bot", "priority", "urgent"]
