import json
import logging
from pathlib import Path

import pytest
import yaml
from fastapi.testclient import TestClient

from reflex.app import (
    LOCAL,
    MODEL_VERSION,
    build_default_app,
    check_token_policy,
    create_app,
    effective_host,
    resolve_bind,
)
from reflex.config import config_path, load_rules_config
from reflex.rules import RulesConfig

ROOT = Path(__file__).resolve().parents[3]
YAML_PATH = ROOT / "config" / "reflex.config.yaml"
FIXTURE = json.loads((Path(__file__).parent / "cases.json").read_text(encoding="utf-8"))
STANDARD_QUESTIONS = [
    {"id": "intent", "kind": "choice", "options": ["chat", "system", "code", "research", "app_op", "routine"]},
    {"id": "complexity", "kind": "score", "scale": [0, 4]},
    {"id": "owner", "kind": "choice", "options": []},
    {"id": "executor", "kind": "choice", "options": []},
    {"id": "parallelizable", "kind": "noul"},
    {"id": "risk", "kind": "score", "scale": [0, 3]},
    {"id": "needs_approval", "kind": "noul"},
    {"id": "language", "kind": "choice", "options": ["pt", "en", "es", "other"]},
]
FACTS = {
    "text": "implementa o login para o app",
    "channel": "telegram",
    "userId": "42",
    "bots": [{"id": "bot_lead", "name": "lead", "role": "coordinator"}],
    "executors": [{"id": "claude-code", "available": True}],
    "hasRepo": False,
}
SECRET = "test-secret"


def body(facts: dict | None = None, questions: list | None = None, **extra: object) -> dict:
    return {"facts": {**FACTS, **(facts or {})}, "questions": questions or STANDARD_QUESTIONS, **extra}


@pytest.fixture
def config() -> RulesConfig:
    return load_rules_config(YAML_PATH)


@pytest.fixture
def client(config: RulesConfig) -> TestClient:
    return TestClient(create_app(config, token=SECRET))


def post(client: TestClient, payload: dict, token: str | bytes | None = SECRET) -> int:
    headers = {} if token is None else {"X-Reflex-Token": token}
    return client.post("/v1/systemone", json=payload, headers=headers).status_code


def test_valid_request_gets_eight_rule_answers(client: TestClient) -> None:
    response = client.post("/v1/systemone", json=body(), headers={"X-Reflex-Token": SECRET})
    assert response.status_code == 200
    payload = response.json()
    assert [answer["id"] for answer in payload["answers"]] == [question["id"] for question in STANDARD_QUESTIONS]
    assert payload["modelVersion"] == MODEL_VERSION
    assert payload["latencyMs"] >= 0
    intent = next(answer for answer in payload["answers"] if answer["id"] == "intent")
    assert (intent["value"], intent["confidence"], intent["source"]) == ("code", 0.9, "rule")


def test_invalid_kind_is_rejected_with_422(client: TestClient) -> None:
    assert post(client, body(questions=[{"id": "intent", "kind": "guess"}])) == 422


def test_wrong_or_missing_token_is_401(client: TestClient) -> None:
    assert post(client, body(), token="nope") == 401
    assert post(client, body(), token=None) == 401


def test_non_ascii_token_header_is_401_not_500(client: TestClient) -> None:
    assert post(client, body(), token="sécret".encode("utf-8")) == 401


def test_non_ascii_configured_token_matches_its_utf8_bytes(config: RulesConfig) -> None:
    unicode_client = TestClient(create_app(config, token="tökén"))
    assert post(unicode_client, body(), token="tökén".encode("utf-8")) == 200
    assert post(unicode_client, body(), token="token".encode("utf-8")) == 401


def test_no_token_configured_allows_calls(config: RulesConfig) -> None:
    open_client = TestClient(create_app(config, token=None))
    assert post(open_client, body(), token=None) == 200


def test_health_and_version(client: TestClient) -> None:
    assert client.get("/health").json() == {"ok": True, "modelVersion": MODEL_VERSION}
    assert client.get("/v1/version").json() == {"modelVersion": MODEL_VERSION, "contract": "systemone-v1"}


def test_extra_field_is_rejected_at_every_level(client: TestClient) -> None:
    assert post(client, body(correlationId="evt_1")) == 422
    assert post(client, {**body(), "unexpected": True}) == 422
    assert post(client, body(questions=[{**STANDARD_QUESTIONS[0], "extra": 1}])) == 422


def test_oversized_lists_and_text_are_rejected(client: TestClient) -> None:
    bot = {"id": "b", "name": "n", "role": "r"}
    executor = {"id": "e", "available": True}
    option = "o"
    assert post(client, body(facts={"text": "x" * 20_001})) == 422
    assert post(client, body(facts={"bots": [bot] * 51})) == 422
    assert post(client, body(facts={"executors": [executor] * 21})) == 422
    assert post(client, body(questions=[STANDARD_QUESTIONS[0]] * 17)) == 422
    assert post(client, body(questions=[{"id": "c", "kind": "choice", "options": [option] * 51}])) == 422
    assert post(client, body(questions=[{"id": "x" * 65, "kind": "noul"}])) == 422


def test_text_at_the_limit_is_accepted(client: TestClient) -> None:
    assert post(client, body(facts={"text": "x" * 20_000})) == 200


def test_yaml_loads_to_the_config_the_fixture_was_exported_from(config: RulesConfig) -> None:
    assert config == RulesConfig.model_validate(FIXTURE["config"])


def test_real_yaml_scalars_are_strings_under_pyyaml(config: RulesConfig) -> None:
    # Config written in YAML 1.2 (TypeScript) must read the same under PyYAML (YAML 1.1): every keyword is a string.
    raw = yaml.safe_load(YAML_PATH.read_text(encoding="utf-8"))
    keyword_lists = [*raw["intent"].values(), raw["verbs"], raw["sequence"], *raw["risk"].values(), *raw["language"].values()]
    assert all(isinstance(word, str) for words in keyword_lists for word in words)
    assert config.intent.code[0] == "implementa"


def test_config_path_honours_reflex_config(tmp_path: Path) -> None:
    assert config_path({"REFLEX_CONFIG": str(tmp_path / "other.yaml")}) == tmp_path / "other.yaml"


UVICORN = ["/app/.venv/bin/uvicorn", "reflex.app:app"]


def build(environ: dict[str, str], argv: list[str]) -> TestClient:
    return TestClient(build_default_app({"REFLEX_CONFIG": str(YAML_PATH), **environ}, argv))


def test_last_host_flag_wins() -> None:
    assert resolve_bind([*UVICORN, "--host", "127.0.0.1", "--host", "0.0.0.0"], {}) == "0.0.0.0"
    assert resolve_bind([*UVICORN, "--host", "0.0.0.0", "--host", "127.0.0.1"], {}) == "127.0.0.1"


def test_host_equals_form_is_read() -> None:
    assert resolve_bind([*UVICORN, "--host=0.0.0.0"], {}) == "0.0.0.0"


def test_command_line_host_beats_uvicorn_host_env() -> None:
    assert resolve_bind([*UVICORN, "--host", "0.0.0.0"], {"UVICORN_HOST": "127.0.0.1"}) == "0.0.0.0"


def test_uvicorn_host_env_is_read_when_no_flag_is_given() -> None:
    assert resolve_bind(UVICORN, {"UVICORN_HOST": "0.0.0.0"}) == "0.0.0.0"


def test_blank_uvicorn_host_env_falls_back_to_uvicorn_default() -> None:
    assert resolve_bind(UVICORN, {"UVICORN_HOST": "  "}) == "127.0.0.1"


def test_uds_and_fd_are_local_not_network() -> None:
    assert resolve_bind([*UVICORN, "--uds", "/tmp/reflex.sock"], {}) == LOCAL
    assert resolve_bind([*UVICORN, "--fd=3"], {}) == LOCAL
    check_token_policy(LOCAL, None, allow_no_token=False)
    assert build({}, [*UVICORN, "--uds", "/tmp/reflex.sock"]).get("/health").status_code == 200


def test_module_form_of_uvicorn_is_recognised() -> None:
    argv = ["/lib/python3.13/site-packages/uvicorn/__main__.py", "reflex.app:app", "--host", "0.0.0.0"]
    assert resolve_bind(argv, {}) == "0.0.0.0"


def test_empty_host_value_cannot_be_determined() -> None:
    assert resolve_bind([*UVICORN, "--host="], {}) is None


def test_gunicorn_bind_cannot_be_determined_and_is_refused() -> None:
    argv = ["gunicorn", "-b", "0.0.0.0:8300", "reflex.app:app"]
    assert resolve_bind(argv, {}) is None
    with pytest.raises(RuntimeError, match="cannot be determined"):
        build({}, argv)


def test_undeterminable_bind_with_public_reflex_host_is_refused() -> None:
    with pytest.raises(RuntimeError):
        build({"REFLEX_HOST": "0.0.0.0"}, ["gunicorn", "reflex.app:app"])


def test_undeterminable_bind_with_loopback_reflex_host_serves_with_warning(caplog: pytest.LogCaptureFixture) -> None:
    with caplog.at_level(logging.WARNING, logger="reflex"):
        client = build({"REFLEX_HOST": "127.0.0.1"}, ["gunicorn", "reflex.app:app"])
    assert client.get("/health").status_code == 200
    assert "without authentication" in caplog.text


def test_pytest_style_process_without_declaration_is_refused() -> None:
    with pytest.raises(RuntimeError):
        build({}, ["pytest", "-q"])


def test_undeterminable_bind_with_token_serves_and_requires_it() -> None:
    client = build({"REFLEX_TOKEN": SECRET}, ["gunicorn", "reflex.app:app"])
    assert post(client, body(), token=None) == 401
    assert post(client, body(), token=SECRET) == 200


def test_effective_host_prefers_the_real_bind_over_the_declaration() -> None:
    assert effective_host([*UVICORN, "--host", "0.0.0.0"], {"REFLEX_HOST": "127.0.0.1"}) == "0.0.0.0"
    assert effective_host(["gunicorn"], {"REFLEX_HOST": " 127.0.0.1 "}) == "127.0.0.1"


def test_public_bind_without_token_is_refused() -> None:
    with pytest.raises(RuntimeError, match="REFLEX_TOKEN"):
        check_token_policy("0.0.0.0", None, allow_no_token=False)


def test_public_bind_with_explicit_opt_in_is_allowed(caplog: pytest.LogCaptureFixture) -> None:
    with caplog.at_level(logging.WARNING, logger="reflex"):
        check_token_policy("0.0.0.0", None, allow_no_token=True)
    assert "without authentication" in caplog.text


def test_loopback_without_token_warns_and_serves(caplog: pytest.LogCaptureFixture) -> None:
    with caplog.at_level(logging.WARNING, logger="reflex"):
        check_token_policy("127.0.0.1", None, allow_no_token=False)
        check_token_policy("::1", None, allow_no_token=False)
    assert caplog.text.count("without authentication") == 2


def test_whitespace_token_counts_as_no_token() -> None:
    with pytest.raises(RuntimeError):
        build({"REFLEX_TOKEN": "   ", "REFLEX_HOST": "0.0.0.0"}, [*UVICORN, "--host", "0.0.0.0"])


def test_build_default_app_with_token_requires_it_on_public_bind() -> None:
    public = build({"REFLEX_TOKEN": SECRET}, [*UVICORN, "--host", "0.0.0.0"])
    assert post(public, body(), token=None) == 401
    assert post(public, body(), token=SECRET) == 200


def test_long_bot_role_and_name_are_accepted_up_to_200_chars(client: TestClient) -> None:
    bot = {"id": "bot_dev", "name": "n" * 200, "role": "r" * 200}
    assert post(client, body(facts={"bots": [bot]})) == 200
    assert post(client, body(facts={"bots": [{**bot, "role": "r" * 201}]})) == 422
