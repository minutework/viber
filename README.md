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
probe (its chat store is binary, not plaintext). The live submit/authorize endpoints are
provided by the MinuteWork platform + public-dj (S1/S2). See the dispatch packet in the
MinuteWork monorepo.

### Build & test the MCP

```
cd mcp
npm install
npm run typecheck      # tsc, no emit
npm run build          # tsc -> dist/ + vendor the frozen schema
npm test               # node --test (redaction + schema + dry-run + submit)
```
