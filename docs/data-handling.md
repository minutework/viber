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

The bundled MCP server also provides local-only discovery helpers:
`discover_local_sources()`, `build_episode_candidates()`, and `git_aggregate_metrics()`. These
helpers read Claude/Codex/Cursor transcript stores and host-side git metadata for the selected
project, but send nothing over the network. Cursor extraction uses `sqlite3` against Cursor's
`state.vscdb` in read-only immutable mode and only counts project-scoped rows.

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
| A second persisted copy of your raw data | Any working cache is **ephemeral** and purged on completion. No `~/.viber/cache` of raw transcripts. The score replay cache stores only request digests and returned nonce payloads. |

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

The proxy also stores a server-computed `request_digest` for the redacted score request. Retrying
the same score request with the same submission token returns the already-issued nonce instead of
minting a duplicate nonce that would later trip the full-coverage guard.

On submission, public-dj does **not** merely check that the nonce exists — it **recomputes** the
digest and HMAC from the *submitted* episode using its own key, and treats the **proxy-log scores as
authoritative** (overwriting whatever the client submitted). It also (a) requires the submitted
episodes to cover **every** `request_id` the proxy issued for that submission token, so a client
cannot silently drop low-scoring episodes, and (b) **recomputes all aggregates** (`dimensions.*`,
`overall_score`, `overall_grade`) from the verified episode scores — the headline numbers users see
are server-derived, not client-asserted. Any episode that fails recomputation is **held**
(`verified=false`), never trusted. Profiles are **append-only and non-editable**. Exact duplicate
submits return the existing snapshot receipt instead of appending a duplicate; changed submissions
append a new snapshot. There is no manual edit path.

## Verify it yourself

- Read [`schema/profile.schema.json`](../schema/profile.schema.json) — the hard allowlist.
- Run the bootstrap with `--dry-run` to print the exact payload and send nothing.
- Read [`skill/SKILL.md`](../skill/SKILL.md) and [`mcp/`](../mcp/) — the analysis and the submit tool are open source.

## Schema 1.1.0 additions (wrapped behavioral aggregates)

Schema 1.1.0 adds OPTIONAL aggregate blocks. Every new field is numeric, enum-bounded, a fixed-size
histogram, or a salted opaque ref; **no new free-text fields were added**. Specifically:

- `vibe_metrics.model_usage` — model-FAMILY names from a fixed client-side allowlist map
  (`claude-opus-4-8` -> "Opus 4.8"); raw ids that do not normalize are dropped fail-closed, so this
  field can never carry free text.
- `vibe_metrics.{plan_mode, interruption, concurrency, prompt_stats, event_hour_histogram_local,
  longest_agent_run, last_30_days}` — counts, ratios, durations, and 24-bin LOCAL-clock histograms.
  Prompt statistics are computed over human prompts only and ship as NUMBERS (word-count buckets,
  politeness/question/crash-out counts); the prompts themselves never leave the machine. Local-hour
  binning uses per-commit UTC offsets (git) or the host's current offset (transcripts); the
  timezone identifier itself is never shipped.
- `git_metrics.{commit_hour_histogram_local, commits_by_weekday_local, loc_added_by_weekday_local,
  night_owl_share, biggest_push, pr_metrics, last_30_days}` — author-filtered aggregate counts.
  `biggest_push` carries the WEEKDAY only, never the date (a date would be cross-referenceable
  against public repo activity given the handle). The author emails used for filtering are detected
  locally and never serialized.
- `work_streams[]` — salted opaque stream refs with session/commit counts and durations only.
- `craft_stats`, `economics_stats`, `orchestration_stats`, `identity_stats` — derived rates,
  medians, and counts (edit precision, red-to-green recovery, blast radius, churn, cache hit rate,
  delegation depth, build streaks, tool loyalty, session shape). All numbers/enums.
- `operating_level`, `specialty_signals`, `decisions[].{initiative,outcome_evidence,topics}` —
  rubric 1.1 stubs (band enums, topic enums, confidence numbers, evidence excerpts that pass the
  same double-redaction as all excerpt fields). Not populated until the rubric 1.1 release;
  public-dj serves operating_level only for maturity-established profiles.
- `client_telemetry.classifier_version` — the versioned command-classifier behind the test/build
  classification rates, for reproducibility.

The verbatim-quote insights (cryptic prompt, crash-out quote, go-to phrase) remain EXCLUDED: only
their numeric counts ship. Any future verbatim tier requires a schema 1.2.0 consent object, per-quote
approval, and an explicit amendment to this document.
