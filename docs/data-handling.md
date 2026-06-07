# Data handling — exactly what leaves your machine

**Contract version:** schema `1.0.0` / rubric `1.0.0`

viber analyzes your coding-agent transcripts **locally, inside your own agent, on your own
subscription**. The only thing transmitted is a single schema-valid **profile JSON** (the shape in
[`schema/profile.schema.json`](../schema/profile.schema.json)). Raw transcripts, source code, file
contents, and your working tree **never leave your machine**. This page is the human-readable mirror
of that schema and is enforced fail-closed at **two** points: the client **Validator** before
submission, and **public-dj ingestion** on receipt. Either layer finding a violation rejects the
whole submission.

This tool is **open source** and runs in **your** agent — you can read every line, watch it work,
and diff the exact payload with `--dry-run` before anything is sent.

---

## What leaves your machine (allowlisted, redacted)

**Always sent:** handle, agent + version, run manifest, `generated_at`, dimensions, overall
grade/score, top strengths & growth edges, episode scores, redaction report. **Sent when
available:** session metadata, git metrics, recent commit subjects, decisions, code-quality signals,
client telemetry.

| Sent | Form | Notes |
|---|---|---|
| GitHub handle | lowercased username | From your verified submission token, **not** transcript text. |
| Agent + version | enum (`claude`/`codex`/`cursor`) + version string | Version is pattern-bounded; no path/host can hide in it. |
| Run manifest | session/episode **counts**, token estimates, time window, `repos_considered == 1` | Project-scoped attestation is **mandatory** (required field). |
| `generated_at` | UTC timestamp | When the profile was synthesized. |
| Per-dimension scores | int 0–100 + confidence | The eight rubric dimensions you have evidence for. **Recomputed server-side.** |
| Overall grade / score | enum + int 0–100 | **Recomputed server-side** from verified episode scores. |
| Top strengths / growth edges | ≤5 bounded strings each | Re-scrubbed narrative. |
| Evidence excerpts | ≤400 chars, paraphrased + double-redacted | No raw code/paths/identifiers/secrets. 2–3 per scored dimension. |
| Per-episode scores | ints + integrity nonce (`request_id` + HMAC + `digest`) | Each scored episode is proxy-signed; see Integrity. |
| Rationales / summary / archetype | bounded strings, re-scrubbed | LLM narrative is re-run through both redaction layers. |
| Session metadata | counts, **hex** opaque `session_ref`, timestamps, intent | `session_ref` is a salted hash (hex-only), never the real id or a path. |
| Git metrics | **aggregate** counts, velocity, extension histogram | Counts only; file involvement only as extensions (`ts`, `py`). **No paths, no commit hashes.** |
| Recent commit subjects | ≤200 chars, double-redacted, + timestamp | No author name/email, **no commit hash**. |
| Decisions | paraphrased proposal/response + tags | Never raw transcript or code. |
| Code-quality signals | floats 0–1, counts | Behavioral inference, never code. |
| Client telemetry | OS **family**, durations, pattern-bounded versions | `darwin`/`linux`/`windows` only. |
| Redaction report | two `applied: true` flags + counts | Advisory; public-dj re-verifies independently and unconditionally. |

## What NEVER leaves your machine

| Never sent | Why |
|---|---|
| Raw transcripts (Claude/Codex/Cursor) | Analyzed locally; only derived scores/evidence leave. |
| Source code / file contents / working-tree bytes | Git metadata is derived host-side via `git` commands; the analyzer never reads working-tree blobs. |
| **Absolute or repo-relative file paths & filenames** | Paths are PII. Stripped from **every** field — including git numstat and session events. Nothing carrying a path leaves. |
| Class / function / variable / module **identifiers** | Layer-2 redactor strips them; excerpts are paraphrased. |
| **Author email / author name / git identity** | Never uploaded. Only **aggregate** commit stats. |
| Secrets, API keys, tokens, JWTs, PEM keys, DB URLs with creds | Layer-1 secret scrubber, fail-closed. |
| Other repos, remotes, org names | **Project-scoped only.** The skill analyzes the one chosen project and never enumerates, catalogs, or transmits other repos/remotes/orgs. `repos_considered` is asserted `== 1`. |
| `~/.ssh`, `~/.aws`, keychains, env files, the docker socket | Out of scope; the analyzer reads only agent-transcript locations + host-side `git`. |
| A second persisted copy of your raw data | Any working cache is **ephemeral** and purged on completion. No `~/.viber/cache` of raw transcripts. |

> Two of these rows — **host-side git derivation** (never reading working-tree blobs) and the
> **ephemeral cache** (no second persisted copy) — are guarantees of the open-source client/runtime,
> not of the schema. You verify them by reading the tool, which is why it is open source and runs in
> your own agent. Everything else above is additionally backstopped by the schema + redactors below.

---

## The two redaction layers (fail-closed, both sides)

1. **Secret scrubber** — high-confidence credential patterns (vendor API keys, AWS `AKIA*`, GitHub
   `ghp_*`, Google `AIza*`, Slack `xox*`, Stripe `sk_*`, generic `Bearer`/JWT, `-----BEGIN …
   PRIVATE KEY-----`, DB URLs with embedded creds). Reimplemented independently from public
   (gitleaks-style) rule sets.
2. **Code / identifier / path redactor** — strips fenced & indented code, long inline code,
   absolute and repo-relative paths, filenames, and code identifiers; excerpts are paraphrased, not
   quoted verbatim.

Both layers run on every text field, **including LLM-generated narrative**, before packaging.
"Fail-closed" means: if a layer cannot confidently scrub a field, that field is **dropped**, not
sent. **public-dj re-runs both layers independently and unconditionally over every text field on
ingestion and rejects the whole submission on any hit** — the client's redaction is never trusted on
its own.

What the *schema* structurally guarantees is narrower, and worth stating plainly: (i) closed objects
(no unexpected fields), (ii) type/length/enum/pattern bounds, and (iii) **hex-only opaque ids** that
cannot encode a path, identifier, email, or repo/org name. The schema does **not** prevent PII
*inside* an allowed free-text field — a short path or key fits within a length bound — so that
exclusion is enforced entirely by the two redactors plus public-dj's re-scrub-and-reject, **not** by
the length bounds.

## Integrity (why the scores are trustworthy)

Heavy analysis is local on your subscription, but the **final per-episode scoring** routes through
the public-dj **verification proxy**. Only redacted episode digests reach the proxy. For each episode
it scores, the proxy returns the scores plus a signed nonce — `request_id` + base64url HMAC-SHA256 +
`digest` — over a **frozen canonical preimage**: `HMAC(server_key, request_id ‖ handle ‖ digest ‖
canonical_scores)`, where `digest = SHA-256(JCS({episode_id, type, scores}))` and JCS is RFC 8785
canonical JSON. The `handle` binding stops a nonce issued to one developer being replayed in
another's submission.

On submission, public-dj does **not** merely check that the nonce exists — it **recomputes** the
digest and HMAC from the *submitted* episode using its own key, and treats the **proxy-log scores as
authoritative** (overwriting whatever the client submitted). It also (a) requires the submitted
episodes to cover **every** `request_id` the proxy issued for that submission token, so a client
cannot silently drop low-scoring episodes, and (b) **recomputes all aggregates** (`dimensions.*`,
`overall_score`, `overall_grade`) from the verified episode scores — the headline numbers users see
are server-derived, not client-asserted. Any episode that fails recomputation is **held**
(`verified=false`), never trusted. Profiles are **append-only and non-editable** — re-running
regenerates and replaces; there is no manual edit path.

## Verify it yourself

- Read [`schema/profile.schema.json`](../schema/profile.schema.json) — the hard allowlist.
- Run the bootstrap with `--dry-run` to print the exact payload and send nothing.
- Read [`skill/SKILL.md`](../skill/SKILL.md) and [`mcp/`](../mcp/) — the analysis and the submit tool are open source.
