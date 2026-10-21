"""One line of `reflex export` (T-032), typed for the dataset builder.

Only the fields the dataset needs are declared. Unknown keys are ignored so the export can grow without breaking the
build; `facts.userId` and every bot's name and role are therefore never read.
"""

from typing import Literal

from pydantic import AwareDatetime, BaseModel, ConfigDict, Field

Kind = Literal["noul", "choice", "score"]
Outcome = Literal["correct", "corrected_by_human", "escalated", "unknown"]
# Same union as the export: a noul answer is bool, a choice answer is an option id, a score answer is a number.
Value = bool | str | int | float


class _Lenient(BaseModel):
    model_config = ConfigDict(extra="ignore")


class FactsRow(_Lenient):
    text: str
    channel: str | None = None
    language: str | None = None


class QuestionRow(_Lenient):
    id: str = Field(min_length=1, max_length=64)
    kind: Kind


class AnswerRow(_Lenient):
    value: Value


class DecisionRow(_Lenient):
    decisionId: str = Field(min_length=1)
    # Aware timestamps only: a naive one would make the temporal split ambiguous.
    ts: AwareDatetime
    facts: FactsRow
    question: QuestionRow
    answer: AnswerRow
    outcome: Outcome
    # Set by the export when the human note is `-> <value>`, already typed by the question kind.
    corrected: Value | None = None
