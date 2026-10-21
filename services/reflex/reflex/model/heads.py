"""Head: one linear classifier per question on top of the frozen embedding, plus its sigmoid/isotonic calibration.

Class keys are strings: "true"/"false" for noul, the option id for choice, an integer text ("0".."4") for score.
"""

import io
from pathlib import Path
from typing import Any, Literal

import joblib
import numpy as np
from sklearn.calibration import CalibratedClassifierCV
from sklearn.frozen import FrozenEstimator
from sklearn.linear_model import LogisticRegression

HeadKind = Literal["noul", "choice", "score"]
Label = bool | int | float | str
ISOTONIC_MIN_CALIB = 1000
# The frozen classifier is not refitted, so the folds only split the predictions; 2 is the least sklearn accepts.
CALIB_FOLDS = 2
STATE_KEYS = {"question_id", "kind", "classes", "tau", "method", "classifier", "calibrated"}


class HeadError(ValueError):
    """The head cannot be fitted, calibrated or loaded from the data it was given."""


def class_key(label: Label) -> str:
    """Stable string key of a dataset label; a whole float is an int (4.0 -> "4")."""
    if isinstance(label, bool):
        return "true" if label else "false"
    if isinstance(label, float) and label.is_integer():
        return str(int(label))
    return str(label)


def label_kind(label: Label) -> HeadKind:
    if isinstance(label, bool):
        return "noul"
    if isinstance(label, int | float):
        return "score"
    if isinstance(label, str):
        return "choice"
    raise HeadError(f"unsupported label type {type(label).__name__}")


def order_classes(kind: HeadKind, keys: set[str]) -> list[str]:
    if kind == "score":
        try:
            return sorted(keys, key=int)
        except ValueError as error:
            raise HeadError("score labels must be whole numbers") from error
    return sorted(keys)


class Head:
    def __init__(self, question_id: str, kind: HeadKind, classes: list[str]) -> None:
        if len(set(classes)) != len(classes) or not classes:
            raise HeadError("classes must be non-empty and unique")
        self.question_id = question_id
        self.kind: HeadKind = kind
        self.classes = list(classes)
        self.tau = 1.0
        self.method: Literal["sigmoid", "isotonic"] | None = None
        self._classifier: LogisticRegression | None = None
        self._calibrated: CalibratedClassifierCV | None = None

    @property
    def is_fitted(self) -> bool:
        return self._classifier is not None

    @property
    def is_calibrated(self) -> bool:
        return self._calibrated is not None

    def fit(self, X: np.ndarray, y: list[str]) -> None:
        if len(set(y)) < 2:
            raise HeadError(f"{self.question_id}: training needs at least two classes")
        unknown = set(y) - set(self.classes)
        if unknown:
            raise HeadError(f"{self.question_id}: labels outside the class list: {sorted(unknown)}")
        classifier = LogisticRegression(max_iter=1000, class_weight="balanced")
        classifier.fit(X, y)
        self._classifier = classifier
        self._calibrated = None
        self.method = None
        self.tau = 1.0

    def calibrate(self, X_calib: np.ndarray, y_calib: list[str]) -> None:
        classifier = self._require_classifier()
        # A label never seen in training cannot be calibrated; the rows still count as errors when tau is chosen.
        seen = {str(name) for name in classifier.classes_}
        known = [index for index, label in enumerate(y_calib) if label in seen]
        # sklearn's cross_val_predict needs the calibration rows to cover exactly the classifier's classes, twice each.
        counts = {name: sum(y_calib[i] == name for i in known) for name in seen}
        if min(counts.values()) < CALIB_FOLDS:
            raise HeadError(f"{self.question_id}: calibration needs at least {CALIB_FOLDS} rows of every class")
        method: Literal["sigmoid", "isotonic"] = "isotonic" if len(known) >= ISOTONIC_MIN_CALIB else "sigmoid"
        calibrated = CalibratedClassifierCV(FrozenEstimator(classifier), method=method, cv=CALIB_FOLDS)
        try:
            calibrated.fit(X_calib[known], [y_calib[i] for i in known])
        except ValueError as error:
            raise HeadError(f"{self.question_id}: calibration failed ({error})") from error
        self._calibrated = calibrated
        self.method = method

    def predict_proba_raw(self, X: np.ndarray) -> np.ndarray:
        classifier = self._require_classifier()
        return self._align(classifier.predict_proba(X), classifier.classes_)

    def predict_proba(self, X: np.ndarray) -> np.ndarray:
        """Calibrated probabilities [n, n_classes] in `self.classes` order (raw ones if never calibrated)."""
        if self._calibrated is None:
            return self.predict_proba_raw(X)
        return self._align(self._calibrated.predict_proba(X), self._calibrated.classes_)

    def save(self, path: Path) -> None:
        joblib.dump(
            {
                "question_id": self.question_id,
                "kind": self.kind,
                "classes": self.classes,
                "tau": self.tau,
                "method": self.method,
                "classifier": self._require_classifier(),
                "calibrated": self._calibrated,
            },
            path,
        )

    # joblib is pickle: only bytes whose sha256 matches the manifest reach this (see artifact.py).
    @classmethod
    def from_bytes(cls, data: bytes) -> "Head":
        state: Any = joblib.load(io.BytesIO(data))
        if not isinstance(state, dict) or set(state) != STATE_KEYS:
            raise HeadError("not a head file")
        classifier, calibrated = state["classifier"], state["calibrated"]
        if not isinstance(classifier, LogisticRegression):
            raise HeadError("classifier is not a LogisticRegression")
        if calibrated is not None and not isinstance(calibrated, CalibratedClassifierCV):
            raise HeadError("calibrator is not a CalibratedClassifierCV")
        tau, method = state["tau"], state["method"]
        if not isinstance(tau, float) or not 0.0 <= tau <= 1.0 or method not in (None, "sigmoid", "isotonic"):
            raise HeadError("calibration state is out of range")
        head = cls(state["question_id"], state["kind"], state["classes"])
        head.tau = tau
        head.method = method
        head._classifier = classifier
        head._calibrated = calibrated
        return head

    def _require_classifier(self) -> LogisticRegression:
        if self._classifier is None:
            raise HeadError(f"{self.question_id}: head is not fitted")
        return self._classifier

    def _align(self, proba: np.ndarray, model_classes: np.ndarray) -> np.ndarray:
        out = np.zeros((proba.shape[0], len(self.classes)), dtype=np.float64)
        index = {name: position for position, name in enumerate(self.classes)}
        for column, name in enumerate(model_classes):
            out[:, index[str(name)]] = proba[:, column]
        return out
