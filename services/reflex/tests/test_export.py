"""Export command construction, output confinement and subprocess handling. The real export never runs here."""

import subprocess
from collections.abc import Callable
from pathlib import Path

import pytest

from reflex.model import export as export_module
from reflex.model.export import (
    EXPORT_PACKAGES,
    EXPORT_TIMEOUT_S,
    EXPORT_WORKER,
    SERVICE_ROOT,
    ExportError,
    build_export_command,
    export_onnx,
    resolve_export_target,
)

MODEL = "intfloat/multilingual-e5-small"
OnStart = Callable[[list[str]], None]


def write_outputs(command: list[str]) -> None:
    out = Path(command[-2])
    out.mkdir(parents=True, exist_ok=True)
    (out / "model.onnx").write_bytes(b"x")
    (out / "tokenizer.json").write_text("{}", encoding="utf-8")


@pytest.fixture
def root(tmp_path: Path) -> Path:
    models = tmp_path / "models"
    models.mkdir()
    return models


def fake_popen(
    monkeypatch: pytest.MonkeyPatch,
    waits: list[int | BaseException],
    on_start: OnStart | None = None,
) -> list[dict[str, object]]:
    recorded: list[dict[str, object]] = []

    class FakePopen:
        pid = 4242

        def __init__(self, command: list[str], **kwargs: object) -> None:
            recorded.append({"command": command, **kwargs})
            if on_start is not None:
                on_start(command)
            self._waits = list(waits)

        def wait(self, timeout: float | None = None) -> int:
            outcome = self._waits.pop(0)
            if isinstance(outcome, BaseException):
                raise outcome
            return outcome

    monkeypatch.setattr(export_module.subprocess, "Popen", FakePopen)
    return recorded


# --- command construction -------------------------------------------------------------------------------------------


def test_command_runs_in_an_isolated_ephemeral_environment(tmp_path: Path) -> None:
    command = build_export_command(MODEL, tmp_path / "out", "cpu")
    assert command[:2] == ["uv", "run"]
    assert "--isolated" in command
    assert "--no-project" in command
    assert command[command.index("--python") + 1] == "3.13"


def test_command_pins_the_export_stack_and_no_optimum_extras(tmp_path: Path) -> None:
    command = build_export_command(MODEL, tmp_path / "out", "cpu")
    with_values = [command[index + 1] for index, arg in enumerate(command) if arg == "--with"]
    assert with_values == list(EXPORT_PACKAGES)
    assert all("==" in value for value in with_values)
    assert not any("[" in value for value in with_values)


def test_command_ends_with_the_worker_and_its_arguments(tmp_path: Path) -> None:
    out = tmp_path / "out"
    command = build_export_command(MODEL, out, "cuda")
    assert command[-6:] == ["python", "-m", EXPORT_WORKER, MODEL, str(out), "cuda"]


def test_unknown_device_is_rejected_before_anything_runs(tmp_path: Path) -> None:
    with pytest.raises(ValueError, match="device"):
        build_export_command(MODEL, tmp_path, "tpu")


# --- output and model confinement ----------------------------------------------------------------------------------


def test_output_inside_models_is_accepted(root: Path) -> None:
    _, target = resolve_export_target(MODEL, root / "e5-small", allow_outside=False, models_root=root)
    assert target == (root / "e5-small").resolve()


def test_dot_dot_that_escapes_models_is_refused(root: Path) -> None:
    with pytest.raises(ExportError, match="outside"):
        resolve_export_target(MODEL, root / ".." / "evil", allow_outside=False, models_root=root)


def test_absolute_output_outside_models_is_refused(root: Path, tmp_path: Path) -> None:
    with pytest.raises(ExportError, match="outside"):
        resolve_export_target(MODEL, tmp_path / "elsewhere", allow_outside=False, models_root=root)


def test_symlink_that_escapes_models_is_refused(root: Path, tmp_path: Path) -> None:
    outside = tmp_path / "outside"
    outside.mkdir()
    (root / "link").symlink_to(outside, target_is_directory=True)
    with pytest.raises(ExportError, match="outside"):
        resolve_export_target(MODEL, root / "link" / "e5", allow_outside=False, models_root=root)


def test_models_root_itself_is_refused(root: Path) -> None:
    with pytest.raises(ExportError, match="outside"):
        resolve_export_target(MODEL, root, allow_outside=False, models_root=root)


def test_outside_output_is_allowed_only_with_the_flag(root: Path, tmp_path: Path) -> None:
    _, target = resolve_export_target(MODEL, tmp_path / "elsewhere", allow_outside=True, models_root=root)
    assert target == (tmp_path / "elsewhere").resolve()


@pytest.mark.parametrize("model_id", ["../evil/model", "/abs/model", "./x/y", "org/../x", "single-segment"])
def test_model_id_must_be_a_hugging_face_id_unless_the_flag_is_set(root: Path, model_id: str) -> None:
    with pytest.raises(ExportError, match="Hugging Face id"):
        resolve_export_target(model_id, root / "e5", allow_outside=False, models_root=root)


def test_local_model_path_is_allowed_only_with_the_flag(root: Path) -> None:
    model, _ = resolve_export_target("/abs/local/model", root / "e5", allow_outside=True, models_root=root)
    assert model == "/abs/local/model"


def test_valid_hugging_face_id_is_accepted(root: Path) -> None:
    model, _ = resolve_export_target(MODEL, root / "e5", allow_outside=False, models_root=root)
    assert model == MODEL


def test_export_refuses_before_running_uv(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    recorded = fake_popen(monkeypatch, waits=[0])
    with pytest.raises(ExportError):
        export_onnx(MODEL, tmp_path / "elsewhere", "cpu")
    assert recorded == []


# --- subprocess handling -------------------------------------------------------------------------------------------


def test_export_runs_the_argv_in_its_own_session_and_requires_both_files(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    recorded = fake_popen(monkeypatch, waits=[0], on_start=write_outputs)
    export_onnx(MODEL, tmp_path / "e5", "cpu", allow_outside_models=True)
    call = recorded[0]
    assert isinstance(call["command"], list)
    assert call["start_new_session"] is True
    assert call["cwd"] == SERVICE_ROOT
    assert "shell" not in call


def test_timeout_kills_the_whole_process_group(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    fake_popen(monkeypatch, waits=[subprocess.TimeoutExpired(cmd="uv", timeout=EXPORT_TIMEOUT_S), -9])
    killed: list[tuple[int, int]] = []
    monkeypatch.setattr(export_module.os, "killpg", lambda pid, sig: killed.append((pid, sig)))
    with pytest.raises(ExportError, match="killed"):
        export_onnx(MODEL, tmp_path / "e5", "cpu", allow_outside_models=True)
    assert killed == [(4242, export_module.signal.SIGKILL)]


def test_nonzero_exit_is_an_export_error(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    fake_popen(monkeypatch, waits=[1])
    with pytest.raises(ExportError, match="exit code 1"):
        export_onnx(MODEL, tmp_path / "e5", "cpu", allow_outside_models=True)


def test_success_without_model_onnx_is_an_export_error(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    def tokenizer_only(command: list[str]) -> None:
        out = Path(command[-2])
        out.mkdir(parents=True, exist_ok=True)
        (out / "tokenizer.json").write_text("{}", encoding="utf-8")

    fake_popen(monkeypatch, waits=[0], on_start=tokenizer_only)
    with pytest.raises(ExportError, match="model.onnx"):
        export_onnx(MODEL, tmp_path / "e5", "cpu", allow_outside_models=True)


def test_success_without_tokenizer_json_is_an_export_error(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    def model_only(command: list[str]) -> None:
        out = Path(command[-2])
        out.mkdir(parents=True, exist_ok=True)
        (out / "model.onnx").write_bytes(b"x")

    fake_popen(monkeypatch, waits=[0], on_start=model_only)
    with pytest.raises(ExportError, match="tokenizer.json"):
        export_onnx(MODEL, tmp_path / "e5", "cpu", allow_outside_models=True)
