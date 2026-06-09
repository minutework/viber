import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import { buildWrappedAggregates } from "../src/aggregates.ts";
import { writeClaudeCorpus, writeCodexCorpus } from "./fixture-corpus.ts";

function makeTempDir(): string {
  return mkdtempSync(path.join(tmpdir(), "viber-aggregates-"));
}

function cleanup(dir: string): void {
  rmSync(dir, { recursive: true, force: true });
}

function initRepoWithCommits(repo: string): void {
  mkdirSync(repo, { recursive: true });
  execFileSync("git", ["init", repo], { stdio: "ignore" });
  const git = (args: string[], env: Record<string, string> = {}) =>
    execFileSync("git", ["-C", repo, ...args], { stdio: "ignore", env: { ...process.env, ...env } });
  git(["config", "user.email", "builder@example.com"]);
  git(["config", "user.name", "Builder One"]);
  git(["config", "commit.gpgsign", "false"]);
  const commit = (file: string, content: string, message: string, date: string) => {
    writeFileSync(path.join(repo, file), content);
    git(["add", "."]);
    git(["commit", "-m", message], { GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date });
  };
  commit("a.ts", "export const a = 1;\nexport const b = 2;\n", "Add feature module", "2026-06-01T10:00:00-07:00");
  commit("a.ts", "export const a = 1;\n", "Fix feature regression", "2026-06-01T22:30:00-07:00");
  commit("c.ts", "export const c = 1;\nexport const d = 2;\nexport const e = 3;\n", "Add helper", "2026-06-03T11:00:00-07:00");
}

test("buildWrappedAggregates produces schema-shaped aggregate blocks over the fixture corpus", () => {
  const root = makeTempDir();
  try {
    const home = path.join(root, "home");
    const repo = path.join(root, "repo");
    initRepoWithCommits(repo);
    // Sessions are scoped by directory-name match against the repo path.
    writeClaudeCorpus(home, repo, { includeSubagent: true });
    writeCodexCorpus(home, repo);

    const aggregates = buildWrappedAggregates({ homeDir: home, projectPath: repo });

    // Git histograms: 24/7 bins, local-clock binning (22:30-07:00 commit lands at hour 22).
    assert.equal(aggregates.git_extra.commit_hour_histogram_local?.length, 24);
    assert.equal(aggregates.git_extra.commit_hour_histogram_local?.[22], 1);
    assert.equal(aggregates.git_extra.commits_by_weekday_local?.length, 7);
    assert.equal(aggregates.git_extra.night_owl_share, Math.round((1 / 3) * 10_000) / 10_000);
    assert.ok(aggregates.git_extra.biggest_push, "biggest_push present");
    assert.equal(aggregates.git_extra.biggest_push?.lines_added, 3);
    assert.equal(aggregates.git_extra.pr_metrics?.source, "merge_commit_heuristic");

    // Model usage: claude opus + codex gpt families, session-counted.
    const families = (aggregates.vibe_extra.model_usage ?? []).map((entry) => entry.model_family).sort();
    assert.deepEqual(families, ["GPT-5.5", "Opus 4.8"]);

    // Plan mode: claude permissionMode plan + codex collaboration plan both feed shares.
    assert.ok((aggregates.vibe_extra.plan_mode?.plan_prompts_share ?? 0) > 0);
    assert.ok((aggregates.vibe_extra.plan_mode?.sessions_entering_plan_share ?? 0) > 0);

    // Interruption: 1 claude marker + 1 codex turn_aborted.
    assert.equal(aggregates.vibe_extra.interruption?.interrupt_count, 2);

    // Prompt stats: only the 2 claude human prompts + 1 codex user_message count.
    assert.equal(aggregates.vibe_extra.prompt_stats?.prompt_count, 3);
    assert.equal(aggregates.vibe_extra.prompt_stats?.politeness?.please_message_count, 2);
    assert.equal(aggregates.vibe_extra.prompt_stats?.words_histogram?.length, 6);

    // Identity: streak across activity days; tool loyalty present.
    assert.ok((aggregates.identity_stats.longest_build_streak_days as number) >= 1);
    assert.ok(aggregates.identity_stats.first_contact, "first_contact present");

    // Economics: cache hit rate from codex cached_input_tokens (2500/5000 input side) and claude cache fields.
    assert.ok((aggregates.economics_stats.cache_hit_rate as number) > 0.3);
    // Commits add 2 + 0 (pure deletion) + 3 lines inside one 7-day window.
    assert.equal((aggregates.economics_stats.peak_ship_week as { lines_added: number }).lines_added, 5);

    // Orchestration: subagent transcript drives sidechain + delegation depth 2.
    assert.equal(aggregates.orchestration_stats.deepest_delegation_chain, 2);
    assert.ok((aggregates.orchestration_stats.sidechain_output_share as number) > 0);
    const autonomy = aggregates.orchestration_stats.autonomy as Record<string, number>;
    assert.equal(autonomy.codex_never_approval_share, 1);

    assert.equal(aggregates.classifier_version, "1.0.0");
  } finally {
    cleanup(root);
  }
});

test("wrapped aggregates serialize without text, paths, branch names, or emails", () => {
  const root = makeTempDir();
  try {
    const home = path.join(root, "home");
    const repo = path.join(root, "repo");
    initRepoWithCommits(repo);
    writeClaudeCorpus(home, repo, { includeSubagent: true });
    writeCodexCorpus(home, repo, { repositoryUrl: "https://github.com/acme/secret-repo.git" });

    const aggregates = buildWrappedAggregates({ homeDir: home, projectPath: repo });
    const serialized = JSON.stringify(aggregates);
    assert.equal(serialized.includes(repo), false, "project path must not appear");
    assert.equal(serialized.includes("codex/fixture-branch"), false, "branch name must not appear");
    assert.equal(serialized.includes("secret-repo"), false, "remote must not appear");
    assert.equal(serialized.includes("@"), false, "emails must not appear");
    assert.equal(serialized.includes("failing login test"), false, "prompt text must not appear");
    assert.equal(serialized.includes("Add feature module"), false, "commit subjects must not appear");
  } finally {
    cleanup(root);
  }
});

test("edit precision and test runs join tool_use to tool_result outcomes", () => {
  const root = makeTempDir();
  try {
    const home = path.join(root, "home");
    const projectPath = "/private/project";
    const projectDir = path.join(home, ".claude", "projects", "-private-project");
    mkdirSync(projectDir, { recursive: true });
    const lines = [
      {
        type: "user",
        timestamp: "2026-06-09T10:00:00Z",
        cwd: projectPath,
        message: { role: "user", content: "Fix the parser bug and prove it with the test suite." },
      },
      {
        type: "assistant",
        timestamp: "2026-06-09T10:01:00Z",
        message: {
          role: "assistant",
          model: "claude-opus-4-8",
          content: [
            { type: "tool_use", id: "tu_edit_1", name: "Edit", input: { file_path: "/private/project/src/parser.ts" } },
            { type: "tool_use", id: "tu_bash_1", name: "Bash", input: { command: "pnpm test" } },
          ],
        },
      },
      {
        type: "user",
        timestamp: "2026-06-09T10:02:00Z",
        message: {
          role: "user",
          content: [
            { type: "tool_result", tool_use_id: "tu_edit_1", content: [{ type: "text", text: "edit applied" }] },
            { type: "tool_result", tool_use_id: "tu_bash_1", content: [{ type: "text", text: "Tests: 2 failed, 10 passed" }] },
          ],
        },
      },
      {
        type: "assistant",
        timestamp: "2026-06-09T10:05:00Z",
        message: {
          role: "assistant",
          model: "claude-opus-4-8",
          content: [
            { type: "tool_use", id: "tu_edit_2", name: "Edit", input: { file_path: "/private/project/CLAUDE.md" } },
            { type: "tool_use", id: "tu_bash_2", name: "Bash", input: { command: "pnpm test" } },
          ],
        },
      },
      {
        type: "user",
        timestamp: "2026-06-09T10:09:00Z",
        message: {
          role: "user",
          content: [
            { type: "tool_result", tool_use_id: "tu_edit_2", is_error: true, content: [{ type: "text", text: "old_string not found" }] },
            { type: "tool_result", tool_use_id: "tu_bash_2", content: [{ type: "text", text: "12 passed in 3.2s" }] },
          ],
        },
      },
    ];
    writeFileSync(path.join(projectDir, "session-joins.jsonl"), lines.map((line) => JSON.stringify(line)).join("\n"));

    const aggregates = buildWrappedAggregates({ homeDir: home, projectPath });
    assert.equal(aggregates.craft_stats.edit_attempt_count, 2);
    assert.equal(aggregates.craft_stats.edit_precision_rate, 0.5);
    // red -> green: fail at 10:02, pass at 10:09 => 7 minutes.
    assert.equal(aggregates.craft_stats.red_to_green_median_minutes, 7);
    assert.equal(aggregates.craft_stats.red_to_green_sample_count, 1);
    // CLAUDE.md edit counts as context craft.
    assert.equal(aggregates.craft_stats.context_craft_edit_count, 1);
  } finally {
    cleanup(root);
  }
});
