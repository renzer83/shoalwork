"""Replaces URLs, e-mails, ids, secrets and phone-like digit runs in free text with fixed placeholders.

The same input always gives the same output, so repeated messages stay identical in the dataset. Order matters: URLs
before e-mails (an address can sit inside a URL), the Telegram token and known secret prefixes before the digit rule
(a token starts with digits), and ids before the generic long-token rule (`bot_...` ids are not secrets).
"""

import re

_RULES: tuple[tuple[re.Pattern[str], str], ...] = (
    (re.compile(r"https?://\S+|www\.\S+", re.IGNORECASE), "<url>"),
    (re.compile(r"[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}"), "<email>"),
    (re.compile(r"\b\d{6,}:[A-Za-z0-9_-]{30,}\b"), "<token>"),
    # Short keys with a known prefix. Longer keys, fine-grained GitHub tokens included, fall to the generic rule below.
    (re.compile(r"\b(?:sk-[A-Za-z0-9_-]{8,}|gh[pousr]_[A-Za-z0-9]{8,}|xox[abprs]-[A-Za-z0-9-]{8,})\b"), "<token>"),
    (re.compile(r"\b(?:bot|task)_[A-Za-z0-9_-]+"), "<id>"),
    # Long runs mixing letters and digits: hashes and keys. Plain words never reach 32 characters.
    (re.compile(r"(?<![\w-])(?=[A-Za-z0-9_-]*\d)(?=[A-Za-z0-9_-]*[A-Za-z])[A-Za-z0-9_-]{32,}(?![\w-])"), "<token>"),
    # Eight or more digits, with single phone separators allowed between them.
    (re.compile(r"(?<!\d)\+?\d(?:[\s().-]?\d){7,}(?!\d)"), "<num>"),
)


def anonymize(text: str) -> str:
    for pattern, placeholder in _RULES:
        text = pattern.sub(placeholder, text)
    return text
