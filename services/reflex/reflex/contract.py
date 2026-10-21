"""Wire contract of POST /v1/systemone. Mirrors packages/reflex/src/contract.ts.

Requests forbid unknown fields and bound their sizes: the service can be reached from the network, so a request
cannot grow past these limits. `text` is counted in code points (TypeScript counts UTF-16 units; at most 2x).
"""

from typing import Annotated, Literal

from pydantic import BaseModel, ConfigDict, Field, StringConstraints

Channel = Literal["telegram", "api", "cli", "tide", "voice"]

MAX_TEXT_CHARS = 20_000
MAX_BOTS = 50
MAX_EXECUTORS = 20
MAX_QUESTIONS = 16
MAX_OPTIONS = 50
MAX_ROUTING = 20
MAX_IDENT_CHARS = 64
MAX_LABEL_CHARS = 200

Ident = Annotated[str, StringConstraints(min_length=1, max_length=MAX_IDENT_CHARS)]
Text = Annotated[str, StringConstraints(max_length=MAX_TEXT_CHARS)]
# Bot names and roles are free text on the TypeScript side (Bot.role is a String).
Label = Annotated[str, StringConstraints(min_length=1, max_length=MAX_LABEL_CHARS)]


class Request(BaseModel):
    model_config = ConfigDict(extra="forbid")


class Question(Request):
    id: Ident
    kind: Literal["noul", "choice", "score"]
    options: Annotated[list[Ident], Field(max_length=MAX_OPTIONS)] | None = None
    scale: tuple[int, int] | None = None


class Routing(Request):
    preferred: Annotated[list[Ident], Field(max_length=MAX_ROUTING)]
    allowed: Annotated[list[Ident], Field(max_length=MAX_ROUTING)]


# `routing` is the optional executor preference of a Bot, needed by the executor question (as in the TS contract).
class BotFact(Request):
    id: Ident
    name: Label
    role: Label
    routing: Routing | None = None


class ExecutorFact(Request):
    id: Ident
    available: bool


class Facts(Request):
    text: Text
    channel: Channel
    userId: Ident
    botHint: Ident | None = None
    bots: Annotated[list[BotFact], Field(max_length=MAX_BOTS)]
    executors: Annotated[list[ExecutorFact], Field(max_length=MAX_EXECUTORS)]
    hasRepo: bool = False
    language: Ident | None = None


class SystemOneRequest(Request):
    facts: Facts
    questions: Annotated[list[Question], Field(max_length=MAX_QUESTIONS)]
    policyVersion: Ident = "v0"


class Answer(BaseModel):
    id: str
    value: bool | str | int | float
    confidence: float = Field(ge=0, le=1)
    source: Literal["rule", "model", "llm", "cache"]
    abstained: bool = False


class SystemOneResponse(BaseModel):
    answers: list[Answer]
    modelVersion: str
    latencyMs: float
