# viber — Vibexp verifiable AI-builder credential

Prove how well you build *with* AI — architecture, steering, debugging, review, shipping — backed by
real evidence from your own coding-agent transcripts, scored against a fixed open rubric. The
credential powers [Vibexp](https://vibexp.dev) builder profiles and leaderboards.

```
curl -fsSL https://profile.vibexp.com/upload.sh | bash
```

Run it from the project root you want to profile, or pass `--project /path/to/project`. To opt
extra repositories into the structural repo-architecture scorecard, add `--repo <path>`
(repeatable) or `--repos /path/a,/path/b`, or pick from the interactive prompt on a terminal —
repos are **never** auto-enumerated; only what you explicitly select is scanned.

## How it works (and why you can trust it)

This tool is **open source** and runs **inside your own coding agent, on your own subscription**.
The bootstrap launches your agent (Claude / Codex / Cursor) pointed at an open skill; the agent
analyzes your transcripts **locally**, and the **only** thing transmitted is one schema-valid
**profile JSON**. Raw transcripts, source code, file paths, and your working tree **never leave your
machine**. You can read every line, watch it work, and `--dry-run` to print the exact payload before
anything is sent. Opt-in repo scans are local too: a repo scorecard carries only **numbers,
booleans, enums, and a salted opaque ref** plus at most two paraphrased, redaction-backstopped
notes — repos are identified by primary language + size band, never by name, path, or remote, and
the local secret scan ships a **count only**, never values or locations.

Sign-in uses a **PKCE GitHub-OAuth loopback handoff** against the shared platform
(`VIBER_PLATFORM_BASE_URL`): the bootstrap generates a PKCE verifier locally, opens your browser to
the platform start URL with only a `127.0.0.1` `redirect_uri` + the S256 `code_challenge`, receives a
single-use authorization **code** on a local listener, then exchanges that code for a short-lived
**signed submission token** plus a platform refresh credential. The submission token is held in
memory and passed to the submit MCP via env only, never written to disk. The refresh credential is
written to `~/.vibexp/refresh/credential` only if you opt into the living-profile refresh.

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
| [`skill/repo_rubric.md`](skill/repo_rubric.md) | The separate repo-architecture rubric (10 structural dimensions for opt-in repo scorecards). |
| `skill/SKILL.md` | The multi-agent analysis instructions (orchestrator / worker / synthesizer / validator). |
| `mcp/` | The local MCP server (`submit_profile`, `analysis_manifest`, plus local-only analysis helpers incl. `analyze_repo_architecture`) — open so you see exactly what is sent. |
| `upload.sh` | The download-then-exec bootstrap (detect agent, authorize, run, submit). |
| [`docs/data-handling.md`](docs/data-handling.md) | Exactly what does and does not leave your machine. |

**Contract:** schema `1.3.0` / rubric `1.1.0` / repo_rubric `1.0.0` (decoupled since 1.1.0;
public-dj dual-accepts older verified snapshots through its server-side compatibility map).

## Outcome layer — shipped with AI

Schema 1.3.0 adds an opt-in `shipped_with_ai` block: the things you actually shipped with AI
(apps, features, OSS, docs), as **user-approved public facts**. Detection is local and read-only;
**named items leave your machine only after you approve them in an interactive CLI review**
(`viber-mcp --detect-shipped` prints candidates to your terminal; `viber-mcp --review-shipped`
runs the approve/hide review and persists `~/.vibexp/shipped/approved.json`). The bootstrap offers
the review on interactive runs (skip with `VIBER_SHIPPED_NO_PROMPT=1`); scheduled/non-interactive
runs never prompt and just reuse stored approvals. Approved titles/URLs are the only name-bearing
fields in the profile — still secret-scanned, URLs https-only; without approval at most aggregate
counts ship. Vibexp's own analysis runs are excluded from all builder stats and reported only as
the aggregate `vibe_metrics.profile_analysis_overhead` audit block. Details in
[`docs/data-handling.md`](docs/data-handling.md).

## Status

`schema/`, `skill/rubric.md`, and `docs/data-handling.md` are frozen (S0). `skill/SKILL.md`,
`mcp/` (the submit MCP + clean-room two-layer redaction lib), and `upload.sh` (the bootstrap)
are implemented (S3) and ship **Claude + Codex first**; Cursor is best-effort behind a format
probe (its chat store is binary, not plaintext). `upload.sh` is wired to the **real** S1 PKCE
endpoints (`/api/v1/developer/builder-profile/oauth/github/start/` →
`…/submission-token/exchange/`) on the platform (`VIBER_PLATFORM_BASE_URL`, default
`https://platform.minutework.ai`); the public-dj ingest endpoint (`VIBER_PUBLIC_DJ_BASE_URL`) is
the shared public profile API.

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

## Living profile (hourly metrics, weekly AI)

A profile should never go stale. The bootstrap itself installs a living-profile
refresh — no repo checkout needed. After a successful run it offers:

    vibexp: keep this profile live with hourly metrics and weekly AI analysis? [Y/n]

or do it explicitly:

```sh
curl -fsSL https://profile.vibexp.com/upload.sh | bash -s -- --schedule-only --project /path/to/project
curl -fsSL https://profile.vibexp.com/upload.sh | bash -s -- --schedule-uninstall
```

What gets installed: a small runner at `~/.vibexp/bin/vibexp-refresh` plus a
macOS LaunchAgent (or a Linux systemd user timer with `Persistent=true`).
It fires hourly; firings missed while asleep are coalesced by the OS, and a
login/boot firing covers machines powered off. Local stamps make metrics
at-most-once per local hour and full AI analysis about weekly. Each refresh
re-fetches `upload.sh` from `VIBER_BASE_URL` (the same trust model as the
install command), falling back to the last cached copy when offline.

Publishing unattended uses the refresh credential issued during the interactive
run. It lives at `~/.vibexp/refresh/credential` (`0600`) and is exchanged
at `VIBER_TOKEN_REFRESH_URL` for a 15-minute submission token; rotated
credentials atomically replace the local file. The refresh credential is never
passed to the MCP server or coding agent. If the credential is missing,
expired, or rejected, refreshes fall back to **prepare-only** — metrics/cache
warmed, payload validated, nothing sent — and a notification says publish needs
re-auth.

Privacy-safe caches live under `~/.vibexp/cache/<project_digest>/` and contain
only salted request digests, extractor/version stamps, redacted derived
aggregates, and score nonce replay data. Raw transcripts, source code, paths,
filenames, repo names, commit hashes, local ids, emails, refresh credentials,
and submission tokens never live in that cache.

Controls:

```sh
~/.vibexp/bin/vibexp-refresh --status
~/.vibexp/bin/vibexp-refresh --force
~/.vibexp/bin/vibexp-refresh --mode=metrics --force
~/.vibexp/bin/vibexp-refresh --mode=full --force
curl -fsSL https://profile.vibexp.com/upload.sh | bash -s -- --schedule-only --project /path/to/project
curl -fsSL https://profile.vibexp.com/upload.sh | bash -s -- --schedule-uninstall
```

Config lives at `~/.vibexp/refresh/config`; set `VIBER_REFRESH_DISABLED=1`
for a temporary off-switch.

The repo-scorecard selection persists there too, as `VIBER_ARCH_REPOS`
(colon-separated absolute paths); nightly refreshes rescan the same
explicitly selected set — directories that no longer exist are skipped with
a warning. Change the set by editing that line, or by re-running the
bootstrap with `--schedule-only --repos /path/a,/path/b`.
