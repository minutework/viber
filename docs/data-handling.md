# Data handling — exactly what leaves your machine

**Contract version:** schema `1.2.0` / rubric `1.1.0` / repo_rubric `1.0.0` (decoupled; accepted
pairings are enforced by public-dj's server-side compatibility map).

viber analyzes your coding-agent transcripts **locally, inside your own agent, on your own
subscription**. The only thing transmitted is a single schema-valid **profile JSON** (the shape in
[`schema/profile.schema.json`](../schema/profile.schema.json)). Raw transcripts, source code, file
contents, and your working tree **never leave your machine**. This page is the human-readable mirror
of that schema and is enforced fail-closed at **two** points: the client **Validator** before
submission, and **public-dj ingestion** on receipt. Either layer finding a violation rejects the
whole submission.

This tool is **open source** and runs in **your** agent — you can read every line, watch it work,
and diff the exact payload with `--dry-run` before anything is sent.

The bundled MCP server also provides local-only analysis helpers: `discover_local_sources()`,
`build_actual_metrics()`, `build_episode_candidates()`, `build_wrapped_aggregates()`,
`git_aggregate_metrics()`, and `analyze_repo_architecture()` — all local-only; they read
transcript stores, host-side git metadata, and (for explicitly selected repos) repository
structure, and send nothing over the network. Cursor extraction uses `sqlite3` against Cursor's
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
| Repo architecture scorecards (opt-in) | per-repo numbers/booleans/enums + salted hex `repo_ref` + ≤2 paraphrased ≤400-char notes | Only for repos you explicitly selected (`--repo`/`--repos`/interactive picker). Repos identified by primary language + size band, never name/path. The secret scan ships a COUNT only. Self-reported; server re-verification is a later slice. |

## What NEVER leaves your machine

| Never sent | Why |
|---|---|
| Raw transcripts (Claude/Codex/Cursor) | Analyzed locally; only derived scores/evidence leave. |
| Source code / file contents / working-tree bytes | Git metadata is derived host-side via `git` commands; the analyzer never reads working-tree blobs. |
| **Absolute or repo-relative file paths & filenames** | Paths are PII. Stripped from **every** field — including git numstat and session events. Nothing carrying a path leaves. |
| Class / function / variable / module **identifiers** | Layer-2 redactor strips them; excerpts are paraphrased. |
| **Author email / author name / git identity** | Never uploaded. Only **aggregate** commit stats. |
| Secrets, API keys, tokens, JWTs, PEM keys, DB URLs with creds | Layer-1 secret scrubber, fail-closed. |
| Other repos, remotes, org names | **Transcript analysis is project-scoped** (`repos_considered == 1`): the skill analyzes one chosen project's transcripts and never enumerates other repos/remotes/orgs on its own. Structural repo SCANS are a separate, explicit opt-in per repo; even for opted-in repos, names, paths, remotes, and orgs never leave — a scorecard carries only numbers, booleans, enums, and a salted hex ref. |
| `~/.ssh`, `~/.aws`, keychains, env files, the docker socket | Out of scope; the analyzer reads only agent-transcript locations + host-side `git`. |
| A second persisted copy of your raw data | Raw working files are **ephemeral** and purged on completion. The persistent `~/.vibexp/cache/<project_digest>/` stores only salted request digests, extractor/version stamps, redacted derived aggregates, and score nonce replay data. No raw transcripts, source code, paths, filenames, repo names, hashes, emails, refresh credentials, or submission tokens. |

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

## Schema 1.2.0 additions (repo architecture scorecards)

Schema 1.2.0 adds an OPTIONAL `repo_architecture` block plus an advisory `combined_score` /
`combined_grade` headline (client display hints; a later public-dj slice recomputes them
server-side). It is a **consented, multi-repo structural showcase**: scorecards for repositories
you **explicitly selected** (`--repo` / `--repos` / the interactive picker), scored under the
separate [`skill/repo_rubric.md`](../skill/repo_rubric.md) (repo_rubric `1.0.0`). It is entirely
separate from — and changes nothing about — the single-project session privacy contract above:
`repos_considered == 1` still attests that **transcript** analysis covered exactly one project.

- Every scorecard field is a **number, boolean, pinned enum, or salted hex opaque `repo_ref`** —
  except at most two OPTIONAL paraphrased notes per repo (architecture and maintainability
  rationale, ≤400 chars each) that pass the **same double redaction** as every excerpt field.
- Repos are identified by **primary language + size band + the opaque ref only** — never by name,
  path, remote, or org.
- The scanner's deterministic markers ship verbatim (counts, ratios, booleans). Its local secret
  scan contributes a **count only** — never secret values or locations.
- The scan's `local_only` block (candidate file paths, top-level dirs, largest/most-churned/TODO
  files) is a local judging input for the agent and **never ships** — no schema field accepts it.
- Multi-repo enumeration is **explicit opt-in**: with no `--repo`/`--repos` flags and no
  interactive selection, only the already-consented selected project is scanned, and the tool
  never discovers or scans a repo you did not list.
- Scorecards are self-reported by the open-source client; server-side re-verification of repo
  scans is a later slice. The session-scoring integrity path (proxy nonces, server recomputation)
  is unchanged.

The verbatim-quote insights (cryptic prompt, crash-out quote, go-to phrase) remain EXCLUDED: only
their numeric counts ship. Any future verbatim tier requires a future schema (1.3.0 or later)
consent object, per-quote approval, and an explicit amendment to this document — the 1.2.0
repo-architecture block does not consume that reservation and adds no verbatim transcript or
source content.
