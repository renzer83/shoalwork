#!/usr/bin/env bash
# Exercises scripts/deploy/remote-install.sh with fake systemctl and curl, feeding it a good
# release and then a broken release that must trigger a rollback. The curl stub reads a target
# file to decide which /health body (and status code) to return, so the test can simulate the
# unit coming up on the previous version after the rollback.
set -euo pipefail

script_dir="$(cd "$(dirname "$0")" && pwd)"
root="$script_dir/.."
remote_install="$root/remote-install.sh"
[ -f "$remote_install" ] || { echo "remote-install.sh not found at $remote_install" >&2; exit 2; }

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

releases="$work/opt/shoalwork/releases"
current="$work/opt/shoalwork/current"
state_dir="$work/state"
bin="$work/bin"
mkdir -p "$releases" "$state_dir" "$bin"

systemctl_log="$state_dir/systemctl.log"
curl_target="$state_dir/curl_target"

# Fake systemctl: records every call and succeeds. We never actually touch systemd.
cat > "$bin/systemctl" <<'EOF'
#!/usr/bin/env bash
printf '%s\n' "$*" >> "$SYSTEMCTL_LOG"
exit 0
EOF
chmod +x "$bin/systemctl"

# Fake curl: reads a tag from "$CURL_TARGET" and returns a /health body for that tag. If the
# tag is "none" (or the file is missing), curl exits non-zero to mimic a dead service.
cat > "$bin/curl" <<'EOF'
#!/usr/bin/env bash
# Only answer our health URL; anything else is a mistake we want to see.
target=""
if [ -f "$CURL_TARGET" ]; then
  target="$(tr -d '[:space:]' < "$CURL_TARGET")"
fi
if [ -z "$target" ] || [ "$target" = "none" ]; then
  echo "curl: connection refused" >&2
  exit 7
fi
printf '{"ok":true,"version":"%s","db":"ok","dbPath":"shoalwork.db","journalMode":"wal","uptimeSeconds":1}\n' "$target"
EOF
chmod +x "$bin/curl"

export SYSTEMCTL_LOG="$systemctl_log"
export CURL_TARGET="$curl_target"

make_tarball() {
  local tag="$1" target="$2" include_release="${3:-1}"
  local staging
  staging="$(mktemp -d)"
  mkdir -p "$staging/release"
  if [ "$include_release" = "1" ]; then
    printf '%s' "$tag" > "$staging/release/RELEASE_TAG"
  fi
  printf '{"name":"shoalwork","version":"%s"}\n' "$tag" > "$staging/release/package.json"
  tar -czf "$target" -C "$staging" release
  rm -rf "$staging"
}

run_install() {
  local tag="$1" tarball="$2"
  env \
    RELEASES_DIR="$releases" \
    CURRENT_LINK="$current" \
    SYSTEMCTL="$bin/systemctl" \
    SYSTEMCTL_ARGS="--user" \
    CURL="$bin/curl" \
    SKIP_INSTALL=1 \
    HEALTH_TIMEOUT=4 \
    HEALTH_INTERVAL=1 \
    ROLLBACK_HEALTH_TIMEOUT=4 \
    KEEP_RELEASES=5 \
    SYSTEMCTL_LOG="$systemctl_log" \
    CURL_TARGET="$curl_target" \
    bash "$remote_install" "$tag" "$tarball"
}

fail() { echo "FAIL: $*" >&2; exit 1; }

echo "step 1: install good release v-good"
printf '%s' "v-good" > "$curl_target"
good_tar="$work/good.tar.gz"
make_tarball "v-good" "$good_tar"
run_install "v-good" "$good_tar" > "$work/good.log" 2>&1 || {
  cat "$work/good.log" >&2
  fail "good release install exited non-zero"
}
[ -L "$current" ] || fail "current is not a symlink after good install"
[ "$(readlink "$current")" = "$releases/v-good" ] || fail "current not pointing at v-good (got $(readlink "$current"))"
grep -q "installed: v-good" "$work/good.log" || fail "missing 'installed: v-good' marker"

echo "step 2: install broken release v-bad (curl refuses it) → must roll back to v-good"
# Curl keeps answering "v-good" even after the symlink flips: the broken release never serves
# the right version. The rollback flips it back, and curl still answers for v-good, so the
# rollback health-check passes.
bad_tar="$work/bad.tar.gz"
make_tarball "v-bad" "$bad_tar"
set +e
run_install "v-bad" "$bad_tar" > "$work/bad.log" 2>&1
status=$?
set -e
[ "$status" -ne 0 ] || { cat "$work/bad.log"; fail "broken release install should have exited non-zero"; }
grep -q "rolling back to $releases/v-good" "$work/bad.log" || { cat "$work/bad.log"; fail "no rollback message"; }
grep -q "rollback complete: $releases/v-good" "$work/bad.log" || { cat "$work/bad.log"; fail "rollback did not complete"; }
[ "$(readlink "$current")" = "$releases/v-good" ] || fail "current not pointing at v-good after rollback (got $(readlink "$current"))"
[ ! -d "$releases/v-bad" ] || fail "broken release directory should be cleaned up"

# Three systemctl restarts total: v-good install, v-bad install, rollback.
count="$(wc -l < "$systemctl_log" | tr -d '[:space:]')"
[ "$count" -ge 3 ] || fail "expected at least 3 systemctl restarts, got $count"

echo "PASS"
