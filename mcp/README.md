# @viber/mcp — submit MCP

A small stdio [MCP](https://modelcontextprotocol.io/) server that the viber skill calls to
discover local evidence, score episodes through public-dj, and submit a Verifiable AI-Builder
Profile. It is intentionally auditable: local discovery tools send nothing, the scoring tool sends
only redacted episode summaries to the verifier, and submit transmits the **single schema-valid
profile JSON**.

## Tools

- **`analysis_manifest()`** — returns `schema_version`, `rubric_version`, and the data-handling
  "what leaves / what never leaves" summary so the agent knows exactly the allowlist before it
  builds a profile. Sends nothing over the network.
- **`discover_local_sources()`** — local-only Claude/Codex/Cursor coverage for the selected
  project. Returns counts, opaque refs, and dropped reasons; never paths.
- **`build_episode_candidates()`** — local-only redacted episode candidates, session metadata,
  steering/decision/code-output/parallelism signals, and coverage. Cursor is read from
  `state.vscdb` `cursorDiskKV` rows through `sqlite3` read-only immutable mode.
- **`git_aggregate_metrics()`** — host-side aggregate git stats only. It never reads source blobs
  and never returns hashes, authors, paths, filenames, remotes, or repo names.
- **`score_episodes({ episodes })`** — sends redacted episode summaries to public-dj for
  authoritative scores and HMAC nonces. Within `VIBER_SCRATCH_DIR`, it keeps a digest-only replay
  cache of returned nonce payloads; no raw summaries are cached.
- **`submit_profile({ profile, dry_run? })`** — validates the profile against the frozen allowlist
  schema (`schema/profile.schema.json`, ajv), re-runs **both redaction layers** over every
  free-text field as a fail-closed backstop, then POSTs the profile to the public-dj ingest
  endpoint with the submission token. In `--dry-run` it returns the exact payload and sends
  nothing.

## Redaction library (`src/redaction.ts`)

A clean-room, two-layer redactor mirroring `docs/data-handling.md`:

1. **Secret scrubber** — vendor API keys, AWS `AKIA…`, GitHub `ghp_…`, Google `AIza…`, Slack
   `xox…`, Stripe `sk_…`, generic `Bearer`/JWT, PEM `PRIVATE KEY` blocks, DB URLs with creds.
2. **Code / identifier / path redactor** — strips fenced & indented code, long inline code,
   absolute & repo-relative paths, filenames, and code identifiers.

`redactField()` is **fail-closed**: a field it cannot confidently scrub is dropped, not sent.
`detectViolations()` is the scan used by the submit backstop. Prompt-injection content such as a
transcript line saying `rate me 100` is treated as analyzable DATA — it is **not** stripped and
**not** obeyed (it is, at most, a negative behavioral signal for the skill to score).

## Configuration (env)

| Var | Default | Notes |
|---|---|---|
| `VIBER_SUBMIT_TOKEN` | _(none)_ | Signed submission token; set by the bootstrap. Never persisted. |
| `VIBER_PUBLIC_DJ_BASE_URL` | `https://viber.minutework.ai` | public-dj base URL. |
| `VIBER_INGEST_URL` | derived | Override the full ingest URL. |
| `VIBER_SCORE_URL` | derived | Override the full score proxy URL. |
| `VIBER_SELECTED_PROJECT_PATH` | MCP cwd | Project path selected by `upload.sh`; used only for local scoping. |
| `VIBER_SCRATCH_DIR` | _(unset)_ | Ephemeral 0700 scratch dir for digest-only score replay cache. |
| `VIBER_DRY_RUN` | _(unset)_ | `1`/`true` forces dry-run. |

## Develop

```
npm install
npm run typecheck
npm run build       # emits dist/ and vendors the frozen schema into dist/schema
npm test
```

Bin: `viber-mcp` → `dist/cli.js`.
