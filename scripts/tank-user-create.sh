#!/usr/bin/env bash
# Creates the Linux user that runs a Bot's commands in server mode (ADR-004).
# Run as root:  sudo bash scripts/tank-user-create.sh <bot-name>
# --dry-run:    prints what would run, changes nothing, does not need root.
set -euo pipefail

usage() {
  echo "usage: $0 <bot-name> [--dry-run]" >&2
  exit 2
}

[[ $# -ge 1 ]] || usage
name="$1"
shift

dry_run=0
for arg in "$@"; do
  case "$arg" in
    --dry-run) dry_run=1 ;;
    *) usage ;;
  esac
done

if ! [[ "$name" =~ ^[A-Za-z0-9][A-Za-z0-9_-]*$ ]]; then
  echo "invalid bot name: $name" >&2
  exit 2
fi

user="bot-${name}"
create=(useradd -m -s /bin/bash -U "$user")

if [[ "$dry_run" -eq 1 ]]; then
  echo "dry-run: nothing will be changed. As root, this would run:"
  printf '  %q' "${create[@]}"
  echo
  echo "dry-run: the core user then needs the sudoers rule from ADR-004 (sudoers section), e.g.:"
  echo "  <core-user> ALL=(bot-*) NOPASSWD: ALL"
  exit 0
fi

if [[ "$(id -u)" -ne 0 ]]; then
  echo "must run as root (or use --dry-run)" >&2
  exit 1
fi

if id -u "$user" >/dev/null 2>&1; then
  echo "$user already exists; nothing to do"
  exit 0
fi

"${create[@]}"
echo "created $user; home: /home/$user"
