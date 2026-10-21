"""Predictor: embeds the message once and answers every question that has an active, calibrated head.

A question the model cannot answer (no active head, confidence below tau, or a value the request cannot use) goes to
the `fallback` callable, which gives the rule answer; when a head existed, that answer is marked `abstained`.
"""

import logging
import os
from collections.abc import Callable, Mapping, Sequence
from pathlib import Path

import numpy as np

from reflex.answers import Value, choice_options
from reflex.contract import Answer, Facts, Question
from reflex.data.anonymize import anonymize
from reflex.data.build import TEXT_MAX_CHARS
from reflex.model.artifact import Artifact, ArtifactError
from reflex.model.heads import Head
from reflex.model.metrics import EmbedMetrics
from reflex.model.train import Encoder

MODEL_DIR_ENV = "REFLEX_MODEL_DIR"
EMBEDDER_DIR_ENV = "REFLEX_EMBEDDER_DIR"
DEFAULT_EMBEDDER_DIR = "models/e5-small"

logger = logging.getLogger("reflex")


class Predictor:
    def __init__(self, artifact: Artifact, embedder: Encoder) -> None:
        self.artifact = artifact
        self._embedder = embedder
        dims = getattr(embedder, "dims", artifact.manifest.dims)
        if dims != artifact.manifest.dims:
            raise ArtifactError(f"artifact has {artifact.manifest.dims}-d heads, the encoder gives {dims}-d")
        metrics = getattr(embedder, "metrics", None)
        self.embed_metrics: EmbedMetrics | None = metrics if isinstance(metrics, EmbedMetrics) else None

    @property
    def version(self) -> str:
        return self.artifact.version

    def _active_head(self, question: Question) -> Head | None:
        entry = self.artifact.manifest.questions.get(question.id)
        head = self.artifact.heads.get(question.id)
        if entry is None or head is None or entry.disabled or head.kind != question.kind:
            return None
        return head

    def answer(
        self, facts: Facts, questions: Sequence[Question], fallback: Callable[[Question], Answer]
    ) -> list[Answer]:
        heads = {question.id: self._active_head(question) for question in questions}
        if not any(head is not None for head in heads.values()):
            return [fallback(question) for question in questions]
        try:
            vector = self._embedder.encode([anonymize(facts.text)[:TEXT_MAX_CHARS]], kind="query")
        except Exception:  # an encoder failure must not take the rules down with it
            logger.exception("embedding failed: answering from rules")
            vector = None
        answers: list[Answer] = []
        for question in questions:
            head = heads[question.id]
            if head is None:
                answers.append(fallback(question))
                continue
            predicted = self._predict(head, question, facts, vector)
            if predicted is None:
                predicted = fallback(question).model_copy(update={"abstained": True})
            answers.append(predicted)
        return answers

    def _predict(self, head: Head, question: Question, facts: Facts, vector: np.ndarray | None) -> Answer | None:
        if vector is None:
            return None
        proba = head.predict_proba(vector)[0]
        best = int(proba.argmax())
        confidence = float(min(1.0, max(0.0, proba[best])))
        if confidence < head.tau:
            return None
        value = _value(head.classes[best], question, facts)
        if value is None:
            return None
        return Answer(id=question.id, value=value, confidence=confidence, source="model")


# The class as the value the question asks for, or None when the request cannot use it (the model abstains).
def _value(name: str, question: Question, facts: Facts) -> Value | None:
    if question.kind == "noul":
        return name == "true"
    if question.kind == "score":
        if question.scale is None:
            return None
        number = int(name)
        return number if question.scale[0] <= number <= question.scale[1] else None
    options = choice_options(question, facts)
    return name if options is None or name in options else None


def load_predictor(environ: Mapping[str, str] = os.environ) -> Predictor | None:
    """The Predictor named by REFLEX_MODEL_DIR, or None when the variable is unset (rules only).

    A set but unusable directory fails the boot: the operator asked for a model, silently serving rules would hide it.
    """
    model_dir = (environ.get(MODEL_DIR_ENV) or "").strip()
    if not model_dir:
        return None
    from reflex.model.embedder import Embedder

    try:
        artifact = Artifact.load(Path(model_dir))
        embedder = Embedder((environ.get(EMBEDDER_DIR_ENV) or "").strip() or DEFAULT_EMBEDDER_DIR)
        predictor = Predictor(artifact, embedder)
    except Exception as error:  # whatever the loader or the ONNX runtime raised, the boot stops with one message
        raise RuntimeError(f"refusing to serve: {MODEL_DIR_ENV}={model_dir}: {error}") from error
    active = sum(not entry.disabled for entry in artifact.manifest.questions.values())
    logger.info("serving %s with %d active heads", artifact.version, active)
    return predictor
