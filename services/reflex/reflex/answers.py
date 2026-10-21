"""Port of the answer resolution in packages/reflex/src/reflex.ts: a rule's value when it fits the question, else neutral."""

from dataclasses import dataclass
from typing import TypeGuard

from reflex.contract import Facts, Question
from reflex.rules import Scored, StandardScores

STANDARD_IDS = ("intent", "complexity", "owner", "executor", "parallelizable", "risk", "needs_approval", "language")

Value = bool | str | int | float


@dataclass(frozen=True)
class Resolved:
    value: Value
    confidence: float


def _standard(scores: StandardScores, question_id: str) -> Scored[Value] | None:
    if question_id not in STANDARD_IDS:
        return None
    scored: Scored[Value] = getattr(scores, question_id)
    return scored


# Static options when the question declares them. Owner and executor declare none: their options come from facts.
def choice_options(question: Question, facts: Facts) -> list[str] | None:
    if question.options:
        return question.options
    if question.id == "owner":
        return [*(bot.id for bot in facts.bots), "new"]
    if question.id == "executor":
        return [*(executor.id for executor in facts.executors), "none"]
    return None


def _is_number(value: Value) -> TypeGuard[int | float]:
    return isinstance(value, int | float) and not isinstance(value, bool)


# A value fits the question when its type matches the kind (and the scale or the options).
def _fits(question: Question, value: Value, facts: Facts) -> bool:
    if question.kind == "noul":
        return isinstance(value, bool)
    if question.kind == "score":
        if question.scale is None or not _is_number(value):
            return False
        low, high = question.scale
        return low <= value <= high
    options = choice_options(question, facts)
    return isinstance(value, str) and (options is None or value in options)


# Neutral value of the right type, used with confidence 0 when no rule answers or the answer does not fit.
def _neutral(question: Question, facts: Facts) -> Value:
    if question.kind == "noul":
        return False
    if question.kind == "score":
        return question.scale[0] if question.scale is not None else 0
    options = choice_options(question, facts)
    return options[0] if options else "unknown"


def resolve(question: Question, scores: StandardScores, facts: Facts) -> Resolved:
    scored = _standard(scores, question.id)
    if scored is not None and _fits(question, scored.value, facts):
        return Resolved(scored.value, scored.confidence)
    return Resolved(_neutral(question, facts), 0.0)
