import { CLASSIFIER_VERSION } from "./command-classifier.js";
import {
  activeIntervals,
  collectActualSessionData,
  collectGitCommitStats,
  collectNormalizedSessions,
  localDayOfWeek,
  mergeIntervals,
  parseIsoOffsetMinutes,
  parseTimestampMs,
  type ActualSessionData,
  type AgentTool,
  type GitCommitStat,
  type LocalExtractorOptions,
  type NormalizedEvent,
  type NormalizedSession,
} from "./extractors.js";
import { normalizeModelId } from "./signals.js";

/**
 * Wave 2 wrapped-profile aggregates. Every field maps 1:1 onto an OPTIONAL
 * schema 1.1.0 block; everything is counts, ratios, enums, durations, local
 * histograms, or salted opaque refs. No text, paths, branch names, shas,
 * emails, or timezone identifiers are computed into any output here.
 *
 * Determinism note: git histograms use the exact per-commit %cI offsets;
 * transcript-event local hours use the host's CURRENT utc offset (transcript
 * timestamps are UTC with no offset) and are therefore approximate across DST
 * boundaries or travel.
 */

export interface WrappedAggregates {
  classifier_version: string;
  git_extra: {
    commit_hour_histogram_local?: number[];
    commits_by_weekday_local?: number[];
    loc_added_by_weekday_local?: number[];
    night_owl_share?: number;
    biggest_push?: { weekday_local: number; commit_count: number; lines_added: number };
    pr_metrics?: { merged_pr_count_30d: number; source: "merge_commit_heuristic" | "gh_cli" };
    last_30_days?: { commit_count: number; lines_added: number; lines_deleted: number };
  };
  vibe_extra: {
    model_usage?: Array<{
      model_family: string;
      tool: AgentTool;
      session_count: number;
      session_share_pct?: number;
    }>;
    plan_mode?: {
      plan_prompts_share?: number;
      sessions_entering_plan_share?: number;
      plan_approved_count?: number;
      plan_edited_before_approval_count?: number;
      per_tool?: Partial<Record<AgentTool, number>>;
    };
    interruption?: {
      interrupt_count: number;
      interrupts_per_100_prompts?: number;
      redirected_share?: number;
      abandoned_share?: number;
      median_rebrief_seconds?: number;
    };
    concurrency?: {
      max_parallel_agents?: number;
      max_parallel_sessions?: number;
      max_parallel_subagents_single_session?: number;
      peak_at?: string;
      by_tool?: Partial<Record<AgentTool, number>>;
    };
    prompt_stats?: {
      prompt_count: number;
      median_words?: number;
      under_10_words_share?: number;
      words_histogram?: number[];
      politeness?: {
        thanks_message_count: number;
        please_message_count: number;
        last_30_days_thanks_message_count: number;
      };
      crashout_message_count?: number;
      question_share?: number;
      opener_split?: { command?: number; question?: number; greeting?: number; other?: number };
    };
    event_hour_histogram_local?: number[];
    longest_agent_run?: { minutes: number; agent_type: AgentTool; session_ref?: string };
    last_30_days?: { vibe_agent_hours?: number; active_calendar_hours?: number; provider_tokens?: number };
  };
  work_streams: Array<{
    stream_ref: string;
    session_count: number;
    active_days?: number;
    total_active_minutes?: number;
    commit_count?: number;
    started_at?: string;
    ended_at?: string;
  }>;
  craft_stats: Record<string, unknown>;
  economics_stats: Record<string, unknown>;
  orchestration_stats: Record<string, unknown>;
  identity_stats: Record<string, unknown>;
  warnings: string[];
}

const NIGHT_OWL_HOURS = new Set([22, 23, 0, 1]);
const REBRIEF_WINDOW_MS = 180_000;
const ACTIVE_GAP_MS = 30 * 60_000;
const DAY_MS = 24 * 60 * 60 * 1000;
const THIRTY_DAYS_MS = 30 * DAY_MS;

export function buildWrappedAggregates(options: LocalExtractorOptions = {}): WrappedAggregates {
  const nowMs = Date.now();
  const normalized = collectNormalizedSessions(options);
  const actual = collectActualSessionData(options);
  const git = collectGitCommitStats(options);
  const warnings = [...new Set([...normalized.warnings, ...actual.warnings, ...git.warnings])];

  // Vibexp measurement (profile-analysis) sessions are excluded from every
  // wrapped aggregate — model usage, prompt/plan/interruption stats, work
  // streams, craft/economics/orchestration/identity blocks. They surface only
  // in vibe_metrics.profile_analysis_overhead (built in extractors.ts).
  // collectActualSessionData already drops them from the `actual` set.
  const visibleSessions = normalized.sessions.filter((session) => session.measurementSession !== true);
  const mainSessions = visibleSessions.filter((session) => !session.subagentOf);
  const subagentSessions = visibleSessions.filter((session) => session.subagentOf);
  const humanPrompts = mainSessions.flatMap((session) => session.events.filter((event) => event.humanPrompt));

  return {
    classifier_version: CLASSIFIER_VERSION,
    git_extra: buildGitExtra(git, nowMs),
    vibe_extra: {
      ...buildModelUsage(mainSessions),
      ...buildPlanMode(mainSessions),
      ...buildInterruption(mainSessions, humanPrompts.length),
      ...buildConcurrency(actual.sessions, visibleSessions),
      ...buildPromptStats(mainSessions, humanPrompts, nowMs),
      ...buildEventHourHistogram(actual.sessions),
      ...buildLongestRun(mainSessions),
      ...buildVibeLast30Days(actual.sessions, nowMs),
    },
    work_streams: buildWorkStreams(mainSessions),
    craft_stats: buildCraftStats(mainSessions, git),
    economics_stats: buildEconomicsStats(mainSessions, actual.sessions, git),
    orchestration_stats: buildOrchestrationStats(visibleSessions, actual.sessions),
    identity_stats: buildIdentityStats(actual.sessions, git, nowMs),
    warnings,
  };
}

// ---------------------------------------------------------------------------
// git
// ---------------------------------------------------------------------------

function buildGitExtra(
  git: ReturnType<typeof collectGitCommitStats>,
  nowMs: number,
): WrappedAggregates["git_extra"] {
  if (git.commits.length === 0) {
    return {};
  }
  const hourHistogram = new Array<number>(24).fill(0);
  const weekdayHistogram = new Array<number>(7).fill(0);
  const locByWeekday = new Array<number>(7).fill(0);
  const byLocalDay = new Map<string, { commit_count: number; lines_added: number; weekday: number }>();
  let nightOwl = 0;
  let last30 = { commit_count: 0, lines_added: 0, lines_deleted: 0 };
  for (const commit of git.commits) {
    const ms = parseTimestampMs(commit.authoredAt);
    if (ms === null) {
      continue;
    }
    // Bulk imports count as commits (time histograms) but never as written lines.
    const writtenAdded = commit.isBulkImport ? 0 : commit.added;
    const writtenDeleted = commit.isBulkImport ? 0 : commit.deleted;
    const offset = parseIsoOffsetMinutes(commit.authoredAt) ?? 0;
    const local = new Date(ms + offset * 60_000);
    const hour = local.getUTCHours();
    const weekday = local.getUTCDay();
    hourHistogram[hour] += 1;
    weekdayHistogram[weekday] += 1;
    locByWeekday[weekday] += writtenAdded;
    if (NIGHT_OWL_HOURS.has(hour)) {
      nightOwl += 1;
    }
    const dayKey = local.toISOString().slice(0, 10);
    const slot = byLocalDay.get(dayKey) ?? { commit_count: 0, lines_added: 0, weekday };
    slot.commit_count += 1;
    slot.lines_added += writtenAdded;
    byLocalDay.set(dayKey, slot);
    if (nowMs - ms <= THIRTY_DAYS_MS) {
      last30 = {
        commit_count: last30.commit_count + 1,
        lines_added: last30.lines_added + writtenAdded,
        lines_deleted: last30.lines_deleted + writtenDeleted,
      };
    }
  }
  let biggest: { weekday_local: number; commit_count: number; lines_added: number } | undefined;
  for (const slot of byLocalDay.values()) {
    if (!biggest || slot.lines_added > biggest.lines_added) {
      biggest = { weekday_local: slot.weekday, commit_count: slot.commit_count, lines_added: slot.lines_added };
    }
  }
  return {
    commit_hour_histogram_local: hourHistogram,
    commits_by_weekday_local: weekdayHistogram,
    loc_added_by_weekday_local: locByWeekday,
    night_owl_share: round4(nightOwl / git.commits.length),
    ...(biggest ? { biggest_push: biggest } : {}),
    pr_metrics: { merged_pr_count_30d: git.mergeCommitCount30d, source: "merge_commit_heuristic" },
    last_30_days: last30,
  };
}

// ---------------------------------------------------------------------------
// models / modes / interrupts
// ---------------------------------------------------------------------------

function buildModelUsage(sessions: NormalizedSession[]): Pick<WrappedAggregates["vibe_extra"], "model_usage"> {
  const counts = new Map<string, { model_family: string; tool: AgentTool; session_count: number }>();
  const perToolTotals: Partial<Record<AgentTool, number>> = {};
  for (const session of sessions) {
    const models = session.signals?.models ?? {};
    let dominant: string | undefined;
    let best = 0;
    for (const [model, count] of Object.entries(models)) {
      if (count > best) {
        best = count;
        dominant = model;
      }
    }
    if (!dominant) {
      continue;
    }
    const family = normalizeModelId(dominant);
    if (!family) {
      continue;
    }
    perToolTotals[session.tool] = (perToolTotals[session.tool] ?? 0) + 1;
    const key = `${family}\0${session.tool}`;
    const slot = counts.get(key) ?? { model_family: family, tool: session.tool, session_count: 0 };
    slot.session_count += 1;
    counts.set(key, slot);
  }
  if (counts.size === 0) {
    return {};
  }
  const entries = Array.from(counts.values())
    .sort((left, right) => right.session_count - left.session_count)
    .slice(0, 24)
    .map((entry) => ({
      ...entry,
      session_share_pct: round2((entry.session_count / (perToolTotals[entry.tool] ?? 1)) * 100),
    }));
  return { model_usage: entries };
}

function buildPlanMode(sessions: NormalizedSession[]): Pick<WrappedAggregates["vibe_extra"], "plan_mode"> {
  let planMarked = 0;
  let approved = 0;
  let editedBeforeApproval = 0;
  const perToolPlan: Partial<Record<AgentTool, { plan: number; total: number }>> = {};
  let promptPlan = 0;
  let promptTotal = 0;
  for (const session of sessions) {
    const signals = session.signals;
    if (!signals) {
      continue;
    }
    const modeMap =
      session.tool === "claude"
        ? signals.permissionModes
        : session.tool === "codex"
          ? signals.collaborationModes
          : signals.unifiedModes;
    const total = Object.values(modeMap).reduce((sum, count) => sum + count, 0);
    const plan = modeMap.plan ?? 0;
    if (total > 0) {
      const slot = (perToolPlan[session.tool] ??= { plan: 0, total: 0 });
      slot.plan += plan;
      slot.total += total;
      promptPlan += plan;
      promptTotal += total;
    }
    if (plan > 0 || signals.exitPlanModeCount > 0 || signals.updatePlanCount > 0) {
      planMarked += 1;
    }
    approved += signals.exitPlanModeCount;
    editedBeforeApproval += signals.planEditedCount;
  }
  if (promptTotal === 0 && planMarked === 0) {
    return {};
  }
  const perTool: Partial<Record<AgentTool, number>> = {};
  for (const [tool, slot] of Object.entries(perToolPlan) as Array<[AgentTool, { plan: number; total: number }]>) {
    if (slot.total > 0) {
      perTool[tool] = round4(slot.plan / slot.total);
    }
  }
  return {
    plan_mode: {
      ...(promptTotal > 0 ? { plan_prompts_share: round4(promptPlan / promptTotal) } : {}),
      sessions_entering_plan_share: round4(planMarked / Math.max(1, sessions.length)),
      plan_approved_count: approved,
      plan_edited_before_approval_count: editedBeforeApproval,
      ...(Object.keys(perTool).length > 0 ? { per_tool: perTool } : {}),
    },
  };
}

function buildInterruption(
  sessions: NormalizedSession[],
  promptCount: number,
): Pick<WrappedAggregates["vibe_extra"], "interruption"> {
  let interruptCount = 0;
  let redirected = 0;
  let detectable = 0;
  const rebriefMs: number[] = [];
  for (const session of sessions) {
    interruptCount += session.signals?.interruptCount ?? 0;
    // Redirect pairing is computable only where interrupt markers are events
    // with timestamps (Claude).
    const events = session.events;
    for (let index = 0; index < events.length; index += 1) {
      const event = events[index];
      if (event.tool !== "claude" || event.role !== "user" || event.humanPrompt) {
        continue;
      }
      if (!event.text.trimStart().startsWith("[Request interrupted by user")) {
        continue;
      }
      detectable += 1;
      const interruptMs = parseTimestampMs(event.timestamp);
      for (let next = index + 1; next < events.length; next += 1) {
        if (!events[next].humanPrompt) {
          continue;
        }
        const nextMs = parseTimestampMs(events[next].timestamp);
        if (interruptMs !== null && nextMs !== null && nextMs - interruptMs <= REBRIEF_WINDOW_MS) {
          redirected += 1;
          rebriefMs.push(Math.max(0, nextMs - interruptMs));
        }
        break;
      }
    }
  }
  if (interruptCount === 0) {
    return {};
  }
  return {
    interruption: {
      interrupt_count: interruptCount,
      ...(promptCount > 0 ? { interrupts_per_100_prompts: round2((interruptCount / promptCount) * 100) } : {}),
      ...(detectable > 0
        ? {
            redirected_share: round4(redirected / detectable),
            abandoned_share: round4(1 - redirected / detectable),
          }
        : {}),
      ...(rebriefMs.length > 0 ? { median_rebrief_seconds: round2((median(rebriefMs) ?? 0) / 1000) } : {}),
    },
  };
}

// ---------------------------------------------------------------------------
// concurrency / runs / time
// ---------------------------------------------------------------------------

function buildConcurrency(
  actual: ActualSessionData[],
  normalized: NormalizedSession[],
): Pick<WrappedAggregates["vibe_extra"], "concurrency"> {
  const intervalsOf = (sessions: ActualSessionData[]) =>
    sessions.flatMap((session) => activeIntervals(session.timestampMs).map((interval) => ({ ...interval, tool: session.tool })));
  const all = intervalsOf(actual);
  if (all.length === 0) {
    return {};
  }
  const sweep = (intervals: Array<{ startMs: number; endMs: number }>): { max: number; atMs: number } => {
    const points = intervals
      .flatMap((interval) => [
        { atMs: interval.startMs, delta: 1 },
        { atMs: interval.endMs, delta: -1 },
      ])
      .sort((left, right) => left.atMs - right.atMs || left.delta - right.delta);
    let current = 0;
    let max = 0;
    let atMs = points[0]?.atMs ?? 0;
    for (const point of points) {
      current += point.delta;
      if (current > max) {
        max = current;
        atMs = point.atMs;
      }
    }
    return { max, atMs };
  };
  // Sessions overlapping in the same minute within ONE store can be artifacts;
  // a 60s minimum interval already exists via activeIntervals' single-point
  // handling, so the sweep is a fair upper bound of simultaneous activity.
  const sessionsSweep = sweep(intervalsOf(actual.filter((session) => !session.isSubagent)));
  const agentsSweep = sweep(all);
  const byTool: Partial<Record<AgentTool, number>> = {};
  for (const tool of ["claude", "codex", "cursor"] as const) {
    const result = sweep(all.filter((interval) => interval.tool === tool));
    if (result.max > 0) {
      byTool[tool] = result.max;
    }
  }
  let maxSubagentsSingleSession = 0;
  const byParent = new Map<string, NormalizedSession[]>();
  for (const session of normalized) {
    if (session.subagentOf) {
      const group = byParent.get(session.subagentOf) ?? [];
      group.push(session);
      byParent.set(session.subagentOf, group);
    }
  }
  for (const group of byParent.values()) {
    const intervals = group.flatMap((session) =>
      activeIntervals(
        session.events
          .map((event) => parseTimestampMs(event.timestamp))
          .filter((value): value is number => value !== null),
      ),
    );
    maxSubagentsSingleSession = Math.max(maxSubagentsSingleSession, sweep(intervals).max);
  }
  const peakAt = new Date(Math.floor(agentsSweep.atMs / 3_600_000) * 3_600_000).toISOString();
  return {
    concurrency: {
      max_parallel_agents: agentsSweep.max,
      max_parallel_sessions: sessionsSweep.max,
      ...(maxSubagentsSingleSession > 0 ? { max_parallel_subagents_single_session: maxSubagentsSingleSession } : {}),
      peak_at: peakAt,
      ...(Object.keys(byTool).length > 0 ? { by_tool: byTool } : {}),
    },
  };
}

function buildLongestRun(sessions: NormalizedSession[]): Pick<WrappedAggregates["vibe_extra"], "longest_agent_run"> {
  let best: { minutes: number; agent_type: AgentTool; session_ref: string } | undefined;
  for (const session of sessions) {
    const events = session.events
      .map((event) => ({ event, ms: parseTimestampMs(event.timestamp) }))
      .filter((entry): entry is { event: NormalizedEvent; ms: number } => entry.ms !== null);
    if (events.length < 2) {
      continue;
    }
    let stretchStart: number | null = null;
    let previousMs: number | null = null;
    for (const { event, ms } of events) {
      const breaksRun = event.humanPrompt || previousMs === null || ms - previousMs > ACTIVE_GAP_MS;
      if (breaksRun) {
        stretchStart = ms;
      }
      previousMs = ms;
      if (stretchStart !== null) {
        const minutes = (ms - stretchStart) / 60_000;
        if (!best || minutes > best.minutes) {
          best = { minutes: round2(minutes), agent_type: session.tool, session_ref: session.sessionRef };
        }
      }
    }
  }
  return best && best.minutes >= 5 ? { longest_agent_run: best } : {};
}

function buildEventHourHistogram(
  actual: ActualSessionData[],
): Pick<WrappedAggregates["vibe_extra"], "event_hour_histogram_local"> {
  const offsetMinutes = -new Date().getTimezoneOffset();
  const histogram = new Array<number>(24).fill(0);
  let total = 0;
  for (const session of actual) {
    for (const ms of session.timestampMs) {
      histogram[new Date(ms + offsetMinutes * 60_000).getUTCHours()] += 1;
      total += 1;
    }
  }
  return total > 0 ? { event_hour_histogram_local: histogram } : {};
}

function buildVibeLast30Days(
  actual: ActualSessionData[],
  nowMs: number,
): Pick<WrappedAggregates["vibe_extra"], "last_30_days"> {
  const windowStart = nowMs - THIRTY_DAYS_MS;
  const clip = (interval: { startMs: number; endMs: number }) => {
    const start = Math.max(interval.startMs, windowStart);
    const end = Math.min(interval.endMs, nowMs);
    return end > start ? end - start : 0;
  };
  const mainIntervals = actual
    .filter((session) => !session.isSubagent)
    .flatMap((session) => activeIntervals(session.timestampMs));
  const agentMs = mainIntervals.reduce((sum, interval) => sum + clip(interval), 0);
  const calendarMs = mergeIntervals(mainIntervals).reduce((sum, interval) => sum + clip(interval), 0);
  const tokens = actual
    .flatMap((session) => session.tokenEvents ?? [])
    .filter((event) => event.timestampMs >= windowStart && event.timestampMs <= nowMs)
    .reduce((sum, event) => sum + event.total, 0);
  if (agentMs === 0 && tokens === 0) {
    return {};
  }
  return {
    last_30_days: {
      vibe_agent_hours: round2(agentMs / 3_600_000),
      active_calendar_hours: round2(calendarMs / 3_600_000),
      provider_tokens: tokens,
    },
  };
}

// ---------------------------------------------------------------------------
// prompts
// ---------------------------------------------------------------------------

const THANKS_RE = /\b(thanks|thank you|thx|ty|appreciated?|great work|nice work|well done)\b/i;
const PLEASE_RE = /\b(please|pls|could you|would you)\b/i;
const QUESTION_OPEN_RE = /^(what|why|how|when|where|which|can|could|should|would|is|are|do|does|did)\b/i;
const GREETING_RE = /^(hi|hey|hello|yo|good (morning|afternoon|evening))\b/i;
const ACRONYM_RE = /\b[A-Z]{2,6}s?\b/g;

function buildPromptStats(
  sessions: NormalizedSession[],
  humanPrompts: NormalizedEvent[],
  nowMs: number,
): Pick<WrappedAggregates["vibe_extra"], "prompt_stats"> {
  if (humanPrompts.length === 0) {
    return {};
  }
  const wordCounts: number[] = [];
  const histogram = [0, 0, 0, 0, 0, 0];
  let thanks = 0;
  let please = 0;
  let thanks30 = 0;
  let crashouts = 0;
  let questions = 0;
  for (const prompt of humanPrompts) {
    const text = prompt.text;
    const words = text.split(/\s+/).filter(Boolean);
    wordCounts.push(words.length);
    histogram[wordBucket(words.length)] += 1;
    if (THANKS_RE.test(text)) {
      thanks += 1;
      const ms = parseTimestampMs(prompt.timestamp);
      if (ms !== null && nowMs - ms <= THIRTY_DAYS_MS) {
        thanks30 += 1;
      }
    }
    if (PLEASE_RE.test(text)) {
      please += 1;
    }
    if (isCrashout(text)) {
      crashouts += 1;
    }
    if (text.trimEnd().endsWith("?") || QUESTION_OPEN_RE.test(text.trim())) {
      questions += 1;
    }
  }
  const openers = { command: 0, question: 0, greeting: 0, other: 0 };
  let openerTotal = 0;
  for (const session of sessions) {
    const first = session.events.find((event) => event.humanPrompt);
    if (!first) {
      continue;
    }
    openerTotal += 1;
    const text = first.text.trim();
    if (GREETING_RE.test(text)) {
      openers.greeting += 1;
    } else if (text.endsWith("?") || QUESTION_OPEN_RE.test(text)) {
      openers.question += 1;
    } else if (/^[a-z]/i.test(text)) {
      openers.command += 1;
    } else {
      openers.other += 1;
    }
  }
  const under10 = wordCounts.filter((count) => count < 10).length;
  return {
    prompt_stats: {
      prompt_count: humanPrompts.length,
      median_words: median(wordCounts) ?? 0,
      under_10_words_share: round4(under10 / wordCounts.length),
      words_histogram: histogram,
      politeness: {
        thanks_message_count: thanks,
        please_message_count: please,
        last_30_days_thanks_message_count: thanks30,
      },
      crashout_message_count: crashouts,
      question_share: round4(questions / humanPrompts.length),
      ...(openerTotal > 0
        ? {
            opener_split: {
              command: round4(openers.command / openerTotal),
              question: round4(openers.question / openerTotal),
              greeting: round4(openers.greeting / openerTotal),
              other: round4(openers.other / openerTotal),
            },
          }
        : {}),
    },
  };
}

function wordBucket(count: number): number {
  if (count < 5) return 0;
  if (count < 10) return 1;
  if (count < 25) return 2;
  if (count < 50) return 3;
  if (count < 100) return 4;
  return 5;
}

function isCrashout(text: string): boolean {
  const stripped = text.replace(ACRONYM_RE, "");
  const letters = stripped.replace(/[^A-Za-z]/g, "");
  if (letters.length < 15) {
    return false;
  }
  const words = stripped.split(/\s+/).filter((word) => /[A-Za-z]/.test(word));
  if (words.length < 3) {
    return false;
  }
  const upper = letters.replace(/[^A-Z]/g, "").length;
  return upper / letters.length >= 0.7;
}

// ---------------------------------------------------------------------------
// work streams
// ---------------------------------------------------------------------------

const STREAM_GAP_MS = 18 * 60 * 60 * 1000;

function buildWorkStreams(sessions: NormalizedSession[]): WrappedAggregates["work_streams"] {
  interface SessionWindow {
    session: NormalizedSession;
    startMs: number;
    endMs: number;
    activeMin: number;
    commitCount: number;
  }
  const byBranch = new Map<string, SessionWindow[]>();
  for (const session of sessions) {
    const branchRef = session.signals?.gitBranchRef;
    if (!branchRef) {
      continue;
    }
    const times = session.events
      .map((event) => parseTimestampMs(event.timestamp))
      .filter((value): value is number => value !== null);
    if (times.length === 0) {
      continue;
    }
    const startMs = Math.min(...times);
    const endMs = Math.max(...times);
    const activeMin = activeIntervals(times).reduce((sum, interval) => sum + (interval.endMs - interval.startMs), 0) / 60_000;
    const group = byBranch.get(branchRef) ?? [];
    group.push({
      session,
      startMs,
      endMs,
      activeMin,
      commitCount: session.signals?.commitEventTimesMs.length ?? 0,
    });
    byBranch.set(branchRef, group);
  }
  const streams: WrappedAggregates["work_streams"] = [];
  for (const [branchRef, windows] of byBranch.entries()) {
    windows.sort((left, right) => left.startMs - right.startMs);
    let current: SessionWindow[] = [];
    const flush = () => {
      if (current.length === 0) {
        return;
      }
      const startMs = Math.min(...current.map((window) => window.startMs));
      const endMs = Math.max(...current.map((window) => window.endMs));
      const days = new Set(
        current.flatMap((window) => [new Date(window.startMs).toISOString().slice(0, 10), new Date(window.endMs).toISOString().slice(0, 10)]),
      );
      streams.push({
        stream_ref: branchRef,
        session_count: current.length,
        active_days: days.size,
        total_active_minutes: round2(current.reduce((sum, window) => sum + window.activeMin, 0)),
        commit_count: current.reduce((sum, window) => sum + window.commitCount, 0),
        started_at: new Date(startMs).toISOString(),
        ended_at: new Date(endMs).toISOString(),
      });
      current = [];
    };
    for (const window of windows) {
      const previous = current[current.length - 1];
      if (previous && window.startMs - previous.endMs > STREAM_GAP_MS) {
        flush();
      }
      current.push(window);
    }
    flush();
  }
  return streams.sort((left, right) => (right.total_active_minutes ?? 0) - (left.total_active_minutes ?? 0)).slice(0, 200);
}

// ---------------------------------------------------------------------------
// craft / economics / orchestration / identity
// ---------------------------------------------------------------------------

function buildCraftStats(
  sessions: NormalizedSession[],
  git: ReturnType<typeof collectGitCommitStats>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  let editOk = 0;
  let editError = 0;
  let contextCraft = 0;
  const redToGreenMinutes: number[] = [];
  let commitsWithTestBefore = 0;
  let commitsConsidered = 0;
  let planSessions = 0;
  let planShipped = 0;
  for (const session of sessions) {
    const signals = session.signals;
    if (!signals) {
      continue;
    }
    editOk += signals.editOutcomes.ok;
    editError += signals.editOutcomes.error;
    contextCraft += signals.contextCraftEditCount;
    const runs = [...signals.testRuns].sort((left, right) => left.atMs - right.atMs);
    for (let index = 0; index < runs.length; index += 1) {
      if (runs[index].outcome !== "fail") {
        continue;
      }
      const recovery = runs.slice(index + 1).find((run) => run.outcome === "pass");
      if (recovery) {
        redToGreenMinutes.push((recovery.atMs - runs[index].atMs) / 60_000);
      }
    }
    const testTimes = [...runs.map((run) => run.atMs), ...signals.testCommandTimesMs];
    for (const commitMs of signals.commitEventTimesMs) {
      commitsConsidered += 1;
      if (testTimes.some((atMs) => atMs <= commitMs)) {
        commitsWithTestBefore += 1;
      }
    }
    const planned =
      (signals.permissionModes.plan ?? 0) > 0 ||
      (signals.collaborationModes.plan ?? 0) > 0 ||
      (signals.unifiedModes.plan ?? 0) > 0 ||
      signals.exitPlanModeCount > 0;
    if (planned) {
      planSessions += 1;
      if (signals.commitEventTimesMs.length > 0 || signals.prLinkCount > 0) {
        planShipped += 1;
      }
    }
  }
  if (editOk + editError > 0) {
    out.edit_precision_rate = round4(editOk / (editOk + editError));
    out.edit_attempt_count = editOk + editError;
  }
  if (redToGreenMinutes.length > 0) {
    out.red_to_green_median_minutes = round2(median(redToGreenMinutes) ?? 0);
    out.red_to_green_sample_count = redToGreenMinutes.length;
  }
  if (commitsConsidered > 0) {
    out.test_before_ship_rate = round4(commitsWithTestBefore / commitsConsidered);
  }
  if (planSessions > 0) {
    out.plan_to_ship_conversion = round4(planShipped / planSessions);
  }
  if (contextCraft > 0) {
    out.context_craft_edit_count = contextCraft;
  }
  const authoredCommits = git.commits.filter((commit) => !commit.isBulkImport);
  if (authoredCommits.length > 0) {
    const files = authoredCommits.map((commit) => commit.files).sort((left, right) => left - right);
    out.median_blast_radius_files = median(files) ?? 0;
    out.p90_blast_radius_files = files[Math.min(files.length - 1, Math.floor(files.length * 0.9))];
    // Same-file rework is computed inside collectGitCommitStats, where the
    // per-commit file digests are in scope.
    if (git.reworkRate48h !== undefined) {
      out.rework_rate_48h = git.reworkRate48h;
    }
    if (git.addedFileCount + git.modifiedFileCount > 0) {
      out.refactor_to_greenfield_ratio = round4(git.modifiedFileCount / (git.addedFileCount + git.modifiedFileCount));
    }
  }
  return out;
}

function buildEconomicsStats(
  sessions: NormalizedSession[],
  actual: ActualSessionData[],
  git: ReturnType<typeof collectGitCommitStats>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  let cachedInput = 0;
  let totalInputSide = 0;
  let totalTokens = 0;
  for (const session of actual) {
    const usage = session.tokenUsage;
    if (!usage) {
      continue;
    }
    cachedInput += usage.cachedInput + usage.cacheReadInput;
    totalInputSide += usage.input + usage.cachedInput + usage.cacheReadInput + usage.cacheCreationInput;
    totalTokens += usage.total;
  }
  if (totalInputSide > 0) {
    out.cache_hit_rate = round4(cachedInput / totalInputSide);
  }
  const writtenCommits = git.commits.filter((commit) => !commit.isBulkImport);
  const linesAdded = writtenCommits.reduce((sum, commit) => sum + commit.added, 0);
  const linesDeleted = writtenCommits.reduce((sum, commit) => sum + commit.deleted, 0);
  if (totalTokens > 0 && linesAdded > 0) {
    out.loc_per_million_tokens = round2((linesAdded / totalTokens) * 1_000_000);
  }
  if (linesAdded > 0) {
    out.churn_ratio = round4(linesDeleted / linesAdded);
  }
  const ideaToCommit: number[] = [];
  for (const session of sessions) {
    const signals = session.signals;
    if (!signals || signals.commitEventTimesMs.length === 0) {
      continue;
    }
    const firstPrompt = session.events.find((event) => event.humanPrompt);
    const firstPromptMs = firstPrompt ? parseTimestampMs(firstPrompt.timestamp) : null;
    if (firstPromptMs === null) {
      continue;
    }
    const firstCommit = Math.min(...signals.commitEventTimesMs.filter((ms) => ms >= firstPromptMs));
    if (Number.isFinite(firstCommit)) {
      ideaToCommit.push((firstCommit - firstPromptMs) / 60_000);
    }
  }
  if (ideaToCommit.length > 0) {
    out.idea_to_commit_median_minutes = round2(median(ideaToCommit) ?? 0);
    out.idea_to_commit_sample_count = ideaToCommit.length;
  }
  const sorted = writtenCommits
    .map((commit) => ({ ms: parseTimestampMs(commit.authoredAt), added: commit.added }))
    .filter((commit): commit is { ms: number; added: number } => commit.ms !== null)
    .sort((left, right) => left.ms - right.ms);
  if (sorted.length > 0) {
    let bestLines = 0;
    let bestCommits = 0;
    let windowStart = 0;
    let windowLines = 0;
    for (let index = 0; index < sorted.length; index += 1) {
      windowLines += sorted[index].added;
      while (sorted[index].ms - sorted[windowStart].ms > 7 * DAY_MS) {
        windowLines -= sorted[windowStart].added;
        windowStart += 1;
      }
      if (windowLines > bestLines) {
        bestLines = windowLines;
        bestCommits = index - windowStart + 1;
      }
    }
    out.peak_ship_week = { lines_added: bestLines, commit_count: bestCommits };
  }
  return out;
}

function buildOrchestrationStats(
  normalized: NormalizedSession[],
  actual: ActualSessionData[],
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  let subOutput = 0;
  let mainOutput = 0;
  for (const session of actual) {
    const output = session.tokenUsage?.output ?? 0;
    if (session.isSubagent) {
      subOutput += output;
    } else {
      mainOutput += output;
    }
  }
  if (subOutput + mainOutput > 0 && subOutput > 0) {
    out.sidechain_output_share = round4(subOutput / (subOutput + mainOutput));
  }
  const subagentSessions = normalized.filter((session) => session.subagentOf);
  if (subagentSessions.length > 0) {
    out.subagent_count = subagentSessions.length;
    out.subagent_session_count = new Set(subagentSessions.map((session) => session.subagentOf)).size;
  }
  let depth = normalized.length > 0 ? 1 : 0;
  if (subagentSessions.length > 0) {
    depth = 2;
    if (subagentSessions.some((session) => (session.sessionKey.match(/\/subagents\//g) ?? []).length >= 2)) {
      depth = 3;
    }
  }
  if (depth > 0) {
    out.deepest_delegation_chain = depth;
  }
  const codexWithOriginator = normalized.filter((session) => session.tool === "codex" && session.signals?.originator);
  if (codexWithOriginator.length > 0) {
    const spawned = codexWithOriginator.filter(
      (session) => !/^codex/i.test(session.signals?.originator ?? ""),
    ).length;
    out.cross_tool_spawn_share = round4(spawned / codexWithOriginator.length);
  }
  const autonomy: Record<string, number> = {};
  let codexApprovalTotal = 0;
  let codexNever = 0;
  let claudeModesTotal = 0;
  let claudeAuto = 0;
  let claudeAcceptEdits = 0;
  for (const session of normalized) {
    const signals = session.signals;
    if (!signals) {
      continue;
    }
    for (const [policy, count] of Object.entries(signals.approvalPolicies)) {
      codexApprovalTotal += count;
      if (policy === "never") {
        codexNever += count;
      }
    }
    for (const [mode, count] of Object.entries(signals.permissionModes)) {
      claudeModesTotal += count;
      if (mode === "auto" || mode === "bypassPermissions") {
        claudeAuto += count;
      }
      if (mode === "acceptEdits") {
        claudeAcceptEdits += count;
      }
    }
  }
  if (codexApprovalTotal > 0) {
    autonomy.codex_never_approval_share = round4(codexNever / codexApprovalTotal);
  }
  if (claudeModesTotal > 0) {
    autonomy.claude_auto_share = round4(claudeAuto / claudeModesTotal);
    autonomy.claude_accept_edits_share = round4(claudeAcceptEdits / claudeModesTotal);
  }
  if (Object.keys(autonomy).length > 0) {
    out.autonomy = autonomy;
  }
  let todoItems = 0;
  let updatePlans = 0;
  let questions = 0;
  const askLatencies: number[] = [];
  let askUnanswered = 0;
  for (const session of normalized) {
    const signals = session.signals;
    if (!signals) {
      continue;
    }
    todoItems += signals.todoItemCount + (signals.toolUseNames.TodoWrite ?? 0);
    updatePlans += signals.updatePlanCount;
    questions += signals.askUserQuestionCount;
    askLatencies.push(...signals.askAnswerLatenciesMs);
    askUnanswered += signals.askUnansweredCount;
  }
  if (todoItems + updatePlans > 0) {
    out.checklist = { todo_item_count: todoItems, update_plan_count: updatePlans };
  }
  if (questions > 0) {
    out.ask_user_question = {
      question_count: questions,
      ...(askLatencies.length + askUnanswered > 0
        ? { answered_share: round4(askLatencies.length / (askLatencies.length + askUnanswered)) }
        : {}),
      ...(askLatencies.length > 0 ? { median_reply_seconds: round2((median(askLatencies) ?? 0) / 1000) } : {}),
    };
  }
  return out;
}

function buildIdentityStats(
  actual: ActualSessionData[],
  git: ReturnType<typeof collectGitCommitStats>,
  nowMs: number,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const daysByTool = new Map<AgentTool, Set<string>>();
  const allDays = new Set<string>();
  let firstMs = Number.POSITIVE_INFINITY;
  const firstByTool = new Map<AgentTool, number>();
  for (const session of actual) {
    for (const ms of session.timestampMs) {
      const day = new Date(ms).toISOString().slice(0, 10);
      allDays.add(day);
      const set = daysByTool.get(session.tool) ?? new Set<string>();
      set.add(day);
      daysByTool.set(session.tool, set);
      if (ms < firstMs) {
        firstMs = ms;
      }
      const toolFirst = firstByTool.get(session.tool);
      if (toolFirst === undefined || ms < toolFirst) {
        firstByTool.set(session.tool, ms);
      }
    }
  }
  for (const commit of git.commits) {
    const ms = parseTimestampMs(commit.authoredAt);
    if (ms !== null) {
      allDays.add(new Date(ms).toISOString().slice(0, 10));
    }
  }
  if (allDays.size > 0) {
    const sortedDays = Array.from(allDays).sort();
    let longest = 1;
    let current = 1;
    for (let index = 1; index < sortedDays.length; index += 1) {
      const previous = Date.parse(sortedDays[index - 1]);
      const day = Date.parse(sortedDays[index]);
      if (day - previous === DAY_MS) {
        current += 1;
        longest = Math.max(longest, current);
      } else {
        current = 1;
      }
    }
    out.longest_build_streak_days = longest;
    const today = new Date(nowMs).toISOString().slice(0, 10);
    const yesterday = new Date(nowMs - DAY_MS).toISOString().slice(0, 10);
    if (allDays.has(today) || allDays.has(yesterday)) {
      let streak = 0;
      let cursor = allDays.has(today) ? Date.parse(today) : Date.parse(yesterday);
      while (allDays.has(new Date(cursor).toISOString().slice(0, 10))) {
        streak += 1;
        cursor -= DAY_MS;
      }
      out.current_streak_days = streak;
    }
  }
  if (Number.isFinite(firstMs)) {
    const corroborating = Array.from(firstByTool.values()).filter((ms) => ms - firstMs <= THIRTY_DAYS_MS).length;
    out.first_contact = {
      first_activity_at: new Date(firstMs).toISOString(),
      corroborating_sources: Math.max(1, corroborating),
    };
  }
  if (daysByTool.size > 0 && allDays.size > 0) {
    let primaryTool: AgentTool | undefined;
    let primaryDays = 0;
    for (const [tool, days] of daysByTool.entries()) {
      if (days.size > primaryDays) {
        primaryDays = days.size;
        primaryTool = tool;
      }
    }
    const activeDayUnion = new Set<string>();
    for (const days of daysByTool.values()) {
      for (const day of days) {
        activeDayUnion.add(day);
      }
    }
    let allThree = 0;
    if (daysByTool.size === 3) {
      for (const day of activeDayUnion) {
        if (Array.from(daysByTool.values()).every((days) => days.has(day))) {
          allThree += 1;
        }
      }
    }
    if (primaryTool) {
      out.tool_loyalty = {
        primary_tool: primaryTool,
        primary_tool_active_day_share: round4(primaryDays / activeDayUnion.size),
        all_three_tools_day_count: allThree,
      };
    }
  }
  const durations = actual
    .filter((session) => !session.isSubagent && session.timestampMs.length >= 2)
    .map((session) =>
      activeIntervals(session.timestampMs).reduce((sum, interval) => sum + (interval.endMs - interval.startMs), 0) / 60_000,
    )
    .filter((minutes) => minutes > 0);
  if (durations.length >= 5) {
    const medianMinutes = median(durations) ?? 0;
    const overTwoHours = durations.filter((minutes) => minutes >= 120).length / durations.length;
    const label = medianMinutes < 20 && overTwoHours < 0.15 ? "sprinter" : medianMinutes >= 60 ? "marathoner" : "mixed";
    out.session_shape = {
      label,
      median_session_minutes: round2(medianMinutes),
      over_two_hours_share: round4(overTwoHours),
    };
  }
  return out;
}

// ---------------------------------------------------------------------------

function median(values: number[]): number | undefined {
  if (values.length === 0) {
    return undefined;
  }
  const sorted = [...values].sort((left, right) => left - right);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

function round4(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}

// Re-exported so the day-binning helper stays single-sourced with extractors.
export { localDayOfWeek };
