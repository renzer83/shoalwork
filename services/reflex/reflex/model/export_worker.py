"""Runs only inside the isolated export environment built by reflex/model/export.py. The service never imports it.

Usage: python -m reflex.model.export_worker MODEL_ID OUT_DIR {cpu,cuda}
"""

import sys
from pathlib import Path

from optimum.exporters.onnx import main_export

TASK = "feature-extraction"
GPU_OPTIONS = {"device": "cuda", "dtype": "fp16", "optimize": "O4"}
USAGE = "usage: python -m reflex.model.export_worker MODEL_ID OUT_DIR {cpu,cuda}"


def main(argv: list[str]) -> int:
    if len(argv) != 3 or argv[2] not in ("cpu", "cuda"):
        print(USAGE, file=sys.stderr)
        return 2
    model_id, out_dir, device = argv
    options: dict[str, str] = {} if device == "cpu" else GPU_OPTIONS
    main_export(model_id, output=Path(out_dir), task=TASK, **options)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
