#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
UPLOAD="$ROOT/upload.sh"

bash -n "$UPLOAD"

TMPDIR_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/viber-schedule-test.XXXXXX")"
cleanup() {
  if [ -n "${SERVER_PID:-}" ]; then
    kill "$SERVER_PID" >/dev/null 2>&1 || true
  fi
  rm -rf "$TMPDIR_ROOT"
}
trap cleanup EXIT

HOME_DIR="$TMPDIR_ROOT/home"
PROJECT_DIR="$TMPDIR_ROOT/project with spaces"
VIBER_HOME_DIR="$HOME_DIR/.viber"
mkdir -p "$HOME_DIR" "$PROJECT_DIR"
PROJECT_CANON="$(cd "$PROJECT_DIR" && pwd -P)"

HOME="$HOME_DIR" \
VIBER_HOME="$VIBER_HOME_DIR" \
VIBER_SCHEDULE_INSTALL_DRY_RUN=1 \
  bash "$UPLOAD" --schedule-only --project "$PROJECT_DIR"

RUNNER="$VIBER_HOME_DIR/bin/viber-refresh"
CONFIG="$VIBER_HOME_DIR/refresh/config"
CREDENTIAL="$VIBER_HOME_DIR/refresh/credential"

[ -x "$RUNNER" ]
[ -f "$CONFIG" ]
grep -F "VIBER_REFRESH_PROJECT_PATH=\"$PROJECT_CANON\"" "$CONFIG" >/dev/null

FAKE_UPLOAD="$TMPDIR_ROOT/fake-upload.sh"
TOKEN_CAPTURE="$TMPDIR_ROOT/token.txt"
ARGS_CAPTURE="$TMPDIR_ROOT/args.txt"
CREDENTIAL_ENV_CAPTURE="$TMPDIR_ROOT/credential-env.txt"
cat >"$FAKE_UPLOAD" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "${VIBER_SUBMIT_TOKEN:-}" >"$TOKEN_CAPTURE"
printf '%s\n' "$*" >"$ARGS_CAPTURE"
env | grep -E '^VIBER_.*CREDENTIAL' >"$CREDENTIAL_ENV_CAPTURE" || true
EOF
chmod 700 "$FAKE_UPLOAD"

printf '%s\n' "old-refresh-credential" >"$CREDENTIAL"
chmod 600 "$CREDENTIAL"

PORT_FILE="$TMPDIR_ROOT/port.txt"
REQUEST_FILE="$TMPDIR_ROOT/request.json"
python3 - "$PORT_FILE" "$REQUEST_FILE" <<'PY' &
import json
import sys
from http.server import BaseHTTPRequestHandler, HTTPServer

port_file, request_file = sys.argv[1:3]


class Handler(BaseHTTPRequestHandler):
    def do_POST(self):
        length = int(self.headers.get("Content-Length", "0"))
        body = self.rfile.read(length).decode("utf-8")
        with open(request_file, "w", encoding="utf-8") as fh:
            fh.write(body)
        response = {
            "submission_token": "short-lived-submit-token",
            "expires_in": 900,
            "refresh_credential": "rotated-refresh-credential",
            "refresh_credential_expires_at": "2026-12-31T00:00:00Z",
        }
        encoded = json.dumps(response).encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(encoded)))
        self.end_headers()
        self.wfile.write(encoded)

    def log_message(self, *args):
        pass


server = HTTPServer(("127.0.0.1", 0), Handler)
with open(port_file, "w", encoding="utf-8") as fh:
    fh.write(str(server.server_address[1]))
server.handle_request()
PY
SERVER_PID=$!

for _ in $(seq 1 50); do
  [ -s "$PORT_FILE" ] && break
  sleep 0.1
done
[ -s "$PORT_FILE" ]
PORT="$(cat "$PORT_FILE")"

cat >>"$CONFIG" <<EOF
VIBER_UPLOAD_LOCAL="$FAKE_UPLOAD"
VIBER_TOKEN_REFRESH_URL="http://127.0.0.1:$PORT/refresh"
export TOKEN_CAPTURE="$TOKEN_CAPTURE"
export ARGS_CAPTURE="$ARGS_CAPTURE"
export CREDENTIAL_ENV_CAPTURE="$CREDENTIAL_ENV_CAPTURE"
EOF

HOME="$HOME_DIR" VIBER_HOME="$VIBER_HOME_DIR" "$RUNNER" --force

grep -F '"refresh_credential": "old-refresh-credential"' "$REQUEST_FILE" >/dev/null
grep -Fx "short-lived-submit-token" "$TOKEN_CAPTURE" >/dev/null
grep -F -- "--non-interactive" "$ARGS_CAPTURE" >/dev/null
if grep -F -- "--dry-run" "$ARGS_CAPTURE" >/dev/null; then
  echo "expected live run not to include --dry-run" >&2
  exit 1
fi
grep -Fx "rotated-refresh-credential" "$CREDENTIAL" >/dev/null
[ ! -s "$CREDENTIAL_ENV_CAPTURE" ]

rm -f "$CREDENTIAL" "$TOKEN_CAPTURE" "$ARGS_CAPTURE" "$CREDENTIAL_ENV_CAPTURE"
HOME="$HOME_DIR" VIBER_HOME="$VIBER_HOME_DIR" "$RUNNER" --force

grep -Fx "" "$TOKEN_CAPTURE" >/dev/null
grep -F -- "--dry-run" "$ARGS_CAPTURE" >/dev/null
[ ! -s "$CREDENTIAL_ENV_CAPTURE" ]

echo "upload schedule tests passed"
