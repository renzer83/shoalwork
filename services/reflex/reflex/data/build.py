"""Builds one dataset per question from a `reflex export` JSONL: labels, anonymized text, temporal splits, stats.

Output layout: `<out>/<question_id>/{train,calib,test,eval_unlabeled}.jsonl` and `<out>/stats.json`. Each labeled split
line is `{text, label, lang, channel, ts}`. `eval_unlabeled` lines are `{text, lang, channel, ts, outcome}`: no label
key, because `datasets` cannot merge an all-null column with the typed label of the splits. Load it on its own.
"""

import json
import re
from collections import Counter
from collections.abc import Iterable
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from typing import TypedDict

from pydantic import ValidationError

from reflex.data.anonymize import anonymize
from reflex.data.schema import DecisionRow, Value

DEFAULT_MIN_PER_CLASS = 5
TEXT_MAX_CHARS = 500
TRAIN_FRACTION = 0.70
CALIB_FRACTION = 0.15
UNKNOWN = "unknown"
UNLABELED = "eval_unlabeled"
STATS_FILE = "stats.json"
# A question id becomes a directory name, so it must not carry path separators or dots-only names.
QUESTION_ID = re.compile(r"[A-Za-z0-9][A-Za-z0-9_.-]{0,63}")


class DatasetError(ValueError):
    """Input the builder refuses: a malformed line or a question id that cannot be a directory name."""


class QuestionStats(TypedDict):
    n: int
    unlabeled: int
    classes: dict[str, int]
    insufficient: bool
    span: list[str]
    splits: dict[str, int]


@dataclass(frozen=True)
class Example:
    ts: datetime
    decision_id: str
    text: str
    lang: str
    channel: str
    label: Value | None
    outcome: str


def read_rows(path: Path) -> dict[str, list[DecisionRow]]:
    by_question: dict[str, list[DecisionRow]] = {}
    with path.open(encoding="utf-8") as handle:
        for number, line in enumerate(handle, start=1):
            if not line.strip():
                continue
            try:
                row = DecisionRow.model_validate_json(line)
            except ValidationError as error:
                # The message names fields only: the line itself holds user text and must not be echoed.
                problems = "; ".join(f"{'.'.join(str(part) for part in e['loc'])}: {e['msg']}" for e in error.errors())
                raise DatasetError(f"{path}:{number}: invalid row ({problems})") from error
            by_question.setdefault(row.question.id, []).append(row)
    return by_question


def build_dataset(path: Path, out_dir: Path, min_per_class: int = DEFAULT_MIN_PER_CLASS) -> dict[str, QuestionStats]:
    if min_per_class < 1:
        raise DatasetError("min_per_class must be at least 1")
    by_question = read_rows(path)
    for question_id in by_question:
        if not QUESTION_ID.fullmatch(question_id):
            raise DatasetError(f"question id {question_id!r} cannot be used as a directory name")
    stats: dict[str, QuestionStats] = {}
    for question_id in sorted(by_question):
        stats[question_id] = _write_question(out_dir / question_id, by_question[question_id], min_per_class)
    out_dir.mkdir(parents=True, exist_ok=True)
    (out_dir / STATS_FILE).write_text(
        json.dumps(stats, ensure_ascii=False, indent=2, sort_keys=True) + "\n", encoding="utf-8"
    )
    return stats


def load_stats(dataset_dir: Path) -> dict[str, QuestionStats]:
    with (dataset_dir / STATS_FILE).open(encoding="utf-8") as handle:
        return json.load(handle)


def _write_question(directory: Path, rows: list[DecisionRow], min_per_class: int) -> QuestionStats:
    labeled: list[Example] = []
    unlabeled: list[Example] = []
    for row in rows:
        example = _example(row)
        (unlabeled if example.label is None else labeled).append(example)
    labeled.sort(key=_order)
    unlabeled.sort(key=_order)

    # Temporal split on the labeled rows: the newest 15% is the test set, so no test row precedes a training row.
    n_train = round(len(labeled) * TRAIN_FRACTION)
    n_calib = round(len(labeled) * CALIB_FRACTION)
    parts: dict[str, list[dict[str, object]]] = {
        "train": [_record(e) for e in labeled[:n_train]],
        "calib": [_record(e) for e in labeled[n_train : n_train + n_calib]],
        "test": [_record(e) for e in labeled[n_train + n_calib :]],
        UNLABELED: [_unlabeled_record(e) for e in unlabeled],
    }
    directory.mkdir(parents=True, exist_ok=True)
    for name, records in parts.items():
        _write_jsonl(directory / f"{name}.jsonl", records)

    classes = Counter(_class_key(e.label) for e in labeled if e.label is not None)
    timestamps = [row.ts for row in rows]
    return {
        "n": len(labeled),
        "unlabeled": len(unlabeled),
        "classes": dict(sorted(classes.items())),
        "insufficient": not classes or any(count < min_per_class for count in classes.values()),
        "span": [min(timestamps).isoformat(), max(timestamps).isoformat()],
        "splits": {name: len(records) for name, records in parts.items()},
    }


def _example(row: DecisionRow) -> Example:
    return Example(
        ts=row.ts,
        decision_id=row.decisionId,
        text=anonymize(row.facts.text)[:TEXT_MAX_CHARS],
        lang=row.facts.language or UNKNOWN,
        channel=row.facts.channel or UNKNOWN,
        label=_label(row),
        outcome=row.outcome,
    )


# A correction counts only when the export typed it (note `-> <value>`); free-text notes never become labels.
def _label(row: DecisionRow) -> Value | None:
    if row.outcome == "correct":
        return row.answer.value
    if row.outcome == "corrected_by_human":
        return row.corrected
    return None


def _order(example: Example) -> tuple[datetime, str]:
    return (example.ts, example.decision_id)


def _class_key(label: Value) -> str:
    if isinstance(label, bool):
        return "true" if label else "false"
    return str(label)


def _record(example: Example) -> dict[str, object]:
    return {
        "text": example.text,
        "label": example.label,
        "lang": example.lang,
        "channel": example.channel,
        "ts": example.ts.isoformat(),
    }


def _unlabeled_record(example: Example) -> dict[str, object]:
    return {
        "text": example.text,
        "lang": example.lang,
        "channel": example.channel,
        "ts": example.ts.isoformat(),
        "outcome": example.outcome,
    }


def _write_jsonl(path: Path, records: Iterable[dict[str, object]]) -> None:
    with path.open("w", encoding="utf-8") as handle:
        for record in records:
            handle.write(json.dumps(record, ensure_ascii=False) + "\n")
