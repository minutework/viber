import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

/**
 * Synthetic transcript corpus exercising the real on-disk shapes of all three
 * sources (Claude Code JSONL, Codex CLI rollout JSONL, Cursor sqlite). The
 * shapes mirror fields observed in real stores: tool_result user lines,
 * sidechain/subagent transcripts, SDK prompts, command wrappers, interrupt
 * markers, queue operations, Codex event_msg/response_item duality,
 * session_meta git attribution, and archived sessions.
 */

export function claudeProjectDirName(projectPath: string): string {
  return projectPath.replace(/[/.]/g, "-").replace(/^-?/, "-");
}

export interface ClaudeCorpusOptions {
  /** Working directory advertised by the session's records. Defaults to projectPath. */
  cwd?: string;
  /** Directory name override for the project dir under ~/.claude/projects. */
  projectDirName?: string;
  sessionFileName?: string;
  includeSubagent?: boolean;
}

export function writeClaudeCorpus(home: string, projectPath: string, options: ClaudeCorpusOptions = {}): string {
  const cwd = options.cwd ?? projectPath;
  const projectDir = path.join(home, ".claude", "projects", options.projectDirName ?? claudeProjectDirName(projectPath));
  mkdirSync(projectDir, { recursive: true });
  const sessionFileName = options.sessionFileName ?? "session-main.jsonl";
  const sessionBase = sessionFileName.replace(/\.jsonl$/, "");

  const lines = [
    {
      type: "user",
      timestamp: "2026-06-09T10:00:00Z",
      cwd,
      gitBranch: "codex/fixture-branch",
      permissionMode: "plan",
      sessionId: sessionBase,
      message: { role: "user", content: "Please fix the failing login test and keep the change scoped." },
    },
    {
      type: "assistant",
      timestamp: "2026-06-09T10:01:00Z",
      cwd,
      message: {
        role: "assistant",
        model: "claude-opus-4-8",
        content: [{ type: "text", text: "I will reproduce the failure first, then patch the validator." }],
        usage: { input_tokens: 120, cache_creation_input_tokens: 30, cache_read_input_tokens: 400, output_tokens: 60 },
      },
    },
    {
      type: "user",
      timestamp: "2026-06-09T10:02:00Z",
      cwd,
      toolUseResult: { stdout: "1 failing test", usage: { input_tokens: 999_999, output_tokens: 999_999 } },
      message: {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "tu_1", content: [{ type: "text", text: "stdout: 1 failing test in suite" }] }],
      },
    },
    {
      type: "user",
      timestamp: "2026-06-09T10:03:00Z",
      cwd,
      message: { role: "user", content: [{ type: "text", text: "[Request interrupted by user]" }] },
    },
    {
      type: "user",
      timestamp: "2026-06-09T10:04:00Z",
      cwd,
      promptSource: "sdk",
      message: { role: "user", content: "Continue with the previously planned refactor of the helper module." },
    },
    {
      type: "user",
      timestamp: "2026-06-09T10:05:00Z",
      cwd,
      message: { role: "user", content: "<command-name>/compact</command-name> <command-args></command-args>" },
    },
    {
      type: "queue-operation",
      timestamp: "2026-06-09T10:06:00Z",
      operation: "enqueue",
      sessionId: sessionBase,
      content: "Queued follow-up instruction that must not be double counted.",
    },
    {
      type: "assistant",
      timestamp: "2026-06-09T10:07:00Z",
      cwd,
      isSidechain: true,
      message: { role: "assistant", content: [{ type: "text", text: "Sidechain worker reporting an intermediate result." }] },
    },
    {
      type: "user",
      timestamp: "2026-06-09T10:10:00Z",
      cwd,
      message: { role: "user", content: "Now also add a regression test for the empty-password case please." },
    },
    {
      type: "assistant",
      timestamp: "2026-06-09T10:11:00Z",
      cwd,
      message: {
        role: "assistant",
        model: "claude-opus-4-8",
        content: [{ type: "text", text: "Added the regression test and verified the suite passes." }],
        usage: { input_tokens: 80, cache_creation_input_tokens: 0, cache_read_input_tokens: 500, output_tokens: 40 },
      },
    },
  ];
  const sessionPath = path.join(projectDir, sessionFileName);
  writeFileSync(sessionPath, lines.map((line) => JSON.stringify(line)).join("\n"));

  if (options.includeSubagent !== false) {
    const subagentDir = path.join(projectDir, sessionBase, "subagents");
    mkdirSync(subagentDir, { recursive: true });
    const subagentLines = [
      {
        type: "user",
        timestamp: "2026-06-09T10:01:10Z",
        cwd,
        isSidechain: true,
        message: { role: "user", content: "Explore the test suite layout and report the failing spec." },
      },
      {
        type: "assistant",
        timestamp: "2026-06-09T10:01:40Z",
        cwd,
        isSidechain: true,
        message: {
          role: "assistant",
          model: "claude-haiku-4-5-20251001",
          content: [{ type: "text", text: "The failing spec asserts the legacy validator message text." }],
          usage: { input_tokens: 50, cache_creation_input_tokens: 0, cache_read_input_tokens: 100, output_tokens: 25 },
        },
      },
    ];
    writeFileSync(path.join(subagentDir, "agent-1.jsonl"), subagentLines.map((line) => JSON.stringify(line)).join("\n"));
  }
  return sessionPath;
}

export interface CodexCorpusOptions {
  cwd?: string;
  repositoryUrl?: string;
  fileName?: string;
  archived?: boolean;
}

export function writeCodexCorpus(home: string, projectPath: string, options: CodexCorpusOptions = {}): string {
  const cwd = options.cwd ?? projectPath;
  const dir = options.archived
    ? path.join(home, ".codex", "archived_sessions")
    : path.join(home, ".codex", "sessions", "2026", "06", "09");
  mkdirSync(dir, { recursive: true });
  const lines = [
    {
      timestamp: "2026-06-09T11:00:00Z",
      type: "session_meta",
      payload: {
        cwd,
        originator: "codex_cli",
        ...(options.repositoryUrl ? { git: { repository_url: options.repositoryUrl, branch: "main" } } : {}),
      },
    },
    {
      timestamp: "2026-06-09T11:00:01Z",
      type: "turn_context",
      payload: { cwd, model: "gpt-5.5", effort: "high", approval_policy: "never", collaboration_mode: { mode: "plan" } },
    },
    {
      timestamp: "2026-06-09T11:00:05Z",
      type: "event_msg",
      payload: { type: "user_message", message: "Investigate why the nightly export job times out and propose a fix." },
    },
    {
      timestamp: "2026-06-09T11:00:05Z",
      type: "response_item",
      payload: {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "Investigate why the nightly export job times out and propose a fix." }],
      },
    },
    {
      timestamp: "2026-06-09T11:00:20Z",
      type: "response_item",
      payload: { type: "function_call", name: "update_plan", arguments: "{}" },
    },
    {
      timestamp: "2026-06-09T11:00:30Z",
      type: "response_item",
      payload: { type: "function_call_output", output: "plan updated" },
    },
    {
      timestamp: "2026-06-09T11:01:00Z",
      type: "response_item",
      payload: {
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: "The export job times out because the batch query is unindexed; adding an index fixes it." }],
      },
    },
    {
      timestamp: "2026-06-09T11:01:05Z",
      type: "event_msg",
      payload: { type: "agent_message", message: "The export job times out because the batch query is unindexed; adding an index fixes it." },
    },
    {
      timestamp: "2026-06-09T11:01:30Z",
      type: "event_msg",
      payload: { type: "turn_aborted", reason: "interrupted", turn_id: "turn-1" },
    },
    {
      timestamp: "2026-06-09T11:02:00Z",
      type: "event_msg",
      payload: {
        type: "token_count",
        info: {
          total_token_usage: {
            total_tokens: 5000,
            input_tokens: 4000,
            cached_input_tokens: 2500,
            output_tokens: 1000,
            reasoning_output_tokens: 400,
          },
        },
      },
    },
  ];
  const filePath = path.join(dir, options.fileName ?? "rollout-2026-06-09-main.jsonl");
  writeFileSync(filePath, lines.map((line) => JSON.stringify(line)).join("\n"));
  return filePath;
}

export function writeLegacyCodexCorpus(home: string, projectPath: string): string {
  const dir = path.join(home, ".codex", "archived_sessions");
  mkdirSync(dir, { recursive: true });
  const lines = [
    { cwd: projectPath, role: "user", timestamp: "2026-06-08T09:00:00Z", content: "Review the migration plan and keep the rollout reversible." },
    { role: "assistant", timestamp: "2026-06-08T09:02:00Z", content: "The migration is staged in two reversible steps with a backout script." },
  ];
  const filePath = path.join(dir, "rollout-legacy.jsonl");
  writeFileSync(filePath, lines.map((line) => JSON.stringify(line)).join("\n"));
  return filePath;
}
