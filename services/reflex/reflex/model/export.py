"""Exports intfloat/multilingual-e5-small to ONNX without touching the service environment.

The service pins transformers 5.x, which optimum-onnx cannot be installed alongside (optimum-onnx 0.1.0 requires
transformers<4.58 and optimum~=2.1.0). The export therefore runs in an ephemeral uv environment with its own pins
(06-research/reflex-ml-serving.md §1), as a subprocess with an argv list: no shell, no interpolated strings.

Writes are confined to services/reflex/models/ unless the caller passes allow_outside_models=True.
"""

import os
import re
import signal
import subprocess
from pathlib import Path
from typing import Literal

from reflex.model.embedder import MODEL_FILE, TOKENIZER_FILE

DEFAULT_MODEL_ID = "intfloat/multilingual-e5-small"
Device = Literal["cpu", "cuda"]
DEVICES: tuple[str, ...] = ("cpu", "cuda")
SERVICE_ROOT = Path(__file__).resolve().parents[2]
MODELS_ROOT = SERVICE_ROOT / "models"
# Hugging Face repo id: org/name, each part starting with a letter, digit or underscore. Rules out "." and "..".
HF_ID = re.compile(r"\w[\w.-]*/\w[\w.-]*", re.ASCII)
EXPORT_PYTHON = "3.13"
EXPORT_PACKAGES = (
    "optimum-onnx==0.1.0",
    "optimum==2.1.0",
    "transformers==4.57.6",
    "onnxruntime==1.31.0",
)
EXPORT_WORKER = "reflex.model.export_worker"
EXPORT_TIMEOUT_S = 1800
REQUIRED_OUTPUTS = (MODEL_FILE, TOKENIZER_FILE)


class ExportError(RuntimeError):
    pass


def resolve_export_target(
    model_id: str,
    out_dir: Path,
    *,
    allow_outside: bool,
    models_root: Path = MODELS_ROOT,
) -> tuple[str, Path]:
    """Returns the model id and the resolved output directory, or raises ExportError when either escapes the rules."""
    if not HF_ID.fullmatch(model_id) and not allow_outside:
        raise ExportError(
            f"--model {model_id!r} is not a Hugging Face id (org/name); "
            "a local model path needs --allow-outside-models"
        )
    root = models_root.resolve()
    target = out_dir.resolve()  # follows symlinks and collapses "..", so an escape shows up here
    inside = target != root and target.is_relative_to(root)
    if not inside and not allow_outside:
        raise ExportError(f"{target} is outside {root}; pass --allow-outside-models to write there")
    return model_id, target


def build_export_command(model_id: str, out_dir: Path, device: str) -> list[str]:
    if device not in DEVICES:
        raise ValueError(f"device must be one of {DEVICES}, got {device!r}")
    command = ["uv", "run", "--isolated", "--no-project", "--python", EXPORT_PYTHON]
    for package in EXPORT_PACKAGES:
        command += ["--with", package]
    command += ["python", "-m", EXPORT_WORKER, model_id, str(out_dir), device]
    return command


def export_onnx(
    model_id: str,
    out_dir: Path,
    device: Device,
    *,
    allow_outside_models: bool = False,
) -> None:
    """cpu writes fp32; cuda writes fp16 with the O4 graph optimisation (GPU only, see the gpu extra)."""
    model, target = resolve_export_target(model_id, out_dir, allow_outside=allow_outside_models)
    command = build_export_command(model, target, device)
    _run_isolated(command)
    missing = [name for name in REQUIRED_OUTPUTS if not (target / name).is_file()]
    if missing:
        raise ExportError(f"export finished but {', '.join(str(target / name) for name in missing)} not written")


def _run_isolated(command: list[str]) -> None:
    try:
        # Own process group: on timeout the whole tree (uv and the export it spawns) is killed, not just uv.
        process = subprocess.Popen(command, cwd=SERVICE_ROOT, start_new_session=True)
    except FileNotFoundError as error:
        raise ExportError("uv is not on PATH; it is required to run the isolated export") from error
    try:
        returncode = process.wait(timeout=EXPORT_TIMEOUT_S)
    except subprocess.TimeoutExpired as error:
        _kill_group(process.pid)
        process.wait()
        raise ExportError(f"export did not finish within {EXPORT_TIMEOUT_S} s and was killed") from error
    if returncode != 0:
        raise ExportError(f"export failed with exit code {returncode}; see the output above")


def _kill_group(pid: int) -> None:
    try:
        os.killpg(pid, signal.SIGKILL)
    except ProcessLookupError:
        pass
