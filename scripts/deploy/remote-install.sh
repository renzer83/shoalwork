#!/usr/bin/env bash
# Installs a release in /opt/shoalwork/releases/<tag>, swaps the `current` symlink, restarts the
# user systemd unit and polls /health. On failure it rolls back the symlink and restarts again.
# All I/O goes through environment variables so the companion test can inject stubs.
set -euo pipefail

: "${RELEASES_DIR:=/opt/shoalwork/releases}"
: "${CURRENT_LINK:=/opt/shoalwork/current}"
: "${UNIT_NAME:=shoalwork-core}"
: "${SYSTEMCTL:=systemctl}"
: "${SYSTEMCTL_ARGS:=--user}"
: "${CURL:=curl}"
: "${CORE_PORT:=28900}"
: "${HEALTH_TIMEOUT:=60}"
: "${HEALTH_INTERVAL:=2}"
: "${ROLLBACK_HEALTH_TIMEOUT:=30}"
: "${KEEP_RELEASES:=5}"

log() { printf '%s %s\n' "[remote-install]" "$*"; }
die() { log "ERROR: $*"; exit 1; }

extract_release() {
  local tag="$1" tarball="$2" target="$RELEASES_DIR/$tag"
  [ -f "$tarball" ] || die "tarball not found: $tarball"
  mkdir -p "$RELEASES_DIR"
  if [ -e "$target" ]; then
    die "release already present: $target (remove it or deploy a new tag)"
  fi
  local staging
  staging="$(mktemp -d)"
  tar -xzf "$tarball" -C "$staging"
  if [ -d "$staging/release" ]; then
    mv "$staging/release" "$target"
  else
    mv "$staging" "$target"
  fi
  rm -rf "$staging"
  printf '%s' "$target"
}

install_runtime_deps() {
  local release="$1"
  if [ -z "${SKIP_INSTALL:-}" ] && [ -f "$release/package.json" ]; then
    ( cd "$release" && pnpm install --prod --frozen-lockfile )
  fi
}

restart_unit() {
  "$SYSTEMCTL" $SYSTEMCTL_ARGS restart "$UNIT_NAME"
}

health_check() {
  local tag="$1" timeout="$2" deadline waited=0
  deadline="$(( SECONDS + timeout ))"
  while [ "$SECONDS" -lt "$deadline" ]; do
    local body
    if body="$("$CURL" -fsS "http://127.0.0.1:${CORE_PORT}/health" 2>/dev/null)"; then
      if printf '%s' "$body" | grep -F "\"version\":\"$tag\"" >/dev/null; then
        if printf '%s' "$body" | grep -F '"ok":true' >/dev/null; then
          return 0
        fi
      fi
    fi
    sleep "$HEALTH_INTERVAL"
    waited=$(( waited + HEALTH_INTERVAL ))
  done
  log "health-check timed out after ${timeout}s (last body: ${body:-<none>})"
  return 1
}

swap_current() {
  local target="$1"
  ln -snf "$target" "$CURRENT_LINK"
}

previous_target() {
  if [ -L "$CURRENT_LINK" ]; then
    readlink "$CURRENT_LINK"
  fi
}

read_release_tag() {
  local release="$1"
  if [ -f "$release/RELEASE_TAG" ]; then
    tr -d '[:space:]' < "$release/RELEASE_TAG"
  fi
}

prune_old_releases() {
  local keep="$KEEP_RELEASES"
  ( cd "$RELEASES_DIR" && ls -1t | awk "NR>${keep}" | while IFS= read -r old; do
      [ -n "$old" ] && rm -rf -- "$old"
    done )
}

rollback() {
  local previous="$1"
  if [ -z "$previous" ]; then
    die "nothing to roll back to (no previous release)"
  fi
  log "rolling back to $previous"
  swap_current "$previous"
  restart_unit
  local prev_tag
  prev_tag="$(read_release_tag "$previous")"
  if [ -n "$prev_tag" ]; then
    if health_check "$prev_tag" "$ROLLBACK_HEALTH_TIMEOUT"; then
      log "rollback complete: $previous"
      return 0
    fi
    log "rollback health-check failed for $previous"
    return 1
  fi
  log "rollback complete (no RELEASE_TAG to verify)"
  return 0
}

install_release() {
  local tag="$1" tarball="$2"
  [ -n "$tag" ] || die "missing tag"
  [ -n "$tarball" ] || die "missing tarball path"

  local previous
  previous="$(previous_target)"

  local release
  release="$(extract_release "$tag" "$tarball")"
  log "extracted: $release"

  install_runtime_deps "$release"

  swap_current "$release"
  log "symlink -> $release"

  restart_unit
  log "restarted $UNIT_NAME"

  if ! health_check "$tag" "$HEALTH_TIMEOUT"; then
    log "health-check failed for $tag"
    rm -rf "$release"
    rollback "$previous" || die "rollback failed"
    exit 1
  fi

  prune_old_releases
  log "installed: $tag"
}

# When sourced, expose functions and skip main. When executed, run main.
if [ "${BASH_SOURCE[0]:-}" = "${0:-}" ]; then
  install_release "${1:-}" "${2:-}"
fi
