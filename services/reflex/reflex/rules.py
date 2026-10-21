"""Port of packages/reflex/src/rules.ts: the v0 rules, no model. Same tables, same confidences, same order of checks.

Text is measured the way JavaScript measures it (UTF-16 code units, the JS whitespace set), so the same input
gets the same decision here and in TypeScript. Python's `re` has no \\p{L}: `\\w` is the same set (letters, digits, _).
"""

import re
import unicodedata
from dataclasses import dataclass, field
from typing import Annotated, Literal

from pydantic import BaseModel, Field

from reflex.contract import BotFact, Facts

Intent = Literal["chat", "system", "code", "research", "app_op", "routine"]
Language = Literal["pt", "en", "es", "other"]

# Confidence levels of the v0 rules (no model involved).
STRONG = 0.9  # whole-word keyword, explicit mention or hint
ROLE = 0.7  # Bot picked by its role
WEAK = 0.6  # weak heuristic: repo presence, stopwords, sequence words
DEFAULT = 0.5  # no rule matched
UNKNOWN = 0.3  # no owner candidate at all
NONE = 0.0

Words = Annotated[list[str], Field(min_length=1)]
Chars = Annotated[int, Field(ge=1, le=100_000)]


class IntentTables(BaseModel):
    code: Words
    research: Words
    app_op: Words
    routine: Words


class RiskTables(BaseModel):
    high: Words
    external: Words
    local: Words


class LanguageTables(BaseModel):
    pt: Words
    en: Words
    es: Words


class OwnerTables(BaseModel):
    roles: Words
    leadName: str = Field(min_length=1)


class Limits(BaseModel):
    ruleChars: Chars = 8000
    payloadChars: Chars = 2000


# Mirrors config/reflex.config.yaml (the keys the rules read). Thresholds are not rules' concern.
class RulesConfig(BaseModel):
    intent: IntentTables
    verbs: Words
    sequence: Words
    risk: RiskTables
    language: LanguageTables
    owner: OwnerTables
    limits: Limits = Limits()


# JavaScript WhiteSpace and LineTerminator: what \s and String.prototype.trim() match.
_JS_WS = "\t\n\x0b\x0c\r \xa0 " + "".join(chr(c) for c in range(0x2000, 0x200B)) + "    　﻿"
_JS_SPACE_RUN = "[" + re.escape(_JS_WS) + "]+"
_WS_RUN = re.compile(_JS_SPACE_RUN)

_WORD_START = r"(?<!\w)"
_WORD_END = r"(?!\w)"
_REGEX_SPECIAL = re.compile(r"[.*+?^${}()|\[\]\\]")

# Structural patterns that are not keyword tables.
_ROUTINE_HOUR = re.compile(_WORD_START + "às" + _JS_SPACE_RUN + "[0-9]", re.IGNORECASE)
_LIST_LINE = re.compile(r"(?:(?<=[\n\r  ])|^)[ \t]*(?:[0-9]+\.|-)[ \t]")


def js_len(text: str) -> int:
    """Length in UTF-16 code units, as JavaScript's String.length counts it."""
    return len(text.encode("utf-16-le", "surrogatepass")) // 2


def js_slice(text: str, count: int) -> str:
    """The first `count` UTF-16 code units, as String.prototype.slice(0, count) cuts them."""
    return text.encode("utf-16-le", "surrogatepass")[: 2 * count].decode("utf-16-le", "surrogatepass")


def js_trim(text: str) -> str:
    return text.strip(_JS_WS)


def _escape(word: str) -> str:
    return _REGEX_SPECIAL.sub(lambda m: "\\" + m.group(0), word)


# Whole words, case-insensitive, Unicode-aware. Longest first, so phrases win.
def compile_words(words: list[str]) -> re.Pattern[str]:
    # Sorted by UTF-16 length, as the TypeScript rules sort, so the alternation order is the same.
    alternatives = sorted((js_trim(word) for word in words), key=js_len, reverse=True)
    body = "|".join(_WS_RUN.sub(lambda _m: _JS_SPACE_RUN, _escape(word)) for word in alternatives)
    return re.compile(f"{_WORD_START}(?:{body}){_WORD_END}", re.IGNORECASE)


def _has(pattern: re.Pattern[str], text: str) -> bool:
    return pattern.search(text) is not None


def _at(pattern: re.Pattern[str], text: str) -> int:
    match = pattern.search(text)
    return match.start() if match is not None else -1


def _count(pattern: re.Pattern[str], text: str) -> int:
    return sum(1 for _ in pattern.finditer(text))


def _distinct(pattern: re.Pattern[str], text: str) -> int:
    return len({_WS_RUN.sub(" ", match.group(0).lower()) for match in pattern.finditer(text)})


@dataclass(frozen=True)
class Scored[V]:
    value: V
    confidence: float


@dataclass
class CompiledRules:
    code: re.Pattern[str]
    research: re.Pattern[str]
    app_op: re.Pattern[str]
    routine: re.Pattern[str]
    verbs: re.Pattern[str]
    sequence: re.Pattern[str]
    high: re.Pattern[str]
    external: re.Pattern[str]
    local: re.Pattern[str]
    languages: list[tuple[Literal["pt", "en", "es"], re.Pattern[str]]]
    owner_roles: list[str]
    lead_name: str
    rule_chars: int
    # Memo of the mention pattern per Bot name; compiled once per name, reused across asks.
    mentions: dict[str, re.Pattern[str]] = field(default_factory=dict)


def compile_rules(config: RulesConfig) -> CompiledRules:
    return CompiledRules(
        code=compile_words(config.intent.code),
        research=compile_words(config.intent.research),
        app_op=compile_words(config.intent.app_op),
        routine=compile_words(config.intent.routine),
        verbs=compile_words(config.verbs),
        sequence=compile_words(config.sequence),
        high=compile_words(config.risk.high),
        external=compile_words(config.risk.external),
        local=compile_words(config.risk.local),
        languages=[
            ("pt", compile_words(config.language.pt)),
            ("en", compile_words(config.language.en)),
            ("es", compile_words(config.language.es)),
        ],
        owner_roles=[role.lower() for role in config.owner.roles],
        lead_name=config.owner.leadName,
        rule_chars=config.limits.ruleChars,
    )


# Every rule reads the same view of the text: NFC-normalized and cut to `ruleChars`.
def _text_of(facts: Facts, c: CompiledRules) -> str:
    return js_slice(unicodedata.normalize("NFC", facts.text), c.rule_chars)


# Bounded: names come from requests, so the memo evicts its oldest entry rather than growing without limit.
MENTION_MEMO_LIMIT = 256


def _mention(name: str, c: CompiledRules) -> re.Pattern[str]:
    cached = c.mentions.get(name)
    if cached is not None:
        return cached
    if len(c.mentions) >= MENTION_MEMO_LIMIT:
        del c.mentions[next(iter(c.mentions))]
    pattern = compile_words([name])
    c.mentions[name] = pattern
    return pattern


def intent_rule(facts: Facts, c: CompiledRules) -> Scored[Intent]:
    text = js_trim(_text_of(facts, c))
    if text.startswith("/"):
        return Scored("system", STRONG)
    if _has(c.code, text):
        return Scored("code", STRONG)
    if _has(c.research, text):
        return Scored("research", STRONG)
    if _has(c.app_op, text):
        return Scored("app_op", STRONG)
    if _has(c.routine, text) or _has(_ROUTINE_HOUR, text):
        return Scored("routine", STRONG)
    # Repo presence is weak evidence: explicit keywords above take precedence.
    if facts.hasRepo:
        return Scored("code", WEAK)
    return Scored("chat", DEFAULT)


def _length_points(length: int) -> int:
    if length < 80:
        return 0
    if length < 200:
        return 1
    return 2 if length < 400 else 3


def complexity_rule(facts: Facts, c: CompiledRules) -> Scored[int]:
    text = js_trim(_text_of(facts, c))
    verbs = _distinct(c.verbs, text)
    verb_points = 2 if verbs >= 3 else 1 if verbs == 2 else 0
    sequence_points = 1 if _has(c.sequence, text) else 0
    return Scored(min(4, _length_points(js_len(text)) + verb_points + sequence_points), WEAK)


# The Bot mentioned first in the text (@name or the bare name) wins; on a tie, the first one in the list.
def _first_mentioned(facts: Facts, text: str, c: CompiledRules) -> BotFact | None:
    best: tuple[int, BotFact] | None = None
    for bot in facts.bots:
        at = _at(_mention(bot.name, c), text)
        if at != -1 and (best is None or at < best[0]):
            best = (at, bot)
    return None if best is None else best[1]


# Order: explicit hint, mention of a Bot name, code intent to a dev/worker role, lead.
def owner_rule(facts: Facts, c: CompiledRules, intent: Intent) -> Scored[str]:
    hinted = next((bot for bot in facts.bots if bot.id == facts.botHint), None)
    if hinted is not None:
        return Scored(hinted.id, STRONG)
    mentioned = _first_mentioned(facts, _text_of(facts, c), c)
    if mentioned is not None:
        return Scored(mentioned.id, STRONG)
    if intent == "code":
        worker = next(
            (bot for bot in facts.bots if any(role in bot.role.lower() for role in c.owner_roles)),
            None,
        )
        if worker is not None:
            return Scored(worker.id, ROLE)
    lead = next((bot for bot in facts.bots if bot.name == c.lead_name), None)
    if lead is not None:
        return Scored(lead.id, WEAK)
    return Scored("new", UNKNOWN)


# Owner's preferred list first, then its allowed list; only executors reported available qualify.
# An owner without routing (or "new") has no executor: none, confidence 0.
def executor_rule(facts: Facts, owner: str) -> Scored[str]:
    available = {executor.id for executor in facts.executors if executor.available}
    routing = next((bot.routing for bot in facts.bots if bot.id == owner), None)
    if routing is None:
        return Scored("none", NONE)
    preferred = next((executor for executor in routing.preferred if executor in available), None)
    if preferred is not None:
        return Scored(preferred, STRONG)
    allowed = next((executor for executor in routing.allowed if executor in available), None)
    if allowed is not None:
        return Scored(allowed, WEAK)
    return Scored("none", NONE)


def parallelizable_rule(facts: Facts, c: CompiledRules, complexity: int) -> Scored[bool]:
    return Scored(complexity >= 3 and _LIST_LINE.search(_text_of(facts, c)) is not None, WEAK)


def risk_rule(facts: Facts, c: CompiledRules) -> Scored[int]:
    text = _text_of(facts, c)
    if _has(c.high, text):
        return Scored(3, STRONG)
    if _has(c.external, text):
        return Scored(2, STRONG)
    if _has(c.local, text):
        return Scored(1, STRONG)
    return Scored(0, DEFAULT)


def needs_approval_rule(risk: Scored[int]) -> Scored[bool]:
    return Scored(risk.value >= 2, risk.confidence)


# Stopword counts per language; the highest count wins, ties go to the order pt, en, es.
def language_rule(facts: Facts, c: CompiledRules) -> Scored[Language]:
    text = _text_of(facts, c)
    best_lang: Language = "other"
    best_hits = 0
    for lang, words in c.languages:
        hits = _count(words, text)
        if hits > best_hits:
            best_lang, best_hits = lang, hits
    if best_hits == 0:
        return Scored("other", DEFAULT)
    return Scored(best_lang, STRONG if best_hits >= 2 else WEAK)


@dataclass(frozen=True)
class StandardScores:
    intent: Scored[Intent]
    complexity: Scored[int]
    owner: Scored[str]
    executor: Scored[str]
    parallelizable: Scored[bool]
    risk: Scored[int]
    needs_approval: Scored[bool]
    language: Scored[Language]


# Pure: every standard question, with its dependencies computed once.
def score_all(facts: Facts, c: CompiledRules) -> StandardScores:
    intent = intent_rule(facts, c)
    complexity = complexity_rule(facts, c)
    owner = owner_rule(facts, c, intent.value)
    executor = executor_rule(facts, owner.value)
    parallelizable = parallelizable_rule(facts, c, complexity.value)
    risk = risk_rule(facts, c)
    return StandardScores(
        intent=intent,
        complexity=complexity,
        owner=owner,
        executor=executor,
        parallelizable=parallelizable,
        risk=risk,
        needs_approval=needs_approval_rule(risk),
        language=language_rule(facts, c),
    )
