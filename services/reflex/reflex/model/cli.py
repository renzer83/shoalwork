"""`reflex-model` commands, run as `uv run python -m reflex.model.cli`.

`export` writes the ONNX model and tokenizer; `bench` prints per-text latency of Embedder.encode; `train` fits,
calibrates and packages the heads (`reflex-v<N>`); `eval` re-scores an artifact on a dataset's test split.
"""

import argparse
import math
import os
import re
import sys
import time
from collections.abc import Sequence
from pathlib import Path
from typing import Any

from reflex.model.export import DEFAULT_MODEL_ID, ExportError, export_onnx

DEFAULT_MODEL_DIR = "models/e5-small"
BENCH_SAMPLES = [
    "mensagem de teste sobre o deploy do bot",
    "hello, can you check the BTC funding rate for me?",
    "implementa o login para o app com passkey",
    "what is the status of the last build on main?",
]
BATCH_SIZES = (1, 16)


def _percentile(samples: list[float], quantile: float) -> float:
    ordered = sorted(samples)
    return ordered[min(len(ordered) - 1, math.ceil(quantile * len(ordered)) - 1)]


def _bench_texts(n: int, run: str) -> list[str]:
    # A distinct text per item and per run: every lookup is a cache miss, so the numbers are inference only.
    return [f"{run} {index} {BENCH_SAMPLES[index % len(BENCH_SAMPLES)]}" for index in range(n)]


def bench(model_dir: Path, n: int) -> list[str]:
    from reflex.model.embedder import EMBED_CACHE_ENV, Embedder

    # The disk cache is not what this measures.
    os.environ.pop(EMBED_CACHE_ENV, None)
    embedder = Embedder(str(model_dir))
    embedder.encode(["warm-up"], kind="query")  # first call pays session and tokenizer setup; not a bench text
    lines = [f"model={model_dir} providers={','.join(embedder.providers)} n={n}"]
    for batch_size in BATCH_SIZES:
        texts = _bench_texts(n, run=f"b{batch_size}")
        per_text_ms: list[float] = []
        for start in range(0, n, batch_size):
            chunk = texts[start : start + batch_size]
            started = time.perf_counter()
            embedder.encode(chunk, kind="query")
            per_text_ms.append((time.perf_counter() - started) * 1000 / len(chunk))
        p50 = _percentile(per_text_ms, 0.50)
        p95 = _percentile(per_text_ms, 0.95)
        lines.append(f"batch={batch_size:<3} p50={p50:.2f} ms/text  p95={p95:.2f} ms/text  samples={len(per_text_ms)}")
    return lines


EVAL_HEADER = (
    f"{'question':<16} {'kind':<7} {'macro_f1':>9} {'qwk':>7} {'ece':>7} {'coverage':>9} {'n_test':>7}  status"
)


def _num(value: object) -> str:
    return f"{value:.3f}" if isinstance(value, float) else "-"


def format_eval(report: dict[str, dict[str, Any]]) -> str:
    lines = [EVAL_HEADER]
    for question_id, row in report.items():
        metrics = row["metrics"]
        status = "disabled" if row["disabled"] else f"tau={row['tau']:.3f}"
        lines.append(
            f"{question_id:<16} {row['kind']:<7} {_num(metrics['macro_f1']):>9} {_num(metrics['qwk']):>7} "
            f"{_num(metrics['ece']):>7} {_num(metrics['coverage']):>9} {metrics['n_test']:>7}  {status}"
        )
    return "\n".join(lines)


def _version_of(out: Path, explicit: int | None) -> int:
    if explicit is not None:
        return explicit
    match = re.fullmatch(r"reflex-v([1-9][0-9]*)", out.name)
    if match is None:
        raise ValueError("pass --version N or name the output directory reflex-v<N>")
    return int(match.group(1))


def _train_and_eval(args: argparse.Namespace) -> int:
    from reflex.model.artifact import Artifact, ArtifactError
    from reflex.model.embedder import Embedder
    from reflex.model.train import TrainConfig, TrainError, eval_artifact, train_all

    try:
        embedder = Embedder(str(args.model_dir))
        if args.command == "train":
            config = TrainConfig(target_accuracy=args.target_accuracy)
            manifest = train_all(args.dataset, args.out, embedder, _version_of(args.out, args.version), config)
            print(f"wrote {manifest.version} to {args.out}")
            artifact = Artifact.load(args.out)
        else:
            artifact = Artifact.load(args.artifact)
        print(format_eval(eval_artifact(artifact, args.dataset, embedder)))
    except (ArtifactError, TrainError, ValueError, OSError, RuntimeError) as error:
        print(f"reflex-model: {error}", file=sys.stderr)
        return 1
    return 0


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="reflex-model", description="Export and benchmark the Reflex encoder.")
    commands = parser.add_subparsers(dest="command", required=True)

    export = commands.add_parser("export", help="export multilingual-e5-small to ONNX")
    export.add_argument("--out", required=True, type=Path, help="output directory, e.g. models/e5-small")
    export.add_argument("--model", default=DEFAULT_MODEL_ID, help="Hugging Face model id")
    export.add_argument("--gpu", action="store_true", help="CUDA export: fp16 with O4 (needs the gpu extra)")
    export.add_argument(
        "--allow-outside-models",
        action="store_true",
        help="allow --out outside services/reflex/models and a local --model path",
    )

    bench_cmd = commands.add_parser("bench", help="print p50/p95 ms per text for batch 1 and 16")
    bench_cmd.add_argument("--model-dir", type=Path, default=Path(DEFAULT_MODEL_DIR))
    bench_cmd.add_argument("--n", type=int, default=200)

    train = commands.add_parser("train", help="fit, calibrate and package one head per question")
    train.add_argument("dataset", type=Path, help="directory written by `reflex-data build`, e.g. data/v1")
    train.add_argument("--out", required=True, type=Path, help="new artifact directory, e.g. models/reflex-v1")
    train.add_argument("--version", type=int, default=None, help="N of reflex-v<N>; default: from the --out name")
    train.add_argument("--target-accuracy", type=float, default=0.90, help="accuracy tau must reach (default 0.90)")
    train.add_argument("--model-dir", type=Path, default=Path(DEFAULT_MODEL_DIR))

    evaluate_cmd = commands.add_parser("eval", help="print per-question metrics of an artifact on a dataset")
    evaluate_cmd.add_argument("artifact", type=Path, help="artifact directory, e.g. models/reflex-v1")
    evaluate_cmd.add_argument("dataset", type=Path, help="dataset directory, e.g. data/v1")
    evaluate_cmd.add_argument("--model-dir", type=Path, default=Path(DEFAULT_MODEL_DIR))

    args = parser.parse_args(argv)
    if args.command in ("train", "eval"):
        if args.command == "train" and not 0 < args.target_accuracy <= 1:
            parser.error("--target-accuracy must be in (0, 1]")
        return _train_and_eval(args)
    try:
        if args.command == "export":
            export_onnx(
                args.model,
                args.out,
                "cuda" if args.gpu else "cpu",
                allow_outside_models=args.allow_outside_models,
            )
            print(f"exported {args.model} to {args.out}")
            return 0
        if args.n < 1:
            parser.error("--n must be at least 1")
        for line in bench(args.model_dir, args.n):
            print(line)
    except (ExportError, OSError, RuntimeError) as error:
        print(f"reflex-model: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
