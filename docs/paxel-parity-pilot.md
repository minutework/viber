# Paxel Parity Pilot

Date: 2026-06-09

This pilot validates the first-class local extractor path for the selected monorepo project. It
uses only local transcript stores and host-side git metadata. The report intentionally records
counts only: no transcript text, paths, filenames, remotes, commit hashes, authors, or code.

## Extractor Coverage

Command shape:

```sh
pnpm -C mcp exec tsx -e 'discoverLocalSources(...); buildEpisodeCandidates(...)'
```

Cap: 50 sessions per tool.

| Tool | Sessions | Messages | Episode Candidates | Dropped Reasons |
|---|---:|---:|---:|---|
| Claude | 18 | 3,137 | 26 | `empty_event_text=5022` |
| Codex | 50 | 36,239 | 50 | `empty_event_text=82545`, `session_event_limit=3` |
| Cursor | 50 | 10,346 | 50 | none |
| Total | 118 | 49,722 | 126 | none blocking |

Manifest:

- `project_scope.single_project=true`
- `project_scope.repos_considered=1`
- `session_count=118`
- `episode_count=126`
- `decision_count=61`
- `active_days=13`

## Git Aggregate Check

Command shape:

```sh
pnpm -C mcp exec tsx -e 'gitAggregateMetrics(...)'
```

Results:

- `commit_count=503`
- `files_changed_count=17912`
- `active_days=44`
- `recent_commit_count=50`
- `median_commit_gap_minutes=22.93`
- `busiest_hour_utc=21`
- `weekend_share=0.3797`
- Extension histogram produced extension-only keys.
- Warnings: none.

## Coverage Diff

Prior state from the shipped skill/upload flow treated Cursor as best-effort and warned that it
could be skipped. This pilot confirms the new path produces first-class candidates for all three
required tools: Claude, Codex, and Cursor.

The previous Claude-only live profile payload is not stored in this repository, so this report
uses the old implementation state as the baseline rather than diffing against a saved payload.

## Post-Wave-0 Re-Run (2026-06-09)

Same methodology (cap 50/tool) after the Wave 0 correctness fixes (`mcp/scripts/pilot-report.mts`).
Counts only; no transcript text, paths, remotes, hashes, authors, or code.

| Tool | Sessions | Messages | Episode Candidates | Dropped Reasons |
|---|---:|---:|---:|---|
| Claude | 32 | 3,992 | 60 | `index_record_skipped=1041`, `empty_event_text=4465`, `queue_operation_skipped=262`, `empty_or_unreadable_session=4` |
| Codex | 50 | 35,344 | 99 | `telemetry_record_skipped=1289`, `empty_event_text=49672`, `session_event_limit=8`, `outside_selected_project=1` |
| Cursor | 50 | 2,867 | 53 | `empty_cursor_bubble=19891` |
| Total | 132 | 42,203 | 212 | none blocking |

Manifest: `session_count=132`, `episode_count=212`, `decision_count=90`, `active_days=36`,
`subagent_session_metadata=32` (kept, flagged, excluded from session counts).

Deltas vs the 2026-06-09 baseline above, all intended corrections:

- Codex episodes 50 -> 99 (~2/session instead of the degenerate 1/session): format-aware role
  inference fixed the `event_msg`/`response_item` misclassification.
- Claude sessions 18 -> 32 main (+32 subagent files now excluded from counts): worktree sessions
  of the same git remote are in scope; `subagents/*.jsonl` no longer count as sessions.
- Git `commit_count` 503 -> 438 and `weekend_share` 0.3797 -> 0.3128: author-filtered commits
  (configured email + name-matched emails, never serialized) and local-clock weekday binning.
- Uncapped totals: `total_vibe_agent_hours=1127.2` (was 1187.3 — subagent double-count removed),
  `total_tokens=38,309,716,770` (was 42,338,247,314 — usage objects nested in `toolUseResult`
  no longer double-count), `total_vibe_loc=2,873,013` (author-filtered).
- Cursor tokens: per-bubble `tokenCount` extraction added and covered by tests, but this
  project's composers carry only zero values, so `token_source` stays honest `unavailable`.
  Non-zero `composerData.usageData` (per-model `costInCents`/`amount`) exists and is the
  Wave 1 signal source for Cursor model/cost stats.

Follow-up: regenerate and resubmit the dvk31 profile (still schema 1.0.0) so the public
numbers reflect the corrections; Wave 3 consistency baselines start from that snapshot.
