"""Loads config/reflex.config.yaml, the file the TypeScript rules read. REFLEX_CONFIG overrides the path."""

import os
from collections.abc import Mapping
from pathlib import Path

import yaml

from reflex.rules import RulesConfig

DEFAULT_CONFIG_PATH = "../../config/reflex.config.yaml"


def config_path(environ: Mapping[str, str] = os.environ) -> Path:
    return Path(environ.get("REFLEX_CONFIG") or DEFAULT_CONFIG_PATH)


# A missing file or a shape the rules cannot use fails the boot, naming the file.
def load_rules_config(path: Path) -> RulesConfig:
    with path.open(encoding="utf-8") as handle:
        raw = yaml.safe_load(handle)
    return RulesConfig.model_validate(raw)
