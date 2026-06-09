/**
 * analysis_manifest() payload — the human/agent-readable "what is allowed to
 * leave this machine" summary. Mirrors docs/data-handling.md so the agent sees
 * exactly the allowlist before it ever calls submit_profile.
 *
 * This is intentionally a static, code-level mirror of the frozen contract; it
 * does not phone home and contains no machine-identifying data.
 */
import { RUBRIC_VERSION, SCHEMA_VERSION } from "./schema.js";

export interface AnalysisManifest {
  schema_version: string;
  rubric_version: string;
  open_source: true;
  what_leaves: string[];
  what_never_leaves: string[];
  redaction_layers: string[];
  integrity: string;
  enforcement: string;
}

export function buildAnalysisManifest(): AnalysisManifest {
  return {
    schema_version: SCHEMA_VERSION,
    rubric_version: RUBRIC_VERSION,
    open_source: true,
    what_leaves: [
      "GitHub handle (lowercased username, from the verified submission token — never transcript text)",
      "Agent + version (enum claude/codex/cursor + pattern-bounded version string)",
      "Run manifest: session/episode counts, token estimates, time window, repos_considered == 1",
      "generated_at UTC timestamp",
      "Per-dimension scores (int 0-100 + confidence) for the eight rubric dimensions you have evidence for — recomputed server-side",
      "Overall grade/score (enum + int 0-100) — recomputed server-side from verified episode scores",
      "Top strengths / growth edges (<=5 bounded, re-scrubbed strings each)",
      "Evidence excerpts (<=400 chars, paraphrased + double-redacted; 2-3 per scored dimension)",
      "Per-episode scores (ints + integrity nonce: request_id + HMAC + digest)",
      "Rationales / summary / archetype (bounded strings, re-scrubbed)",
      "Session metadata (counts, hex opaque session_ref, timestamps, intent)",
      "Git metrics (aggregate counts, velocity, extension histogram — no paths, no commit hashes)",
      "Recent commit subjects (<=200 chars, double-redacted, + timestamp — no author name/email, no hash)",
      "Decisions (paraphrased proposal/response + tags)",
      "Code-quality signals (floats 0-1, counts — behavioral inference, never code)",
      "Client telemetry (OS family darwin/linux/windows only, durations, pattern-bounded versions incl. classifier version)",
      "Redaction report (two applied:true flags + counts — advisory; public-dj re-verifies independently)",
      "Model usage split (allowlisted model-family names + session counts/shares — unknown ids fail closed and are dropped)",
      "Behavioral aggregates (schema 1.1.0, all numeric/enum): plan-mode shares, interruption counts/rates, concurrency maxima, prompt statistics (word-count histograms, politeness/question/crash-out COUNTS — never prompt text), local-clock hour/weekday histograms (no timezone name), longest-run duration, rolling 30-day windows",
      "Work streams (salted opaque stream refs + session/commit counts and durations — no branch names or titles)",
      "Craft/economics/orchestration/identity stat blocks (rates, medians, counts: edit precision, red-to-green minutes, blast radius, churn, cache hit rate, delegation depth, streaks, tool loyalty — all derived numbers, no underlying text)",
    ],
    what_never_leaves: [
      "Raw transcripts (Claude/Codex/Cursor)",
      "Source code / file contents / working-tree bytes",
      "Absolute or repo-relative file paths and filenames",
      "Class / function / variable / module identifiers",
      "Author email / author name / git identity",
      "Secrets, API keys, tokens, JWTs, PEM keys, DB URLs with creds",
      "Other repos, remotes, org names (project-scoped only; repos_considered asserted == 1)",
      "~/.ssh, ~/.aws, keychains, env files, the docker socket",
      "A second persisted copy of your raw data (any working cache is ephemeral, purged on completion)",
    ],
    redaction_layers: [
      "Layer 1 — secret scrubber: vendor API keys, AWS AKIA*, GitHub ghp_*, Google AIza*, Slack xox*, Stripe sk_*, generic Bearer/JWT, PEM private keys, DB URLs with creds. Reimplemented independently.",
      "Layer 2 — code/identifier/path redactor: strips fenced & indented code, long inline code, absolute and repo-relative paths, filenames, code identifiers; excerpts are paraphrased.",
      "Both layers run on every text field including LLM-generated narrative, fail-closed (a field that cannot be confidently scrubbed is dropped, not sent).",
    ],
    integrity:
      "Final per-episode scoring routes through the public-dj verification proxy; each scored episode carries a signed nonce (request_id + base64url HMAC-SHA256 + digest) over a frozen canonical preimage HMAC(server_key, request_id || handle || digest || canonical_scores). public-dj recomputes digest+HMAC from the submitted episode, treats proxy-log scores as authoritative, requires the submitted set to cover every request_id issued for this token, recomputes all aggregates, and holds any episode that fails verification.",
    enforcement:
      "Fail-closed at TWO points: this client Validator before submission, and public-dj ingestion on receipt. Either layer finding a violation rejects the whole submission. The client redaction_report is advisory only — public-dj re-runs both redactors unconditionally over every text field and rejects on any hit.",
  };
}
