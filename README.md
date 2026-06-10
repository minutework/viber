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

A profile should never go stale. The bootstrap itself installs a daily
refresh — no repo checkout needed. After a successful run it offers:

    viber: keep this profile LIVE with a daily refresh at 12:15 AM ...? [Y/n]

or do it explicitly from anywhere:

```sh
curl -fsSL https://viber.minutework.ai/upload.sh | bash -s -- --schedule-only
curl -fsSL https://viber.minutework.ai/upload.sh | bash -s -- --schedule-uninstall
```

What gets installed: a small runner at `~/.viber/bin/viber-refresh` plus a
macOS LaunchAgent (or a Linux systemd user timer with `Persistent=true`).
It fires at **00:15 local time**; firings missed while asleep are coalesced
by the OS, and a login/boot firing covers machines powered off at midnight —
a local-date stamp makes catch-ups at-most-once-per-day. Each night the
runner re-fetches `upload.sh` from `VIBER_BASE_URL` (the same trust model as
the install command), falling back to the last cached copy when offline. The
digest caches keep repeat runs cheap (only new sessions cost LLM work).

Publishing unattended needs a non-interactive token. The runner tries, in
order: `VIBER_TOKEN_COMMAND` (advanced/self-hosted), then a stored refresh
credential at `~/.viber/refresh/credential` exchanged at
`VIBER_TOKEN_REFRESH_URL` (issued by the platform's refresh-credential
endpoint). With neither, nightly runs are **prepare-only** — full analysis,
caches warmed, payload validated, nothing sent — and a notification says so.
Config lives at `~/.viber/refresh/config`; set `VIBER_REFRESH_DISABLED=1`
for a temporary off-switch.
