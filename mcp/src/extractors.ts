import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { redactField } from "./redaction.js";
import {
  collectClaudeSignals,
  collectCodexSignals,
  collectCursorBubbleSignals,
  collectCursorComposerSignals,
  emptySessionSignals,
  finalizeSessionSignals,
  type SessionSignals,
} from "./signals.js";

export type AgentTool = "claude" | "codex" | "cursor";
export type EventRole = "user" | "assistant" | "tool" | "result";
export type EpisodeType =
  | "feature"
  | "bugfix"
  | "refactor"
  | "investigation"
  | "infra"
  | "review"
  | "planning"
  | "other";

export interface LocalExtractorOptions {
  projectPath?: string;
  homeDir?: string;
  maxSessions?: number;
  cursorDbPath?: string;
  cursorWorkspaceStorageDir?: string;
  sqlitePath?: string;
  gitPath?: string;
}

export interface ToolCoverage {
  tool: AgentTool;
  session_count: number;
  message_count: number;
  episode_candidate_count: number;
  dropped_reasons: Record<string, number>;
}

export interface LocalSourceDiscovery {
  project_scope: { single_project: true; repos_considered: 1 };
  selected_project_ref: string;
  tools: Record<AgentTool, ToolCoverage>;
  totals: {
    session_count: number;
    message_count: number;
    episode_candidate_count: number;
  };
  warnings: string[];
}

export interface SessionMetadataCandidate {
  session_ref: string;
  agent_type: AgentTool;
  message_count: number;
  first_prompt?: string;
  started_at?: string;
  ended_at?: string;
  is_subagent?: boolean;
  session_intent?: EpisodeType;
  active_minutes?: number;
}

export interface EpisodeCandidate {
  episode_id: string;
  title: string;
  type: EpisodeType;
  summary: string;
  session_refs: string[];
  signals: {
    user_message_count: number;
    assistant_message_count: number;
    tool_event_count: number;
    code_block_count: number;
    code_output_chars: number;
    steering_trace_count: number;
    decision_hint_count: number;
    parallelism_hint_count: number;
    active_minutes: number;
  };
}

export type DecisionTopic =
  | "scalability"
  | "security"
  | "data_modeling"
  | "distributed_systems"
  | "performance"
  | "ux"
  | "tooling";

export interface DecisionCandidate {
  decision_id: string;
  type: "architecture" | "tradeoff" | "course_correction" | "scope" | "tooling" | "other";
  proposal: string;
  response: string;
  confidence: number;
  significance: "low" | "medium" | "high";
  reversibility: "reversible" | "costly" | "irreversible";
  outcome: "accepted" | "rejected" | "modified" | "deferred" | "unknown";
  episode_id: string;
  /** Who raised the direction/concern first (rubric 1.1 initiative attribution). */
  initiative: { raised_by: "human" | "agent" | "unknown" };
  /** Deterministic outcome linkage from in-session commit/test telemetry. */
  outcome_evidence?: {
    commit_within_2h?: boolean;
    test_signal_after?: "pass" | "fail" | "none";
  };
  /** Fixed-taxonomy topic tags (<=3) proposed by lexicon; the skill confirms or strips. */
  topics?: DecisionTopic[];
}

export interface SessionBehaviorSignals {
  session_ref: string;
  tool: AgentTool;
  is_subagent: boolean;
  signals: SessionSignals;
}

export interface EpisodeCandidateBundle {
  project_scope: { single_project: true; repos_considered: 1 };
  selected_project_ref: string;
  coverage: LocalSourceDiscovery;
  episode_candidates: EpisodeCandidate[];
  session_metadata: SessionMetadataCandidate[];
  /**
   * Per-session structured signals (counts/enums/durations/salted refs only).
   * LOCAL analysis input for the skill and Wave 2 aggregates — this block has
   * no counterpart in the submission schema and must never be copied into the
   * profile payload.
   */
  behavior_signals: SessionBehaviorSignals[];
  decisions: DecisionCandidate[];
  code_quality: {
    tests_written_signal: number;
    reviews_ai_output_signal: number;
    refactor_signal: number;
    blind_accept_signal: number;
    notes: string;
  };
  analysis_manifest: {
    session_count: number;
    episode_count: number;
    total_tokens_estimate: number;
    analyzed_token_estimate: number;
    time_window?: {
      first_activity_at?: string;
      last_activity_at?: string;
      active_days?: number;
    };
    project_scope: { single_project: true; repos_considered: 1 };
  };
  warnings: string[];
}

export interface GitAggregateMetrics {
  project_scope: { single_project: true; repos_considered: 1 };
  git_metrics?: {
    commit_count: number;
    lines_added: number;
    lines_deleted: number;
    vibe_loc_by_period: {
      today: number;
      this_week: number;
      this_month: number;
      this_year: number;
    };
    files_changed_count: number;
    active_days: number;
    commits_per_active_day: number;
    extension_histogram: Record<string, number>;
    velocity?: {
      median_commit_gap_minutes?: number;
      busiest_hour_utc?: number;
      weekend_share?: number;
    };
  };
  recent_commits: Array<{ subject: string; authored_at: string }>;
  warnings: string[];
}

export type ActualMetricsScope = "all_project_sessions_uncapped";
export type TokenSourceStatus = "provider_reported" | "estimated" | "unavailable";

export interface TokenSourceSummary {
  status: TokenSourceStatus;
  total_tokens?: number;
  warnings?: string[];
}

export type MetricsPeriodKey = "today" | "this_week" | "this_month" | "this_year";

export type MetricsPeriodBreakdown = Record<MetricsPeriodKey, number>;

export interface ActualMetricsToolCoverage {
  tool: AgentTool;
  session_count: number;
  timestamped_event_count: number;
  active_hours: number;
  active_days: number;
  first_activity_at?: string;
  last_activity_at?: string;
  token_source: TokenSourceStatus;
  total_tokens?: number;
  warnings: string[];
}

export interface ActualVibeMetrics {
  metrics_scope: ActualMetricsScope;
  total_vibe_agent_hours: number;
  total_active_calendar_hours: number;
  total_tokens: number;
  token_sources: Record<AgentTool, TokenSourceSummary>;
  vibe_agent_hours_by_period: MetricsPeriodBreakdown;
  active_calendar_hours_by_period: MetricsPeriodBreakdown;
  provider_tokens_by_period: MetricsPeriodBreakdown;
  total_vibe_loc?: number;
  vibe_loc_by_period?: MetricsPeriodBreakdown;
  metrics_coverage: {
    tools: Record<AgentTool, ActualMetricsToolCoverage>;
    totals: {
      session_count: number;
      timestamped_event_count: number;
      active_days: number;
      first_activity_at?: string;
      last_activity_at?: string;
    };
  };
  warnings: string[];
}

export interface ActualMetricsBundle {
  project_scope: { single_project: true; repos_considered: 1 };
  selected_project_ref: string;
  vibe_metrics: ActualVibeMetrics;
  warnings: string[];
}

export interface NormalizedEvent {
  tool: AgentTool;
  role: EventRole;
  text: string;
  timestamp?: string;
  sessionKey: string;
  sessionRef: string;
  isSubagent: boolean;
  /**
   * True only for messages a human actually typed. Tool results, sidechain
   * (subagent) chatter, SDK-originated prompts, command wrappers, interrupt
   * markers, and model-conversation mirrors of user text are all `false`.
   */
  humanPrompt: boolean;
  codeBlockCount: number;
  codeOutputChars: number;
}

export interface NormalizedSession {
  tool: AgentTool;
  sessionKey: string;
  sessionRef: string;
  events: NormalizedEvent[];
  droppedReasons: Record<string, number>;
  scopeMatched?: boolean;
  /** Opaque parent session key when this transcript is a subagent sidechain file. */
  subagentOf?: string;
  /** First observed working directory for the session, used only for local scope checks. */
  cwd?: string;
  /** Normalized git remote advertised by the session itself (Codex session_meta). Local-only. */
  remoteKey?: string;
  /** Structured behavioral signals collected in the same parse pass. */
  signals?: SessionSignals;
}

interface CollectorResult {
  sessions: NormalizedSession[];
  droppedReasons: Record<string, number>;
  warnings: string[];
}

const DEFAULT_MAX_SESSIONS = 1000;
const MAX_EVENTS_PER_SESSION = 2000;
const MAX_TEXT_CHARS = 5000;
const EPISODE_IDLE_GAP_MS = 90 * 60 * 1000;
const ACTIVE_GAP_CAP_MINUTES = 30;

interface ActualSessionMetric {
  tool: AgentTool;
  timestampMs: number[];
  tokenUsage?: TokenUsage;
  tokenEvents?: TokenUsageEvent[];
}

interface ActualCollectorResult {
  tool: AgentTool;
  sessions: ActualSessionMetric[];
  /**
   * Subagent sidechain transcripts. Their provider tokens are real spend and
   * count toward token totals, but they run concurrently with their parent
   * session, so they are excluded from session counts and agent-hour sums.
   */
  subagentSessions?: ActualSessionMetric[];
  warnings: string[];
  tokenSource: TokenSourceStatus;
}

export interface TokenUsage {
  input: number;
  cachedInput: number;
  cacheCreationInput: number;
  cacheReadInput: number;
  output: number;
  reasoningOutput: number;
  total: number;
}

interface TokenUsageEvent {
  timestampMs: number;
  usage: TokenUsage;
}

export function discoverLocalSources(options: LocalExtractorOptions = {}): LocalSourceDiscovery {
  const context = createExtractorContext(options);
  const collected = collectAllSessions(context);
  const tools = makeCoverage(collected);
  const totals = Object.values(tools).reduce(
    (acc, tool) => {
      acc.session_count += tool.session_count;
      acc.message_count += tool.message_count;
      acc.episode_candidate_count += tool.episode_candidate_count;
      return acc;
    },
    { session_count: 0, message_count: 0, episode_candidate_count: 0 },
  );
  return {
    project_scope: PROJECT_SCOPE,
    selected_project_ref: context.selectedProjectRef,
    tools,
    totals,
    warnings: collected.flatMap((entry) => entry.warnings),
  };
}

export function buildActualMetrics(options: LocalExtractorOptions = {}): ActualMetricsBundle {
  const context = createExtractorContext(options);
  const collectors = [
    collectActualClaudeMetrics(context),
    collectActualCodexMetrics(context),
    collectActualCursorMetrics(context),
  ];
  const gitMetrics = gitAggregateMetrics(options);
  const warnings = [...collectors.flatMap((collector) => collector.warnings), ...gitMetrics.warnings];
  const allSessions = collectors.flatMap((collector) => collector.sessions);
  const allTimestamps = allSessions.flatMap((session) => session.timestampMs);
  const coverageTools = Object.fromEntries(
    collectors.map((collector) => {
      const toolTimestamps = collector.sessions.flatMap((session) => session.timestampMs);
      const usage = sumTokenUsage(
        [...collector.sessions, ...(collector.subagentSessions ?? [])].flatMap((session) =>
          session.tokenUsage ? [session.tokenUsage] : [],
        ),
      );
      const tokenSource =
        collector.tokenSource === "provider_reported" && usage.total > 0 ? "provider_reported" : collector.tokenSource;
      return [
        collector.tool,
        {
          tool: collector.tool,
          session_count: collector.sessions.length,
          timestamped_event_count: toolTimestamps.length,
          active_hours: roundHours(collector.sessions.reduce((sum, session) => sum + activeMinutes(session.timestampMs), 0)),
          active_days: activeDayCount(toolTimestamps),
          ...activityWindowFields(toolTimestamps),
          token_source: tokenSource,
          ...(usage.total > 0 ? { total_tokens: usage.total } : {}),
          warnings: collector.warnings,
        } satisfies ActualMetricsToolCoverage,
      ];
    }),
  ) as Record<AgentTool, ActualMetricsToolCoverage>;

  const tokenSources = Object.fromEntries(
    (Object.keys(coverageTools) as AgentTool[]).map((tool) => {
      const coverage = coverageTools[tool];
      return [
        tool,
        {
          status: coverage.token_source,
          ...(coverage.total_tokens ? { total_tokens: coverage.total_tokens } : {}),
          ...(coverage.warnings.length > 0 ? { warnings: coverage.warnings } : {}),
        } satisfies TokenSourceSummary,
      ];
    }),
  ) as Record<AgentTool, TokenSourceSummary>;

  const totalTokens = Object.values(coverageTools).reduce((sum, tool) => sum + (tool.total_tokens ?? 0), 0);
  const totalAgentMinutes = allSessions.reduce((sum, session) => sum + activeMinutes(session.timestampMs), 0);
  const agentIntervals = allSessions.flatMap((session) => activeIntervals(session.timestampMs));
  const mergedCalendarIntervals = mergeIntervals(allSessions.flatMap((session) => activeIntervals(session.timestampMs)));
  const totalCalendarMinutes = mergedCalendarIntervals.reduce((sum, interval) => sum + (interval.endMs - interval.startMs) / 60000, 0);
  const allSubagentSessions = collectors.flatMap((collector) => collector.subagentSessions ?? []);
  const tokenEvents = [...allSessions, ...allSubagentSessions].flatMap((session) => session.tokenEvents ?? []);
  const metricsCoverageTotals = {
    session_count: allSessions.length,
    timestamped_event_count: allTimestamps.length,
    active_days: activeDayCount(allTimestamps),
    ...activityWindowFields(allTimestamps),
  };

  const vibeMetrics: ActualVibeMetrics = {
    metrics_scope: "all_project_sessions_uncapped",
    total_vibe_agent_hours: roundHours(totalAgentMinutes),
    total_active_calendar_hours: roundHours(totalCalendarMinutes),
    total_tokens: totalTokens,
    token_sources: tokenSources,
    vibe_agent_hours_by_period: hoursByPeriod(agentIntervals),
    active_calendar_hours_by_period: hoursByPeriod(mergedCalendarIntervals),
    provider_tokens_by_period: tokensByPeriod(tokenEvents),
    ...(gitMetrics.git_metrics
      ? {
          total_vibe_loc: gitMetrics.git_metrics.lines_added,
          vibe_loc_by_period: gitMetrics.git_metrics.vibe_loc_by_period,
        }
      : {}),
    metrics_coverage: {
      tools: coverageTools,
      totals: metricsCoverageTotals,
    },
    warnings,
  };

  return {
    project_scope: PROJECT_SCOPE,
    selected_project_ref: context.selectedProjectRef,
    vibe_metrics: vibeMetrics,
    warnings,
  };
}

export function buildEpisodeCandidates(options: LocalExtractorOptions = {}): EpisodeCandidateBundle {
  const context = createExtractorContext(options);
  const collected = collectAllSessions(context);
  const allSessions = collected.flatMap((entry) => entry.sessions);
  const episodeCandidates: EpisodeCandidate[] = [];
  const sessionMetadata: SessionMetadataCandidate[] = [];
  const decisions: DecisionCandidate[] = [];

  for (const session of allSessions) {
    const sortedEvents = sortEvents(session.events);
    if (sortedEvents.length === 0) {
      continue;
    }
    const sessionEpisodes = splitSessionIntoEpisodes(sortedEvents);
    const sessionIntent = classifyEpisodeType(sortedEvents.map((event) => event.text).join("\n"));
    sessionMetadata.push(buildSessionMetadata(session, sortedEvents, sessionIntent));
    sessionEpisodes.forEach((events, index) => {
      const candidate = buildEpisodeCandidate(context, session, events, index);
      episodeCandidates.push(candidate);
      decisions.push(...extractDecisionCandidates(context, candidate, events, session.signals));
    });
  }

  const mainSessions = allSessions.filter((session) => !session.subagentOf);
  const coverage = {
    project_scope: PROJECT_SCOPE,
    selected_project_ref: context.selectedProjectRef,
    tools: makeCoverage(collected),
    totals: {
      session_count: mainSessions.length,
      message_count: mainSessions.reduce((sum, session) => sum + session.events.length, 0),
      episode_candidate_count: episodeCandidates.length,
    },
    warnings: collected.flatMap((entry) => entry.warnings),
  };

  const timestamps = allSessions.flatMap((session) =>
    session.events.map((event) => parseTimestampMs(event.timestamp)).filter((value): value is number => value !== null),
  );

  const behaviorSignals: SessionBehaviorSignals[] = allSessions.flatMap((session) =>
    session.signals
      ? [
          {
            session_ref: session.sessionRef,
            tool: session.tool,
            is_subagent: Boolean(session.subagentOf),
            signals: session.signals,
          },
        ]
      : [],
  );

  return {
    project_scope: PROJECT_SCOPE,
    selected_project_ref: context.selectedProjectRef,
    coverage,
    episode_candidates: episodeCandidates,
    session_metadata: sessionMetadata,
    behavior_signals: behaviorSignals,
    decisions: decisions.slice(0, 100),
    code_quality: buildCodeQualitySignals(episodeCandidates, allSessions.flatMap((session) => session.events)),
    analysis_manifest: {
      session_count: mainSessions.length,
      episode_count: episodeCandidates.length,
      total_tokens_estimate: estimateTokens(allSessions.flatMap((session) => session.events)),
      analyzed_token_estimate: estimateTokens(allSessions.flatMap((session) => session.events)),
      time_window: buildTimeWindow(timestamps),
      project_scope: PROJECT_SCOPE,
    },
    warnings: coverage.warnings,
  };
}

/**
 * Normalized session access for the aggregates module (Wave 2). Same
 * collectors and scope rules as buildEpisodeCandidates; LOCAL-only data.
 */
export interface CollectedNormalizedSessions {
  sessions: NormalizedSession[];
  warnings: string[];
}

export function collectNormalizedSessions(options: LocalExtractorOptions = {}): CollectedNormalizedSessions {
  const context = createExtractorContext(options);
  const collected = collectAllSessions(context);
  return {
    sessions: collected.flatMap((entry) => entry.sessions),
    warnings: collected.flatMap((entry) => entry.warnings),
  };
}

/** Uncapped per-session timing/token data (metrics path) for the aggregates module. */
export interface ActualSessionData {
  tool: AgentTool;
  timestampMs: number[];
  tokenUsage?: TokenUsage;
  tokenEvents?: Array<{ timestampMs: number; total: number }>;
  isSubagent: boolean;
}

export function collectActualSessionData(options: LocalExtractorOptions = {}): {
  sessions: ActualSessionData[];
  warnings: string[];
} {
  const context = createExtractorContext(options);
  const collectors = [
    collectActualClaudeMetrics(context),
    collectActualCodexMetrics(context),
    collectActualCursorMetrics(context),
  ];
  const sessions: ActualSessionData[] = [];
  const toEvents = (session: ActualSessionMetric) =>
    (session.tokenEvents ?? []).map((event) => ({ timestampMs: event.timestampMs, total: event.usage.total }));
  for (const collector of collectors) {
    for (const session of collector.sessions) {
      sessions.push({
        tool: collector.tool,
        timestampMs: session.timestampMs,
        ...(session.tokenUsage ? { tokenUsage: session.tokenUsage } : {}),
        tokenEvents: toEvents(session),
        isSubagent: false,
      });
    }
    for (const session of collector.subagentSessions ?? []) {
      sessions.push({
        tool: collector.tool,
        timestampMs: session.timestampMs,
        ...(session.tokenUsage ? { tokenUsage: session.tokenUsage } : {}),
        tokenEvents: toEvents(session),
        isSubagent: true,
      });
    }
  }
  return { sessions, warnings: collectors.flatMap((collector) => collector.warnings) };
}

/**
 * Versioned denylist of generated/vendored artifacts excluded from the
 * "lines you wrote" stat family (peak week, fuel efficiency, churn, blast
 * radius). Classification happens in-process; paths never leave.
 * The headline vibe-LOC totals in gitAggregateMetrics intentionally keep the
 * raw numstat semantics for continuity with published profiles.
 */
export const GENERATED_PATH_DENYLIST_VERSION = "1.0.0";

const GENERATED_LOCK_BASENAMES = new Set([
  "pnpm-lock.yaml",
  "package-lock.json",
  "yarn.lock",
  "poetry.lock",
  "cargo.lock",
  "gemfile.lock",
  "composer.lock",
  "uv.lock",
  "go.sum",
  "bun.lockb",
]);

const GENERATED_DIR_RE = /(^|\/)(node_modules|vendor|dist|build|out|\.next|target|__generated__|generated|coverage)\//;
const GENERATED_SUFFIX_RE = /\.(min\.js|min\.css|map|snap)$/;

export function isGeneratedArtifactPath(filePath: string): boolean {
  const lower = filePath.toLowerCase();
  const base = lower.split("/").pop() ?? "";
  return GENERATED_LOCK_BASENAMES.has(base) || GENERATED_SUFFIX_RE.test(base) || GENERATED_DIR_RE.test(lower);
}

/**
 * Author-filtered commit stats for the aggregates module. Subjects are NEVER
 * returned — fix-likeness is computed in place so no commit text leaves this
 * function — and generated/vendored files are excluded per the denylist above.
 */
/**
 * A single commit adding more than this many (post-denylist) lines is a bulk
 * import/vendor event — a reference tree, a generated archive, a repo merge —
 * not authored work. Such commits stay in commit counts and time histograms
 * but are excluded from every "lines you wrote" aggregate.
 */
export const BULK_IMPORT_LINES_THRESHOLD = 50_000;

export interface GitCommitStat {
  authoredAt: string;
  added: number;
  deleted: number;
  files: number;
  isFixLike: boolean;
  isBulkImport: boolean;
}

export function collectGitCommitStats(options: LocalExtractorOptions = {}): {
  commits: GitCommitStat[];
  mergeCommitCount30d: number;
  addedFileCount: number;
  modifiedFileCount: number;
  /**
   * Share of non-fix commits followed within 48h by a fix-like commit
   * TOUCHING AT LEAST ONE OF THE SAME FILES. Computed here because the
   * per-commit file sets (path digests, in-memory only) never leave this
   * function.
   */
  reworkRate48h?: number;
  warnings: string[];
} {
  const context = createExtractorContext(options);
  const gitPath = options.gitPath ?? "git";
  const repoPath = context.selectedProjectPath;
  const warnings: string[] = [];
  const empty = { commits: [], mergeCommitCount30d: 0, addedFileCount: 0, modifiedFileCount: 0, warnings };
  const gitCheck = spawnSync(gitPath, ["-C", repoPath, "rev-parse", "--show-toplevel"], {
    encoding: "utf8",
    maxBuffer: 1024 * 1024,
  });
  if (gitCheck.status !== 0) {
    warnings.push("selected_project_not_git_repo");
    return empty;
  }
  const authorEmails = detectAuthorEmails(gitPath, repoPath);
  if (authorEmails.length === 0) {
    warnings.push("git_author_filter_unavailable");
  }
  const authorArgs = authorEmails.map((email) => `--author=${escapeRegExp(email)}`);
  const commits: GitCommitStat[] = [];
  // Per-commit file digests, used ONLY for the same-file rework join below;
  // discarded before return.
  const commitPathDigests: Array<Set<string>> = [];
  try {
    const output = execFileSync(
      gitPath,
      ["-C", repoPath, "log", ...authorArgs, "--numstat", "--format=__VIBER_COMMIT__%x09%cI%x09%s", "--no-renames"],
      { encoding: "utf8", maxBuffer: 20 * 1024 * 1024 },
    );
    let current: GitCommitStat | null = null;
    let currentPaths: Set<string> | null = null;
    const flush = () => {
      if (current) {
        current.isBulkImport = current.added > BULK_IMPORT_LINES_THRESHOLD;
        commits.push(current);
        commitPathDigests.push(currentPaths ?? new Set());
      }
    };
    for (const line of output.split(/\r?\n/)) {
      if (!line) {
        continue;
      }
      if (line.startsWith("__VIBER_COMMIT__\t")) {
        flush();
        const [, authoredAt = "", subject = ""] = line.split("\t");
        current = {
          authoredAt,
          added: 0,
          deleted: 0,
          files: 0,
          isFixLike: /\b(fix|hotfix|bugfix|revert|patch|regression)\b/i.test(subject),
          isBulkImport: false,
        };
        currentPaths = new Set();
        continue;
      }
      if (!current) {
        continue;
      }
      const [addedRaw, deletedRaw, fileRaw = ""] = line.split("\t");
      if (fileRaw && isGeneratedArtifactPath(fileRaw)) {
        continue;
      }
      current.added += parseNumstatValue(addedRaw);
      current.deleted += parseNumstatValue(deletedRaw);
      current.files += 1;
      if (fileRaw) {
        currentPaths?.add(sha256Hex(fileRaw).slice(0, 16));
      }
    }
    flush();
  } catch {
    warnings.push("git_log_failed");
    return empty;
  }

  // Rework: a non-fix commit followed within 48h by a fix-like commit that
  // touches >=1 of the same files. The file overlap requirement is what keeps
  // busy multi-feature repos from over-firing on unrelated fixes.
  let reworkRate48h: number | undefined;
  {
    const ordered = commits
      .map((commit, index) => ({ commit, paths: commitPathDigests[index], ms: parseTimestampMs(commit.authoredAt) }))
      .filter((entry): entry is { commit: GitCommitStat; paths: Set<string>; ms: number } => entry.ms !== null)
      .sort((left, right) => left.ms - right.ms);
    let reworked = 0;
    let nonFix = 0;
    for (let index = 0; index < ordered.length; index += 1) {
      if (ordered[index].commit.isFixLike) {
        continue;
      }
      nonFix += 1;
      for (let next = index + 1; next < ordered.length; next += 1) {
        if (ordered[next].ms - ordered[index].ms > 48 * 60 * 60 * 1000) {
          break;
        }
        if (!ordered[next].commit.isFixLike) {
          continue;
        }
        let overlaps = false;
        for (const digest of ordered[next].paths) {
          if (ordered[index].paths.has(digest)) {
            overlaps = true;
            break;
          }
        }
        if (overlaps) {
          reworked += 1;
          break;
        }
      }
    }
    if (nonFix > 0) {
      reworkRate48h = Math.round((reworked / nonFix) * 10_000) / 10_000;
    }
  }
  let mergeCommitCount30d = 0;
  try {
    const output = execFileSync(
      gitPath,
      ["-C", repoPath, "rev-list", "--merges", "--count", "--since=30 days ago", "HEAD"],
      { encoding: "utf8", maxBuffer: 1024 * 1024 },
    );
    mergeCommitCount30d = Number.parseInt(output.trim(), 10) || 0;
  } catch {
    warnings.push("git_merge_count_failed");
  }
  let addedFileCount = 0;
  let modifiedFileCount = 0;
  try {
    const output = execFileSync(
      gitPath,
      ["-C", repoPath, "log", ...authorArgs, "--name-status", "--format=", "--no-renames", "--max-count=2000"],
      { encoding: "utf8", maxBuffer: 20 * 1024 * 1024 },
    );
    for (const line of output.split(/\r?\n/)) {
      const filePath = line.slice(2);
      if (filePath && isGeneratedArtifactPath(filePath)) {
        continue;
      }
      if (line.startsWith("A\t")) {
        addedFileCount += 1;
      } else if (line.startsWith("M\t")) {
        modifiedFileCount += 1;
      }
    }
  } catch {
    warnings.push("git_name_status_failed");
  }
  return {
    commits,
    mergeCommitCount30d,
    addedFileCount,
    modifiedFileCount,
    ...(reworkRate48h !== undefined ? { reworkRate48h } : {}),
    warnings,
  };
}

export function gitAggregateMetrics(options: LocalExtractorOptions = {}): GitAggregateMetrics {
  const context = createExtractorContext(options);
  const gitPath = options.gitPath ?? "git";
  const repoPath = context.selectedProjectPath;
  const warnings: string[] = [];
  const gitCheck = spawnSync(gitPath, ["-C", repoPath, "rev-parse", "--show-toplevel"], {
    encoding: "utf8",
    maxBuffer: 1024 * 1024,
  });
  if (gitCheck.status !== 0) {
    return {
      project_scope: PROJECT_SCOPE,
      recent_commits: [],
      warnings: ["selected_project_not_git_repo"],
    };
  }

  const authorEmails = detectAuthorEmails(gitPath, repoPath);
  if (authorEmails.length === 0) {
    warnings.push("git_author_filter_unavailable");
  }
  // The detected emails are used ONLY as local `--author` filters; they are
  // never serialized into any output (tests assert no '@' in the result).
  const authorArgs = authorEmails.map((email) => `--author=${escapeRegExp(email)}`);

  let output = "";
  try {
    output = execFileSync(
      gitPath,
      ["-C", repoPath, "log", ...authorArgs, "--numstat", "--format=__VIBER_COMMIT__%x09%cI%x09%s", "--no-renames"],
      { encoding: "utf8", maxBuffer: 20 * 1024 * 1024 },
    );
  } catch (cause) {
    return {
      project_scope: PROJECT_SCOPE,
      recent_commits: [],
      warnings: [`git_log_failed:${cause instanceof Error ? cause.message : String(cause)}`],
    };
  }

  const commits: Array<{ authoredAt: string; subject: string; added: number; deleted: number; files: number }> = [];
  const extensionHistogram: Record<string, number> = {};
  let current: { authoredAt: string; subject: string; added: number; deleted: number; files: number } | null = null;

  for (const line of output.split(/\r?\n/)) {
    if (!line) {
      continue;
    }
    if (line.startsWith("__VIBER_COMMIT__\t")) {
      if (current) {
        commits.push(current);
      }
      const [, authoredAt = "", subject = ""] = line.split("\t");
      current = { authoredAt, subject, added: 0, deleted: 0, files: 0 };
      continue;
    }
    if (!current) {
      continue;
    }
    const [addedRaw, deletedRaw, fileRaw = ""] = line.split("\t");
    const added = parseNumstatValue(addedRaw);
    const deleted = parseNumstatValue(deletedRaw);
    current.added += added;
    current.deleted += deleted;
    current.files += 1;
    const extension = extensionFromPath(fileRaw);
    if (extension) {
      extensionHistogram[extension] = (extensionHistogram[extension] ?? 0) + 1;
    }
  }
  if (current) {
    commits.push(current);
  }

  const activeDays = new Set(commits.map((commit) => commit.authoredAt.slice(0, 10)).filter(Boolean));
  const authoredTimes = commits
    .map((commit) => parseTimestampMs(commit.authoredAt))
    .filter((value): value is number => value !== null)
    .sort((left, right) => left - right);
  const gaps = authoredTimes
    .slice(1)
    .map((value, index) => Math.max(0, (value - authoredTimes[index]) / 60000))
    .filter((gap) => Number.isFinite(gap));
  // busiest_hour_utc stays UTC because the schema 1.0.0 field name says UTC;
  // the local-hour histogram is a schema 1.1.0 field.
  const busiestHourUtc = busiestHour(authoredTimes);
  const localDays = commits
    .map((commit) => localDayOfWeek(commit.authoredAt))
    .filter((day): day is number => day !== null);
  const weekendShare = localDays.length
    ? localDays.filter((day) => day === 0 || day === 6).length / localDays.length
    : undefined;

  const recentCommits = commits.slice(0, 50).flatMap((commit) => {
    const subject = safeRedactedText(commit.subject, 200);
    if (!subject || !commit.authoredAt) {
      return [];
    }
    return [{ subject, authored_at: commit.authoredAt }];
  });
  if (recentCommits.length < Math.min(commits.length, 50)) {
    warnings.push("some_recent_commit_subjects_dropped_by_redactor");
  }

  return {
    project_scope: PROJECT_SCOPE,
    git_metrics: {
      commit_count: commits.length,
      lines_added: commits.reduce((sum, commit) => sum + commit.added, 0),
      lines_deleted: commits.reduce((sum, commit) => sum + commit.deleted, 0),
      vibe_loc_by_period: vibeLocByPeriod(commits),
      files_changed_count: commits.reduce((sum, commit) => sum + commit.files, 0),
      active_days: activeDays.size,
      commits_per_active_day: activeDays.size ? commits.length / activeDays.size : 0,
      extension_histogram: extensionHistogram,
      velocity: {
        median_commit_gap_minutes: median(gaps),
        busiest_hour_utc: busiestHourUtc,
        weekend_share: weekendShare,
      },
    },
    recent_commits: recentCommits,
    warnings,
  };
}

function collectActualClaudeMetrics(context: ExtractorContext): ActualCollectorResult {
  const root = path.join(context.homeDir, ".claude", "projects");
  const warnings: string[] = [];
  if (!existsSync(root)) {
    return { tool: "claude", sessions: [], warnings: ["claude_transcript_dir_missing"], tokenSource: "unavailable" };
  }
  const files = walkAllFiles(root, ".jsonl").filter((filePath) =>
    isLikelyClaudeProjectFile(filePath, context.selectedProjectPath),
  );
  if (files.length === 0) {
    warnings.push("claude_no_project_matching_sessions");
  }
  const sessions: ActualSessionMetric[] = [];
  const subagentSessions: ActualSessionMetric[] = [];
  for (const filePath of files) {
    let content = "";
    try {
      content = readFileSync(filePath, "utf8");
    } catch {
      warnings.push("claude_unreadable_session_skipped");
      continue;
    }
    if (!claudeContentInScope(context, content)) {
      continue;
    }
    const parsed = parseActualJsonlContent(content, (entry, currentUsage) => {
      // Only the direct assistant `message.usage` is the session's own spend;
      // any descent would also pick up usage objects embedded inside
      // toolUseResult payloads (subagent results) and double-count them.
      const nextUsage = claudeTokenUsage(directMessageUsage(entry));
      if (!nextUsage) {
        return currentUsage;
      }
      return sumTokenUsage([...(currentUsage ? [currentUsage] : []), nextUsage]);
    });
    if (parsed.timestampMs.length === 0) {
      continue;
    }
    const metric: ActualSessionMetric = { tool: "claude", ...parsed, tokenEvents: collectClaudeTokenEvents(content) };
    if (claudeSubagentParent(filePath)) {
      subagentSessions.push(metric);
    } else {
      sessions.push(metric);
    }
  }
  return {
    tool: "claude",
    sessions,
    subagentSessions,
    warnings,
    tokenSource: [...sessions, ...subagentSessions].some((session) => session.tokenUsage && session.tokenUsage.total > 0)
      ? "provider_reported"
      : "unavailable",
  };
}

/**
 * Local-only scope check for the metrics path: when both the selected project
 * and the session's cwd advertise a git remote, the remotes decide. Sessions
 * with a missing or non-git cwd fall back to the directory-name prefilter
 * that already ran.
 */
function claudeContentInScope(context: ExtractorContext, content: string): boolean {
  if (!context.projectRemoteKey) {
    return true;
  }
  const cwd = readFirstClaudeCwd(content);
  if (!cwd || !existsSync(cwd)) {
    return true;
  }
  const remote = gitRemoteKeyForDir(context.gitPath, cwd, context.remoteKeyCache);
  if (!remote) {
    return true;
  }
  return remote === context.projectRemoteKey;
}

/**
 * Field-based Codex scope: session_meta's git remote is authoritative when
 * available, then the session's cwd. Full-content substring matching is
 * deliberately NOT used — it over-matched sessions that merely mentioned the
 * selected project's path.
 */
function codexContentInScope(context: ExtractorContext, content: string): boolean {
  let cwd: string | undefined;
  let scanned = 0;
  for (const line of content.split(/\r?\n/)) {
    if (scanned >= 50 && cwd) {
      break;
    }
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }
    scanned += 1;
    if (scanned > 200) {
      break;
    }
    const parsed = parseMaybeJson(trimmed);
    if (!parsed || typeof parsed !== "object") {
      continue;
    }
    const record = parsed as Record<string, unknown>;
    const remoteKey = extractCodexRemoteKey(record);
    if (remoteKey && context.projectRemoteKey) {
      return remoteKey === context.projectRemoteKey;
    }
    if (!cwd) {
      cwd = extractSessionCwd("codex", record);
    }
  }
  if (!cwd) {
    return false;
  }
  if (context.projectRemoteKey && existsSync(cwd)) {
    const remote = gitRemoteKeyForDir(context.gitPath, cwd, context.remoteKeyCache);
    if (remote) {
      return remote === context.projectRemoteKey;
    }
  }
  return pathMatchesInText(cwd, context.selectedProjectPath);
}

function readFirstClaudeCwd(content: string): string | undefined {
  let scanned = 0;
  for (const line of content.split(/\r?\n/)) {
    if (scanned >= 50) {
      return undefined;
    }
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }
    scanned += 1;
    const parsed = parseMaybeJson(trimmed);
    if (!parsed || typeof parsed !== "object") {
      continue;
    }
    const record = parsed as Record<string, unknown>;
    if (record.type === "queue-operation") {
      continue;
    }
    if (typeof record.cwd === "string" && record.cwd.startsWith("/")) {
      return record.cwd;
    }
  }
  return undefined;
}

function collectActualCodexMetrics(context: ExtractorContext): ActualCollectorResult {
  const roots = [
    path.join(context.homeDir, ".codex", "sessions"),
    path.join(context.homeDir, ".codex", "archived_sessions"),
  ];
  const warnings: string[] = [];
  const sessions: ActualSessionMetric[] = [];
  for (const root of roots) {
    if (!existsSync(root)) {
      warnings.push(root.endsWith("archived_sessions") ? "codex_archived_transcript_dir_missing" : "codex_transcript_dir_missing");
      continue;
    }
    for (const filePath of walkAllFiles(root, ".jsonl")) {
      let content = "";
      try {
        content = readFileSync(filePath, "utf8");
      } catch {
        warnings.push("codex_unreadable_session_skipped");
        continue;
      }
      if (!codexContentInScope(context, content)) {
        continue;
      }
      const parsed = parseActualJsonlContent(content, (entry, currentUsage) => {
        const usage = getProperty(entry, ["total_token_usage"]);
        return codexTokenUsage(usage) ?? currentUsage;
      });
      if (parsed.timestampMs.length > 0) {
        sessions.push({ tool: "codex", ...parsed, tokenEvents: collectCodexTokenDeltaEvents(content) });
      }
    }
  }
  if (sessions.length === 0) {
    warnings.push("codex_no_project_matching_sessions");
  }
  return {
    tool: "codex",
    sessions,
    warnings,
    tokenSource: sessions.some((session) => session.tokenUsage && session.tokenUsage.total > 0)
      ? "provider_reported"
      : "unavailable",
  };
}

function collectActualCursorMetrics(context: ExtractorContext): ActualCollectorResult {
  const warnings: string[] = [];
  const dbPaths = cursorDbCandidates(context);
  if (dbPaths.length === 0) {
    return {
      tool: "cursor",
      sessions: [],
      warnings: ["cursor_state_db_missing", "cursor_provider_tokens_unavailable"],
      tokenSource: "unavailable",
    };
  }
  const sqliteProbe = spawnSync(context.sqlitePath, ["-version"], { encoding: "utf8" });
  if (sqliteProbe.status !== 0) {
    return {
      tool: "cursor",
      sessions: [],
      warnings: ["sqlite3_missing_for_cursor", "cursor_provider_tokens_unavailable"],
      tokenSource: "unavailable",
    };
  }

  const projectClauses = pathVariants(context.selectedProjectPath)
    .map((variant) => `instr(CAST(value AS TEXT), ${sqlLiteral(variant)}) > 0`)
    .join(" OR ");
  const seenComposers = new Set<string>();
  const sessions: ActualSessionMetric[] = [];
  for (const dbPath of dbPaths) {
    const dbUri = `${pathToFileURL(dbPath).href}?mode=ro&immutable=1`;
    const composerSql = [
      "SELECT key FROM cursorDiskKV",
      "WHERE key >= 'composerData:' AND key < 'composerData;'",
      projectClauses ? `AND (${projectClauses})` : "",
      "ORDER BY key;",
    ].join(" ");
    const composerKeys = queryCursorKeys(context.sqlitePath, dbUri, composerSql, warnings);
    for (const key of composerKeys) {
      const composerId = key.slice("composerData:".length);
      if (!composerId || seenComposers.has(composerId)) {
        continue;
      }
      seenComposers.add(composerId);
      const startKey = `bubbleId:${composerId}:`;
      const endKey = `bubbleId:${composerId};`;
      const bubbleSql = [
        "SELECT json_extract(CAST(value AS TEXT), '$.createdAt') AS created_at,",
        "json_extract(CAST(value AS TEXT), '$.tokenCount') AS token_count FROM cursorDiskKV",
        `WHERE key >= ${sqlLiteral(startKey)} AND key < ${sqlLiteral(endKey)}`,
        "ORDER BY key;",
      ].join(" ");
      const bubbles = queryCursorBubbleMetrics(context.sqlitePath, dbUri, bubbleSql, warnings);
      if (bubbles.timestampMs.length === 0) {
        continue;
      }
      const usage = sumTokenUsage(bubbles.tokenEvents.map((event) => event.usage));
      sessions.push({
        tool: "cursor",
        timestampMs: bubbles.timestampMs,
        ...(usage.total > 0 ? { tokenUsage: usage } : {}),
        ...(bubbles.tokenEvents.length > 0 ? { tokenEvents: bubbles.tokenEvents } : {}),
      });
    }
  }
  const hasTokens = sessions.some((session) => session.tokenUsage && session.tokenUsage.total > 0);
  if (!hasTokens) {
    warnings.push("cursor_provider_tokens_unavailable");
  }
  if (sessions.length === 0) {
    warnings.push("cursor_no_project_matching_sessions");
  }
  return { tool: "cursor", sessions, warnings, tokenSource: hasTokens ? "provider_reported" : "unavailable" };
}

/**
 * Candidate Cursor state DBs: per-workspace copies first so workspace-scoped
 * composer records win the cross-DB dedupe over the global store.
 */
function cursorDbCandidates(context: ExtractorContext): string[] {
  const candidates: string[] = [];
  try {
    if (existsSync(context.cursorWorkspaceStorageDir)) {
      for (const entry of readdirSync(context.cursorWorkspaceStorageDir)) {
        const dbPath = path.join(context.cursorWorkspaceStorageDir, entry, "state.vscdb");
        if (existsSync(dbPath)) {
          candidates.push(dbPath);
        }
      }
    }
  } catch {
    // Unreadable workspaceStorage is non-fatal; the global DB still covers most data.
  }
  if (existsSync(context.cursorDbPath)) {
    candidates.push(context.cursorDbPath);
  }
  return candidates;
}

function queryCursorBubbleMetrics(
  sqlitePath: string,
  dbUri: string,
  sql: string,
  warnings: string[],
): { timestampMs: number[]; tokenEvents: TokenUsageEvent[] } {
  try {
    const output = execFileSync(sqlitePath, ["-readonly", "-json", dbUri, sql], {
      encoding: "utf8",
      maxBuffer: 20 * 1024 * 1024,
    });
    const parsed = JSON.parse(output || "[]") as Array<{ created_at?: unknown; token_count?: unknown }>;
    const timestampMs: number[] = [];
    const tokenEvents: TokenUsageEvent[] = [];
    for (const row of parsed) {
      const ms = parseTimestampMs(normalizeTimestamp(row.created_at));
      if (ms !== null) {
        timestampMs.push(ms);
      }
      const total = cursorTokenTotal(row.token_count);
      if (ms !== null && total > 0) {
        tokenEvents.push({
          timestampMs: ms,
          usage: { input: 0, cachedInput: 0, cacheCreationInput: 0, cacheReadInput: 0, output: 0, reasoningOutput: 0, total },
        });
      }
    }
    return { timestampMs, tokenEvents };
  } catch {
    warnings.push("cursor_sqlite_query_failed");
    return { timestampMs: [], tokenEvents: [] };
  }
}

function cursorTokenTotal(value: unknown): number {
  const parsed = parseMaybeJson(value);
  if (typeof parsed === "number" && Number.isFinite(parsed) && parsed > 0) {
    return Math.floor(parsed);
  }
  if (!parsed || typeof parsed !== "object") {
    return 0;
  }
  const total = numericProperty(parsed, "totalTokens") || numericProperty(parsed, "total_tokens");
  if (total > 0) {
    return Math.floor(total);
  }
  const input = numericProperty(parsed, "inputTokens") || numericProperty(parsed, "input_tokens");
  const output = numericProperty(parsed, "outputTokens") || numericProperty(parsed, "output_tokens");
  return Math.floor(input + output);
}

function parseActualJsonlContent(
  content: string,
  tokenUsageForEntry: (entry: unknown, currentUsage?: TokenUsage) => TokenUsage | undefined,
): Omit<ActualSessionMetric, "tool"> {
  const timestampMs: number[] = [];
  let tokenUsage: TokenUsage | undefined;
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }
    const parsed = parseMaybeJson(trimmed);
    const timestamp = normalizeTimestamp(
      getProperty(parsed, ["timestamp", "createdAt", "created_at", "time"]) ??
        (parsed && typeof parsed === "object" && "payload" in parsed
          ? getProperty((parsed as Record<string, unknown>).payload, ["timestamp"])
          : undefined),
    );
    const timestampValue = parseTimestampMs(timestamp);
    if (timestampValue !== null) {
      timestampMs.push(timestampValue);
    }
    tokenUsage = tokenUsageForEntry(parsed, tokenUsage) ?? tokenUsage;
  }
  return { timestampMs, ...(tokenUsage ? { tokenUsage } : {}) };
}

function collectClaudeTokenEvents(content: string): TokenUsageEvent[] {
  const events: TokenUsageEvent[] = [];
  for (const line of content.split(/\r?\n/)) {
    const parsed = parseMaybeJson(line.trim());
    if (!parsed || typeof parsed !== "object") {
      continue;
    }
    const timestamp = normalizeTimestamp(
      getProperty(parsed, ["timestamp", "createdAt", "created_at", "time"]) ??
        getProperty((parsed as Record<string, unknown>).message, ["timestamp"]),
    );
    const timestampMs = parseTimestampMs(timestamp);
    const usage = claudeTokenUsage(directMessageUsage(parsed));
    if (timestampMs !== null && usage) {
      events.push({ timestampMs, usage });
    }
  }
  return events;
}

function collectCodexTokenDeltaEvents(content: string): TokenUsageEvent[] {
  const events: TokenUsageEvent[] = [];
  let previousUsage: TokenUsage | undefined;
  for (const line of content.split(/\r?\n/)) {
    const parsed = parseMaybeJson(line.trim());
    if (!parsed || typeof parsed !== "object") {
      continue;
    }
    const usage = codexTokenUsage(getProperty(parsed, ["total_token_usage"]));
    if (!usage) {
      continue;
    }
    const timestamp = normalizeTimestamp(
      getProperty(parsed, ["timestamp", "createdAt", "created_at", "time"]) ??
        getProperty((parsed as Record<string, unknown>).payload, ["timestamp"]),
    );
    const timestampMs = parseTimestampMs(timestamp);
    const delta = tokenUsageDelta(usage, previousUsage);
    previousUsage = usage.total >= (previousUsage?.total ?? 0) ? usage : previousUsage;
    if (timestampMs !== null && delta.total > 0) {
      events.push({ timestampMs, usage: delta });
    }
  }
  return events;
}

/** Direct `entry.message.usage` access — no recursive descent (see call sites). */
function directMessageUsage(entry: unknown): unknown {
  if (!entry || typeof entry !== "object") {
    return undefined;
  }
  const message = (entry as Record<string, unknown>).message;
  if (!message || typeof message !== "object") {
    return undefined;
  }
  return (message as Record<string, unknown>).usage;
}

function claudeTokenUsage(value: unknown): TokenUsage | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const input = numericProperty(value, "input_tokens");
  const cacheCreationInput = numericProperty(value, "cache_creation_input_tokens");
  const cacheReadInput = numericProperty(value, "cache_read_input_tokens");
  const output = numericProperty(value, "output_tokens");
  const total = input + cacheCreationInput + cacheReadInput + output;
  if (total <= 0) {
    return undefined;
  }
  return {
    input,
    cachedInput: 0,
    cacheCreationInput,
    cacheReadInput,
    output,
    reasoningOutput: 0,
    total,
  };
}

function codexTokenUsage(value: unknown): TokenUsage | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const input = numericProperty(value, "input_tokens");
  const cachedInput = numericProperty(value, "cached_input_tokens");
  const output = numericProperty(value, "output_tokens");
  const reasoningOutput = numericProperty(value, "reasoning_output_tokens");
  const explicitTotal = numericProperty(value, "total_tokens");
  const total = explicitTotal || input + output;
  if (total <= 0) {
    return undefined;
  }
  return {
    input,
    cachedInput,
    cacheCreationInput: 0,
    cacheReadInput: 0,
    output,
    reasoningOutput,
    total,
  };
}

function tokenUsageDelta(current: TokenUsage, previous?: TokenUsage): TokenUsage {
  if (!previous) {
    return current;
  }
  if (current.total <= previous.total) {
    return { input: 0, cachedInput: 0, cacheCreationInput: 0, cacheReadInput: 0, output: 0, reasoningOutput: 0, total: 0 };
  }
  return {
    input: Math.max(0, current.input - previous.input),
    cachedInput: Math.max(0, current.cachedInput - previous.cachedInput),
    cacheCreationInput: Math.max(0, current.cacheCreationInput - previous.cacheCreationInput),
    cacheReadInput: Math.max(0, current.cacheReadInput - previous.cacheReadInput),
    output: Math.max(0, current.output - previous.output),
    reasoningOutput: Math.max(0, current.reasoningOutput - previous.reasoningOutput),
    total: current.total - previous.total,
  };
}

function sumTokenUsage(entries: TokenUsage[]): TokenUsage {
  return entries.reduce(
    (sum, usage) => ({
      input: sum.input + usage.input,
      cachedInput: sum.cachedInput + usage.cachedInput,
      cacheCreationInput: sum.cacheCreationInput + usage.cacheCreationInput,
      cacheReadInput: sum.cacheReadInput + usage.cacheReadInput,
      output: sum.output + usage.output,
      reasoningOutput: sum.reasoningOutput + usage.reasoningOutput,
      total: sum.total + usage.total,
    }),
    { input: 0, cachedInput: 0, cacheCreationInput: 0, cacheReadInput: 0, output: 0, reasoningOutput: 0, total: 0 },
  );
}

function emptyPeriodBreakdown(): MetricsPeriodBreakdown {
  return { today: 0, this_week: 0, this_month: 0, this_year: 0 };
}

function periodStarts(now: Date): MetricsPeriodBreakdown {
  return {
    today: startOfUtcDay(now),
    this_week: startOfUtcWeek(now),
    this_month: Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1),
    this_year: Date.UTC(now.getUTCFullYear(), 0, 1),
  };
}

function hoursByPeriod(
  intervals: Array<{ startMs: number; endMs: number }>,
  now = new Date(),
): MetricsPeriodBreakdown {
  const nowMs = now.getTime();
  const starts = periodStarts(now);
  const totals = emptyPeriodBreakdown();

  for (const interval of intervals) {
    const endMs = Math.min(interval.endMs, nowMs);
    if (endMs <= interval.startMs) {
      continue;
    }
    for (const period of Object.keys(starts) as MetricsPeriodKey[]) {
      const overlapStart = Math.max(interval.startMs, starts[period]);
      if (endMs > overlapStart) {
        totals[period] += (endMs - overlapStart) / 60000;
      }
    }
  }

  return {
    today: roundHours(totals.today),
    this_week: roundHours(totals.this_week),
    this_month: roundHours(totals.this_month),
    this_year: roundHours(totals.this_year),
  };
}

function tokensByPeriod(events: TokenUsageEvent[], now = new Date()): MetricsPeriodBreakdown {
  const nowMs = now.getTime();
  const starts = periodStarts(now);
  const totals = emptyPeriodBreakdown();

  for (const event of events) {
    if (event.timestampMs > nowMs || event.usage.total <= 0) {
      continue;
    }
    for (const period of Object.keys(starts) as MetricsPeriodKey[]) {
      if (event.timestampMs >= starts[period]) {
        totals[period] += event.usage.total;
      }
    }
  }

  return totals;
}

function vibeLocByPeriod(
  commits: Array<{ authoredAt: string; added: number }>,
  now = new Date(),
): { today: number; this_week: number; this_month: number; this_year: number } {
  const nowMs = now.getTime();
  const starts = periodStarts(now);
  const totals = emptyPeriodBreakdown();

  for (const commit of commits) {
    const authoredMs = parseTimestampMs(commit.authoredAt);
    if (authoredMs === null || authoredMs > nowMs) {
      continue;
    }
    if (authoredMs >= starts.today) {
      totals.today += commit.added;
    }
    if (authoredMs >= starts.this_week) {
      totals.this_week += commit.added;
    }
    if (authoredMs >= starts.this_month) {
      totals.this_month += commit.added;
    }
    if (authoredMs >= starts.this_year) {
      totals.this_year += commit.added;
    }
  }

  return totals;
}

function startOfUtcDay(value: Date): number {
  return Date.UTC(value.getUTCFullYear(), value.getUTCMonth(), value.getUTCDate());
}

function startOfUtcWeek(value: Date): number {
  const dayStart = startOfUtcDay(value);
  const day = value.getUTCDay();
  const daysSinceMonday = day === 0 ? 6 : day - 1;
  return dayStart - daysSinceMonday * 24 * 60 * 60 * 1000;
}

const PROJECT_SCOPE = { single_project: true as const, repos_considered: 1 as const };

interface ExtractorContext {
  selectedProjectPath: string;
  selectedProjectRef: string;
  homeDir: string;
  maxSessions: number;
  cursorDbPath: string;
  cursorWorkspaceStorageDir: string;
  sqlitePath: string;
  gitPath: string;
  salt: string;
  /** Normalized git remote of the selected project; null when not a repo / no remote. Local-only. */
  projectRemoteKey: string | null;
  /** Local-only cache of directory -> normalized remote lookups for scope checks. */
  remoteKeyCache: Map<string, string | null>;
}

function createExtractorContext(options: LocalExtractorOptions): ExtractorContext {
  const selectedProjectPath = path.resolve(options.projectPath ?? process.cwd());
  const homeDir = options.homeDir ?? homedir();
  const salt = sha256Hex(`viber-local-v1\0${selectedProjectPath}\0${homeDir}`);
  const gitPath = options.gitPath ?? "git";
  const remoteKeyCache = new Map<string, string | null>();
  return {
    selectedProjectPath,
    selectedProjectRef: opaqueRef(salt, "project", selectedProjectPath),
    homeDir,
    maxSessions: clampInteger(options.maxSessions ?? DEFAULT_MAX_SESSIONS, 1, 5000),
    cursorDbPath:
      options.cursorDbPath ??
      path.join(homeDir, "Library", "Application Support", "Cursor", "User", "globalStorage", "state.vscdb"),
    cursorWorkspaceStorageDir:
      options.cursorWorkspaceStorageDir ??
      path.join(homeDir, "Library", "Application Support", "Cursor", "User", "workspaceStorage"),
    sqlitePath: options.sqlitePath ?? "sqlite3",
    gitPath,
    salt,
    projectRemoteKey: gitRemoteKeyForDir(gitPath, selectedProjectPath, remoteKeyCache),
    remoteKeyCache,
  };
}

/**
 * Normalizes a git remote URL into a comparable host/path key. Used only for
 * local session<->project attribution; never serialized into any output.
 */
function normalizeRemoteUrl(url: string): string | null {
  const trimmed = url.trim().toLowerCase();
  if (!trimmed) {
    return null;
  }
  let rest = trimmed
    .replace(/^[a-z+]+:\/\//, "")
    .replace(/^git@/, "")
    .replace(/^[^/@]*@/, "");
  rest = rest.replace(/:/, "/");
  rest = rest.replace(/\.git$/, "").replace(/\/+$/, "");
  return rest || null;
}

function gitRemoteKeyForDir(gitPath: string, dir: string, cache: Map<string, string | null>): string | null {
  const cached = cache.get(dir);
  if (cached !== undefined) {
    return cached;
  }
  let key: string | null = null;
  try {
    const output = execFileSync(gitPath, ["-C", dir, "remote", "get-url", "origin"], {
      encoding: "utf8",
      maxBuffer: 1024 * 1024,
      stdio: ["ignore", "pipe", "ignore"],
    });
    key = normalizeRemoteUrl(output);
  } catch {
    key = null;
  }
  cache.set(dir, key);
  return key;
}

/**
 * Scope authority for a parsed session: when both the project and the session
 * advertise a git remote, the remotes decide (covers worktrees and excludes
 * same-name sibling checkouts). Falls back to cwd/path heuristics otherwise.
 */
function sessionInScope(context: ExtractorContext, session: NormalizedSession): boolean {
  if (context.projectRemoteKey) {
    if (session.remoteKey) {
      return session.remoteKey === context.projectRemoteKey;
    }
    if (session.cwd && existsSync(session.cwd)) {
      const cwdRemote = gitRemoteKeyForDir(context.gitPath, session.cwd, context.remoteKeyCache);
      if (cwdRemote) {
        return cwdRemote === context.projectRemoteKey;
      }
    }
  }
  if (session.cwd && pathMatchesInText(session.cwd, context.selectedProjectPath)) {
    return true;
  }
  return session.scopeMatched === true;
}

function collectAllSessions(context: ExtractorContext): CollectorResult[] {
  return [collectClaudeSessions(context), collectCodexSessions(context), collectCursorSessions(context)];
}

function collectClaudeSessions(context: ExtractorContext): CollectorResult {
  const root = path.join(context.homeDir, ".claude", "projects");
  const warnings: string[] = [];
  const droppedReasons: Record<string, number> = {};
  if (!existsSync(root)) {
    return { sessions: [], droppedReasons: { missing_transcript_dir: 1 }, warnings: ["claude_transcript_dir_missing"] };
  }
  const files = walkFiles(root, ".jsonl", context.maxSessions * 3).filter((filePath) =>
    isLikelyClaudeProjectFile(filePath, context.selectedProjectPath),
  );
  const sessions = files
    .map((filePath) => {
      const session = parseJsonlSession(context, "claude", filePath);
      if (!session) {
        return null;
      }
      const subagentParent = claudeSubagentParent(filePath);
      if (subagentParent) {
        session.subagentOf = `claude:${subagentParent}`;
        for (const event of session.events) {
          event.isSubagent = true;
          event.humanPrompt = false;
        }
      }
      return session;
    })
    .filter((session): session is NormalizedSession => {
      if (!session || session.events.length === 0) {
        bump(droppedReasons, "empty_or_unreadable_session");
        return false;
      }
      if (!session.subagentOf && !sessionInScope(context, session)) {
        bump(droppedReasons, "outside_selected_project");
        return false;
      }
      return true;
    })
    .slice(0, context.maxSessions);
  if (files.length === 0) {
    warnings.push("claude_no_project_matching_sessions");
  }
  return { sessions, droppedReasons, warnings };
}

/**
 * Detects Claude subagent sidechain transcripts stored at
 * `<project>/<sessionId>/subagents/<agent>.jsonl` and returns the parent
 * transcript path they belong to.
 */
function claudeSubagentParent(filePath: string): string | null {
  const parentDir = path.dirname(filePath);
  if (path.basename(parentDir) !== "subagents") {
    return null;
  }
  const sessionDir = path.dirname(parentDir);
  return `${sessionDir}.jsonl`;
}

function collectCodexSessions(context: ExtractorContext): CollectorResult {
  const roots = [
    path.join(context.homeDir, ".codex", "sessions"),
    path.join(context.homeDir, ".codex", "archived_sessions"),
  ];
  const warnings: string[] = [];
  const droppedReasons: Record<string, number> = {};
  if (!roots.some((root) => existsSync(root))) {
    return { sessions: [], droppedReasons: { missing_transcript_dir: 1 }, warnings: ["codex_transcript_dir_missing"] };
  }
  const sessions: NormalizedSession[] = [];
  for (const root of roots) {
    if (!existsSync(root)) {
      continue;
    }
    const files = walkFiles(root, ".jsonl", context.maxSessions * 6);
    for (const filePath of files) {
      const session = parseJsonlSession(context, "codex", filePath);
      if (!session || session.events.length === 0) {
        bump(droppedReasons, "empty_or_unreadable_session");
        continue;
      }
      if (!sessionInScope(context, session)) {
        bump(droppedReasons, "outside_selected_project");
        continue;
      }
      sessions.push(session);
      if (sessions.length >= context.maxSessions) {
        break;
      }
    }
    if (sessions.length >= context.maxSessions) {
      break;
    }
  }
  if (sessions.length === 0) {
    warnings.push("codex_no_project_matching_sessions");
  }
  return { sessions, droppedReasons, warnings };
}

function collectCursorSessions(context: ExtractorContext): CollectorResult {
  const warnings: string[] = [];
  const droppedReasons: Record<string, number> = {};
  const dbPaths = cursorDbCandidates(context);
  if (dbPaths.length === 0) {
    return { sessions: [], droppedReasons: { missing_cursor_db: 1 }, warnings: ["cursor_state_db_missing"] };
  }
  const sqliteProbe = spawnSync(context.sqlitePath, ["-version"], { encoding: "utf8" });
  if (sqliteProbe.status !== 0) {
    return { sessions: [], droppedReasons: { sqlite3_missing: 1 }, warnings: ["sqlite3_missing_for_cursor"] };
  }

  const projectClauses = pathVariants(context.selectedProjectPath)
    .map((variant) => `instr(CAST(value AS TEXT), ${sqlLiteral(variant)}) > 0`)
    .join(" OR ");
  const sessionsByKey = new Map<string, NormalizedEvent[]>();
  const signalsByKey = new Map<string, SessionSignals>();
  const seenComposers = new Set<string>();

  for (const dbPath of dbPaths) {
    const dbUri = `${pathToFileURL(dbPath).href}?mode=ro&immutable=1`;
    const composerSql = [
      "SELECT key, substr(CAST(value AS TEXT), 1, 50000) AS value FROM cursorDiskKV",
      "WHERE key LIKE 'composerData:%'",
      projectClauses ? `AND (${projectClauses})` : "",
      "ORDER BY key LIMIT 200;",
    ].join(" ");
    const composerRows = queryCursorRows(context.sqlitePath, dbUri, composerSql, warnings);

    const projectComposerIds = new Set<string>();
    const projectBubbleIds = new Set<string>();
    for (const row of composerRows) {
      const key = String(row.key ?? "");
      if (!key.startsWith("composerData:")) {
        continue;
      }
      const composerId = key.slice("composerData:".length);
      if (!composerId || seenComposers.has(composerId)) {
        continue;
      }
      const value = parseMaybeJson(row.value);
      if (cursorComposerMatchesProject(value, context.selectedProjectPath)) {
        seenComposers.add(composerId);
        projectComposerIds.add(composerId);
        collectCursorBubbleIds(value).forEach((bubbleId) => projectBubbleIds.add(bubbleId));
        const sessionKey = `cursor:${composerId}`;
        const composerSignals = signalsByKey.get(sessionKey) ?? emptySessionSignals();
        collectCursorComposerSignals(composerSignals, value);
        signalsByKey.set(sessionKey, composerSignals);
      }
    }

    const bubbleRows: Array<{ key: string; value: unknown }> = [];
    for (const composerId of projectComposerIds) {
      const sql = [
        "SELECT key, substr(CAST(value AS TEXT), 1, 50000) AS value FROM cursorDiskKV",
        `WHERE key LIKE ${sqlLiteral(`bubbleId:${composerId}:%`)}`,
        "ORDER BY key LIMIT 2000;",
      ].join(" ");
      bubbleRows.push(...queryCursorRows(context.sqlitePath, dbUri, sql, warnings));
    }
    const bubbleIdList = Array.from(projectBubbleIds).slice(0, 5000);
    for (let index = 0; index < bubbleIdList.length; index += 250) {
      const chunk = bubbleIdList.slice(index, index + 250);
      const sql = [
        "SELECT key, substr(CAST(value AS TEXT), 1, 50000) AS value FROM cursorDiskKV",
        `WHERE key IN (${chunk.map((bubbleId) => sqlLiteral(`bubbleId:${bubbleId}`)).join(",")})`,
        "ORDER BY key;",
      ].join(" ");
      bubbleRows.push(...queryCursorRows(context.sqlitePath, dbUri, sql, warnings));
    }
    appendCursorBubbleEvents(context, bubbleRows, projectComposerIds, sessionsByKey, signalsByKey, droppedReasons, true);
  }

  if (sessionsByKey.size === 0) {
    // Fallback: no composer matched the project in any DB; look for
    // project-scoped bubble text directly (legacy stores).
    warnings.push("cursor_project_scope_inferred_from_bubble_text_or_skipped");
    for (const dbPath of dbPaths) {
      const dbUri = `${pathToFileURL(dbPath).href}?mode=ro&immutable=1`;
      const bubbleFallbackSql = [
        "SELECT key, substr(CAST(value AS TEXT), 1, 50000) AS value FROM cursorDiskKV",
        "WHERE key LIKE 'bubbleId:%'",
        projectClauses ? `AND (${projectClauses})` : "",
        "ORDER BY key LIMIT 200;",
      ].join(" ");
      const rows = queryCursorRows(context.sqlitePath, dbUri, bubbleFallbackSql, warnings);
      appendCursorBubbleEvents(context, rows, new Set(), sessionsByKey, signalsByKey, droppedReasons, false);
      if (sessionsByKey.size > 0) {
        break;
      }
    }
  }
  if (sessionsByKey.size === 0) {
    bump(droppedReasons, "no_cursor_rows");
  }

  const sessions = Array.from(sessionsByKey.entries())
    .map(([sessionKey, events]) => ({
      tool: "cursor" as const,
      sessionKey,
      sessionRef: opaqueRef(context.salt, "cursor-session", sessionKey),
      events: sortEvents(events).slice(0, MAX_EVENTS_PER_SESSION),
      droppedReasons: {},
      signals: signalsByKey.get(sessionKey) ?? emptySessionSignals(),
    }))
    .filter((session) => session.events.length > 0)
    .slice(0, context.maxSessions);
  if (sessions.length === 0) {
    warnings.push("cursor_no_project_matching_sessions");
  }
  return { sessions, droppedReasons, warnings };
}

function appendCursorBubbleEvents(
  context: ExtractorContext,
  rows: Array<{ key: string; value: unknown }>,
  projectComposerIds: Set<string>,
  sessionsByKey: Map<string, NormalizedEvent[]>,
  signalsByKey: Map<string, SessionSignals>,
  droppedReasons: Record<string, number>,
  requireComposerMatch: boolean,
): void {
  for (const row of rows) {
    const value = parseMaybeJson(row.value);
    const composerId = cursorComposerIdFromBubbleKey(row.key);
    if (requireComposerMatch && composerId && !projectComposerIds.has(composerId)) {
      bump(droppedReasons, "outside_selected_project");
      continue;
    }
    if (!requireComposerMatch && !cursorBubbleMatchesProject(value, context.selectedProjectPath)) {
      bump(droppedReasons, "unscoped_cursor_bubble");
      continue;
    }
    {
      const signalsKey = composerId ? `cursor:${composerId}` : "cursor:unscoped-project-match";
      const bubbleSignals = signalsByKey.get(signalsKey) ?? emptySessionSignals();
      collectCursorBubbleSignals(bubbleSignals, value);
      signalsByKey.set(signalsKey, bubbleSignals);
    }
    const text = cursorBubbleText(value);
    if (!text) {
      bump(droppedReasons, "empty_cursor_bubble");
      continue;
    }
    const sessionKey = composerId ? `cursor:${composerId}` : "cursor:unscoped-project-match";
    const role = cursorRole(value);
    const timestamp = normalizeTimestamp(getProperty(value, ["createdAt", "created_at", "timestamp"]));
    const codeBlocks = cursorCodeBlocks(value);
    const event: NormalizedEvent = {
      tool: "cursor",
      role,
      text,
      timestamp,
      sessionKey,
      sessionRef: opaqueRef(context.salt, "cursor-session", sessionKey),
      isSubagent: false,
      humanPrompt: role === "user",
      codeBlockCount: codeBlocks.length + countCodeBlocks(text),
      codeOutputChars: codeBlocks.reduce((sum, block) => sum + block.length, 0),
    };
    const events = sessionsByKey.get(sessionKey) ?? [];
    events.push(event);
    sessionsByKey.set(sessionKey, events);
  }
}

function parseJsonlSession(context: ExtractorContext, tool: AgentTool, filePath: string): NormalizedSession | null {
  let content: string;
  try {
    content = readFileSync(filePath, "utf8");
  } catch {
    return null;
  }
  const sessionKey = `${tool}:${filePath}`;
  const sessionRef = opaqueRef(context.salt, `${tool}-session`, filePath);
  const events: NormalizedEvent[] = [];
  const droppedReasons: Record<string, number> = {};
  const scopeMatched = pathMatchesInText(filePath, context.selectedProjectPath);
  const signals = emptySessionSignals();
  let sessionCwd: string | undefined;
  let sessionRemoteKey: string | undefined;

  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }
    const parsed = parseMaybeJson(trimmed);
    if (!parsed || typeof parsed !== "object") {
      bump(droppedReasons, "invalid_jsonl_line");
      continue;
    }
    const record = parsed as Record<string, unknown>;
    if (tool === "claude") {
      collectClaudeSignals(signals, context.salt, record);
    } else if (tool === "codex") {
      collectCodexSignals(signals, context.salt, record);
    }
    if (!sessionCwd) {
      sessionCwd = extractSessionCwd(tool, record);
    }
    if (!sessionRemoteKey && tool === "codex") {
      const remoteKey = extractCodexRemoteKey(record);
      if (remoteKey) {
        sessionRemoteKey = remoteKey;
      }
    }
    const classified = classifyLine(tool, record);
    if (classified.skip) {
      bump(droppedReasons, classified.skip);
      continue;
    }
    const textParts = extractTextParts(parsed);
    const text = clampText(textParts.join("\n\n"));
    if (!text) {
      bump(droppedReasons, "empty_event_text");
      continue;
    }
    const timestamp = normalizeTimestamp(getProperty(parsed, ["timestamp", "createdAt", "created_at", "time"]));
    events.push({
      tool,
      role: classified.role,
      text,
      timestamp,
      sessionKey,
      sessionRef,
      isSubagent: classified.isSubagent,
      humanPrompt: classified.humanPrompt && !isNonPromptMarkerText(text),
      codeBlockCount: countCodeBlocks(text),
      codeOutputChars: countCodeOutputChars(text),
    });
    if (events.length >= MAX_EVENTS_PER_SESSION) {
      bump(droppedReasons, "session_event_limit");
      break;
    }
  }
  // Older Codex rollouts have no event_msg user_message records; the model
  // conversation mirror is then the only carrier of human text. Promote it.
  if (tool === "codex" && !events.some((event) => event.humanPrompt)) {
    for (const event of events) {
      if (event.role === "user") {
        event.humanPrompt = true;
      }
    }
  }
  finalizeSessionSignals(signals);
  return {
    tool,
    sessionKey,
    sessionRef,
    events,
    droppedReasons,
    scopeMatched,
    signals,
    ...(sessionCwd ? { cwd: sessionCwd } : {}),
    ...(sessionRemoteKey ? { remoteKey: sessionRemoteKey } : {}),
  };
}

interface ClassifiedLine {
  role: EventRole;
  humanPrompt: boolean;
  isSubagent: boolean;
  skip?: string;
}

function classifyLine(tool: AgentTool, record: Record<string, unknown>): ClassifiedLine {
  if (tool === "claude") {
    return classifyClaudeLine(record);
  }
  if (tool === "codex") {
    return classifyCodexLine(record);
  }
  return { role: inferRole(record), humanPrompt: false, isSubagent: isSubagentEvent(record) };
}

function classifyClaudeLine(record: Record<string, unknown>): ClassifiedLine {
  const type = typeof record.type === "string" ? record.type : "";
  const isSidechain = record.isSidechain === true;
  if (type === "queue-operation") {
    // Queued prompt text is re-emitted as a normal user line when dequeued;
    // keeping both would double-count the human's words.
    return { role: "user", humanPrompt: false, isSubagent: isSidechain, skip: "queue_operation_skipped" };
  }
  if (type === "last-prompt" || type === "ai-title" || type === "custom-title" || type === "file-history-snapshot") {
    return { role: "assistant", humanPrompt: false, isSubagent: isSidechain, skip: "index_record_skipped" };
  }
  if (type === "assistant") {
    return { role: "assistant", humanPrompt: false, isSubagent: isSidechain };
  }
  if (type === "user") {
    if (record.toolUseResult !== undefined || claudeContentHasToolResult(record)) {
      return { role: "result", humanPrompt: false, isSubagent: isSidechain };
    }
    const humanPrompt = !isSidechain && record.promptSource !== "sdk";
    return { role: "user", humanPrompt, isSubagent: isSidechain };
  }
  return { role: inferRole(record), humanPrompt: false, isSubagent: isSidechain };
}

function classifyCodexLine(record: Record<string, unknown>): ClassifiedLine {
  const type = typeof record.type === "string" ? record.type : "";
  const payload =
    record.payload && typeof record.payload === "object" ? (record.payload as Record<string, unknown>) : undefined;
  const payloadType = payload && typeof payload.type === "string" ? payload.type : "";
  if (type === "event_msg") {
    if (payloadType === "user_message") {
      return { role: "user", humanPrompt: true, isSubagent: false };
    }
    if (payloadType === "agent_message" || payloadType === "agent_reasoning") {
      return { role: "assistant", humanPrompt: false, isSubagent: false };
    }
    return { role: "assistant", humanPrompt: false, isSubagent: false };
  }
  if (type === "response_item") {
    const payloadRole = payload && typeof payload.role === "string" ? payload.role : "";
    if (payloadType === "function_call" || payloadType === "custom_tool_call" || payloadType === "local_shell_call") {
      return { role: "tool", humanPrompt: false, isSubagent: false };
    }
    if (payloadType === "function_call_output" || payloadType === "custom_tool_call_output") {
      return { role: "result", humanPrompt: false, isSubagent: false };
    }
    if (payloadRole === "user") {
      // Mirror of the human message inside the model conversation; the
      // event_msg user_message record is the canonical copy.
      return { role: "user", humanPrompt: false, isSubagent: false };
    }
    return { role: "assistant", humanPrompt: false, isSubagent: false };
  }
  if (type === "session_meta" || type === "turn_context" || type === "compacted") {
    return { role: "assistant", humanPrompt: false, isSubagent: false, skip: "telemetry_record_skipped" };
  }
  if (!type && typeof record.role === "string") {
    // Legacy single-level rollout format: { role, content, cwd }.
    const role = inferRole(record);
    return { role, humanPrompt: role === "user", isSubagent: false };
  }
  return { role: inferRole(record), humanPrompt: false, isSubagent: false };
}

function claudeContentHasToolResult(record: Record<string, unknown>): boolean {
  const message = record.message;
  if (!message || typeof message !== "object") {
    return false;
  }
  const content = (message as Record<string, unknown>).content;
  if (!Array.isArray(content)) {
    return false;
  }
  return content.some(
    (item) => item && typeof item === "object" && (item as Record<string, unknown>).type === "tool_result",
  );
}

function isNonPromptMarkerText(text: string): boolean {
  const trimmed = text.trimStart();
  return trimmed.startsWith("[Request interrupted by user") || trimmed.startsWith("<command-name>");
}

function extractSessionCwd(tool: AgentTool, record: Record<string, unknown>): string | undefined {
  if (typeof record.cwd === "string" && record.cwd.startsWith("/")) {
    if (tool !== "claude" || record.type === "user" || record.type === "assistant") {
      return record.cwd;
    }
  }
  if (tool === "codex" && record.payload && typeof record.payload === "object") {
    const payloadCwd = (record.payload as Record<string, unknown>).cwd;
    if (typeof payloadCwd === "string" && payloadCwd.startsWith("/")) {
      return payloadCwd;
    }
  }
  return undefined;
}

function extractCodexRemoteKey(record: Record<string, unknown>): string | undefined {
  if (record.type !== "session_meta" || !record.payload || typeof record.payload !== "object") {
    return undefined;
  }
  const git = (record.payload as Record<string, unknown>).git;
  if (!git || typeof git !== "object") {
    return undefined;
  }
  const url = (git as Record<string, unknown>).repository_url;
  if (typeof url !== "string") {
    return undefined;
  }
  return normalizeRemoteUrl(url) ?? undefined;
}

function queryCursorRows(
  sqlitePath: string,
  dbUri: string,
  sql: string,
  warnings: string[],
): Array<{ key: string; value: unknown }> {
  try {
    const output = execFileSync(sqlitePath, ["-readonly", "-json", dbUri, sql], {
      encoding: "utf8",
      maxBuffer: 20 * 1024 * 1024,
    });
    const parsed = JSON.parse(output || "[]") as Array<{ key?: unknown; value?: unknown }>;
    return parsed.flatMap((row) =>
      typeof row.key === "string" ? [{ key: row.key, value: row.value }] : [],
    );
  } catch (cause) {
    warnings.push(`cursor_sqlite_query_failed:${cause instanceof Error ? cause.message : String(cause)}`);
    return [];
  }
}

function queryCursorKeys(sqlitePath: string, dbUri: string, sql: string, warnings: string[]): string[] {
  try {
    const output = execFileSync(sqlitePath, ["-readonly", "-json", dbUri, sql], {
      encoding: "utf8",
      maxBuffer: 20 * 1024 * 1024,
    });
    const parsed = JSON.parse(output || "[]") as Array<{ key?: unknown }>;
    return parsed.flatMap((row) => (typeof row.key === "string" ? [row.key] : []));
  } catch {
    warnings.push("cursor_sqlite_query_failed");
    return [];
  }
}

function cursorComposerMatchesProject(value: unknown, selectedProjectPath: string): boolean {
  const haystack = JSON.stringify(value ?? "");
  return pathMatchesInText(haystack, selectedProjectPath);
}

function cursorBubbleMatchesProject(value: unknown, selectedProjectPath: string): boolean {
  const haystack = JSON.stringify(value ?? "");
  return pathMatchesInText(haystack, selectedProjectPath);
}

function cursorComposerIdFromBubbleKey(key: string): string | null {
  const parts = key.split(":");
  if (parts.length >= 3 && parts[1]) {
    return parts[1];
  }
  return null;
}

function collectCursorBubbleIds(value: unknown, depth = 0): string[] {
  if (depth > 8 || value == null) {
    return [];
  }
  if (Array.isArray(value)) {
    return value.flatMap((entry) => collectCursorBubbleIds(entry, depth + 1));
  }
  if (typeof value !== "object") {
    return [];
  }
  const ids: string[] = [];
  for (const [key, child] of Object.entries(value)) {
    if (/bubbleId$/i.test(key) && typeof child === "string" && child.length <= 200) {
      ids.push(child);
    }
    ids.push(...collectCursorBubbleIds(child, depth + 1));
  }
  return ids;
}

function cursorRole(value: unknown): EventRole {
  const rawType = getProperty(value, ["type", "role"]);
  if (rawType === 1 || rawType === "1" || rawType === "user") {
    return "user";
  }
  if (rawType === 2 || rawType === "2" || rawType === "assistant") {
    return "assistant";
  }
  return "assistant";
}

function cursorBubbleText(value: unknown): string {
  const text = getProperty(value, ["text", "content", "message"]);
  if (typeof text === "string") {
    return clampText(text);
  }
  return clampText(extractTextParts(value).join("\n\n"));
}

function cursorCodeBlocks(value: unknown): string[] {
  const raw = getProperty(value, ["codeBlocks", "code_blocks"]);
  if (!Array.isArray(raw)) {
    return [];
  }
  return raw.flatMap((entry) => {
    if (typeof entry === "string") {
      return [entry];
    }
    const text = getProperty(entry, ["text", "content", "code"]);
    return typeof text === "string" ? [text] : [];
  });
}

function makeCoverage(collected: CollectorResult[]): Record<AgentTool, ToolCoverage> {
  const empty = (tool: AgentTool): ToolCoverage => ({
    tool,
    session_count: 0,
    message_count: 0,
    episode_candidate_count: 0,
    dropped_reasons: {},
  });
  const coverage: Record<AgentTool, ToolCoverage> = {
    claude: empty("claude"),
    codex: empty("codex"),
    cursor: empty("cursor"),
  };
  for (const result of collected) {
    for (const session of result.sessions) {
      const tool = coverage[session.tool];
      if (!session.subagentOf) {
        tool.session_count += 1;
        tool.message_count += session.events.length;
      }
      tool.episode_candidate_count += splitSessionIntoEpisodes(sortEvents(session.events)).length;
      mergeCounts(tool.dropped_reasons, session.droppedReasons);
    }
    const tool = result.sessions[0]?.tool ?? inferToolFromWarnings(result.warnings);
    if (tool) {
      mergeCounts(coverage[tool].dropped_reasons, result.droppedReasons);
    }
  }
  return coverage;
}

function inferToolFromWarnings(warnings: string[]): AgentTool | null {
  if (warnings.some((warning) => warning.startsWith("claude_"))) return "claude";
  if (warnings.some((warning) => warning.startsWith("codex_"))) return "codex";
  if (warnings.some((warning) => warning.startsWith("cursor_") || warning.startsWith("sqlite3_"))) return "cursor";
  return null;
}

function buildSessionMetadata(
  session: NormalizedSession,
  events: NormalizedEvent[],
  intent: EpisodeType,
): SessionMetadataCandidate {
  const timestamps = events.map((event) => parseTimestampMs(event.timestamp)).filter((value): value is number => value !== null);
  const firstPrompt = events.find((event) => event.humanPrompt)?.text;
  const metadata: SessionMetadataCandidate = {
    session_ref: session.sessionRef,
    agent_type: session.tool,
    message_count: events.length,
    is_subagent: events.some((event) => event.isSubagent),
    session_intent: intent,
    active_minutes: activeMinutes(timestamps),
  };
  const safeFirstPrompt = firstPrompt ? safeRedactedText(firstPrompt, 200) : "";
  if (safeFirstPrompt) {
    metadata.first_prompt = safeFirstPrompt;
  }
  if (timestamps.length > 0) {
    metadata.started_at = new Date(Math.min(...timestamps)).toISOString();
    metadata.ended_at = new Date(Math.max(...timestamps)).toISOString();
  }
  return metadata;
}

function splitSessionIntoEpisodes(events: NormalizedEvent[]): NormalizedEvent[][] {
  const sorted = sortEvents(events);
  const episodes: NormalizedEvent[][] = [];
  let current: NormalizedEvent[] = [];
  let userMessagesInCurrent = 0;
  for (const event of sorted) {
    const previous = current[current.length - 1];
    const gapMs = previous ? timestampGapMs(previous.timestamp, event.timestamp) : 0;
    const startsNewGoal =
      event.humanPrompt &&
      current.length > 0 &&
      (gapMs > EPISODE_IDLE_GAP_MS || (userMessagesInCurrent >= 4 && looksLikeNewGoal(event.text)));
    if (startsNewGoal) {
      episodes.push(current);
      current = [];
      userMessagesInCurrent = 0;
    }
    current.push(event);
    if (event.humanPrompt) {
      userMessagesInCurrent += 1;
    }
  }
  if (current.length > 0) {
    episodes.push(current);
  }
  return episodes;
}

function buildEpisodeCandidate(
  context: ExtractorContext,
  session: NormalizedSession,
  events: NormalizedEvent[],
  ordinal: number,
): EpisodeCandidate {
  const userEvents = events.filter((event) => event.humanPrompt);
  const assistantEvents = events.filter((event) => event.role === "assistant");
  const toolEvents = events.filter((event) => event.role === "tool" || event.role === "result");
  const fullText = events.map((event) => event.text).join("\n\n");
  const firstGoal = userEvents[0]?.text ?? assistantEvents[0]?.text ?? fullText;
  const type = classifyEpisodeType(fullText);
  const title = safeTitle(firstGoal, type);
  const steeringTraceCount = countMatches(fullText, /\b(instead|rather|do not|don't|avoid|only|scope|constraint|keep|stay|no need|not that|wrong|try again)\b/gi);
  const decisionHintCount = countMatches(fullText, /\b(decision|trade[- ]?off|choose|chosen|prefer|because|accepted|rejected|defer)\b/gi);
  const parallelismHintCount = countMatches(fullText, /\b(subagent|parallel|fan[- ]?out|concurrent|worker|shard)\b/gi);
  const timestamps = events.map((event) => parseTimestampMs(event.timestamp)).filter((value): value is number => value !== null);
  const codeBlockCount = events.reduce((sum, event) => sum + event.codeBlockCount, 0);
  const codeOutputChars = events.reduce((sum, event) => sum + event.codeOutputChars, 0);
  const episodeId = opaqueRef(context.salt, "episode", session.sessionKey, String(ordinal));
  const goal = safeRedactedText(firstGoal, 360) || "The builder worked through a local coding-agent episode.";
  const summary = [
    `Candidate episode for proxy scoring; paraphrase any excerpt before final submission.`,
    `User goal signal: ${goal}`,
    `Counts: ${userEvents.length} builder messages, ${assistantEvents.length} assistant messages, ${toolEvents.length} tool/result events.`,
    `Signals: steering=${steeringTraceCount}, decisions=${decisionHintCount}, parallelism=${parallelismHintCount}, code_blocks=${codeBlockCount}.`,
  ].join(" ");
  return {
    episode_id: episodeId,
    title,
    type,
    summary,
    session_refs: [session.sessionRef],
    signals: {
      user_message_count: userEvents.length,
      assistant_message_count: assistantEvents.length,
      tool_event_count: toolEvents.length,
      code_block_count: codeBlockCount,
      code_output_chars: codeOutputChars,
      steering_trace_count: steeringTraceCount,
      decision_hint_count: decisionHintCount,
      parallelism_hint_count: parallelismHintCount,
      active_minutes: activeMinutes(timestamps),
    },
  };
}

const DECISION_KEYWORDS_RE =
  /\b(decision|trade[- ]?off|choose|prefer|instead|rather|accepted|reject|defer|scope|constraint)\b/i;

const DECISION_TOPIC_PATTERNS: Array<{ topic: DecisionTopic; pattern: RegExp }> = [
  {
    topic: "scalability",
    pattern: /\b(scal(e|ing|ability)|load|throughput|backpressure|n\+1|cach(e|ing)|index(es|ing)?|shard(ing)?|rate[- ]?limit)\b/i,
  },
  {
    topic: "security",
    pattern: /\b(security|auth[nz]?|csrf|xss|injection|secret|token|permission|rbac|acl|encrypt|vulnerab)\b/i,
  },
  {
    topic: "data_modeling",
    pattern: /\b(schema|migration|data model|normali[sz]|foreign key|constraint|append[- ]only|immutab)\b/i,
  },
  {
    topic: "distributed_systems",
    pattern: /\b(distributed|queue|idempoten|eventual consistency|retry|at[- ]least[- ]once|race condition|deadlock|concurren)\b/i,
  },
  { topic: "performance", pattern: /\b(performance|perf\b|slow|optimi[sz]|profil(e|ing)|memory|cpu|latency)\b/i },
  { topic: "ux", pattern: /\b(ux|user experience|usabilit|onboarding|accessib|design system|layout|copywriting)\b/i },
  { topic: "tooling", pattern: /\b(ci\b|pipeline|tooling|linter|build system|scaffold|template|devex)\b/i },
];

function classifyDecisionTopics(text: string): DecisionTopic[] {
  const topics: DecisionTopic[] = [];
  for (const { topic, pattern } of DECISION_TOPIC_PATTERNS) {
    if (pattern.test(text)) {
      topics.push(topic);
      if (topics.length >= 3) {
        break;
      }
    }
  }
  return topics;
}

function extractDecisionCandidates(
  context: ExtractorContext,
  episode: EpisodeCandidate,
  events: NormalizedEvent[],
  signals?: SessionSignals,
): DecisionCandidate[] {
  const candidates: DecisionCandidate[] = [];
  for (let index = 1; index < events.length; index += 1) {
    const current = events[index];
    if (!current.humanPrompt) {
      continue;
    }
    // Anchor the proposal on the nearest preceding ASSISTANT message (skipping
    // tool/result plumbing) so the exchange is a real proposal->response pair;
    // fall back to the adjacent event when no assistant message is close.
    let previous = events[index - 1];
    for (let back = index - 1; back >= Math.max(0, index - 6); back -= 1) {
      if (events[back].role === "assistant") {
        previous = events[back];
        break;
      }
    }
    const pairText = `${previous.text}\n${current.text}`;
    if (!DECISION_KEYWORDS_RE.test(pairText)) {
      continue;
    }
    const proposal = safeRedactedText(previous.text, 260);
    const response = safeRedactedText(current.text, 260);
    if (!proposal || !response) {
      continue;
    }
    // Initiative: who put the decision language on the table first.
    const agentRaised = previous.role === "assistant" && DECISION_KEYWORDS_RE.test(previous.text);
    const humanRaised = DECISION_KEYWORDS_RE.test(current.text);
    const raisedBy = agentRaised ? "agent" : humanRaised ? "human" : "unknown";
    // Outcome linkage: did a commit land within 2h, and what did tests say next.
    const decisionMs = parseTimestampMs(current.timestamp);
    let outcomeEvidence: DecisionCandidate["outcome_evidence"];
    if (decisionMs !== null && signals) {
      const commitWithin2h = signals.commitEventTimesMs.some(
        (ms) => ms > decisionMs && ms - decisionMs <= 2 * 60 * 60 * 1000,
      );
      const nextTest = [...signals.testRuns].sort((left, right) => left.atMs - right.atMs).find((run) => run.atMs > decisionMs);
      outcomeEvidence = {
        commit_within_2h: commitWithin2h,
        test_signal_after: nextTest ? nextTest.outcome : "none",
      };
    }
    // Outcome-linked confidence replaces the old hardcoded 0.55: validated
    // decisions (shipped + tests passing) are more trustworthy evidence.
    let confidence = 0.5;
    if (outcomeEvidence?.commit_within_2h) {
      confidence += 0.15;
    }
    if (outcomeEvidence?.test_signal_after === "pass") {
      confidence += 0.1;
    }
    const topics = classifyDecisionTopics(pairText);
    candidates.push({
      decision_id: opaqueRef(context.salt, "decision", episode.episode_id, String(index)),
      type: classifyDecisionType(pairText),
      proposal: `A local agent or prior step proposed: ${proposal}`,
      response: `The builder responded: ${response}`,
      confidence: Math.round(confidence * 100) / 100,
      significance: "medium",
      reversibility: "reversible",
      outcome: inferDecisionOutcome(current.text),
      episode_id: episode.episode_id,
      initiative: { raised_by: raisedBy },
      ...(outcomeEvidence ? { outcome_evidence: outcomeEvidence } : {}),
      ...(topics.length > 0 ? { topics } : {}),
    });
    if (candidates.length >= 3) {
      break;
    }
  }
  return candidates;
}

function buildCodeQualitySignals(episodes: EpisodeCandidate[], events: NormalizedEvent[]) {
  const text = events.map((event) => event.text).join("\n");
  const testHits = countMatches(text, /\b(test|tests|pytest|jest|vitest|typecheck|lint|verify|build)\b/gi);
  const reviewHits = countMatches(text, /\b(review|diff|check|inspect|verify|regression|edge case)\b/gi);
  const refactorHits = countMatches(text, /\b(refactor|cleanup|simplify|rename|extract|deduplicate)\b/gi);
  const blindAcceptHits = countMatches(text, /\b(looks good|ship it|done|accept)\b/gi);
  const userCount = events.filter((event) => event.humanPrompt).length || 1;
  const notes = safeRedactedText(
    `Deterministic local signals from ${episodes.length} episode candidates: tests=${testHits}, review=${reviewHits}, refactor=${refactorHits}, quick-accept=${blindAcceptHits}.`,
    600,
  );
  return {
    tests_written_signal: clamp01(testHits / userCount),
    reviews_ai_output_signal: clamp01(reviewHits / userCount),
    refactor_signal: clamp01(refactorHits / userCount),
    blind_accept_signal: clamp01(blindAcceptHits / userCount),
    notes: notes || "Deterministic local code-quality signals were sparse.",
  };
}

function classifyEpisodeType(text: string): EpisodeType {
  if (/\b(test failed|failing|bug|fix|error|exception|traceback|regression)\b/i.test(text)) return "bugfix";
  if (/\b(refactor|cleanup|deduplicate|simplify|rename)\b/i.test(text)) return "refactor";
  if (/\b(investigate|research|find out|diagnose|why|root cause)\b/i.test(text)) return "investigation";
  if (/\b(ci|deploy|migration|infra|docker|server|env|config)\b/i.test(text)) return "infra";
  if (/\b(review|diff|pr|pull request|code review)\b/i.test(text)) return "review";
  if (/\b(plan|design|approach|proposal|spec)\b/i.test(text)) return "planning";
  if (/\b(add|build|implement|create|feature|screen|endpoint)\b/i.test(text)) return "feature";
  return "other";
}

function classifyDecisionType(text: string): DecisionCandidate["type"] {
  if (/\b(schema|api|interface|architecture|model|service|boundary)\b/i.test(text)) return "architecture";
  if (/\b(trade[- ]?off|prefer|choose|instead|rather)\b/i.test(text)) return "tradeoff";
  if (/\b(wrong|not that|course|redirect|try again|avoid)\b/i.test(text)) return "course_correction";
  if (/\b(scope|only|defer|later|out of scope)\b/i.test(text)) return "scope";
  if (/\b(tool|cli|mcp|agent|model|library|framework)\b/i.test(text)) return "tooling";
  return "other";
}

function inferDecisionOutcome(text: string): DecisionCandidate["outcome"] {
  if (/\b(reject|do not|don't|avoid|not)\b/i.test(text)) return "rejected";
  if (/\b(instead|modify|change|rather)\b/i.test(text)) return "modified";
  if (/\b(defer|later|not now)\b/i.test(text)) return "deferred";
  if (/\b(accept|yes|ok|use|go with)\b/i.test(text)) return "accepted";
  return "unknown";
}

function safeTitle(text: string, type: EpisodeType): string {
  const safe = safeRedactedText(text, 120);
  if (!safe) {
    return `${type} episode`;
  }
  return safe.replace(/[.!?]\s.*$/, "").slice(0, 120) || `${type} episode`;
}

function safeRedactedText(input: string, maxLength: number): string {
  const compact = input.replace(/\s+/g, " ").trim();
  if (!compact) {
    return "";
  }
  const redacted = redactField(compact.slice(0, Math.max(maxLength * 3, 500)));
  if (redacted.dropped || !redacted.text) {
    return "";
  }
  return redacted.text.replace(/\s+/g, " ").trim().slice(0, maxLength);
}

function extractTextParts(value: unknown, key = "", depth = 0): string[] {
  if (depth > 8 || value == null) {
    return [];
  }
  const lowerKey = key.toLowerCase();
  if (/path|cwd|file|filename|uri|url|id|uuid|hash|token|key|email|author/.test(lowerKey)) {
    return [];
  }
  if (typeof value === "string") {
    if (!isTextBearingKey(lowerKey) && key !== "") {
      return [];
    }
    return [value];
  }
  if (Array.isArray(value)) {
    return value.flatMap((entry) => extractTextParts(entry, key, depth + 1));
  }
  if (typeof value === "object") {
    return Object.entries(value).flatMap(([childKey, child]) => extractTextParts(child, childKey, depth + 1));
  }
  return [];
}

function isTextBearingKey(key: string): boolean {
  return (
    key === "" ||
    key === "text" ||
    key === "content" ||
    key === "message" ||
    key === "prompt" ||
    key === "response" ||
    key === "completion" ||
    key === "summary" ||
    key === "title" ||
    key === "stdout" ||
    key === "stderr" ||
    key === "output"
  );
}

function inferRole(value: unknown): EventRole {
  const role = String(getProperty(value, ["role", "type", "author", "speaker"]) ?? "").toLowerCase();
  if (role.includes("user") || role.includes("human")) return "user";
  if (role.includes("assistant") || role.includes("agent")) return "assistant";
  if (role.includes("tool")) return "tool";
  if (role.includes("result") || role.includes("output")) return "result";
  return "assistant";
}

function isSubagentEvent(value: unknown): boolean {
  const serialized = JSON.stringify(value ?? "");
  return /\b(subagent|worker|parallel|shard)\b/i.test(serialized);
}

function isLikelyClaudeProjectFile(filePath: string, selectedProjectPath: string): boolean {
  const parent = path.basename(path.dirname(filePath));
  const normalizedProject = selectedProjectPath.replace(/\/+$/, "");
  const encoded = normalizedProject.replace(/[/.]/g, "-").replace(/^-?/, "-");
  const compact = normalizedProject.replace(/[^A-Za-z0-9]/g, "-");
  return (
    parent.includes(path.basename(normalizedProject)) ||
    parent.includes(encoded) ||
    parent.includes(compact) ||
    filePath.includes(encoded) ||
    filePath.includes(compact)
  );
}

function pathMatchesInText(text: string, selectedProjectPath: string): boolean {
  return pathVariants(selectedProjectPath).some((variant) => text.includes(variant));
}

function pathVariants(selectedProjectPath: string): string[] {
  const normalized = selectedProjectPath.replace(/\/+$/, "");
  if (!normalized) {
    return [];
  }
  return Array.from(
    new Set([
      normalized,
      path.basename(normalized),
      normalized.replace(/[/.]/g, "-").replace(/^-?/, "-"),
      normalized.replace(/[^A-Za-z0-9]/g, "-"),
    ]),
  ).filter((variant) => variant.length >= 4);
}

function sqlLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function walkFiles(root: string, suffix: string, maxFiles: number): string[] {
  const results: Array<{ filePath: string; mtimeMs: number }> = [];
  const stack = [root];
  while (stack.length > 0 && results.length < maxFiles * 2) {
    const dir = stack.pop();
    if (!dir) {
      continue;
    }
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry);
      let stats;
      try {
        stats = statSync(full);
      } catch {
        continue;
      }
      if (stats.isDirectory()) {
        stack.push(full);
        continue;
      }
      if (stats.isFile() && full.endsWith(suffix)) {
        results.push({ filePath: full, mtimeMs: stats.mtimeMs });
      }
    }
  }
  return results
    .sort((left, right) => right.mtimeMs - left.mtimeMs)
    .slice(0, maxFiles)
    .map((entry) => entry.filePath);
}

function walkAllFiles(root: string, suffix: string): string[] {
  const results: Array<{ filePath: string; mtimeMs: number }> = [];
  const stack = [root];
  while (stack.length > 0) {
    const dir = stack.pop();
    if (!dir) {
      continue;
    }
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry);
      let stats;
      try {
        stats = statSync(full);
      } catch {
        continue;
      }
      if (stats.isDirectory()) {
        stack.push(full);
        continue;
      }
      if (stats.isFile() && full.endsWith(suffix)) {
        results.push({ filePath: full, mtimeMs: stats.mtimeMs });
      }
    }
  }
  return results.sort((left, right) => right.mtimeMs - left.mtimeMs).map((entry) => entry.filePath);
}

function parseMaybeJson(value: unknown): unknown {
  let current = value;
  for (let depth = 0; depth < 3; depth += 1) {
    if (typeof current !== "string") {
      return current;
    }
    const trimmed = current.trim();
    if (!trimmed) {
      return "";
    }
    try {
      const parsed = JSON.parse(trimmed);
      if (parsed === current) {
        return parsed;
      }
      current = parsed;
    } catch {
      return current;
    }
  }
  return current;
}

function getProperty(value: unknown, keys: string[]): unknown {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  for (const key of keys) {
    if (key in record) {
      return record[key];
    }
  }
  for (const child of Object.values(record)) {
    if (child && typeof child === "object") {
      const nested = getProperty(child, keys);
      if (nested !== undefined) {
        return nested;
      }
    }
  }
  return undefined;
}

function normalizeTimestamp(value: unknown): string | undefined {
  if (value instanceof Date) {
    return value.toISOString();
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    const millis = value > 10_000_000_000 ? value : value * 1000;
    return new Date(millis).toISOString();
  }
  if (typeof value === "string" && value.trim()) {
    const parsed = Date.parse(value);
    if (!Number.isNaN(parsed)) {
      return new Date(parsed).toISOString();
    }
  }
  return undefined;
}

export function parseTimestampMs(value: string | undefined): number | null {
  if (!value) {
    return null;
  }
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : parsed;
}

function timestampGapMs(previous: string | undefined, current: string | undefined): number {
  const previousMs = parseTimestampMs(previous);
  const currentMs = parseTimestampMs(current);
  if (previousMs === null || currentMs === null) {
    return 0;
  }
  return Math.max(0, currentMs - previousMs);
}

function sortEvents(events: NormalizedEvent[]): NormalizedEvent[] {
  return [...events].sort((left, right) => {
    const leftMs = parseTimestampMs(left.timestamp) ?? 0;
    const rightMs = parseTimestampMs(right.timestamp) ?? 0;
    return leftMs - rightMs;
  });
}

function activeMinutes(timestamps: number[]): number {
  if (timestamps.length < 2) {
    return timestamps.length === 1 ? 1 : 0;
  }
  const sorted = [...timestamps].sort((left, right) => left - right);
  let minutes = 0;
  for (let index = 1; index < sorted.length; index += 1) {
    minutes += Math.min(ACTIVE_GAP_CAP_MINUTES, Math.max(0, (sorted[index] - sorted[index - 1]) / 60000));
  }
  return Math.round(minutes * 10) / 10;
}

export function activeIntervals(timestamps: number[]): Array<{ startMs: number; endMs: number }> {
  const sorted = Array.from(new Set(timestamps.filter((value) => Number.isFinite(value)))).sort((left, right) => left - right);
  if (sorted.length === 0) {
    return [];
  }
  if (sorted.length === 1) {
    return [{ startMs: sorted[0], endMs: sorted[0] + 60_000 }];
  }
  const intervals: Array<{ startMs: number; endMs: number }> = [];
  for (let index = 1; index < sorted.length; index += 1) {
    const startMs = sorted[index - 1];
    const gapMs = Math.max(0, sorted[index] - startMs);
    intervals.push({ startMs, endMs: startMs + Math.min(ACTIVE_GAP_CAP_MINUTES * 60_000, gapMs) });
  }
  return intervals;
}

export function mergeIntervals(intervals: Array<{ startMs: number; endMs: number }>): Array<{ startMs: number; endMs: number }> {
  const sorted = [...intervals].sort((left, right) => left.startMs - right.startMs);
  const merged: Array<{ startMs: number; endMs: number }> = [];
  for (const interval of sorted) {
    const previous = merged[merged.length - 1];
    if (!previous || interval.startMs > previous.endMs) {
      merged.push({ ...interval });
      continue;
    }
    previous.endMs = Math.max(previous.endMs, interval.endMs);
  }
  return merged;
}

function activeDayCount(timestamps: number[]): number {
  return new Set(timestamps.map((timestamp) => new Date(timestamp).toISOString().slice(0, 10))).size;
}

function activityWindowFields(timestamps: number[]): { first_activity_at?: string; last_activity_at?: string } {
  if (timestamps.length === 0) {
    return {};
  }
  let first = Number.POSITIVE_INFINITY;
  let last = Number.NEGATIVE_INFINITY;
  for (const timestamp of timestamps) {
    if (timestamp < first) {
      first = timestamp;
    }
    if (timestamp > last) {
      last = timestamp;
    }
  }
  return {
    first_activity_at: new Date(first).toISOString(),
    last_activity_at: new Date(last).toISOString(),
  };
}

function roundHours(minutes: number): number {
  return Math.round((minutes / 60) * 10) / 10;
}

function buildTimeWindow(timestamps: number[]): EpisodeCandidateBundle["analysis_manifest"]["time_window"] {
  if (timestamps.length === 0) {
    return undefined;
  }
  const first = Math.min(...timestamps);
  const last = Math.max(...timestamps);
  const activeDays = new Set(timestamps.map((time) => new Date(time).toISOString().slice(0, 10))).size;
  return {
    first_activity_at: new Date(first).toISOString(),
    last_activity_at: new Date(last).toISOString(),
    active_days: activeDays,
  };
}

function estimateTokens(events: NormalizedEvent[]): number {
  const chars = events.reduce((sum, event) => sum + event.text.length, 0);
  return Math.ceil(chars / 4);
}

function looksLikeNewGoal(text: string): boolean {
  return /^\s*(ok|okay|next|now|new|another|separate|switch|let's|lets)\b/i.test(text);
}

function countCodeBlocks(text: string): number {
  return countMatches(text, /```[\s\S]*?```|~~~[\s\S]*?~~~/g);
}

function countCodeOutputChars(text: string): number {
  const matches = text.match(/```[\s\S]*?```|~~~[\s\S]*?~~~/g) ?? [];
  return matches.reduce((sum, match) => sum + match.length, 0);
}

function countMatches(text: string, re: RegExp): number {
  return text.match(re)?.length ?? 0;
}

function clampText(text: string): string {
  return text.replace(/\s+/g, " ").trim().slice(0, MAX_TEXT_CHARS);
}

function numericProperty(value: unknown, key: string): number {
  if (!value || typeof value !== "object") {
    return 0;
  }
  const raw = (value as Record<string, unknown>)[key];
  return typeof raw === "number" && Number.isFinite(raw) && raw > 0 ? raw : 0;
}

function parseNumstatValue(value: string): number {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : 0;
}

function extensionFromPath(filePath: string): string | null {
  const base = filePath.split(/[\\/]/).pop() ?? "";
  const dot = base.lastIndexOf(".");
  if (dot <= 0 || dot === base.length - 1) {
    return null;
  }
  const extension = base.slice(dot + 1).toLowerCase();
  return /^[a-z0-9]{1,12}$/.test(extension) ? extension : null;
}

function median(values: number[]): number | undefined {
  if (values.length === 0) {
    return undefined;
  }
  const sorted = [...values].sort((left, right) => left - right);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) {
    return sorted[mid];
  }
  return (sorted[mid - 1] + sorted[mid]) / 2;
}

function busiestHour(times: number[]): number | undefined {
  if (times.length === 0) {
    return undefined;
  }
  const counts = new Array<number>(24).fill(0);
  for (const time of times) {
    counts[new Date(time).getUTCHours()] += 1;
  }
  let bestHour = 0;
  let bestCount = -1;
  counts.forEach((count, hour) => {
    if (count > bestCount) {
      bestCount = count;
      bestHour = hour;
    }
  });
  return bestHour;
}

/**
 * Detects the local builder's author emails for this repo: the configured
 * user.email plus any log emails whose author name matches the configured
 * user.name. Local-only; the emails never appear in any serialized output.
 */
function detectAuthorEmails(gitPath: string, repoPath: string): string[] {
  const emails = new Set<string>();
  let configuredName = "";
  try {
    const email = execFileSync(gitPath, ["-C", repoPath, "config", "user.email"], {
      encoding: "utf8",
      maxBuffer: 1024 * 1024,
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    if (email) {
      emails.add(email.toLowerCase());
    }
  } catch {
    // No configured email; name-matching below may still find one.
  }
  try {
    configuredName = execFileSync(gitPath, ["-C", repoPath, "config", "user.name"], {
      encoding: "utf8",
      maxBuffer: 1024 * 1024,
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    configuredName = "";
  }
  if (configuredName) {
    try {
      const output = execFileSync(gitPath, ["-C", repoPath, "log", "--format=%ae%x09%an", "--max-count=5000"], {
        encoding: "utf8",
        maxBuffer: 20 * 1024 * 1024,
        stdio: ["ignore", "pipe", "ignore"],
      });
      const wantedName = configuredName.toLowerCase();
      for (const line of output.split(/\r?\n/)) {
        const [email = "", name = ""] = line.split("\t");
        if (email && name.trim().toLowerCase() === wantedName) {
          emails.add(email.trim().toLowerCase());
        }
      }
    } catch {
      // Log unavailable; fall back to whatever config provided.
    }
  }
  return Array.from(emails);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Extracts the UTC-offset minutes from an ISO-8601 string (e.g. `-07:00`),
 * so commit times can be binned in the author's local clock without ever
 * serializing the offset or a timezone name.
 */
export function parseIsoOffsetMinutes(value: string): number | null {
  const match = /(Z|[+-]\d{2}:?\d{2})\s*$/.exec(value.trim());
  if (!match) {
    return null;
  }
  if (match[1] === "Z") {
    return 0;
  }
  const sign = match[1].startsWith("-") ? -1 : 1;
  const digits = match[1].slice(1).replace(":", "");
  const hours = Number.parseInt(digits.slice(0, 2), 10);
  const minutes = Number.parseInt(digits.slice(2, 4), 10);
  if (!Number.isFinite(hours) || !Number.isFinite(minutes)) {
    return null;
  }
  return sign * (hours * 60 + minutes);
}

export function localDayOfWeek(isoTimestamp: string): number | null {
  const ms = parseTimestampMs(isoTimestamp);
  if (ms === null) {
    return null;
  }
  const offsetMinutes = parseIsoOffsetMinutes(isoTimestamp) ?? 0;
  return new Date(ms + offsetMinutes * 60_000).getUTCDay();
}

function sha256Hex(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

function opaqueRef(salt: string, ...parts: string[]): string {
  return sha256Hex(`${salt}\0${parts.join("\0")}`).slice(0, 24);
}

function clampInteger(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) {
    return min;
  }
  return Math.max(min, Math.min(max, Math.floor(value)));
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }
  return Math.max(0, Math.min(1, value));
}

function bump(counts: Record<string, number>, key: string): void {
  counts[key] = (counts[key] ?? 0) + 1;
}

function mergeCounts(target: Record<string, number>, source: Record<string, number>): void {
  for (const [key, value] of Object.entries(source)) {
    target[key] = (target[key] ?? 0) + value;
  }
}
