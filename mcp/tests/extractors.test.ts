import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import { buildActualMetrics, buildEpisodeCandidates, discoverLocalSources, gitAggregateMetrics } from "../src/extractors.ts";
import { scanProfileForLeaks } from "../src/submit.ts";

function makeTempDir(): string {
  return mkdtempSync(path.join(tmpdir(), "viber-extractors-"));
}

function cleanup(dir: string): void {
  rmSync(dir, { recursive: true, force: true });
}

function sqlString(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

async function startCursorWalDb(root: string, projectPath: string): Promise<{ dbPath: string; close: () => Promise<void> }> {
  const dbPath = path.join(root, "state.vscdb");
  const proc = spawn("sqlite3", [dbPath], { stdio: ["pipe", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  proc.stdout.setEncoding("utf8");
  proc.stderr.setEncoding("utf8");
  proc.stdout.on("data", (chunk) => {
    stdout += chunk;
  });
  proc.stderr.on("data", (chunk) => {
    stderr += chunk;
  });

  const ready = new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`sqlite3 WAL fixture did not become ready: ${stderr}`)), 5000);
    proc.once("exit", (code) => {
      clearTimeout(timeout);
      reject(new Error(`sqlite3 WAL fixture exited before ready with code ${code}: ${stderr}`));
    });
    const poll = setInterval(() => {
      if (stdout.includes("__READY__")) {
        clearTimeout(timeout);
        clearInterval(poll);
        resolve();
      }
    }, 25);
  });

  const composer = JSON.stringify({ workspacePath: projectPath });
  const userBubble = JSON.stringify({
    type: 1,
    text: "Use the existing plan, avoid broad refactors, and add tests.",
    createdAt: "2026-06-09T12:00:00Z",
    codeBlocks: [],
  });
  const assistantBubble = JSON.stringify({
    type: 2,
    text: "I will keep the change scoped and verify with tests.",
    createdAt: "2026-06-09T12:01:00Z",
    codeBlocks: [{ text: "function example() { return true; }" }],
  });
  proc.stdin.write(
    [
      "PRAGMA journal_mode=WAL;",
      "PRAGMA wal_autocheckpoint=0;",
      "CREATE TABLE cursorDiskKV(key TEXT PRIMARY KEY, value TEXT);",
      `INSERT INTO cursorDiskKV VALUES('composerData:abc', ${sqlString(composer)});`,
      `INSERT INTO cursorDiskKV VALUES('bubbleId:abc:1', ${sqlString(userBubble)});`,
      `INSERT INTO cursorDiskKV VALUES('bubbleId:abc:2', ${sqlString(assistantBubble)});`,
      ".print __READY__",
    ].join("\n") + "\n",
  );
  await ready;

  return {
    dbPath,
    close: async () => {
      if (proc.exitCode !== null) {
        return;
      }
      try {
        proc.stdin.end(".exit\n");
      } catch {
        // Process may have exited between the exitCode check and stdin write.
      }
      await new Promise<void>((resolve) => {
        const startedAt = Date.now();
        const timer = setInterval(() => {
          if (proc.exitCode !== null || Date.now() - startedAt > 1000) {
            clearInterval(timer);
            if (proc.exitCode === null) {
              proc.kill("SIGTERM");
            }
            resolve();
          }
        }, 25);
        setTimeout(() => {
          if (proc.exitCode === null) {
            proc.kill("SIGTERM");
          }
        }, 1000);
      });
    },
  };
}

test("discovers project-scoped Claude and Codex sessions without leaking paths", () => {
  const root = makeTempDir();
  try {
    const home = path.join(root, "home");
    const projectPath = "/private/project";
    const claudeDir = path.join(home, ".claude", "projects", "-private-project");
    const codexDir = path.join(home, ".codex", "sessions", "2026", "06", "09");
    mkdirSync(claudeDir, { recursive: true });
    mkdirSync(codexDir, { recursive: true });
    writeFileSync(
      path.join(claudeDir, "session.jsonl"),
      [
        JSON.stringify({
          type: "user",
          timestamp: "2026-06-09T10:00:00Z",
          message: { content: "Please fix the failing test in /private/project/src/app.ts and verify it." },
        }),
        JSON.stringify({
          type: "assistant",
          timestamp: "2026-06-09T10:02:00Z",
          message: { content: "I found the issue and will run the focused test." },
        }),
      ].join("\n"),
    );
    writeFileSync(
      path.join(codexDir, "rollout-1.jsonl"),
      [
        JSON.stringify({
          cwd: projectPath,
          role: "user",
          timestamp: "2026-06-09T11:00:00Z",
          content: "Review the diff, keep scope tight, and run typecheck.",
        }),
        JSON.stringify({
          role: "assistant",
          timestamp: "2026-06-09T11:03:00Z",
          content: "I'll check the behavior and avoid unrelated edits.",
        }),
      ].join("\n"),
    );

    const discovery = discoverLocalSources({ homeDir: home, projectPath });
    assert.equal(discovery.project_scope.single_project, true);
    assert.equal(discovery.project_scope.repos_considered, 1);
    assert.equal(discovery.tools.claude.session_count, 1);
    assert.equal(discovery.tools.codex.session_count, 1);

    const bundle = buildEpisodeCandidates({ homeDir: home, projectPath });
    assert.equal(bundle.episode_candidates.length, 2);
    assert.ok(bundle.session_metadata.every((session) => /^[a-f0-9]{16,64}$/.test(session.session_ref)));
    const serialized = JSON.stringify(bundle);
    assert.equal(serialized.includes(projectPath), false);
    assert.equal(serialized.includes("src/app.ts"), false);
  } finally {
    cleanup(root);
  }
});

const sqliteAvailable = spawnSync("sqlite3", ["-version"], { encoding: "utf8" }).status === 0;

if (sqliteAvailable) {
  test("extracts Cursor bubble rows from cursorDiskKV in read-only sqlite mode", () => {
    const root = makeTempDir();
    try {
      const dbPath = path.join(root, "state.vscdb");
      const projectPath = "/private/project";
      const composer = JSON.stringify({ workspacePath: projectPath });
      const userBubble = JSON.stringify({
        type: 1,
        text: "Use the existing plan, avoid broad refactors, and add tests.",
        createdAt: "2026-06-09T12:00:00Z",
        codeBlocks: [],
      });
      const assistantBubble = JSON.stringify({
        type: 2,
        text: "I will keep the change scoped and verify with tests.",
        createdAt: "2026-06-09T12:01:00Z",
        codeBlocks: [{ text: "function example() { return true; }" }],
      });
      execFileSync("sqlite3", [dbPath], {
        input: [
          "CREATE TABLE cursorDiskKV(key TEXT PRIMARY KEY, value TEXT);",
          `INSERT INTO cursorDiskKV VALUES('composerData:abc', ${sqlString(composer)});`,
          `INSERT INTO cursorDiskKV VALUES('bubbleId:abc:1', ${sqlString(userBubble)});`,
          `INSERT INTO cursorDiskKV VALUES('bubbleId:abc:2', ${sqlString(assistantBubble)});`,
        ].join("\n"),
      });

      const bundle = buildEpisodeCandidates({ homeDir: root, projectPath, cursorDbPath: dbPath });
      assert.equal(bundle.coverage.tools.cursor.session_count, 1);
      assert.equal(bundle.episode_candidates.length, 1);
      assert.equal(bundle.episode_candidates[0].signals.code_block_count >= 1, true);
      assert.equal(JSON.stringify(bundle).includes(projectPath), false);
    } finally {
      cleanup(root);
    }
  });
} else {
  test("extracts Cursor bubble rows from cursorDiskKV in read-only sqlite mode", { skip: "sqlite3 not installed" }, () => {});
}

if (sqliteAvailable) {
  test("extracts Cursor rows when cursorDiskKV is visible only through WAL", async () => {
    const root = makeTempDir();
    let walDb: { dbPath: string; close: () => Promise<void> } | undefined;
    try {
      const projectPath = "/private/project";
      walDb = await startCursorWalDb(root, projectPath);

      const bundle = buildEpisodeCandidates({ homeDir: root, projectPath, cursorDbPath: walDb.dbPath });
      assert.equal(bundle.coverage.tools.cursor.session_count, 1);
      assert.equal(bundle.episode_candidates.length, 1);
      assert.equal(bundle.episode_candidates[0].signals.code_block_count >= 1, true);

      const actual = buildActualMetrics({ homeDir: root, projectPath, cursorDbPath: walDb.dbPath });
      assert.equal(actual.vibe_metrics.metrics_coverage.tools.cursor.session_count, 1);
      assert.equal(actual.vibe_metrics.metrics_coverage.tools.cursor.timestamped_event_count, 2);
      assert.equal(scanProfileForLeaks(actual).clean, true);
    } finally {
      await walDb?.close();
      cleanup(root);
    }
  });
} else {
  test("extracts Cursor rows when cursorDiskKV is visible only through WAL", { skip: "sqlite3 not installed" }, () => {});
}

if (sqliteAvailable) {
  test("skips Cursor DBs without cursorDiskKV using redaction-safe warnings", () => {
    const root = makeTempDir();
    try {
      const dbPath = path.join(root, "state.vscdb");
      execFileSync("sqlite3", [dbPath], {
        input: "CREATE TABLE ItemTable(key TEXT PRIMARY KEY, value TEXT);\n",
      });

      const actual = buildActualMetrics({ homeDir: root, projectPath: "/private/project", cursorDbPath: dbPath });
      assert.equal(actual.vibe_metrics.metrics_coverage.tools.cursor.session_count, 0);
      assert.ok(actual.vibe_metrics.warnings.includes("cursor-state-schema-unsupported"));
      assert.equal(JSON.stringify(actual).includes("cursorDiskKV"), false);
      assert.equal(scanProfileForLeaks(actual).clean, true);

      const bundle = buildEpisodeCandidates({ homeDir: root, projectPath: "/private/project", cursorDbPath: dbPath });
      assert.equal(bundle.coverage.tools.cursor.session_count, 0);
    } finally {
      cleanup(root);
    }
  });
} else {
  test("skips Cursor DBs without cursorDiskKV using redaction-safe warnings", { skip: "sqlite3 not installed" }, () => {});
}

if (sqliteAvailable) {
  test("buildActualMetrics computes uncapped provider totals and coverage without leaking scope", () => {
    const root = makeTempDir();
    try {
      const home = path.join(root, "home");
      const projectPath = "/private/project";
      const claudeDir = path.join(home, ".claude", "projects", "-private-project");
      const codexDir = path.join(home, ".codex", "sessions", "2026", "06", "09");
      const codexArchiveDir = path.join(home, ".codex", "archived_sessions");
      // Period assertions are relative to the real clock; fixed dates would
      // flake whenever the suite runs near a UTC day boundary.
      const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();
      mkdirSync(claudeDir, { recursive: true });
      mkdirSync(codexDir, { recursive: true });
      mkdirSync(codexArchiveDir, { recursive: true });

      writeFileSync(
        path.join(claudeDir, "session.jsonl"),
        [
          JSON.stringify({
            type: "assistant",
            timestamp: minutesAgo(10),
            message: {
              usage: {
                input_tokens: 100,
                cache_creation_input_tokens: 50,
                cache_read_input_tokens: 200,
                output_tokens: 20,
              },
              content: "Scoped work.",
            },
          }),
          JSON.stringify({
            type: "assistant",
            timestamp: minutesAgo(5),
            message: {
              usage: {
                input_tokens: 10,
                cache_creation_input_tokens: 0,
                cache_read_input_tokens: 20,
                output_tokens: 5,
              },
              content: "Verified work.",
            },
          }),
        ].join("\n"),
      );
      writeFileSync(
        path.join(codexDir, "rollout-1.jsonl"),
        [
          JSON.stringify({
            timestamp: minutesAgo(20),
            payload: { cwd: projectPath, info: { total_token_usage: { total_tokens: 1000, input_tokens: 900, output_tokens: 100 } } },
          }),
          JSON.stringify({
            timestamp: minutesAgo(15),
            payload: { info: { total_token_usage: { total_tokens: 2500, input_tokens: 2300, output_tokens: 200 } } },
          }),
        ].join("\n"),
      );
      writeFileSync(
        path.join(codexArchiveDir, "rollout-archived.jsonl"),
        [
          JSON.stringify({
            timestamp: minutesAgo(25 * 60),
            payload: { cwd: projectPath, info: { total_token_usage: { total_tokens: 700, input_tokens: 650, output_tokens: 50 } } },
          }),
          JSON.stringify({
            timestamp: minutesAgo(25 * 60 - 1),
            payload: { info: { total_token_usage: { total_tokens: 900, input_tokens: 830, output_tokens: 70 } } },
          }),
        ].join("\n"),
      );

      const dbPath = path.join(root, "state.vscdb");
      execFileSync("sqlite3", [dbPath], {
        input: [
          "CREATE TABLE cursorDiskKV(key TEXT UNIQUE ON CONFLICT REPLACE, value TEXT);",
          `INSERT INTO cursorDiskKV VALUES('composerData:cursor-composer', ${sqlString(JSON.stringify({ workspacePath: projectPath }))});`,
          `INSERT INTO cursorDiskKV VALUES('bubbleId:cursor-composer:1', ${sqlString(JSON.stringify({ createdAt: minutesAgo(30), text: "One" }))});`,
          `INSERT INTO cursorDiskKV VALUES('bubbleId:cursor-composer:2', ${sqlString(JSON.stringify({ createdAt: minutesAgo(25), text: "Two" }))});`,
        ].join("\n"),
      });

      const actual = buildActualMetrics({ homeDir: home, projectPath, cursorDbPath: dbPath });

      assert.equal(actual.vibe_metrics.metrics_scope, "all_project_sessions_uncapped");
      assert.equal(actual.vibe_metrics.metrics_coverage.tools.claude.session_count, 1);
      assert.equal(actual.vibe_metrics.metrics_coverage.tools.codex.session_count, 2);
      assert.equal(actual.vibe_metrics.metrics_coverage.tools.cursor.session_count, 1);
      assert.equal(actual.vibe_metrics.token_sources.claude.status, "provider_reported");
      assert.equal(actual.vibe_metrics.token_sources.codex.status, "provider_reported");
      assert.equal(actual.vibe_metrics.token_sources.cursor.status, "unavailable");
      assert.equal(actual.vibe_metrics.token_sources.claude.total_tokens, 405);
      assert.equal(actual.vibe_metrics.token_sources.codex.total_tokens, 3400);
      assert.equal(actual.vibe_metrics.total_tokens, 3805);
      assert.equal(actual.vibe_metrics.provider_tokens_by_period.today, 2905);
      // The archived session sits ~25h back: inside this_week unless the suite
      // runs on a Monday, so assert the safe range.
      assert.equal(actual.vibe_metrics.provider_tokens_by_period.this_week >= 2905, true);
      assert.equal(actual.vibe_metrics.provider_tokens_by_period.this_week <= 3805, true);
      assert.equal(actual.vibe_metrics.provider_tokens_by_period.this_year <= actual.vibe_metrics.total_tokens, true);
      assert.equal(actual.vibe_metrics.total_vibe_agent_hours > 0, true);
      assert.equal(actual.vibe_metrics.total_active_calendar_hours > 0, true);
      assert.equal(actual.vibe_metrics.vibe_agent_hours_by_period.today > 0, true);
      assert.equal(
        actual.vibe_metrics.active_calendar_hours_by_period.this_year <= actual.vibe_metrics.total_active_calendar_hours,
        true,
      );

      const serialized = JSON.stringify(actual);
      assert.equal(serialized.includes(projectPath), false);
      assert.equal(serialized.includes("cursor-composer"), false);
      assert.equal(serialized.includes("rollout-1"), false);
    } finally {
      cleanup(root);
    }
  });
} else {
  test("buildActualMetrics computes uncapped provider totals and coverage without leaking scope", { skip: "sqlite3 not installed" }, () => {});
}

test("gitAggregateMetrics returns aggregate stats without hashes, authors, or paths", () => {
  const root = makeTempDir();
  try {
    const repo = path.join(root, "repo");
    mkdirSync(path.join(repo, "src"), { recursive: true });
    execFileSync("git", ["-C", repo, "init"], { stdio: "ignore" });
    execFileSync("git", ["-C", repo, "config", "user.email", "dev@example.com"]);
    execFileSync("git", ["-C", repo, "config", "user.name", "Dev User"]);
    writeFileSync(path.join(repo, "src", "main.ts"), "export const value = 1;\n");
    execFileSync("git", ["-C", repo, "add", "."]);
    execFileSync("git", ["-C", repo, "commit", "-m", "Add src/main.ts"], { stdio: "ignore" });

    const metrics = gitAggregateMetrics({ projectPath: repo });
    assert.equal(metrics.project_scope.repos_considered, 1);
    assert.equal(metrics.git_metrics?.commit_count, 1);
    assert.equal(metrics.git_metrics?.extension_histogram.ts, 1);
    const serialized = JSON.stringify(metrics);
    assert.equal(serialized.includes("dev@example.com"), false);
    assert.equal(serialized.includes("Dev User"), false);
    assert.equal(serialized.includes("src/main.ts"), false);
  } finally {
    cleanup(root);
  }
});

test("gitAggregateMetrics counts committed, tracked working-tree, and untracked code LOC without leaking paths", () => {
  const root = makeTempDir();
  try {
    const repo = path.join(root, "repo");
    mkdirSync(path.join(repo, "src"), { recursive: true });
    mkdirSync(path.join(repo, "reference", "yc"), { recursive: true });
    mkdirSync(path.join(repo, "tmp"), { recursive: true });
    execFileSync("git", ["-C", root, "init", repo], { stdio: "ignore" });
    execFileSync("git", ["-C", repo, "config", "user.email", "dev@example.com"]);
    execFileSync("git", ["-C", repo, "config", "user.name", "Dev User"]);
    writeFileSync(path.join(repo, "src", "main.ts"), "export const committed = 1;\n");
    execFileSync("git", ["-C", repo, "add", "."]);
    execFileSync("git", ["-C", repo, "commit", "-m", "Add initial code"], {
      stdio: "ignore",
      env: {
        ...process.env,
        GIT_AUTHOR_DATE: "2026-06-09T12:00:00+00:00",
        GIT_COMMITTER_DATE: "2026-06-09T12:00:00+00:00",
      },
    });

    writeFileSync(
      path.join(repo, "src", "main.ts"),
      "export const committed = 1;\nexport const tracked = 2;\nexport const more = 3;\n",
    );
    writeFileSync(path.join(repo, "src", "untracked.ts"), "export const one = 1;\nexport const two = 2;\nexport const three = 3;\n");
    writeFileSync(path.join(repo, "reference", "yc", "upload.sh"), "ignored\nignored\nignored\n");
    writeFileSync(path.join(repo, "tmp", "scratch.ts"), "ignored\nignored\n");
    writeFileSync(path.join(repo, ".env"), "SECRET=value\n");

    const metrics = gitAggregateMetrics({ projectPath: repo, now: new Date("2026-06-10T12:00:00Z") });
    assert.equal(metrics.git_metrics?.vibe_loc_sources?.committed, 1);
    assert.equal(metrics.git_metrics?.vibe_loc_sources?.tracked_working_tree, 2);
    assert.equal(metrics.git_metrics?.vibe_loc_sources?.untracked, 3);
    assert.equal(metrics.git_metrics?.lines_added, 6);
    assert.equal(metrics.git_metrics?.vibe_loc_by_period.today, 5);

    const actual = buildActualMetrics({ homeDir: path.join(root, "empty-home"), projectPath: repo, now: new Date("2026-06-10T12:00:00Z") });
    assert.equal(actual.vibe_metrics.total_vibe_loc, 6);
    assert.deepEqual(actual.vibe_metrics.vibe_loc_sources, {
      committed: 1,
      tracked_working_tree: 2,
      untracked: 3,
    });

    const serialized = JSON.stringify(actual);
    assert.equal(serialized.includes("untracked.ts"), false);
    assert.equal(serialized.includes("reference"), false);
    assert.equal(serialized.includes("SECRET"), false);
    assert.equal(serialized.includes("dev@example.com"), false);
  } finally {
    cleanup(root);
  }
});

test("vibe LOC local periods include the builder's local day while UTC periods stay global", () => {
  const previousTz = process.env.TZ;
  process.env.TZ = "America/Los_Angeles";
  const root = makeTempDir();
  try {
    const repo = path.join(root, "repo");
    mkdirSync(path.join(repo, "src"), { recursive: true });
    execFileSync("git", ["-C", root, "init", repo], { stdio: "ignore" });
    execFileSync("git", ["-C", repo, "config", "user.email", "dev@example.com"]);
    execFileSync("git", ["-C", repo, "config", "user.name", "Dev User"]);
    writeFileSync(path.join(repo, "src", "main.ts"), "export const local = 1;\nexport const day = 2;\n");
    execFileSync("git", ["-C", repo, "add", "."]);
    execFileSync("git", ["-C", repo, "commit", "-m", "Local day work"], {
      stdio: "ignore",
      env: {
        ...process.env,
        GIT_AUTHOR_DATE: "2026-06-09T09:01:07-07:00",
        GIT_COMMITTER_DATE: "2026-06-09T09:01:07-07:00",
      },
    });

    const metrics = gitAggregateMetrics({ projectPath: repo, now: new Date("2026-06-10T04:39:54Z") });
    assert.equal(metrics.git_metrics?.vibe_loc_by_period.today, 0);
    assert.equal(metrics.git_metrics?.vibe_loc_by_period.this_week, 2);
    assert.equal(metrics.git_metrics?.vibe_loc_by_local_period?.today, 2);
    assert.equal(metrics.git_metrics?.metrics_timezone, "UTC-07:00");
  } finally {
    if (previousTz === undefined) {
      delete process.env.TZ;
    } else {
      process.env.TZ = previousTz;
    }
    cleanup(root);
  }
});
