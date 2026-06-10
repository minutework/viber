# viber — verifiable AI-builder credential

Prove how well you build *with* AI — architecture, steering, debugging, review, shipping — backed by
real evidence from your own coding-agent transcripts, scored against a fixed open rubric. The
credential is the entry gate to [MinuteWork](https://minutework.ai)'s vibe-engineer network.

```
curl -fsSL https://viber.minutework.ai/upload.sh | bash
```

## How it works (and why you can trust it)

This tool is **open source** and runs **inside your own coding agent, on your own subscription**.
The bootstrap launches your agent (Claude / Codex / Cursor) pointed at an open skill; the agent
analyzes your transcripts **locally**, and the **only** thing transmitted is one schema-valid
**profile JSON**. Raw transcripts, source code, file paths, and your working tree **never leave your
machine**. You can read every line, watch it work, and `--dry-run` to print the exact payload before
anything is sent.

Sign-in uses a **PKCE GitHub-OAuth loopback handoff** against the MinuteWork platform
(`VIBER_PLATFORM_BASE_URL`): the bootstrap generates a PKCE verifier locally, opens your browser to
the platform start URL with only a `127.0.0.1` `redirect_uri` + the S256 `code_challenge`, receives a
single-use authorization **code** on a local listener, then exchanges that code for a short-lived
**signed submission token** — which is held in memory and passed to the submit MCP via env only,
never written to disk.

- **Privacy:** a hard allowlist ([`schema/profile.schema.json`](schema/profile.schema.json)) + two
  fail-closed redaction layers (secrets, then code/paths/identifiers), enforced on both the client
  and the server. See [`docs/data-handling.md`](docs/data-handling.md) for the exact "what leaves"
  table.
- **Credibility:** the final per-episode scoring runs through a verification proxy that issues
  signed, handle-bound nonces; the server recomputes and verifies them, holds anything unverified,
  and recomputes the headline scores itself — locally-faked scores don't survive.

## Layout

| Path | What |
|---|---|
| [`schema/profile.schema.json`](schema/profile.schema.json) | The frozen hard allowlist — the only thing submitted. |
| [`skill/rubric.md`](skill/rubric.md) | The versioned, open scoring rubric (8 dimensions + calibration). |
| `skill/SKILL.md` | The multi-agent analysis instructions (orchestrator / worker / synthesizer / validator). |
| `mcp/` | The local MCP server (`submit_profile`, `analysis_manifest`) — open so you see exactly what is sent. |
| `upload.sh` | The download-then-exec bootstrap (detect agent, authorize, run, submit). |
| [`docs/data-handling.md`](docs/data-handling.md) | Exactly what does and does not leave your machine. |

**Contract:** schema `1.0.0` / rubric `1.0.0` (frozen together; advance both per release).

## Status

`schema/`, `skill/rubric.md`, and `docs/data-handling.md` are frozen (S0). `skill/SKILL.md`,
`mcp/` (the submit MCP + clean-room two-layer redaction lib), and `upload.sh` (the bootstrap)
are implemented (S3) and ship **Claude + Codex first**; Cursor is best-effort behind a format
probe (its chat store is binary, not plaintext). `upload.sh` is wired to the **real** S1 PKCE
endpoints (`/api/v1/developer/builder-profile/oauth/github/start/` →
`…/submission-token/exchange/`) on the platform (`VIBER_PLATFORM_BASE_URL`, default
`https://platform.minutework.ai`); the public-dj ingest endpoint (`VIBER_PUBLIC_DJ_BASE_URL`) is
provided by S2. See the dispatch packet in the MinuteWork monorepo.

Bootstrap env overrides: `VIBER_PLATFORM_BASE_URL` (or the full `VIBER_OAUTH_START_URL` /
`VIBER_TOKEN_EXCHANGE_URL`), `VIBER_PUBLIC_DJ_BASE_URL`, `VIBER_SKILL_URL`, `VIBER_MCP_PACKAGE`,
`VIBER_LOOPBACK_PORT`.

### Build & test the MCP

```
cd mcp
npm install
npm run typecheck      # tsc, no emit
npm run build          # tsc -> dist/ + vendor the frozen schema
npm test               # node --test (redaction + schema + dry-run + submit)
```

## Living profile (daily refresh)

A profile should never go stale. `bin/viber-refresh` re-runs the analysis once
per LOCAL day with anacron-style catch-up, and `scripts/install-schedule.sh`
wires it into macOS launchd:

```sh
./scripts/install-schedule.sh install --project /path/to/your/project
./scripts/install-schedule.sh status     # loaded? last run? stamp?
./scripts/install-schedule.sh uninstall
```

Semantics: fires at **00:15 local time**; launchd coalesces firings missed
while asleep, and a `RunAtLoad` firing at login covers machines that were
powered off at midnight — a date stamp in `~/.viber/refresh/` makes catch-ups
at-most-once-per-day. The digest caches keep repeat runs cheap (only new
sessions cost LLM work).

Without a non-interactive token source the nightly run is **prepare-only**
(full analysis, caches warmed, payload validated, nothing sent). To publish
automatically, set `VIBER_TOKEN_COMMAND` in `~/.viber/refresh/config` to a
command that prints a fresh submission token (self-hosted operators can point
it at a platform management command). `upload.sh` also accepts a pre-minted
`VIBER_SUBMIT_TOKEN` from the environment for unattended runs.

Linux: use a systemd user timer with `OnCalendar=*-*-* 00:15` and
`Persistent=true` pointing at `bin/viber-refresh`.
