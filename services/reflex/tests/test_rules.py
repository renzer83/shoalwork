import json
from pathlib import Path

import pytest

from reflex.answers import resolve
from reflex.contract import Facts, Question
from reflex.rules import RulesConfig, _mention, compile_rules, compile_words, js_len, js_slice, score_all

FIXTURE = json.loads((Path(__file__).parent / "cases.json").read_text(encoding="utf-8"))
CONFIG = RulesConfig.model_validate(FIXTURE["config"])
RULES = compile_rules(CONFIG)
CASES = FIXTURE["cases"]
STANDARD = ("intent", "complexity", "owner", "executor", "parallelizable", "risk", "needs_approval", "language")


def _facts(text: str, **extra: object) -> Facts:
    base: dict[str, object] = {
        "text": text,
        "channel": "telegram",
        "userId": "42",
        "bots": [
            {"id": "bot_lead", "name": "lead", "role": "coordinator"},
            {
                "id": "bot_dev",
                "name": "dev-demo",
                "role": "developer",
                "routing": {"preferred": ["claude-code"], "allowed": ["claude-code", "codex"]},
            },
            {"id": "bot_writer", "name": "writer", "role": "content"},
        ],
        "executors": [{"id": "claude-code", "available": True}, {"id": "codex", "available": True}],
        "hasRepo": False,
    }
    base.update(extra)
    return Facts.model_validate(base)


def test_fixture_has_at_least_twenty_cases() -> None:
    assert len(CASES) >= 20


@pytest.mark.parametrize("case", CASES, ids=[case["name"] for case in CASES])
def test_matches_typescript_rules(case: dict) -> None:
    scores = score_all(Facts.model_validate(case["facts"]), RULES)
    for question_id in STANDARD:
        scored = getattr(scores, question_id)
        expected = case["expected"][question_id]
        assert scored.value == expected["value"], question_id
        assert scored.confidence == expected["confidence"], question_id


def test_length_is_counted_in_utf16_code_units() -> None:
    assert js_len("abc") == 3
    assert js_len("\U0001f600") == 2


def test_slice_cuts_utf16_code_units_like_javascript() -> None:
    assert js_slice("a\U0001f600b", 3) == "a\U0001f600"
    assert js_slice("a\U0001f600b", 2) == "a\ud83d"


def test_decides_a_long_whitespace_input_like_a_short_one() -> None:
    big = _facts("\n" * 10_000 + " " * 10_000)  # the contract maximum for text
    small = _facts("\n" * 50 + " " * 50)
    assert score_all(big, RULES) == score_all(small, RULES)


def test_resolve_uses_the_rule_value_when_it_fits_the_question() -> None:
    facts = _facts("implementa o login")
    scores = score_all(facts, RULES)
    resolved = resolve(Question(id="intent", kind="choice", options=["chat", "code"]), scores, facts)
    assert (resolved.value, resolved.confidence) == ("code", 0.9)


def test_resolve_answers_neutral_with_confidence_zero_for_unknown_ids() -> None:
    facts = _facts("implementa o login")
    scores = score_all(facts, RULES)
    assert resolve(Question(id="custom", kind="noul"), scores, facts).value is False
    assert resolve(Question(id="custom", kind="score", scale=(0, 4)), scores, facts).value == 0
    resolved = resolve(Question(id="custom", kind="choice", options=["a", "b"]), scores, facts)
    assert (resolved.value, resolved.confidence) == ("a", 0.0)


def test_resolve_answers_neutral_when_the_value_is_outside_the_scale() -> None:
    facts = _facts("implementa o login")
    scores = score_all(facts, RULES)
    resolved = resolve(Question(id="complexity", kind="score", scale=(5, 6)), scores, facts)
    assert (resolved.value, resolved.confidence) == (5, 0.0)


def test_mention_memo_is_bounded() -> None:
    compiled = compile_rules(CONFIG)
    for index in range(300):
        _mention(f"bot{index}", compiled)
    assert len(compiled.mentions) == 256
    assert "bot299" in compiled.mentions


def test_alternatives_are_ordered_by_utf16_length_like_typescript() -> None:
    # "😀😀" is 2 code points but 4 UTF-16 units, so it must come before the 3-unit "abc".
    pattern = compile_words(["abc", "\U0001f600\U0001f600"]).pattern
    assert pattern.index("\U0001f600") < pattern.index("abc") or pattern.index("\ud83d") < pattern.index("abc")
