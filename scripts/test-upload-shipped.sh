#!/usr/bin/env bash
# Shipped-with-AI review gating tests for upload.sh (outcome layer).
#
# Safe-to-run pinning: ONLY `bash -n`, `--help`, `--schedule-only` runs with
# HOME/VIBER_HOME pointed at a temp dir + VIBER_SCHEDULE_INSTALL_DRY_RUN=1,
# and `--dry-run` runs on a minimal stub PATH (a recording `npx` stub; no
# coding agents) that deterministically exit at agent selection ("No ready
# coding agent found") BEFORE any skill fetch, PKCE, network, or upload —
# `--dry-run` returns early from the score-health preflight and skips OAuth.
# NEVER invoke upload.sh here in any other mode.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
UPLOAD="$ROOT/upload.sh"

fail() {
  printf 'FAIL: %s\n' "$*" >&2
  exit 1
}

# 1. Syntax.
bash -n "$UPLOAD"

TMPDIR_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/vibexp-shipped-test.XXXXXX")"
cleanup() { rm -rf "$TMPDIR_ROOT"; }
trap cleanup EXIT

HOME_DIR="$TMPDIR_ROOT/home"
VIBER_HOME_DIR="$HOME_DIR/.vibexp"
PROJECT_DIR="$TMPDIR_ROOT/project one"
mkdir -p "$HOME_DIR" "$PROJECT_DIR/.git"

# Recording npx stub: logs every invocation's args, exits 0. Any
# `--review-shipped` invocation (or its absence) is observable in NPX_LOG.
STUB_BIN="$TMPDIR_ROOT/stub-bin"
NPX_LOG="$TMPDIR_ROOT/npx-invocations.log"
mkdir -p "$STUB_BIN"
cat >"$STUB_BIN/npx" <<EOF
#!/bin/bash
printf '%s\n' "\$*" >>"$NPX_LOG"
exit 0
EOF
chmod 700 "$STUB_BIN/npx"
STUB_PATH="$STUB_BIN:/usr/bin:/bin"

reset_log() { : >"$NPX_LOG"; }

assert_no_review() {
  if grep -F -- "--review-shipped" "$NPX_LOG" >/dev/null 2>&1; then
    fail "$1: viber-mcp --review-shipped must NOT be invoked"
  fi
}

# 2. --help exits 0 and documents the skip override.
HELP_OUT="$(bash "$UPLOAD" --help)" || fail "--help must exit 0"
printf '%s\n' "$HELP_OUT" | grep -F "VIBER_SHIPPED_NO_PROMPT" >/dev/null ||
  fail "--help must mention VIBER_SHIPPED_NO_PROMPT"

# 3. --schedule-only never reaches the shipped review (install-and-exit).
reset_log
env -u VIBER_ARCH_REPOS \
  HOME="$HOME_DIR" \
  VIBER_HOME="$VIBER_HOME_DIR" \
  VIBER_SCHEDULE_INSTALL_DRY_RUN=1 \
  VIBER_ARCH_NO_PROMPT=1 \
  PATH="$STUB_PATH" \
  bash "$UPLOAD" --schedule-only --project "$PROJECT_DIR" ||
  fail "--schedule-only must exit 0"
assert_no_review "--schedule-only"

# 4. --schedule-only --non-interactive: still no review.
reset_log
env -u VIBER_ARCH_REPOS \
  HOME="$HOME_DIR" \
  VIBER_HOME="$VIBER_HOME_DIR" \
  VIBER_SCHEDULE_INSTALL_DRY_RUN=1 \
  VIBER_ARCH_NO_PROMPT=1 \
  PATH="$STUB_PATH" \
  bash "$UPLOAD" --schedule-only --non-interactive --project "$PROJECT_DIR" ||
  fail "--schedule-only --non-interactive must exit 0"
assert_no_review "--schedule-only --non-interactive"

# Dry-run harness: minimal stub PATH (no coding agents), temp HOME. The run
# passes the shipped-review point, then exits 1 at agent selection — before
# skill fetch / OAuth / any network. --dry-run short-circuits the score-health
# preflight and the PKCE handoff. Usage: run_dry <out-file> [extra upload args...]
run_dry() {
  local out_file="$1"
  shift
  local rc=0
  env -u VIBER_ARCH_REPOS -u VIBER_SHIPPED_NO_PROMPT \
    HOME="$HOME_DIR" \
    VIBER_HOME="$VIBER_HOME_DIR" \
    VIBER_ARCH_NO_PROMPT=1 \
    PATH="$STUB_PATH" \
    bash "$UPLOAD" --dry-run --project "$PROJECT_DIR" ${1+"$@"} >"$out_file" 2>&1 || rc=$?
  [ "$rc" -eq 1 ] || fail "dry run must exit 1 at agent selection (got $rc); output: $(cat "$out_file")"
  grep -F "No ready coding agent found" "$out_file" >/dev/null ||
    fail "dry run must stop at agent selection; output: $(cat "$out_file")"
}

# 5. --non-interactive (unattended) run never prompts for the review.
reset_log
run_dry "$TMPDIR_ROOT/noninteractive-out.txt" --non-interactive
assert_no_review "--non-interactive"

# 6. VIBER_SHIPPED_NO_PROMPT=1 skips the review on an otherwise-interactive run.
reset_log
rc=0
env -u VIBER_ARCH_REPOS \
  HOME="$HOME_DIR" \
  VIBER_HOME="$VIBER_HOME_DIR" \
  VIBER_ARCH_NO_PROMPT=1 \
  VIBER_SHIPPED_NO_PROMPT=1 \
  PATH="$STUB_PATH" \
  bash "$UPLOAD" --dry-run --project "$PROJECT_DIR" \
  >"$TMPDIR_ROOT/noprompt-out.txt" 2>&1 || rc=$?
[ "$rc" -eq 1 ] || fail "VIBER_SHIPPED_NO_PROMPT=1 dry run must exit 1 at agent selection (got $rc)"
grep -F "No ready coding agent found" "$TMPDIR_ROOT/noprompt-out.txt" >/dev/null ||
  fail "VIBER_SHIPPED_NO_PROMPT=1 dry run must stop at agent selection"
assert_no_review "VIBER_SHIPPED_NO_PROMPT=1"

# 7. Positive control (controlling tty only): a plain interactive run DOES
#    invoke `viber-mcp --review-shipped` exactly once, before agent selection.
if [ -r /dev/tty ] && [ -w /dev/tty ]; then
  reset_log
  run_dry "$TMPDIR_ROOT/positive-out.txt"
  review_count="$(grep -cF -- "viber-mcp --review-shipped" "$NPX_LOG" 2>/dev/null || true)"
  [ "${review_count:-0}" = "1" ] ||
    fail "interactive dry run must invoke viber-mcp --review-shipped exactly once (got ${review_count:-0})"
else
  printf 'vibexp-shipped-test: no controlling tty; skipping the positive review-invocation check.\n' >&2
fi

# 8. Compat gate: the multi-repo suite (which itself chains the schedule test)
#    passes unchanged.
bash "$ROOT/scripts/test-upload-multirepo.sh"

echo "upload shipped tests passed"
