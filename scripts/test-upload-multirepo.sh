#!/usr/bin/env bash
# Multi-repo selection tests for upload.sh (VIBER_ARCH_REPOS resolution).
#
# Safe-to-run pinning: ONLY `bash -n`, `--help`, invalid-flag exits, and
# `--schedule-only` runs with HOME/VIBER_HOME pointed at a temp dir +
# VIBER_SCHEDULE_INSTALL_DRY_RUN=1 — these exit before agent detection, PKCE,
# network, or any upload. NEVER invoke upload.sh here without
# --schedule-only/--schedule-uninstall/--help.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
UPLOAD="$ROOT/upload.sh"

fail() {
  printf 'FAIL: %s\n' "$*" >&2
  exit 1
}

# 1. Syntax.
bash -n "$UPLOAD"

TMPDIR_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/vibexp-multirepo-test.XXXXXX")"
cleanup() { rm -rf "$TMPDIR_ROOT"; }
trap cleanup EXIT

HOME_DIR="$TMPDIR_ROOT/home"
VIBER_HOME_DIR="$HOME_DIR/.vibexp"
CONFIG="$VIBER_HOME_DIR/refresh/config"

# Temp git dirs WITH SPACES in their names (the separator must survive them).
P1="$TMPDIR_ROOT/project one"
P2="$TMPDIR_ROOT/repo two"
P3="$TMPDIR_ROOT/repo three"
MISSING="$TMPDIR_ROOT/does-not-exist"
COLON_DIR="$TMPDIR_ROOT/bad:colon"
mkdir -p "$HOME_DIR" "$P1/.git" "$P2/.git" "$P3/.git" "$COLON_DIR"
P1_CANON="$(cd "$P1" && pwd -P)"
P2_CANON="$(cd "$P2" && pwd -P)"
P3_CANON="$(cd "$P3" && pwd -P)"

# All runs use the dry-run schedule-only seam: config is written, nothing is
# installed, and the script exits before any agent/network step. The picker is
# additionally suppressed (schedule-only never prompts + VIBER_ARCH_NO_PROMPT).
run_schedule_only() {
  env -u VIBER_ARCH_REPOS \
    HOME="$HOME_DIR" \
    VIBER_HOME="$VIBER_HOME_DIR" \
    VIBER_SCHEDULE_INSTALL_DRY_RUN=1 \
    VIBER_ARCH_NO_PROMPT=1 \
    bash "$UPLOAD" --schedule-only "$@"
}

expect_config_repos() {
  local expected="VIBER_ARCH_REPOS=\"$1\""
  grep -Fx "$expected" "$CONFIG" >/dev/null ||
    fail "expected config line [$expected], got: $(grep -F 'VIBER_ARCH_REPOS=' "$CONFIG" || echo '<missing>')"
}

# 2. --help exits 0 and documents the new surface.
HELP_OUT="$(bash "$UPLOAD" --help)" || fail "--help must exit 0"
printf '%s\n' "$HELP_OUT" | grep -F -- "--repo <path>" >/dev/null || fail "--help must mention --repo"
printf '%s\n' "$HELP_OUT" | grep -F -- "--repos <p1,p2,...>" >/dev/null || fail "--help must mention --repos"
printf '%s\n' "$HELP_OUT" | grep -F "VIBER_ARCH_REPOS" >/dev/null || fail "--help must mention VIBER_ARCH_REPOS"

# 3. Invalid-flag exits (regression + bare --repo / --repos missing a value).
rc=0
bash "$UPLOAD" --bogus >/dev/null 2>&1 || rc=$?
[ "$rc" -eq 2 ] || fail "--bogus must exit 2 (got $rc)"
rc=0
bash "$UPLOAD" --repo >/dev/null 2>&1 || rc=$?
[ "$rc" -eq 2 ] || fail "bare --repo must exit 2 (got $rc)"
rc=0
bash "$UPLOAD" --repos >/dev/null 2>&1 || rc=$?
[ "$rc" -eq 2 ] || fail "bare --repos must exit 2 (got $rc)"

# 4. --repos CSV: project deduped to the front, canonical, colon-joined.
run_schedule_only --project "$P1" --repos "$P1,$P2"
expect_config_repos "$P1_CANON:$P2_CANON"

# 5. Repeatable --repo: order preserved; repeating an entry dedups.
run_schedule_only --project "$P1" --repo "$P2" --repo "$P3" --repo "$P2"
expect_config_repos "$P1_CANON:$P2_CANON:$P3_CANON"

# 6. Default (no flags, env unset, no-prompt seam): exactly the selected
#    project, and no picker text anywhere on stdout/stderr.
DEFAULT_OUT="$TMPDIR_ROOT/default-out.txt"
run_schedule_only --project "$P1" >"$DEFAULT_OUT" 2>&1
expect_config_repos "$P1_CANON"
if grep -F "also scan additional repos" "$DEFAULT_OUT" >/dev/null; then
  fail "default run must not emit the interactive picker prompt"
fi

# 7. Env passthrough: a pre-set VIBER_ARCH_REPOS is authoritative — persisted
#    verbatim (post-validation) and the project is NOT force-added.
env HOME="$HOME_DIR" \
  VIBER_HOME="$VIBER_HOME_DIR" \
  VIBER_SCHEDULE_INSTALL_DRY_RUN=1 \
  VIBER_ARCH_NO_PROMPT=1 \
  VIBER_ARCH_REPOS="$P2_CANON:$P3_CANON" \
  bash "$UPLOAD" --schedule-only --project "$P1"
expect_config_repos "$P2_CANON:$P3_CANON"

# 8. Rejections: a non-existent path and a ':'-bearing dir are dropped with a
#    warning and never reach the config.
REJECT_ERR="$TMPDIR_ROOT/reject-err.txt"
run_schedule_only --project "$P1" --repos "$MISSING,$COLON_DIR" 2>"$REJECT_ERR"
expect_config_repos "$P1_CANON"
grep -F "skipping repo (not a directory): $MISSING" "$REJECT_ERR" >/dev/null ||
  fail "missing-dir candidate must warn"
grep -F "skipping repo with ':' in path" "$REJECT_ERR" >/dev/null ||
  fail "':'-bearing candidate must warn"
if grep -F "$COLON_DIR" "$CONFIG" >/dev/null; then
  fail "':'-bearing path must not be persisted"
fi
if grep -F "$MISSING" "$CONFIG" >/dev/null; then
  fail "non-existent path must not be persisted"
fi

# 9. Compat gate: the pre-existing schedule test passes unchanged.
bash "$ROOT/scripts/test-upload-schedule.sh"

echo "upload multirepo tests passed"
