"""Trains, calibrates and packages one head per question of a dataset built by `reflex-data build`."""

import hashlib
import json
import os
import shutil
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path
from typing import Any, Literal, Protocol

import numpy as np
import sklearn

from reflex.data.build import STATS_FILE, load_stats
from reflex.model.artifact import (
    EMBEDDER_NAME,
    QUESTION_ID,
    SCHEMA_VERSION,
    Artifact,
    Manifest,
    QuestionEntry,
    metrics_entry,
)
from reflex.model.calibrate import (
    DEFAULT_MIN_COVERAGE,
    DEFAULT_TARGET_ACCURACY,
    Metrics,
    choose_tau,
    evaluate,
    predictions,
)
from reflex.model.heads import Head, HeadError, HeadKind, Label, class_key, label_kind, order_classes

SPLITS = ("train", "calib", "test")
DEFAULT_MIN_TRAIN = 10
# Fewer calibration rows than this and tau is noise: the question stays disabled.
DEFAULT_MIN_CALIB = 30
DEFAULT_DIMS = 384


class TrainError(ValueError):
    """The training input or output location is unusable."""


class Encoder(Protocol):
    def encode(self, texts: list[str], kind: Literal["query", "passage"] = "query") -> np.ndarray: ...


@dataclass(frozen=True)
class TrainConfig:
    target_accuracy: float = DEFAULT_TARGET_ACCURACY
    min_coverage: float = DEFAULT_MIN_COVERAGE
    min_train: int = DEFAULT_MIN_TRAIN
    min_calib: int = DEFAULT_MIN_CALIB


Rows = tuple[list[str], list[Label]]


def read_split(directory: Path, name: str) -> Rows:
    path = directory / f"{name}.jsonl"
    texts: list[str] = []
    labels: list[Label] = []
    if not path.is_file():
        return texts, labels
    with path.open(encoding="utf-8") as handle:
        for line in handle:
            if line.strip():
                record = json.loads(line)
                texts.append(str(record["text"]))
                labels.append(record["label"])
    return texts, labels


def dataset_sha256(data_dir: Path, question_ids: list[str]) -> str:
    digest = hashlib.sha256()
    names = [Path(STATS_FILE)] + [Path(q) / f"{s}.jsonl" for q in sorted(question_ids) for s in SPLITS]
    for relative in names:
        path = data_dir / relative
        if path.is_file():
            digest.update(relative.as_posix().encode("utf-8") + b"\0" + path.read_bytes() + b"\0")
    return digest.hexdigest()


def _embed(embedder: Encoder, texts: list[str]) -> np.ndarray:
    if not texts:
        return np.empty((0, DEFAULT_DIMS), dtype=np.float32)
    return np.asarray(embedder.encode(texts, kind="query"), dtype=np.float32)


def _staging_dir(out_dir: Path) -> Path:
    """A sibling of out_dir, claimed for this run. Another run on the same output fails here, with a message."""
    out_dir.parent.mkdir(parents=True, exist_ok=True)
    prefix = f"{out_dir.name}.tmp-"
    leftovers = sorted(p.name for p in out_dir.parent.iterdir() if p.name.startswith(prefix))
    if leftovers:
        raise TrainError(
            f"{out_dir}: another training run is writing it, or left {', '.join(leftovers)} behind; "
            "wait for it or remove the leftovers"
        )
    staging = out_dir.with_name(f"{prefix}{os.getpid()}")
    try:
        staging.mkdir()
    except FileExistsError as error:
        raise TrainError(f"{out_dir}: another training run is writing it ({staging.name})") from error
    return staging


def _publish(staging: Path, out_dir: Path) -> None:
    """Moves the finished staging directory to out_dir in one rename: the artifact appears whole or not at all."""
    if out_dir.exists() and any(out_dir.iterdir()):
        raise TrainError(f"{out_dir} was written by a concurrent run: artifacts are immutable")
    try:
        os.rename(staging, out_dir)
    except OSError as error:
        raise TrainError(f"cannot publish {out_dir} (a concurrent run may have written it): {error}") from error


def train_all(
    data_dir: Path,
    out_dir: Path,
    embedder: Encoder,
    version: int,
    config: TrainConfig = TrainConfig(),
    now: datetime | None = None,
) -> Manifest:
    if version < 1:
        raise TrainError("version must be at least 1")
    if out_dir.exists() and any(out_dir.iterdir()):
        raise TrainError(f"{out_dir} already exists and is not empty: artifacts are immutable, pick a new version")
    staging = _staging_dir(out_dir)
    try:
        manifest = _build(data_dir, staging, embedder, version, config, now)
        _publish(staging, out_dir)
    except BaseException:
        shutil.rmtree(staging, ignore_errors=True)
        raise
    return manifest


def _build(
    data_dir: Path,
    staging: Path,
    embedder: Encoder,
    version: int,
    config: TrainConfig,
    now: datetime | None,
) -> Manifest:
    stats = load_stats(data_dir)
    for question_id in stats:
        if not QUESTION_ID.fullmatch(question_id):
            raise TrainError(f"question id {question_id!r} cannot be used as a file name")
    entries: dict[str, QuestionEntry] = {}
    heads: dict[str, Head] = {}
    dims = DEFAULT_DIMS
    for question_id in sorted(stats):
        entry, head, width = _train_question(data_dir / question_id, question_id, embedder, config)
        entries[question_id] = entry
        if head is not None:
            heads[question_id] = head
        dims = width or dims
    manifest = Manifest(
        schema_version=SCHEMA_VERSION,
        version=f"reflex-v{version}",
        created_at=(now or datetime.now(UTC)).isoformat(timespec="seconds"),
        embedder=EMBEDDER_NAME,
        dims=dims,
        sklearn=sklearn.__version__,
        dataset_sha256=dataset_sha256(data_dir, list(stats)),
        questions=entries,
    )
    return Artifact.write(staging, manifest, heads)


def _disabled(kind: HeadKind, classes: list[str], metrics: Metrics, reason: str) -> QuestionEntry:
    return QuestionEntry(
        kind=kind, classes=classes, tau=1.0, metrics=metrics_entry(metrics), disabled=True, reason=reason
    )


def _empty_metrics(n_train: int, n_test: int) -> Metrics:
    return Metrics(
        macro_f1=None, qwk=None, ece=None, coverage=0.0, selective_accuracy=None, n_train=n_train, n_test=n_test
    )


def _train_question(
    directory: Path, question_id: str, embedder: Encoder, config: TrainConfig
) -> tuple[QuestionEntry, Head | None, int | None]:
    train_x, train_y = read_split(directory, "train")
    calib_x, calib_y = read_split(directory, "calib")
    test_x, test_y = read_split(directory, "test")
    n_train, n_test = len(train_y), len(test_y)
    all_labels = [*train_y, *calib_y, *test_y]
    if not all_labels:
        return _disabled("choice", [], _empty_metrics(0, 0), "no labeled rows"), None, None
    try:
        kinds = {label_kind(label) for label in all_labels}
        if len(kinds) != 1:
            raise HeadError("mixed label types")
        kind = kinds.pop()
        train_keys = [class_key(label) for label in train_y]
        classes = order_classes(kind, set(train_keys))
        calib_keys = [class_key(label) for label in calib_y]
        test_keys = [class_key(label) for label in test_y]
    except HeadError as error:
        return _disabled("choice", [], _empty_metrics(n_train, n_test), str(error)), None, None
    if n_train < config.min_train:
        return _disabled(kind, classes, _empty_metrics(n_train, n_test), f"only {n_train} training rows"), None, None
    if len(calib_y) < config.min_calib:
        reason = f"only {len(calib_y)} calibration rows (min {config.min_calib})"
        return _disabled(kind, classes, _empty_metrics(n_train, n_test), reason), None, None
    if len(classes) < 2:
        return _disabled(kind, classes, _empty_metrics(n_train, n_test), "a single class in training"), None, None

    head = Head(question_id, kind, classes)
    X_train, X_calib, X_test = _embed(embedder, train_x), _embed(embedder, calib_x), _embed(embedder, test_x)
    head.fit(X_train, train_keys)
    reason: str | None = None
    try:
        head.calibrate(X_calib, calib_keys)
    except HeadError as error:
        reason = str(error)
    if reason is None:
        found = predictions(head, X_calib)
        correct = np.array([a == b for a, b in zip(found.labels, calib_keys)], dtype=float)
        tau = choose_tau(found.confidence, correct, config.target_accuracy, config.min_coverage)
        if tau is None:
            reason = f"no threshold reaches accuracy {config.target_accuracy} with coverage {config.min_coverage}"
        else:
            head.tau = tau
    disabled = reason is not None
    metrics = evaluate(head, X_test, test_keys, n_train, disabled)
    entry = QuestionEntry(
        kind=kind,
        classes=classes,
        tau=head.tau,
        metrics=metrics_entry(metrics),
        disabled=disabled,
        reason=reason,
    )
    return entry, head, int(X_train.shape[1])


def eval_artifact(artifact: Artifact, data_dir: Path, embedder: Encoder) -> dict[str, dict[str, Any]]:
    """Re-scores every head of the artifact on the dataset's test split and writes `eval.json` next to the manifest."""
    report: dict[str, dict[str, Any]] = {}
    for question_id, entry in artifact.manifest.questions.items():
        head = artifact.heads.get(question_id)
        texts, labels = read_split(data_dir / question_id, "test")
        n_train = entry.metrics.n_train
        if head is None:
            metrics = entry.metrics.model_dump()
        else:
            keys = [class_key(label) for label in labels]
            vectors = _embed(embedder, texts)
            metrics = dict(evaluate(head, vectors, keys, n_train, entry.disabled))
        report[question_id] = {"kind": entry.kind, "disabled": entry.disabled, "tau": entry.tau, "metrics": metrics}
    (artifact.directory / "eval.json").write_text(
        json.dumps(report, indent=2, sort_keys=True) + "\n", encoding="utf-8"
    )
    return report
