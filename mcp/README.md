# @viber/mcp — submit MCP

A small stdio [MCP](https://modelcontextprotocol.io/) server that the viber skill calls to
submit a Verifiable AI-Builder Profile. It is intentionally tiny and auditable: it transmits the
**single schema-valid profile JSON** and nothing else.

## Tools

- **`analysis_manifest()`** — returns `schema_version`, `rubric_version`, and the data-handling
  "what leaves / what never leaves" summary so the agent knows exactly the allowlist before it
  builds a profile. Sends nothing over the network.
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
| `VIBER_DRY_RUN` | _(unset)_ | `1`/`true` forces dry-run. |

## Develop

```
npm install
npm run typecheck
npm run build       # emits dist/ and vendors the frozen schema into dist/schema
npm test
```

Bin: `viber-mcp` → `dist/cli.js`.
