/**
 * Vibexp outcome layer — local "shipped with AI" detection + approvals.
 *
 * detectShippedCandidates is a deterministic, READ-ONLY git inspection: it
 * shells out to `git` exactly like the gitAggregateMetrics machinery, never
 * reads blobs, never writes, and never performs network calls. Raw candidates
 * carry LOCAL-ONLY fields (repo_label, suggested_title, source_key) that are
 * shown on the user's terminal and stored in the local approvals file but
 * NEVER ship in a profile: the submitted shipped_with_ai block is built
 * exclusively from explicitly CLI-approved items / aggregate counts via
 * buildShippedWithAiBlock, which strips every local-only key.
 *
 * Approvals file (shared contract): $VIBER_HOME/shipped/approved.json
 * (VIBER_HOME defaults to ~/.vibexp; file 0600, dir 0700) with shape
 * { version: 1, updated_at, mode: approved_items|aggregate_only|opt_out,
 *   items: [schema-shaped items + optional local source_key],
 *   aggregate: schema-shaped summary, source_keys_reviewed: [...] }.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

import { normalizeRemoteUrl } from "./extractors.js";
import { detectShippedTitleViolations, detectShippedUrlViolations } from "./redaction.js";

export const SHIPPED_CATEGORIES = [
  "app",
  "platform",
  "feature",
  "infra",
  "oss",
  "internal_tool",
  "docs",
  "other",
] as const;
export type ShippedCategory = (typeof SHIPPED_CATEGORIES)[number];

export const SHIPPED_EVIDENCE_STATUSES = [
  "local_evidence",
  "git_evidence",
  "public_url",
  "release_tag",
  "deploy_signal",
] as const;
export type ShippedEvidenceStatus = (typeof SHIPPED_EVIDENCE_STATUSES)[number];

export const SHIPPED_AI_CONTRIBUTIONS = ["assist", "majority_ai", "ai_led", "unknown"] as const;
export type ShippedAiContribution = (typeof SHIPPED_AI_CONTRIBUTIONS)[number];

export const SHIPPED_MODES = ["approved_items", "aggregate_only", "opt_out"] as const;
export type ShippedMode = (typeof SHIPPED_MODES)[number];

/** Hard caps from the shared contract. */
export const MAX_SHIPPED_REPOS = 20;
export const MAX_SHIPPED_COMMITS_PER_REPO = 500;
export const MAX_SHIPPED_ITEMS = 20;

/** Schema-shaped shipped item (profile payload shape; no local-only keys). */
export interface ShippedItem {
  title: string;
  public_url?: string;
  category: ShippedCategory;
  shipped_on?: string;
  ai_contribution: ShippedAiContribution;
  evidence_status: ShippedEvidenceStatus;
}

/** Approvals-file item: schema-shaped plus the LOCAL-ONLY source_key. */
export interface ApprovedShippedItem extends ShippedItem {
  /** LOCAL ONLY — "<remoteKey>:<YYYY-MM>"; stripped before any profile build. */
  source_key?: string;
}

export interface ShippedSummary {
  total: number;
  by_category?: Partial<Record<ShippedCategory, number>>;
  by_evidence?: Partial<Record<ShippedEvidenceStatus, number>>;
}

/** Schema-shaped shipped_with_ai block (profile payload shape). */
export interface ShippedWithAiBlock {
  mode: "approved_items" | "aggregate_only";
  summary: ShippedSummary;
  items?: ShippedItem[];
  last_detected_at: string;
}

export interface ShippedApprovalsFile {
  version: 1;
  updated_at: string;
  mode: ShippedMode;
  items?: ApprovedShippedItem[];
  aggregate?: ShippedSummary;
  source_keys_reviewed?: string[];
}

/**
 * One detected per-repo-per-month shipped candidate. repo_label and
 * suggested_title are LOCAL ONLY (terminal/approvals-file display); they must
 * never enter buildShippedAggregate output or a profile payload.
 */
export interface ShippedCandidate {
  /** LOCAL ONLY — "<remoteKey>:<YYYY-MM>". Never ships in a profile. */
  source_key: string;
  /** LOCAL ONLY — repo directory basename for terminal display. */
  repo_label: string;
  /** Calendar month, YYYY-MM. */
  period: string;
  /** Schema category enum values (primary category first). */
  categories: ShippedCategory[];
  /** Schema evidence_status values (strongest first). */
  evidence: ShippedEvidenceStatus[];
  /** Number of shipped-signal commits in this repo x month cluster. */
  commit_count: number;
  /** LOCAL ONLY — default public title offered during CLI review. */
  suggested_title: string;
}

export interface ShippedDetectionOptions {
  repos: string[];
  gitPath?: string;
  /** Test seam; clamped to 1..500 (contract default: last 500 commits). */
  maxCommitsPerRepo?: number;
}

export interface ShippedDetection {
  candidates: ShippedCandidate[];
  warnings: string[];
}

/** VIBER_HOME resolution (defaults to ~/.vibexp). */
export function viberHomeDir(env: NodeJS.ProcessEnv = process.env, homeDir?: string): string {
  const fromEnv = env.VIBER_HOME?.trim();
  if (fromEnv) {
    return fromEnv;
  }
  return path.join(homeDir ?? homedir(), ".vibexp");
}

export function approvalsFilePath(env: NodeJS.ProcessEnv = process.env, homeDir?: string): string {
  return path.join(viberHomeDir(env, homeDir), "shipped", "approved.json");
}

/* ------------------------------------------------------------------ *
 * Detection
 * ------------------------------------------------------------------ */

const RELEASE_SUBJECT_RE = /^(release|chore\(release\)|prepare .*release|v?\d+\.\d+)/i;
const MERGED_PR_SUBJECT_RE = /\(#\d+\)$/;

function isDeployPath(filePath: string): boolean {
  const lower = filePath.toLowerCase();
  const base = lower.split("/").pop() ?? "";
  return (
    base.startsWith("dockerfile") ||
    base.startsWith("captain-definition") ||
    lower.endsWith(".nomad.hcl") ||
    /(^|\/)\.github\/workflows\//.test(lower) ||
    /(^|\/)k8s\//.test(lower) ||
    /(^|\/)terraform\//.test(lower)
  );
}

function isMigrationsPath(filePath: string): boolean {
  return /(^|\/)migrations\//.test(filePath.toLowerCase());
}

function isDocsPath(filePath: string): boolean {
  const lower = filePath.toLowerCase();
  const base = lower.split("/").pop() ?? "";
  return base.startsWith("changelog") || /(^|\/)docs\//.test(lower);
}

function isNewAppSurfacePath(filePath: string): boolean {
  const lower = filePath.toLowerCase();
  return (
    /^apps\/[^/]+\//.test(lower) ||
    /^packages\/[^/]+\//.test(lower) ||
    /^src\/app\/.*\/page\.[a-z0-9]+$/.test(lower) ||
    /^src\/app\/page\.[a-z0-9]+$/.test(lower)
  );
}

interface RepoCommit {
  sha: string;
  authoredAt: string;
  subject: string;
  addedPaths: string[];
  touchedPaths: string[];
}

interface MonthBucket {
  period: string;
  commitCount: number;
  tagged: boolean;
  releaseLike: boolean;
  mergedPr: boolean;
  deploy: boolean;
  docs: boolean;
  migrations: boolean;
  newAppSurface: boolean;
  taggedSubject?: string;
  releaseSubject?: string;
  firstSubject?: string;
}

function runGit(gitPath: string, repoPath: string, args: string[]): string | null {
  try {
    return execFileSync(gitPath, ["-C", repoPath, ...args], {
      encoding: "utf8",
      maxBuffer: 20 * 1024 * 1024,
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch {
    return null;
  }
}

function collectTaggedShas(gitPath: string, repoPath: string): Set<string> {
  const shas = new Set<string>();
  const output = runGit(gitPath, repoPath, [
    "for-each-ref",
    "refs/tags",
    "--format=%(objectname) %(*objectname)",
  ]);
  if (!output) {
    return shas;
  }
  for (const line of output.split(/\r?\n/)) {
    for (const sha of line.trim().split(/\s+/)) {
      if (/^[0-9a-f]{7,64}$/.test(sha)) {
        shas.add(sha);
      }
    }
  }
  return shas;
}

function parseRepoCommits(output: string): RepoCommit[] {
  const commits: RepoCommit[] = [];
  let current: RepoCommit | null = null;
  for (const line of output.split(/\r?\n/)) {
    if (!line) {
      continue;
    }
    if (line.startsWith("__VIBER_SHIP__\t")) {
      if (current) {
        commits.push(current);
      }
      const [, sha = "", authoredAt = "", subject = ""] = line.split("\t");
      current = { sha, authoredAt, subject, addedPaths: [], touchedPaths: [] };
      continue;
    }
    if (!current) {
      continue;
    }
    const [status, filePath = ""] = line.split("\t");
    if (!filePath) {
      continue;
    }
    current.touchedPaths.push(filePath);
    if (status === "A") {
      current.addedPaths.push(filePath);
    }
  }
  if (current) {
    commits.push(current);
  }
  return commits;
}

/**
 * Deterministic, read-only shipped-candidate detection over the given repos.
 * Caps: at most 20 repos, last 500 commits each. Commits are clustered per
 * repo x calendar month; a commit contributes only when at least one shipped
 * signal fires (release-like subject, tag target, merged-PR subject,
 * deploy/config path, migrations path, changelog/docs path, or a newly added
 * app/package/route file).
 *
 * Category mapping (kept simple by design):
 *   feature  - default for release/PR/migration/new-surface signals
 *   infra    - any deploy/config path signal
 *   docs     - any changelog/docs path signal
 *   oss      - appended when the repo's origin remote is on github.com
 * Evidence mapping: release_tag when a tag points at a scanned commit in the
 * cluster, git_evidence otherwise; deploy_signal appended for deploy paths.
 * AI-window correlation is a deliberate non-requirement in this slice.
 */
export function detectShippedCandidates(options: ShippedDetectionOptions): ShippedDetection {
  const gitPath = options.gitPath ?? "git";
  const maxCommits = Math.max(1, Math.min(MAX_SHIPPED_COMMITS_PER_REPO, options.maxCommitsPerRepo ?? MAX_SHIPPED_COMMITS_PER_REPO));
  const warnings: string[] = [];
  const candidates: ShippedCandidate[] = [];
  const seenRepoKeys = new Set<string>();

  const repoPaths: string[] = [];
  for (const repo of options.repos) {
    const resolved = path.resolve(repo);
    if (!repoPaths.includes(resolved)) {
      repoPaths.push(resolved);
    }
  }
  if (repoPaths.length > MAX_SHIPPED_REPOS) {
    warnings.push("shipped_repo_cap_applied");
  }

  for (const repoPath of repoPaths.slice(0, MAX_SHIPPED_REPOS)) {
    const gitCheck = spawnSync(gitPath, ["-C", repoPath, "rev-parse", "--show-toplevel"], {
      encoding: "utf8",
      maxBuffer: 1024 * 1024,
    });
    if (gitCheck.status !== 0) {
      warnings.push("shipped_repo_not_git_skipped");
      continue;
    }
    const toplevel = gitCheck.stdout.trim() || repoPath;
    const repoLabel = path.basename(toplevel);
    const remoteOutput = runGit(gitPath, toplevel, ["remote", "get-url", "origin"]);
    const remoteKey = remoteOutput ? normalizeRemoteUrl(remoteOutput) : null;
    const repoKey = remoteKey ?? `local/${repoLabel}`;
    if (seenRepoKeys.has(repoKey)) {
      continue;
    }
    seenRepoKeys.add(repoKey);
    const isGithubRemote = (remoteKey ?? "").startsWith("github.com/");
    const taggedShas = collectTaggedShas(gitPath, toplevel);
    const logOutput = runGit(gitPath, toplevel, [
      "log",
      `--max-count=${maxCommits}`,
      "--no-renames",
      "--name-status",
      "--format=__VIBER_SHIP__%x09%H%x09%cI%x09%s",
    ]);
    if (logOutput === null) {
      warnings.push("shipped_git_log_failed");
      continue;
    }
    const buckets = new Map<string, MonthBucket>();
    for (const commit of parseRepoCommits(logOutput)) {
      const period = commit.authoredAt.slice(0, 7);
      if (!/^\d{4}-\d{2}$/.test(period)) {
        continue;
      }
      const releaseLike = RELEASE_SUBJECT_RE.test(commit.subject.trim());
      const tagged = taggedShas.has(commit.sha);
      const mergedPr = MERGED_PR_SUBJECT_RE.test(commit.subject.trim());
      const deploy = commit.touchedPaths.some(isDeployPath);
      const migrations = commit.touchedPaths.some(isMigrationsPath);
      const docs = commit.touchedPaths.some(isDocsPath);
      const newAppSurface = commit.addedPaths.some(isNewAppSurfacePath);
      if (!releaseLike && !tagged && !mergedPr && !deploy && !migrations && !docs && !newAppSurface) {
        continue;
      }
      const bucket = buckets.get(period) ?? {
        period,
        commitCount: 0,
        tagged: false,
        releaseLike: false,
        mergedPr: false,
        deploy: false,
        docs: false,
        migrations: false,
        newAppSurface: false,
      };
      bucket.commitCount += 1;
      bucket.tagged ||= tagged;
      bucket.releaseLike ||= releaseLike;
      bucket.mergedPr ||= mergedPr;
      bucket.deploy ||= deploy;
      bucket.docs ||= docs;
      bucket.migrations ||= migrations;
      bucket.newAppSurface ||= newAppSurface;
      const subject = commit.subject.trim();
      if (tagged && !bucket.taggedSubject) {
        bucket.taggedSubject = subject;
      }
      if (releaseLike && !bucket.releaseSubject) {
        bucket.releaseSubject = subject;
      }
      if (!bucket.firstSubject) {
        bucket.firstSubject = subject;
      }
      buckets.set(period, bucket);
    }
    for (const bucket of buckets.values()) {
      const categories: ShippedCategory[] = [];
      const featureSignal =
        bucket.releaseLike || bucket.tagged || bucket.mergedPr || bucket.migrations || bucket.newAppSurface;
      if (featureSignal) {
        categories.push("feature");
      }
      if (bucket.deploy) {
        categories.push("infra");
      }
      if (bucket.docs) {
        categories.push("docs");
      }
      if (categories.length === 0) {
        categories.push("feature");
      }
      if (isGithubRemote) {
        categories.push("oss");
      }
      const evidence: ShippedEvidenceStatus[] = [bucket.tagged ? "release_tag" : "git_evidence"];
      if (bucket.deploy) {
        evidence.push("deploy_signal");
      }
      const subject = bucket.taggedSubject ?? bucket.releaseSubject ?? bucket.firstSubject ?? "";
      const suggested = `${repoLabel}: ${subject}`.trim().slice(0, 120);
      candidates.push({
        source_key: `${repoKey}:${bucket.period}`,
        repo_label: repoLabel,
        period: bucket.period,
        categories,
        evidence,
        commit_count: bucket.commitCount,
        suggested_title: suggested.length >= 3 ? suggested : `${repoLabel} ${bucket.period}`.slice(0, 120),
      });
    }
  }

  candidates.sort((left, right) =>
    left.repo_label === right.repo_label
      ? left.period.localeCompare(right.period)
      : left.repo_label.localeCompare(right.repo_label),
  );
  return { candidates, warnings };
}

/* ------------------------------------------------------------------ *
 * Aggregates / summaries
 * ------------------------------------------------------------------ */

function emptySummaryCounters(): {
  by_category: Record<ShippedCategory, number>;
  by_evidence: Record<ShippedEvidenceStatus, number>;
} {
  return {
    by_category: { app: 0, platform: 0, feature: 0, infra: 0, oss: 0, internal_tool: 0, docs: 0, other: 0 },
    by_evidence: { local_evidence: 0, git_evidence: 0, public_url: 0, release_tag: 0, deploy_signal: 0 },
  };
}

/**
 * Deterministic schema-shaped summary over detected candidates. Each
 * candidate counts ONCE — under its primary (first) category and its
 * strongest (first) evidence — so total === sum(by_category) ===
 * sum(by_evidence). Numbers only: no labels, titles, keys, paths, or hashes.
 */
export function buildShippedAggregate(candidates: ShippedCandidate[]): ShippedSummary {
  const counters = emptySummaryCounters();
  for (const candidate of candidates) {
    const category = candidate.categories[0] ?? "other";
    const evidence = candidate.evidence[0] ?? "git_evidence";
    counters.by_category[category] += 1;
    counters.by_evidence[evidence] += 1;
  }
  return { total: candidates.length, by_category: counters.by_category, by_evidence: counters.by_evidence };
}

/** Recomputes the schema summary from approved items (mode approved_items). */
export function recomputeShippedSummary(items: ShippedItem[]): ShippedSummary {
  const counters = emptySummaryCounters();
  for (const item of items) {
    counters.by_category[item.category] += 1;
    counters.by_evidence[item.evidence_status] += 1;
  }
  return { total: items.length, by_category: counters.by_category, by_evidence: counters.by_evidence };
}

export function strongestEvidence(evidence: ShippedEvidenceStatus[]): ShippedEvidenceStatus {
  for (const status of ["release_tag", "deploy_signal", "public_url", "git_evidence", "local_evidence"] as const) {
    if (evidence.includes(status)) {
      return status;
    }
  }
  return "git_evidence";
}

const CONVENTIONAL_COMMIT_TYPE_RE =
  String.raw`(?:build|chore|ci|docs|feat|fix|perf|refactor|revert|style|test)`;

function stripConventionalCommitPrefix(input: string): string {
  const prefix = `${CONVENTIONAL_COMMIT_TYPE_RE}(?:\\([^)]*\\))?!?:\\s*`;
  return input
    .replace(new RegExp(`^\\s*${prefix}`, "i"), "")
    .replace(new RegExp(`:\\s*${prefix}`, "i"), ": ");
}

/**
 * Public default titles must already satisfy the server-side shipped-title
 * scanner before the user approves them. Defaults therefore remove
 * conventional-commit type/scope prefixes, parenthetical fragments, and
 * slash-shaped route/path fragments. The user can still edit the title, but the
 * review loop validates the edited value before persisting it.
 */
export function sanitizeShippedTitle(input: string, fallback: string): string {
  const candidates = [input, fallback, "Shipped AI outcome"];
  for (const candidate of candidates) {
    const cleaned = stripConventionalCommitPrefix(candidate)
      .replace(/\([^)]*\)/g, " ")
      .replace(/[\\/]+/g, " ")
      .replace(/\s*:\s*/g, " - ")
      .replace(/[`<>]/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 120)
      .trim();
    if (cleaned.length >= 3 && detectShippedTitleViolations(cleaned).length === 0) {
      return cleaned;
    }
  }
  return "Shipped AI outcome";
}

/** Default approved item for a candidate (used by review's approve-all path). */
export function defaultItemForCandidate(candidate: ShippedCandidate): ApprovedShippedItem {
  const fallback = `${candidate.repo_label} ${candidate.period}`;
  return {
    title: sanitizeShippedTitle(candidate.suggested_title, fallback),
    category: candidate.categories[0] ?? "other",
    shipped_on: candidate.period,
    ai_contribution: "unknown",
    evidence_status: strongestEvidence(candidate.evidence),
    source_key: candidate.source_key,
  };
}

/* ------------------------------------------------------------------ *
 * Approvals file
 * ------------------------------------------------------------------ */

export function readShippedApprovals(filePath: string): ShippedApprovalsFile | null {
  let raw: string;
  try {
    raw = readFileSync(filePath, "utf8");
  } catch {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") {
    return null;
  }
  const record = parsed as Record<string, unknown>;
  if (record.version !== 1 || !SHIPPED_MODES.includes(record.mode as ShippedMode)) {
    return null;
  }
  return record as unknown as ShippedApprovalsFile;
}

/** Persists the approvals file with the contract permissions (dir 0700, file 0600). */
export function writeShippedApprovals(filePath: string, approvals: ShippedApprovalsFile): void {
  const dir = path.dirname(filePath);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  writeFileSync(filePath, `${JSON.stringify(approvals, null, 2)}\n`, { mode: 0o600 });
  chmodSync(filePath, 0o600);
}

function sanitizeSummary(value: unknown): ShippedSummary {
  const counters = emptySummaryCounters();
  const summary: ShippedSummary = { total: 0, by_category: counters.by_category, by_evidence: counters.by_evidence };
  if (!value || typeof value !== "object") {
    return summary;
  }
  const record = value as Record<string, unknown>;
  if (typeof record.total === "number" && Number.isInteger(record.total) && record.total >= 0) {
    summary.total = record.total;
  }
  const byCategory = record.by_category;
  if (byCategory && typeof byCategory === "object") {
    for (const key of SHIPPED_CATEGORIES) {
      const count = (byCategory as Record<string, unknown>)[key];
      if (typeof count === "number" && Number.isInteger(count) && count >= 0) {
        counters.by_category[key] = count;
      }
    }
  }
  const byEvidence = record.by_evidence;
  if (byEvidence && typeof byEvidence === "object") {
    for (const key of SHIPPED_EVIDENCE_STATUSES) {
      const count = (byEvidence as Record<string, unknown>)[key];
      if (typeof count === "number" && Number.isInteger(count) && count >= 0) {
        counters.by_evidence[key] = count;
      }
    }
  }
  return summary;
}

const SHIPPED_ON_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

function sanitizeApprovedItem(value: unknown): ShippedItem | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const record = value as Record<string, unknown>;
  const title = typeof record.title === "string" ? record.title.trim() : "";
  if (title.length < 3 || title.length > 120 || detectShippedTitleViolations(title).length > 0) {
    return null;
  }
  if (!SHIPPED_CATEGORIES.includes(record.category as ShippedCategory)) {
    return null;
  }
  if (!SHIPPED_AI_CONTRIBUTIONS.includes(record.ai_contribution as ShippedAiContribution)) {
    return null;
  }
  if (!SHIPPED_EVIDENCE_STATUSES.includes(record.evidence_status as ShippedEvidenceStatus)) {
    return null;
  }
  // Allowlist copy: drops source_key and every other local-only key.
  const item: ShippedItem = {
    title,
    category: record.category as ShippedCategory,
    ai_contribution: record.ai_contribution as ShippedAiContribution,
    evidence_status: record.evidence_status as ShippedEvidenceStatus,
  };
  if (
    typeof record.public_url === "string" &&
    record.public_url.length > 0 &&
    record.public_url.length <= 300 &&
    detectShippedUrlViolations(record.public_url).length === 0
  ) {
    item.public_url = record.public_url;
  }
  if (typeof record.shipped_on === "string" && SHIPPED_ON_RE.test(record.shipped_on)) {
    item.shipped_on = record.shipped_on;
  }
  return item;
}

/**
 * Builds the schema-shaped shipped_with_ai profile block from a stored
 * approvals file. Returns null when there are no approvals or the user opted
 * out. Mode approved_items recomputes the summary from the sanitized items;
 * mode aggregate_only uses the stored aggregate counts. Local-only keys
 * (source_key, source_keys_reviewed, anything unrecognized) never survive.
 */
export function buildShippedWithAiBlock(approvals: ShippedApprovalsFile | null): ShippedWithAiBlock | null {
  if (!approvals || approvals.mode === "opt_out") {
    return null;
  }
  const lastDetectedAt =
    typeof approvals.updated_at === "string" && !Number.isNaN(Date.parse(approvals.updated_at))
      ? new Date(Date.parse(approvals.updated_at)).toISOString()
      : new Date().toISOString();
  if (approvals.mode === "approved_items") {
    const items = (approvals.items ?? [])
      .map(sanitizeApprovedItem)
      .filter((item): item is ShippedItem => item !== null)
      .slice(0, MAX_SHIPPED_ITEMS);
    if (items.length > 0) {
      return {
        mode: "approved_items",
        summary: recomputeShippedSummary(items),
        items,
        last_detected_at: lastDetectedAt,
      };
    }
    // Fail-closed degrade: approved_items with no valid items cannot satisfy
    // the schema's mode<->items coupling, so fall back to aggregate counts.
  }
  return {
    mode: "aggregate_only",
    summary: sanitizeSummary(approvals.aggregate),
    last_detected_at: lastDetectedAt,
  };
}
