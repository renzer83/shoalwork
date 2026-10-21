import json
from collections import Counter
from datetime import datetime
from pathlib import Path

import pytest
from datasets import load_dataset

from reflex.data.anonymize import anonymize
from reflex.data.build import DatasetError, build_dataset, load_stats

FIXTURE = Path(__file__).parent / "fixtures" / "decisions.jsonl"
SPLITS = ("train", "calib", "test")
UNLABELED = "eval_unlabeled"
TRAINING_COLUMNS = ["text", "label", "lang", "channel", "ts"]


@pytest.fixture(scope="module")
def built(tmp_path_factory: pytest.TempPathFactory) -> Path:
    out = tmp_path_factory.mktemp("dataset")
    build_dataset(FIXTURE, out, min_per_class=5)
    return out


def _lines(path: Path) -> list[dict[str, object]]:
    with path.open(encoding="utf-8") as handle:
        return [json.loads(line) for line in handle if line.strip()]


def _ts(row: dict[str, object]) -> datetime:
    return datetime.fromisoformat(str(row["ts"]))


def _all_output(built: Path) -> list[dict[str, object]]:
    rows: list[dict[str, object]] = []
    for question in load_stats(built):
        for name in (*SPLITS, UNLABELED):
            rows.extend(_lines(built / question / f"{name}.jsonl"))
    return rows


def _row(
    i: int,
    outcome: str = "correct",
    value: bool | str = True,
    corrected: bool | None = None,
    note: str | None = None,
    text: str = "Preciso de resposta",
    ts: str | None = None,
) -> dict[str, object]:
    line: dict[str, object] = {
        "decisionId": f"dec_{i:03d}",
        "ts": ts or f"2026-01-01T00:{i:02d}:00.000Z",
        "facts": {"text": text, "channel": "api", "userId": "user_12345678901", "language": "pt"},
        "question": {"id": "q", "kind": "noul"},
        "answer": {"value": value, "confidence": 0.9, "source": "rule"},
        "outcome": outcome,
    }
    if note is not None:
        line["note"] = note
    if corrected is not None:
        line["corrected"] = corrected
    return line


def _write(path: Path, rows: list[dict[str, object]]) -> Path:
    path.write_text("".join(json.dumps(row, ensure_ascii=False) + "\n" for row in rows), encoding="utf-8")
    return path


def test_each_question_splits_70_15_15_within_one_row(built: Path) -> None:
    stats = load_stats(built)
    assert len(stats) == 4
    for question, entry in stats.items():
        n = entry["n"]
        counts = {name: len(_lines(built / question / f"{name}.jsonl")) for name in SPLITS}
        assert sum(counts.values()) == n
        assert abs(counts["train"] - 0.70 * n) <= 1
        assert abs(counts["calib"] - 0.15 * n) <= 1
        assert abs(counts["test"] - 0.15 * n) <= 1


def test_test_rows_are_never_older_than_training_rows(built: Path) -> None:
    for question in load_stats(built):
        stamps = {name: [_ts(r) for r in _lines(built / question / f"{name}.jsonl")] for name in SPLITS}
        assert stamps["train"] and stamps["test"]
        assert max(stamps["train"]) <= min(stamps["calib"])
        assert max(stamps["calib"]) <= min(stamps["test"])
        assert max(stamps["train"]) <= min(stamps["test"])


# Token-shaped literals would trip the secret scanner in CI, so the cases below are assembled at runtime.
TELEGRAM_SHAPED = "".join(["1234567890", ":", "AAHdqTcvCH1vGWJxfSeofSAs0K5PAL", "-abc"])
SLACK_SHAPED = "".join(["xox", "b-1234567-abcdefgh"])
HEX_SHAPED = "".join(["a1b2c3d4e5f6", "a7b8c9d0e1f2", "a3b4c5d6"])


def test_free_text_has_no_emails_urls_or_ids_and_keeps_placeholders(built: Path) -> None:
    joined = "\n".join(str(row["text"]) for row in _all_output(built))
    for leak in ("@", "http", "www.", "bot_", "task_", "ana.silva", "12345678"):
        assert leak not in joined
    for placeholder in ("<email>", "<url>", "<id>", "<num>"):
        assert placeholder in joined
    assert all(len(str(row["text"])) <= 500 for row in _all_output(built))


@pytest.mark.parametrize(
    ("raw", "expected"),
    [
        ("ana.silva@example.com", "<email>"),
        ("https://example.org/x?y=1", "<url>"),
        ("www.example.net/pagina", "<url>"),
        ("task_4f9a2c1d falhou", "<id> falhou"),
        ("bot_alpha", "<id>"),
        ("pedido 12345678 travado", "pedido <num> travado"),
        ("+55 11 98765-4321", "<num>"),
        (TELEGRAM_SHAPED, "<token>"),
        (SLACK_SHAPED, "<token>"),
        (HEX_SHAPED, "<token>"),
        ("Preciso de resposta urgente", "Preciso de resposta urgente"),
    ],
)
def test_anonymize_replaces_each_kind_with_its_placeholder(raw: str, expected: str) -> None:
    assert anonymize(raw) == expected


def test_escalated_and_unknown_rows_stay_out_of_training(built: Path) -> None:
    fixture_outcomes = Counter(str(r["outcome"]) for r in _lines(FIXTURE))
    unlabeled = [r for q in load_stats(built) for r in _lines(built / q / f"{UNLABELED}.jsonl")]
    unlabeled_outcomes = Counter(str(r["outcome"]) for r in unlabeled)
    assert unlabeled_outcomes["escalated"] == fixture_outcomes["escalated"]
    assert unlabeled_outcomes["unknown"] == fixture_outcomes["unknown"]
    trained = sum(load_stats(built)[q]["n"] for q in load_stats(built))
    assert trained + len(unlabeled) == len(_lines(FIXTURE))


def test_stats_mark_a_question_with_a_rare_class_as_insufficient(built: Path) -> None:
    stats = load_stats(built)
    assert stats["bot"]["insufficient"] is True
    assert stats["bot"]["classes"]["bot_rare"] == 4
    assert stats["urgent"]["insufficient"] is False
    assert len(stats["urgent"]["span"]) == 2


def test_load_dataset_reads_each_training_split_without_custom_features(built: Path, tmp_path: Path) -> None:
    question = "urgent"
    data_files = {name: str(built / question / f"{name}.jsonl") for name in SPLITS}
    ds = load_dataset("json", data_files=data_files, cache_dir=str(tmp_path / "hf"))
    for name in SPLITS:
        assert ds[name].column_names == TRAINING_COLUMNS
    assert sum(ds[name].num_rows for name in SPLITS) == load_stats(built)[question]["n"]

    unlabeled = load_dataset(
        "json", data_files={UNLABELED: str(built / question / f"{UNLABELED}.jsonl")}, cache_dir=str(tmp_path / "hf")
    )
    assert "label" not in unlabeled[UNLABELED].column_names
    assert "outcome" in unlabeled[UNLABELED].column_names


def test_user_ids_bot_profiles_and_free_notes_never_reach_the_dataset(built: Path) -> None:
    joined = "\n".join(json.dumps(row, ensure_ascii=False) for row in _all_output(built))
    for secret in ("user_", "Assistente", "financeiro-pessoal", "confirmar com", "ana.silva"):
        assert secret not in joined


def test_only_typed_corrections_become_labels(tmp_path: Path) -> None:
    rows = [
        _row(0, outcome="correct", value=True),
        _row(1, outcome="corrected_by_human", value=True, corrected=False, note="-> false"),
        _row(2, outcome="corrected_by_human", value=True, note="depende do cliente"),
        _row(3, outcome="escalated", value=True),
    ]
    source = _write(tmp_path / "in.jsonl", rows)
    stats = build_dataset(source, tmp_path / "out", min_per_class=1)
    assert stats["q"]["n"] == 2
    assert stats["q"]["classes"] == {"false": 1, "true": 1}
    assert stats["q"]["unlabeled"] == 2
    unlabeled = _lines(tmp_path / "out" / "q" / f"{UNLABELED}.jsonl")
    assert sorted(str(r["outcome"]) for r in unlabeled) == ["corrected_by_human", "escalated"]
    assert "depende do cliente" not in (tmp_path / "out" / "q" / f"{UNLABELED}.jsonl").read_text(encoding="utf-8")


def test_rejects_naive_timestamps_naming_the_line_without_echoing_text(tmp_path: Path) -> None:
    source = _write(tmp_path / "in.jsonl", [_row(0), _row(1, ts="2026-01-01T00:01:00", text="segredo pessoal")])
    with pytest.raises(DatasetError, match=r"in\.jsonl:2: invalid row") as error:
        build_dataset(source, tmp_path / "out")
    assert "segredo pessoal" not in str(error.value)


def test_refuses_question_ids_that_are_not_safe_directory_names(tmp_path: Path) -> None:
    bad = _row(0)
    bad["question"] = {"id": "../escape", "kind": "noul"}
    source = _write(tmp_path / "in.jsonl", [bad])
    with pytest.raises(DatasetError, match="cannot be used as a directory name"):
        build_dataset(source, tmp_path / "out")
    assert not (tmp_path / "escape").exists()
