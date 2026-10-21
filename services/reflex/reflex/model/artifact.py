"""Versioned artifact `reflex-v<N>/`: `manifest.json` + `heads/<question>.joblib`.

The loader refuses an artifact whose schema, version tag, encoder or scikit-learn release differs from this code.

The sha256 of each head is anti-corruption (truncated copies, partial writes, bit rot), NOT anti-tampering: the manifest
sits in the same directory, so whoever can write a head can rewrite its hash too. joblib is pickle, so the artifact
directory must be writable only by the operator of the service. Each head is read once; its bytes are hashed and
unpickled as the same bytes (no window between check and load). Symlinks, and paths that resolve outside the artifact
directory, are refused.
"""

import hashlib
import json
import os
import re
from dataclasses import dataclass
from pathlib import Path

import sklearn
from pydantic import BaseModel, ConfigDict, ValidationError

from reflex.model.calibrate import Metrics
from reflex.model.heads import Head, HeadKind

SCHEMA_VERSION = 1
EMBEDDER_NAME = "e5-small"
MANIFEST_FILE = "manifest.json"
HEADS_DIR = "heads"
VERSION_TAG = re.compile(r"reflex-v([1-9][0-9]*)")
QUESTION_ID = re.compile(r"[A-Za-z0-9][A-Za-z0-9_.-]{0,63}")


class ArtifactError(ValueError):
    """The artifact is missing, corrupt, tampered with, or built for a different schema or library release."""


class _Strict(BaseModel):
    model_config = ConfigDict(extra="forbid")


class MetricsEntry(_Strict):
    macro_f1: float | None
    qwk: float | None
    ece: float | None
    coverage: float
    # Optional so manifests written before this field still load; new artifacts always write it.
    selective_accuracy: float | None = None
    n_train: int
    n_test: int


class QuestionEntry(_Strict):
    kind: HeadKind
    classes: list[str]
    tau: float
    metrics: MetricsEntry
    disabled: bool
    reason: str | None = None
    # sha256 of heads/<id>.joblib; None when no head was fitted (too little data).
    sha256: str | None = None


class Manifest(_Strict):
    schema_version: int
    version: str
    created_at: str
    embedder: str
    dims: int
    sklearn: str
    dataset_sha256: str
    questions: dict[str, QuestionEntry]


def metrics_entry(metrics: Metrics) -> MetricsEntry:
    return MetricsEntry(**metrics)


def file_sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for block in iter(lambda: handle.read(1 << 20), b""):
            digest.update(block)
    return digest.hexdigest()


def _minor(release: str) -> str:
    return ".".join(release.split(".")[:2])


def _check_question_id(question_id: str) -> None:
    if not QUESTION_ID.fullmatch(question_id):
        raise ArtifactError(f"question id {question_id!r} cannot be used as a file name")


def head_path(directory: Path, question_id: str) -> Path:
    _check_question_id(question_id)
    return directory / HEADS_DIR / f"{question_id}.joblib"


def _read_head(directory: Path, question_id: str) -> bytes:
    path = head_path(directory, question_id)
    if path.is_symlink():
        raise ArtifactError(f"{path.name}: symlinks are refused")
    if not path.resolve().is_relative_to(directory.resolve()):
        raise ArtifactError(f"{path.name}: resolves outside the artifact directory")
    try:
        # O_NOFOLLOW makes the open itself refuse a symlink swapped in after the checks above.
        descriptor = os.open(path, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0))
        with os.fdopen(descriptor, "rb") as handle:
            return handle.read()
    except OSError as error:
        raise ArtifactError(f"{path.name}: missing or unreadable ({error})") from error


@dataclass(frozen=True)
class Artifact:
    directory: Path
    manifest: Manifest
    heads: dict[str, Head]

    @property
    def version(self) -> str:
        return self.manifest.version

    @staticmethod
    def write(directory: Path, manifest: Manifest, heads: dict[str, Head]) -> Manifest:
        """Writes the heads, stamps their sha256 into the manifest, writes it last and returns it."""
        (directory / HEADS_DIR).mkdir(parents=True, exist_ok=True)
        entries = dict(manifest.questions)
        for question_id, head in heads.items():
            path = head_path(directory, question_id)
            head.save(path)
            entries[question_id] = entries[question_id].model_copy(update={"sha256": file_sha256(path)})
        final = manifest.model_copy(update={"questions": entries})
        # The manifest goes last and atomically: a directory without it is not an artifact.
        temporary = directory / f"{MANIFEST_FILE}.tmp"
        temporary.write_text(final.model_dump_json(indent=2) + "\n", encoding="utf-8")
        os.replace(temporary, directory / MANIFEST_FILE)
        return final

    @classmethod
    def load(cls, directory: Path) -> "Artifact":
        manifest = cls._read_manifest(directory)
        heads: dict[str, Head] = {}
        for question_id, entry in manifest.questions.items():
            if entry.sha256 is None:
                continue
            path = head_path(directory, question_id)
            data = _read_head(directory, question_id)
            if hashlib.sha256(data).hexdigest() != entry.sha256:
                raise ArtifactError(f"{path.name}: does not match the manifest hash")
            try:
                head = Head.from_bytes(data)
            except Exception as error:  # any unpickling failure (corrupt bytes, missing module...) is an artifact error
                raise ArtifactError(f"{path.name}: cannot be loaded ({error})") from error
            if (head.question_id, head.kind, head.classes, head.tau) != (
                question_id,
                entry.kind,
                entry.classes,
                entry.tau,
            ):
                raise ArtifactError(f"{path.name}: head disagrees with the manifest")
            heads[question_id] = head
        return cls(directory, manifest, heads)

    @staticmethod
    def _read_manifest(directory: Path) -> Manifest:
        path = directory / MANIFEST_FILE
        try:
            raw = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, ValueError) as error:
            raise ArtifactError(f"{path}: cannot read manifest ({error})") from error
        if not isinstance(raw, dict):
            raise ArtifactError(f"{path}: manifest is not an object")
        if raw.get("schema_version") != SCHEMA_VERSION:
            raise ArtifactError(f"incompatible schema {raw.get('schema_version')!r}, expected {SCHEMA_VERSION}")
        if not isinstance(raw.get("version"), str) or not VERSION_TAG.fullmatch(raw["version"]):
            raise ArtifactError(f"incompatible version tag {raw.get('version')!r}, expected reflex-v<N>")
        try:
            manifest = Manifest.model_validate(raw)
        except ValidationError as error:
            raise ArtifactError(f"{path}: invalid manifest ({error.error_count()} problems)") from error
        for question_id in manifest.questions:
            _check_question_id(question_id)
        if manifest.embedder != EMBEDDER_NAME:
            raise ArtifactError(f"artifact was trained on encoder {manifest.embedder!r}, expected {EMBEDDER_NAME!r}")
        if _minor(manifest.sklearn) != _minor(sklearn.__version__):
            raise ArtifactError(f"artifact needs scikit-learn {manifest.sklearn}, running {sklearn.__version__}")
        return manifest
