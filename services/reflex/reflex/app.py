"""HTTP surface of the Reflex service: POST /v1/systemone, GET /health, GET /v1/version.

`reflex.app:app` is built on first access, so importing this module has no side effects (tests call create_app
and build_default_app directly).
"""

import hmac
import ipaddress
import logging
import os
import sys
import time
from collections.abc import Mapping, Sequence
from pathlib import Path
from functools import cache
from typing import Annotated

from fastapi import Depends, FastAPI, Header, HTTPException

from reflex.answers import resolve
from reflex.config import config_path, load_rules_config
from reflex.contract import Answer, Question, SystemOneRequest, SystemOneResponse
from reflex.model.metrics import EmbedMetrics
from reflex.model.predict import Predictor, load_predictor
from reflex.rules import RulesConfig, compile_rules, score_all

MODEL_VERSION = "rules-py-1"
CONTRACT = "systemone-v1"
TOKEN_HEADER = "X-Reflex-Token"
ALLOW_NO_TOKEN_ENV = "REFLEX_ALLOW_NO_TOKEN"
# Bind value of a unix socket (--uds) or an inherited descriptor (--fd): never a network address.
LOCAL = "local"
UVICORN_DEFAULT_HOST = "127.0.0.1"

logger = logging.getLogger("reflex")


def create_app(
    config: RulesConfig,
    token: str | None,
    embed_metrics: EmbedMetrics | None = None,
    predictor: Predictor | None = None,
) -> FastAPI:
    rules = compile_rules(config)
    # With a model attached, its artifact tag is the version; without one the service is the rules, as before.
    model_version = predictor.version if predictor is not None else MODEL_VERSION
    if embed_metrics is None and predictor is not None:
        embed_metrics = predictor.embed_metrics
    expected = token.encode("utf-8") if token is not None else None
    app = FastAPI(title="reflex", version=MODEL_VERSION)

    # Headers arrive decoded as latin-1, which maps every byte back exactly; the comparison is on the raw bytes.
    def require_token(x_reflex_token: Annotated[str | None, Header()] = None) -> None:
        if expected is None:
            return
        presented = (x_reflex_token or "").encode("latin-1", errors="replace")
        if not hmac.compare_digest(presented, expected):
            raise HTTPException(status_code=401, detail="invalid token")

    # The embedding metrics appear only when an embedder is attached; without one the body keeps its v0 shape.
    @app.get("/health")
    def health() -> dict[str, object]:
        body: dict[str, object] = {"ok": True, "modelVersion": model_version}
        if embed_metrics is not None:
            body.update(embed_metrics.snapshot())
        return body

    @app.get("/v1/version")
    def version() -> dict[str, str]:
        return {"modelVersion": model_version, "contract": CONTRACT}

    @app.post("/v1/systemone", response_model=SystemOneResponse, dependencies=[Depends(require_token)])
    def systemone(request: SystemOneRequest) -> SystemOneResponse:
        started = time.perf_counter()
        scores = score_all(request.facts, rules)

        def by_rule(question: Question) -> Answer:
            resolved = resolve(question, scores, request.facts)
            return Answer(id=question.id, value=resolved.value, confidence=resolved.confidence, source="rule")

        if predictor is not None:
            answers = predictor.answer(request.facts, request.questions, by_rule)
        else:
            answers = [by_rule(question) for question in request.questions]
        return SystemOneResponse(
            answers=answers,
            modelVersion=model_version,
            latencyMs=(time.perf_counter() - started) * 1000,
        )

    return app


def _is_loopback(host: str) -> bool:
    if host == "localhost":
        return True
    try:
        return ipaddress.ip_address(host).is_loopback
    except ValueError:
        return False


def _is_uvicorn(argv: Sequence[str]) -> bool:
    if not argv:
        return False
    executable = Path(argv[0])
    # `python -m uvicorn` reports the module file as argv[0].
    return executable.name == "uvicorn" or (executable.name == "__main__.py" and executable.parent.name == "uvicorn")


def _flag_present(argv: Sequence[str], name: str) -> bool:
    return any(arg == name or arg.startswith(f"{name}=") for arg in argv)


# Every occurrence in order; `--host=value` and `--host value` are both read.
def _flag_values(argv: Sequence[str], name: str) -> list[str]:
    values: list[str] = []
    for index, arg in enumerate(argv):
        if arg == name and index + 1 < len(argv):
            values.append(argv[index + 1])
        elif arg.startswith(f"{name}="):
            values.append(arg.partition("=")[2])
    return values


# The address uvicorn will bind, or None when it cannot be read from this process. Fails closed: anything that is
# not a uvicorn command line with a readable bind (gunicorn, a wrapper, an empty value) is None.
def resolve_bind(argv: Sequence[str], environ: Mapping[str, str]) -> str | None:
    if not _is_uvicorn(argv):
        return None
    if _flag_present(argv, "--uds") or _flag_present(argv, "--fd"):
        return LOCAL
    values = _flag_values(argv, "--host")
    if values:
        return values[-1].strip() or None
    env_host = (environ.get("UVICORN_HOST") or "").strip()
    if env_host:
        return env_host
    return UVICORN_DEFAULT_HOST


# The address the policy judges: the one uvicorn binds, else the one the operator declares with REFLEX_HOST.
def effective_host(argv: Sequence[str], environ: Mapping[str, str]) -> str | None:
    bind = resolve_bind(argv, environ)
    if bind is not None:
        return bind
    return (environ.get("REFLEX_HOST") or "").strip() or None


# A token is always enough. Without one, only loopback (or a local socket) serves, with a warning; any other address,
# or an address nobody can name, is refused unless the operator opts in with REFLEX_ALLOW_NO_TOKEN=1.
def check_token_policy(host: str | None, token: str | None, allow_no_token: bool) -> None:
    if token is not None:
        return
    shown = host if host is not None else "an undetermined address"
    if host is not None and (host == LOCAL or _is_loopback(host)):
        logger.warning("REFLEX_TOKEN is not set: serving without authentication on %s", shown)
        return
    if allow_no_token:
        logger.warning("REFLEX_TOKEN is not set: serving without authentication on %s (%s=1)", shown, ALLOW_NO_TOKEN_ENV)
        return
    if host is None:
        raise RuntimeError(
            "refusing to serve: the bind address cannot be determined; set REFLEX_TOKEN, "
            "or REFLEX_HOST=127.0.0.1 for a local run"
        )
    raise RuntimeError(f"refusing to serve on {host} without REFLEX_TOKEN; set {ALLOW_NO_TOKEN_ENV}=1 to override")


def build_default_app(environ: Mapping[str, str], argv: Sequence[str]) -> FastAPI:
    token = (environ.get("REFLEX_TOKEN") or "").strip() or None
    check_token_policy(
        effective_host(argv, environ), token, allow_no_token=environ.get(ALLOW_NO_TOKEN_ENV) == "1"
    )
    return create_app(load_rules_config(config_path(environ)), token, predictor=load_predictor(environ))


@cache
def _default_app() -> FastAPI:
    return build_default_app(os.environ, sys.argv)


def __getattr__(name: str) -> FastAPI:
    if name == "app":
        return _default_app()
    raise AttributeError(f"module {__name__!r} has no attribute {name!r}")
