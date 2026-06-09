import { createHash } from "node:crypto";

/**
 * Structured per-session behavioral signals collected in the SAME parse pass
 * as event normalization (no second file walk). Everything here is counts,
 * enums, durations, or locally-salted opaque refs — never raw branch names,
 * commit shas, timezone names, message text, or queued-prompt content.
 *
 * These signals are local inputs to the analysis skill and the Wave 2
 * aggregates; they are not themselves part of the submitted profile payload.
 */

export interface SessionSignals {
  /** Raw provider model id -> assistant-record count ('<synthetic>' excluded). */
  models: Record<string, number>;
  /** tool_use / function_call name -> count. */
  toolUseNames: Record<string, number>;
  /** Claude permissionMode value -> user-record count. */
  permissionModes: Record<string, number>;
  exitPlanModeCount: number;
  planEditedCount: number;
  /** Human interrupts: Claude interrupt markers + Codex turn_aborted(reason=interrupted). */
  interruptCount: number;
  /** Claude queue-operation `operation` value -> count (content is never read). */
  queueOperations: Record<string, number>;
  prLinkCount: number;
  /** Locally-salted opaque refs of in-transcript git_commit shas (for commit linkage). */
  commitShaRefs: string[];
  /** Locally-salted opaque ref of the session's git branch, when advertised. */
  gitBranchRef?: string;
  sidechainEventCount: number;
  /** Claude sourceToolAssistantUUID link count (spawned-agent output linkage). */
  sourceToolLinkCount: number;
  askUserQuestionCount: number;
  // Codex turn telemetry
  collaborationModes: Record<string, number>;
  approvalPolicies: Record<string, number>;
  efforts: Record<string, number>;
  /** Codex session originator (e.g. 'codex_cli', 'Claude Code'), when advertised. */
  originator?: string;
  agentRole?: string;
  hasParentThread: boolean;
  /** Completed turn durations (ms) from task_complete records. */
  turnDurationsMs: number[];
  turnAbortedOther: number;
  updatePlanCount: number;
  // Cursor composer telemetry
  unifiedModes: Record<string, number>;
  isSpecCount: number;
  todoItemCount: number;
  subagentComposerCount: number;
  cursorLinesAdded: number;
  cursorLinesRemoved: number;
  /** Cursor per-model usage: model -> { costInCents, amount } sums. */
  cursorUsage: Record<string, { costInCents: number; amount: number }>;
  toolFormerStatuses: Record<string, number>;
}

export function emptySessionSignals(): SessionSignals {
  return {
    models: {},
    toolUseNames: {},
    permissionModes: {},
    exitPlanModeCount: 0,
    planEditedCount: 0,
    interruptCount: 0,
    queueOperations: {},
    prLinkCount: 0,
    commitShaRefs: [],
    sidechainEventCount: 0,
    sourceToolLinkCount: 0,
    askUserQuestionCount: 0,
    collaborationModes: {},
    approvalPolicies: {},
    efforts: {},
    hasParentThread: false,
    turnDurationsMs: [],
    turnAbortedOther: 0,
    updatePlanCount: 0,
    unifiedModes: {},
    isSpecCount: 0,
    todoItemCount: 0,
    subagentComposerCount: 0,
    cursorLinesAdded: 0,
    cursorLinesRemoved: 0,
    cursorUsage: {},
    toolFormerStatuses: {},
  };
}

const MAX_DISTINCT_KEYS = 64;
const MAX_COMMIT_REFS = 500;
const MAX_TURN_DURATIONS = 2000;

function bumpKey(map: Record<string, number>, key: string, by = 1): void {
  if (!key) {
    return;
  }
  if (map[key] === undefined && Object.keys(map).length >= MAX_DISTINCT_KEYS) {
    return;
  }
  map[key] = (map[key] ?? 0) + by;
}

function saltedRef(salt: string, kind: string, value: string): string {
  return createHash("sha256").update(`${salt}\0${kind}\0${value}`).digest("hex").slice(0, 24);
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 && value.length <= 200 ? value : undefined;
}

function asPositiveNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
}

/** Collects signals from one Claude Code JSONL record. */
export function collectClaudeSignals(signals: SessionSignals, salt: string, record: Record<string, unknown>): void {
  const type = asString(record.type);
  if (type === "queue-operation") {
    bumpKey(signals.queueOperations, asString(record.operation) ?? "unknown");
    return;
  }
  if (type === "pr-link") {
    signals.prLinkCount += 1;
    return;
  }
  if (type === "git_commit") {
    const sha = asString(record.sha);
    if (sha && signals.commitShaRefs.length < MAX_COMMIT_REFS) {
      signals.commitShaRefs.push(saltedRef(salt, "commit", sha.toLowerCase()));
    }
    return;
  }
  if (record.isSidechain === true) {
    signals.sidechainEventCount += 1;
  }
  if (typeof record.sourceToolAssistantUUID === "string") {
    signals.sourceToolLinkCount += 1;
  }
  if (record.planWasEdited === true) {
    signals.planEditedCount += 1;
  }
  if (!signals.gitBranchRef) {
    const branch = asString(record.gitBranch);
    if (branch) {
      signals.gitBranchRef = saltedRef(salt, "branch", branch);
    }
  }
  if (type === "user") {
    const mode = asString(record.permissionMode);
    if (mode) {
      bumpKey(signals.permissionModes, mode);
    }
  }
  const message = asRecord(record.message);
  if (type === "assistant" && message) {
    const model = asString(message.model);
    if (model && model !== "<synthetic>") {
      bumpKey(signals.models, model);
    }
    const content = message.content;
    if (Array.isArray(content)) {
      for (const item of content) {
        const block = asRecord(item);
        if (!block || block.type !== "tool_use") {
          continue;
        }
        const name = asString(block.name);
        if (!name) {
          continue;
        }
        bumpKey(signals.toolUseNames, name);
        if (name === "ExitPlanMode") {
          signals.exitPlanModeCount += 1;
        }
        if (name === "AskUserQuestion") {
          signals.askUserQuestionCount += 1;
        }
      }
    }
  }
  if (type === "user" && message) {
    const content = message.content;
    const text =
      typeof content === "string"
        ? content
        : Array.isArray(content)
          ? content
              .map((item) => {
                const block = asRecord(item);
                return block && block.type === "text" && typeof block.text === "string" ? block.text : "";
              })
              .join("")
          : "";
    if (text.trimStart().startsWith("[Request interrupted by user")) {
      signals.interruptCount += 1;
    }
  }
}

/** Collects signals from one Codex rollout JSONL record. */
export function collectCodexSignals(signals: SessionSignals, salt: string, record: Record<string, unknown>): void {
  const type = asString(record.type);
  const payload = asRecord(record.payload);
  if (!payload) {
    return;
  }
  if (type === "session_meta") {
    const originator = asString(payload.originator);
    if (originator && !signals.originator) {
      signals.originator = originator;
    }
    const agentRole = asString(payload.agent_role);
    if (agentRole && !signals.agentRole) {
      signals.agentRole = agentRole;
    }
    if (payload.parent_thread_id != null) {
      signals.hasParentThread = true;
    }
    const git = asRecord(payload.git);
    const branch = git ? asString(git.branch) : undefined;
    if (branch && !signals.gitBranchRef) {
      signals.gitBranchRef = saltedRef(salt, "branch", branch);
    }
    return;
  }
  if (type === "turn_context") {
    const model = asString(payload.model);
    if (model) {
      bumpKey(signals.models, model);
    }
    const effort = asString(payload.effort);
    if (effort) {
      bumpKey(signals.efforts, effort);
    }
    const approval = asString(payload.approval_policy);
    if (approval) {
      bumpKey(signals.approvalPolicies, approval);
    }
    const collaboration = asRecord(payload.collaboration_mode);
    const mode = collaboration ? asString(collaboration.mode) : undefined;
    if (mode) {
      bumpKey(signals.collaborationModes, mode);
    }
    return;
  }
  const payloadType = asString(payload.type);
  if (type === "event_msg" && payloadType === "turn_aborted") {
    if (asString(payload.reason) === "interrupted") {
      signals.interruptCount += 1;
    } else {
      signals.turnAbortedOther += 1;
    }
    return;
  }
  if ((type === "event_msg" && payloadType === "task_complete") || type === "task_complete") {
    const duration = asPositiveNumber(payload.duration_ms);
    if (duration > 0 && signals.turnDurationsMs.length < MAX_TURN_DURATIONS) {
      signals.turnDurationsMs.push(duration);
    }
    return;
  }
  if (type === "response_item" && (payloadType === "function_call" || payloadType === "custom_tool_call")) {
    const name = asString(payload.name);
    if (name) {
      bumpKey(signals.toolUseNames, name);
      if (name === "update_plan") {
        signals.updatePlanCount += 1;
      }
    }
  }
}

/** Collects signals from one Cursor composerData value. */
export function collectCursorComposerSignals(signals: SessionSignals, value: unknown): void {
  const composer = asRecord(value);
  if (!composer) {
    return;
  }
  const unifiedMode = asString(composer.unifiedMode);
  if (unifiedMode) {
    bumpKey(signals.unifiedModes, unifiedMode);
  }
  if (composer.isSpec === true) {
    signals.isSpecCount += 1;
  }
  if (Array.isArray(composer.todos)) {
    signals.todoItemCount += composer.todos.length;
  }
  if (Array.isArray(composer.subagentComposerIds)) {
    signals.subagentComposerCount += composer.subagentComposerIds.length;
  }
  signals.cursorLinesAdded += asPositiveNumber(composer.totalLinesAdded);
  signals.cursorLinesRemoved += asPositiveNumber(composer.totalLinesRemoved);
  const modelConfig = asRecord(composer.modelConfig);
  const modelName = modelConfig ? asString(modelConfig.modelName) : undefined;
  if (modelName) {
    bumpKey(signals.models, modelName);
  }
  const usageData = asRecord(composer.usageData);
  if (usageData) {
    for (const [model, raw] of Object.entries(usageData)) {
      const entry = asRecord(raw);
      if (!entry) {
        continue;
      }
      const key = model.slice(0, 80);
      if (!signals.cursorUsage[key] && Object.keys(signals.cursorUsage).length >= MAX_DISTINCT_KEYS) {
        continue;
      }
      const slot = (signals.cursorUsage[key] ??= { costInCents: 0, amount: 0 });
      slot.costInCents += asPositiveNumber(entry.costInCents);
      slot.amount += asPositiveNumber(entry.amount);
    }
  }
}

/** Collects signals from one Cursor bubble value. */
export function collectCursorBubbleSignals(signals: SessionSignals, value: unknown): void {
  const bubble = asRecord(value);
  if (!bubble) {
    return;
  }
  const toolFormer = asRecord(bubble.toolFormerData);
  if (toolFormer) {
    const name = asString(toolFormer.name);
    if (name) {
      bumpKey(signals.toolUseNames, name);
    }
    const status = asString(toolFormer.status);
    if (status) {
      bumpKey(signals.toolFormerStatuses, status);
      if (status === "cancelled" || status === "aborted") {
        signals.interruptCount += 1;
      }
    }
  }
}

/** Known model-family display names; unknown ids fail closed to undefined. */
const MODEL_FAMILY_RULES: Array<{ pattern: RegExp; family: string }> = [
  { pattern: /^claude[-.]?opus[-.]?4[-.]?8/i, family: "Opus 4.8" },
  { pattern: /^claude[-.]?opus[-.]?4[-.]?7/i, family: "Opus 4.7" },
  { pattern: /^claude[-.]?opus[-.]?4[-.]?6/i, family: "Opus 4.6" },
  { pattern: /^claude[-.]?opus/i, family: "Opus" },
  { pattern: /^claude[-.]?sonnet/i, family: "Sonnet" },
  { pattern: /^claude[-.]?haiku/i, family: "Haiku" },
  { pattern: /opus.*thinking|claude-4\.5-opus/i, family: "Opus (Cursor)" },
  { pattern: /^claude/i, family: "Claude" },
  { pattern: /^gpt-5\.5/i, family: "GPT-5.5" },
  { pattern: /^gpt-5\.4/i, family: "GPT-5.4" },
  { pattern: /^gpt-5\.2/i, family: "GPT-5.2" },
  { pattern: /^gpt/i, family: "GPT" },
  { pattern: /^gemini-3/i, family: "Gemini 3" },
  { pattern: /^gemini/i, family: "Gemini" },
  { pattern: /^composer/i, family: "Cursor Composer" },
  { pattern: /^o[0-9]/i, family: "OpenAI o-series" },
];

const MODEL_ID_ALLOWED = /^[0-9A-Za-z][0-9A-Za-z .+_:-]{0,79}$/;

/**
 * Maps a raw provider model id to a bounded display family. Returns undefined
 * (fail closed) for ids that do not look like vendor product strings, so free
 * text can never ride along in a model field.
 */
export function normalizeModelId(raw: string): string | undefined {
  const trimmed = raw.trim();
  if (!MODEL_ID_ALLOWED.test(trimmed)) {
    return undefined;
  }
  for (const rule of MODEL_FAMILY_RULES) {
    if (rule.pattern.test(trimmed)) {
      return rule.family;
    }
  }
  return undefined;
}
