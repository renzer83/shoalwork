"""Abstention threshold (tau) and the per-question metrics: macro-F1, QWK, ECE (10 bins) and coverage."""

from dataclasses import dataclass
from typing import TypedDict

import numpy as np
from sklearn.metrics import cohen_kappa_score, f1_score

from reflex.model.heads import Head

ECE_BINS = 10
DEFAULT_TARGET_ACCURACY = 0.90
DEFAULT_MIN_COVERAGE = 0.5


class Metrics(TypedDict):
    macro_f1: float | None
    qwk: float | None
    ece: float | None
    coverage: float
    # Accuracy of the answered rows (confidence >= tau) of the test split; None when nothing is answered.
    selective_accuracy: float | None
    n_train: int
    n_test: int


@dataclass(frozen=True)
class Predictions:
    labels: list[str]
    confidence: np.ndarray


def predictions(head: Head, X: np.ndarray) -> Predictions:
    proba = head.predict_proba(X)
    best = proba.argmax(axis=1)
    return Predictions([head.classes[i] for i in best], proba[np.arange(len(best)), best])


def ece(confidence: np.ndarray, correct: np.ndarray, bins: int = ECE_BINS) -> float:
    """Expected calibration error of the top-1 prediction (Guo et al. 2017)."""
    if len(confidence) == 0:
        return 0.0
    index = np.minimum((confidence * bins).astype(int), bins - 1)
    total = 0.0
    for b in range(bins):
        in_bin = index == b
        if in_bin.any():
            total += in_bin.sum() * abs(correct[in_bin].mean() - confidence[in_bin].mean())
    return float(total / len(confidence))


def choose_tau(
    confidence: np.ndarray,
    correct: np.ndarray,
    target_accuracy: float = DEFAULT_TARGET_ACCURACY,
    min_coverage: float = DEFAULT_MIN_COVERAGE,
) -> float | None:
    """Smallest tau whose answered rows (confidence >= tau) reach the target accuracy with enough coverage.

    The threshold is always one of the observed confidences, so `confidence >= tau` keeps at least one row.
    None when no threshold qualifies.
    """
    if len(confidence) == 0:
        return None
    for tau in np.unique(confidence):
        kept = confidence >= tau
        if kept.mean() < min_coverage:
            return None
        if correct[kept].mean() >= target_accuracy:
            return float(tau)
    return None


def evaluate(head: Head, X: np.ndarray, y: list[str], n_train: int, disabled: bool) -> Metrics:
    n = len(y)
    if n == 0:
        return Metrics(
            macro_f1=None, qwk=None, ece=None, coverage=0.0, selective_accuracy=None, n_train=n_train, n_test=0
        )
    found = predictions(head, X)
    truth = np.array(y)
    guessed = np.array(found.labels)
    correct = (truth == guessed).astype(float)
    labels = sorted(set(y) | set(found.labels), key=int if head.kind == "score" else str)
    macro = float(f1_score(truth, guessed, labels=labels, average="macro", zero_division=0))
    qwk = None
    if head.kind == "score":
        kappa = float(cohen_kappa_score([int(v) for v in y], [int(v) for v in found.labels], weights="quadratic"))
        qwk = None if np.isnan(kappa) else kappa
    answered = found.confidence >= head.tau
    coverage = 0.0 if disabled else float(answered.mean())
    selective = None if disabled or not answered.any() else float(correct[answered].mean())
    return Metrics(
        macro_f1=macro,
        qwk=qwk,
        ece=ece(found.confidence, correct),
        coverage=coverage,
        selective_accuracy=selective,
        n_train=n_train,
        n_test=n,
    )
