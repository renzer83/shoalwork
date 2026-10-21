"""`reflex-data` command: `build` writes the per-question dataset, `stats` prints its summary table."""

import argparse
import sys
from collections.abc import Sequence
from pathlib import Path

from reflex.data.build import DEFAULT_MIN_PER_CLASS, DatasetError, QuestionStats, build_dataset, load_stats

HEADER = f"{'question':<20} {'n':>6} {'unlab':>6} {'train':>6} {'calib':>6} {'test':>6}  {'insuff':<6}  classes / span"


def format_table(stats: dict[str, QuestionStats]) -> str:
    lines = [HEADER]
    for question, entry in stats.items():
        splits = entry["splits"]
        classes = ", ".join(f"{label}={count}" for label, count in entry["classes"].items()) or "-"
        span = f"{entry['span'][0]} .. {entry['span'][1]}"
        lines.append(
            f"{question:<20} {entry['n']:>6} {entry['unlabeled']:>6} {splits['train']:>6} "
            f"{splits['calib']:>6} {splits['test']:>6}  {'yes' if entry['insufficient'] else 'no':<6}  "
            f"{classes} | {span}"
        )
    return "\n".join(lines)


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="reflex-data", description="Build and inspect the Reflex training dataset.")
    commands = parser.add_subparsers(dest="command", required=True)

    build = commands.add_parser("build", help="read a reflex export JSONL and write the per-question dataset")
    build.add_argument("--in", dest="source", required=True, type=Path, help="JSONL from `reflex export`")
    build.add_argument("--out", required=True, type=Path, help="output directory, e.g. data/v1")
    build.add_argument("--min-per-class", type=int, default=DEFAULT_MIN_PER_CLASS)

    stats = commands.add_parser("stats", help="print the per-question table of a built dataset")
    stats.add_argument("dataset", type=Path, help="directory written by `build`")

    args = parser.parse_args(argv)
    try:
        if args.command == "build":
            if args.min_per_class < 1:
                parser.error("--min-per-class must be at least 1")
            result = build_dataset(args.source, args.out, args.min_per_class)
            print(f"wrote {len(result)} questions to {args.out}")
            print(format_table(result))
        else:
            print(format_table(load_stats(args.dataset)))
    except (DatasetError, OSError) as error:
        print(f"reflex-data: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
