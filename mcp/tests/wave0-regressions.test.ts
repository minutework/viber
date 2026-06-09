import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import { buildActualMetrics, buildEpisodeCandidates, discoverLocalSources, gitAggregateMetrics } from "../src/extractors.ts";
import { claudeProjectDirName, writeClaudeCorpus, writeCodexCorpus, writeLegacyCodexCorpus } from "./fixture-corpus.ts";

function makeTempDir(): string {
  return mkdtempSync(path.join(tmpdir(), "viber-wave0-"));
}

function cleanup(dir: string): void {
  rmSync(dir, { recursive: true, force: true });
}

function git(repo: string, args: string[], env: Record<string, string> = {}): void {
  execFileSync("git", ["-C", repo, ...args], { stdio: "ignore", env: { ...process.env, ...env } });
}

function initRepo(repo: string, email: string, name: string): void {
  mkdirSync(repo, { recursive: true });
  execFileSync("git", ["init", repo], { stdio: "ignore" });
  git(repo, ["config", "user.email", email]);
  git(repo, ["config", "user.name", name]);
  git(repo, ["config", "commit.gpgsign", "false"]);
}

function commitFile(repo: string, file: string, contents: string, message: string, env: Record<string, string> = {}): void {
  writeFileSync(path.join(repo, file), contents);
  git(repo, ["add", "."]);
  git(repo, ["commit", "-m", message], env);
}

test("codex roles come from event payloads: only event_msg user_message is a human prompt", () => {
  const root = makeTempDir();
  try {
    const home = path.join(root, "home");
    const projectPath = "/private/project";
    writeCodexCorpus(home, projectPath);

    const bundle = buildEpisodeCandidates({ homeDir: home, projectPath });
    assert.equal(bundle.coverage.tools.codex.session_count, 1);
    const codexUserMessages = bundle.episode_candidates.reduce(
      (sum, episode) => sum + episode.signals.user_message_count,
      0,
    );
    // The response_item mirror of the same prompt must not double-count it.
    assert.equal(codexUserMessages, 1);
    const toolEvents = bundle.episode_candidates.reduce((sum, episode) => sum + episode.signals.tool_event_count, 0);
    assert.ok(toolEvents >= 1, "function_call/function_call_output records should classify as tool events");
  } finally {
    cleanup(root);
  }
});

test("claude tool results, sidechain, sdk prompts, command wrappers, and queue ops are not human prompts", () => {
  const root = makeTempDir();
  try {
    const home = path.join(root, "home");
    const projectPath = "/private/project";
    writeClaudeCorpus(home, projectPath, { includeSubagent: false });

    const bundle = buildEpisodeCandidates({ homeDir: home, projectPath });
    assert.equal(bundle.coverage.tools.claude.session_count, 1);
    const claudeUserMessages = bundle.episode_candidates.reduce(
      (sum, episode) => sum + episode.signals.user_message_count,
      0,
    );
    // Exactly the two real typed prompts; the tool_result, interrupt marker,
    // sdk prompt, command wrapper, and queued prompt are all excluded.
    assert.equal(claudeUserMessages, 2);
    const dropped = bundle.coverage.tools.claude.dropped_reasons;
    assert.ok((dropped.queue_operation_skipped ?? 0) >= 1, "queue-operation lines must be skipped");
    const metadata = bundle.session_metadata.find((session) => session.agent_type === "claude");
    assert.ok(metadata?.first_prompt?.includes("failing login test"), "first_prompt must be the first typed prompt");
    assert.equal(JSON.stringify(bundle).includes("Queued follow-up instruction"), false);
  } finally {
    cleanup(root);
  }
});

test("subagent transcripts are excluded from session counts but their tokens still count", () => {
  const root = makeTempDir();
  try {
    const home = path.join(root, "home");
    const projectPath = "/private/project";
    writeClaudeCorpus(home, projectPath, { includeSubagent: true });

    const bundle = buildEpisodeCandidates({ homeDir: home, projectPath });
    // One main session; the subagents/agent-1.jsonl file no longer counts.
    assert.equal(bundle.coverage.tools.claude.session_count, 1);
    assert.equal(bundle.analysis_manifest.session_count, 1);
    const subagentMetadata = bundle.session_metadata.filter((session) => session.is_subagent);
    assert.ok(subagentMetadata.length >= 1, "subagent session metadata is kept, flagged");

    const metrics = buildActualMetrics({ homeDir: home, projectPath });
    assert.equal(metrics.vibe_metrics.metrics_coverage.tools.claude.session_count, 1);
    // Main session usage (610 + 620) + subagent usage (175); the fake
    // 999999-token usage nested in toolUseResult must NOT be counted.
    assert.equal(metrics.vibe_metrics.token_sources.claude.total_tokens, 1405);
  } finally {
    cleanup(root);
  }
});

test("archived codex sessions are part of the episode population", () => {
  const root = makeTempDir();
  try {
    const home = path.join(root, "home");
    const projectPath = "/private/project";
    writeCodexCorpus(home, projectPath);
    writeLegacyCodexCorpus(home, projectPath);

    const bundle = buildEpisodeCandidates({ homeDir: home, projectPath });
    assert.equal(bundle.coverage.tools.codex.session_count, 2);

    const metrics = buildActualMetrics({ homeDir: home, projectPath });
    assert.equal(metrics.vibe_metrics.metrics_coverage.tools.codex.session_count, 2);
    assert.equal(metrics.vibe_metrics.token_sources.codex.total_tokens, 5000);
  } finally {
    cleanup(root);
  }
});

test("git metrics are author-filtered and never serialize emails", () => {
  const root = makeTempDir();
  try {
    const repo = path.join(root, "repo");
    initRepo(repo, "builder@example.com", "Builder One");
    commitFile(repo, "mine.ts", "export const mine = 1;\nexport const more = 2;\n", "Add mine");
    commitFile(repo, "theirs.ts", "export const theirs = 1;\n", "Add theirs", {
      GIT_AUTHOR_EMAIL: "teammate@example.com",
      GIT_AUTHOR_NAME: "Teammate Two",
      GIT_COMMITTER_EMAIL: "teammate@example.com",
      GIT_COMMITTER_NAME: "Teammate Two",
    });

    const metrics = gitAggregateMetrics({ projectPath: repo });
    assert.equal(metrics.git_metrics?.commit_count, 1, "only the configured author's commit counts");
    assert.equal(metrics.git_metrics?.lines_added, 2);
    const serialized = JSON.stringify(metrics);
    assert.equal(serialized.includes("@"), false, "no email may appear anywhere in git metrics");
    assert.equal(serialized.includes("Builder One"), false);
  } finally {
    cleanup(root);
  }
});

test("weekend share bins commits in the author's local clock, not UTC", () => {
  const root = makeTempDir();
  try {
    const repo = path.join(root, "repo");
    initRepo(repo, "builder@example.com", "Builder One");
    // Friday 23:30 local (-07:00) = Saturday 06:30 UTC. Local says weekday.
    const fridayLocal = "2026-06-05T23:30:00-07:00";
    commitFile(repo, "late.ts", "export const late = 1;\n", "Late Friday work", {
      GIT_AUTHOR_DATE: fridayLocal,
      GIT_COMMITTER_DATE: fridayLocal,
    });

    const metrics = gitAggregateMetrics({ projectPath: repo });
    assert.equal(metrics.git_metrics?.commit_count, 1);
    assert.equal(metrics.git_metrics?.velocity?.weekend_share, 0);
  } finally {
    cleanup(root);
  }
});

test("remote-keyed scope keeps worktree sessions and drops same-name sibling repos", () => {
  const root = makeTempDir();
  try {
    const home = path.join(root, "home");
    const repoA = path.join(root, "widget");
    const worktree = path.join(root, "widget-wt");
    const sibling = path.join(root, "widget-clone");

    initRepo(repoA, "builder@example.com", "Builder One");
    commitFile(repoA, "a.ts", "export const a = 1;\n", "Init widget");
    git(repoA, ["remote", "add", "origin", "https://github.com/acme/widget.git"]);
    git(repoA, ["worktree", "add", worktree, "-b", "wt-branch"]);

    initRepo(sibling, "builder@example.com", "Builder One");
    commitFile(sibling, "b.ts", "export const b = 1;\n", "Init clone");
    git(sibling, ["remote", "add", "origin", "git@github.com:other/unrelated.git"]);

    writeClaudeCorpus(home, repoA, { includeSubagent: false, sessionFileName: "session-a.jsonl" });
    writeClaudeCorpus(home, worktree, {
      includeSubagent: false,
      projectDirName: claudeProjectDirName(worktree),
      sessionFileName: "session-wt.jsonl",
    });
    writeClaudeCorpus(home, sibling, {
      includeSubagent: false,
      projectDirName: claudeProjectDirName(sibling),
      sessionFileName: "session-clone.jsonl",
    });

    const discovery = discoverLocalSources({ homeDir: home, projectPath: repoA });
    // repoA session + its worktree session stay; the same-name sibling repo
    // with a different remote is dropped.
    assert.equal(discovery.tools.claude.session_count, 2);
    assert.ok((discovery.tools.claude.dropped_reasons.outside_selected_project ?? 0) >= 1);
  } finally {
    cleanup(root);
  }
});

const sqliteAvailable = spawnSync("sqlite3", ["-version"], { encoding: "utf8" }).status === 0;

if (sqliteAvailable) {
  test("cursor reads workspaceStorage DBs, dedupes composers, and reports bubble tokenCount", () => {
    const root = makeTempDir();
    try {
      const projectPath = "/private/project";
      const sqlString = (value: string) => `'${value.replace(/'/g, "''")}'`;
      const composer = JSON.stringify({ workspacePath: projectPath });

      const globalDb = path.join(root, "global.vscdb");
      execFileSync("sqlite3", [globalDb], {
        input: [
          "CREATE TABLE cursorDiskKV(key TEXT PRIMARY KEY, value TEXT);",
          `INSERT INTO cursorDiskKV VALUES('composerData:shared', ${sqlString(composer)});`,
          `INSERT INTO cursorDiskKV VALUES('bubbleId:shared:1', ${sqlString(JSON.stringify({ type: 1, text: "Global copy", createdAt: "2026-06-09T12:00:00Z" }))});`,
          `INSERT INTO cursorDiskKV VALUES('composerData:global-only', ${sqlString(composer)});`,
          `INSERT INTO cursorDiskKV VALUES('bubbleId:global-only:1', ${sqlString(JSON.stringify({ type: 1, text: "Global only chat", createdAt: "2026-06-09T13:00:00Z" }))});`,
        ].join("\n"),
      });

      const workspaceDir = path.join(root, "workspaceStorage");
      const wsDbDir = path.join(workspaceDir, "ws-1");
      mkdirSync(wsDbDir, { recursive: true });
      const wsDb = path.join(wsDbDir, "state.vscdb");
      execFileSync("sqlite3", [wsDb], {
        input: [
          "CREATE TABLE cursorDiskKV(key TEXT PRIMARY KEY, value TEXT);",
          `INSERT INTO cursorDiskKV VALUES('composerData:shared', ${sqlString(composer)});`,
          `INSERT INTO cursorDiskKV VALUES('bubbleId:shared:1', ${sqlString(JSON.stringify({ type: 1, text: "Workspace copy", createdAt: "2026-06-09T12:00:00Z", tokenCount: { inputTokens: 100, outputTokens: 50 } }))});`,
          `INSERT INTO cursorDiskKV VALUES('bubbleId:shared:2', ${sqlString(JSON.stringify({ type: 2, text: "Reply", createdAt: "2026-06-09T12:05:00Z", tokenCount: { inputTokens: 0, outputTokens: 0 } }))});`,
        ].join("\n"),
      });

      const metrics = buildActualMetrics({
        homeDir: path.join(root, "home-empty"),
        projectPath,
        cursorDbPath: globalDb,
        cursorWorkspaceStorageDir: workspaceDir,
      });
      const cursor = metrics.vibe_metrics.metrics_coverage.tools.cursor;
      // 'shared' deduped (workspace copy wins) + 'global-only' = 2 sessions.
      assert.equal(cursor.session_count, 2);
      assert.equal(metrics.vibe_metrics.token_sources.cursor.status, "provider_reported");
      assert.equal(metrics.vibe_metrics.token_sources.cursor.total_tokens, 150);
      assert.equal(cursor.warnings.includes("cursor_provider_tokens_unavailable"), false);
    } finally {
      cleanup(root);
    }
  });
} else {
  test("cursor reads workspaceStorage DBs, dedupes composers, and reports bubble tokenCount", { skip: "sqlite3 not installed" }, () => {});
}
