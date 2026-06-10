/**
 * Measurement-session classification + exclusion regressions (schema 1.3.0).
 *
 * SHARED CONTRACT: a session is a measurement session iff its FIRST human
 * prompt starts with "Use the viber skill at " AND contains "submit_profile".
 * No keyword matching anywhere else in the transcript; subagent sessions
 * inherit the parent's classification. Measurement sessions are excluded
 * from EVERY normal metric (including provider tokens — a deliberate
 * divergence from the subagent precedent) and appear ONLY in
 * vibe_metrics.profile_analysis_overhead.
 */
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import { buildWrappedAggregates } from "../src/aggregates.ts";
import {
  buildActualMetrics,
  buildEpisodeCandidates,
  collectNormalizedSessions,
  discoverLocalSources,
  isMeasurementPrompt,
  MEASUREMENT_PROMPT_PREFIX,
} from "../src/extractors.ts";

const MEASUREMENT_PROMPT =
  "Use the viber skill at /private/tools/viber/skill/SKILL.md to analyze this machine's local " +
  "coding-agent transcripts for ONE chosen project and submit a Verifiable AI-Builder Profile via " +
  "the viber-mcp submit_profile tool. Read-only: do not modify any files.";

function makeTempDir(): string {
  return mkdtempSync(path.join(tmpdir(), "viber-measurement-"));
}

function cleanup(dir: string): void {
  rmSync(dir, { recursive: true, force: true });
}

function minutesAgo(minutes: number): string {
  return new Date(Date.now() - minutes * 60_000).toISOString();
}

function writeClaudeSession(
  home: string,
  projectPath: string,
  fileName: string,
  lines: Array<Record<string, unknown>>,
): string {
  const projectDir = path.join(home, ".claude", "projects", projectPath.replace(/[/.]/g, "-").replace(/^-?/, "-"));
  mkdirSync(projectDir, { recursive: true });
  const filePath = path.join(projectDir, fileName);
  writeFileSync(filePath, lines.map((line) => JSON.stringify(line)).join("\n"));
  return filePath;
}

function normalClaudeLines(projectPath: string): Array<Record<string, unknown>> {
  return [
    {
      type: "user",
      timestamp: minutesAgo(50),
      cwd: projectPath,
      message: { role: "user", content: "Please fix the failing login test and keep the change scoped." },
    },
    {
      type: "assistant",
      timestamp: minutesAgo(45),
      cwd: projectPath,
      message: {
        role: "assistant",
        model: "claude-opus-4-8",
        content: [{ type: "text", text: "Patched the validator and verified the suite." }],
        usage: { input_tokens: 100, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 30 },
      },
    },
  ];
}

function measurementClaudeLines(projectPath: string): Array<Record<string, unknown>> {
  return [
    {
      type: "user",
      timestamp: minutesAgo(30),
      cwd: projectPath,
      message: { role: "user", content: MEASUREMENT_PROMPT },
    },
    {
      type: "assistant",
      timestamp: minutesAgo(20),
      cwd: projectPath,
      message: {
        role: "assistant",
        model: "claude-haiku-4-5-20251001",
        content: [{ type: "text", text: "discover_local_sources" }],
        usage: { input_tokens: 1000, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 500 },
      },
    },
  ];
}

function measurementCodexLines(projectPath: string): Array<Record<string, unknown>> {
  return [
    { timestamp: minutesAgo(28), type: "session_meta", payload: { cwd: projectPath, originator: "codex_cli" } },
    { timestamp: minutesAgo(27), type: "turn_context", payload: { cwd: projectPath, model: "gpt-5.5" } },
    { timestamp: minutesAgo(26), type: "event_msg", payload: { type: "user_message", message: MEASUREMENT_PROMPT } },
    {
      timestamp: minutesAgo(18),
      type: "event_msg",
      payload: {
        type: "token_count",
        info: { total_token_usage: { total_tokens: 2000, input_tokens: 1500, output_tokens: 500 } },
      },
    },
  ];
}

test("isMeasurementPrompt follows the shared contract exactly", () => {
  assert.equal(isMeasurementPrompt(MEASUREMENT_PROMPT), true);
  assert.equal(isMeasurementPrompt(`   ${MEASUREMENT_PROMPT}`), true, "leading whitespace is tolerated");
  assert.equal(isMeasurementPrompt(undefined), false);
  assert.equal(isMeasurementPrompt(""), false);
  assert.equal(
    isMeasurementPrompt(`${MEASUREMENT_PROMPT_PREFIX}/tmp/skill/SKILL.md and do something else entirely.`),
    false,
    "prefix without submit_profile must not classify",
  );
  assert.equal(
    isMeasurementPrompt("Please call submit_profile after you use the viber skill at /tmp/skill."),
    false,
    "submit_profile without the exact prefix must not classify",
  );
});

test("the canonical bootstrap prompt classifies the session as a measurement session", () => {
  const root = makeTempDir();
  try {
    const home = path.join(root, "home");
    const projectPath = "/private/project";
    writeClaudeSession(home, projectPath, "session-measure.jsonl", measurementClaudeLines(projectPath));

    const collected = collectNormalizedSessions({ homeDir: home, projectPath });
    assert.equal(collected.sessions.length, 1);
    assert.equal(collected.sessions[0].measurementSession, true);
  } finally {
    cleanup(root);
  }
});

test("a viber-DEV session that merely discusses submit_profile / viber-mcp is NOT classified", () => {
  const root = makeTempDir();
  try {
    const home = path.join(root, "home");
    const projectPath = "/private/project";
    writeClaudeSession(home, projectPath, "session-dev.jsonl", [
      {
        type: "user",
        timestamp: minutesAgo(60),
        cwd: projectPath,
        message: {
          role: "user",
          content: "Fix the submit_profile retry logic in the viber-mcp server and add tests for the scoring nonce.",
        },
      },
      {
        type: "assistant",
        timestamp: minutesAgo(58),
        cwd: projectPath,
        message: { role: "assistant", content: [{ type: "text", text: "Looking at the retry path now." }] },
      },
      {
        // A LATER human prompt even quoting the canonical bootstrap text must
        // not classify the session — only the FIRST human prompt counts.
        type: "user",
        timestamp: minutesAgo(55),
        cwd: projectPath,
        message: {
          role: "user",
          content: "Use the viber skill at /tmp/skill/SKILL.md wording in the docs and mention submit_profile.",
        },
      },
    ]);

    const collected = collectNormalizedSessions({ homeDir: home, projectPath });
    assert.equal(collected.sessions.length, 1);
    assert.equal(collected.sessions[0].measurementSession, false);
  } finally {
    cleanup(root);
  }
});

test("subagent sessions inherit the parent's measurement classification", () => {
  const root = makeTempDir();
  try {
    const home = path.join(root, "home");
    const projectPath = "/private/project";
    writeClaudeSession(home, projectPath, "session-measure.jsonl", measurementClaudeLines(projectPath));
    const projectDir = path.join(home, ".claude", "projects", "-private-project");
    const subagentDir = path.join(projectDir, "session-measure", "subagents");
    mkdirSync(subagentDir, { recursive: true });
    writeFileSync(
      path.join(subagentDir, "agent-1.jsonl"),
      [
        {
          type: "user",
          timestamp: minutesAgo(25),
          cwd: projectPath,
          isSidechain: true,
          message: { role: "user", content: "Scan the transcript shards and report coverage counts." },
        },
        {
          type: "assistant",
          timestamp: minutesAgo(24),
          cwd: projectPath,
          isSidechain: true,
          message: {
            role: "assistant",
            content: [{ type: "text", text: "Coverage counted." }],
            usage: { input_tokens: 50, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 25 },
          },
        },
      ]
        .map((line) => JSON.stringify(line))
        .join("\n"),
    );

    const collected = collectNormalizedSessions({ homeDir: home, projectPath });
    const subagent = collected.sessions.find((session) => session.subagentOf);
    assert.ok(subagent, "subagent session present");
    assert.equal(subagent?.measurementSession, true, "subagent inherits parent measurement classification");

    // And the actual-metrics path: the subagent's tokens land in overhead,
    // never in the normal totals.
    const metrics = buildActualMetrics({ homeDir: home, projectPath });
    assert.equal(metrics.vibe_metrics.metrics_coverage.tools.claude.session_count, 0);
    assert.equal(metrics.vibe_metrics.total_tokens, 0);
    assert.equal(metrics.vibe_metrics.profile_analysis_overhead?.sessions, 1);
    assert.equal(metrics.vibe_metrics.profile_analysis_overhead?.provider_tokens, 1575);
  } finally {
    cleanup(root);
  }
});

test("measurement sessions are excluded from every normal metric, including tokens", () => {
  const root = makeTempDir();
  try {
    const home = path.join(root, "home");
    const projectPath = "/private/project";
    writeClaudeSession(home, projectPath, "session-normal.jsonl", normalClaudeLines(projectPath));
    writeClaudeSession(home, projectPath, "session-measure.jsonl", measurementClaudeLines(projectPath));
    const codexDir = path.join(home, ".codex", "sessions", "2026", "06", "10");
    mkdirSync(codexDir, { recursive: true });
    writeFileSync(
      path.join(codexDir, "rollout-measure.jsonl"),
      measurementCodexLines(projectPath)
        .map((line) => JSON.stringify(line))
        .join("\n"),
    );

    const metrics = buildActualMetrics({ homeDir: home, projectPath });
    // Session counts: only the normal claude session remains.
    assert.equal(metrics.vibe_metrics.metrics_coverage.tools.claude.session_count, 1);
    assert.equal(metrics.vibe_metrics.metrics_coverage.tools.codex.session_count, 0);
    assert.equal(metrics.vibe_metrics.metrics_coverage.totals.session_count, 1);
    // Tokens: the measurement sessions' 1500 (claude) + 2000 (codex) provider
    // tokens are excluded from the normal totals (deliberate divergence from
    // the subagent precedent) and from the period buckets.
    assert.equal(metrics.vibe_metrics.token_sources.claude.total_tokens, 130);
    assert.equal(metrics.vibe_metrics.token_sources.codex.total_tokens, undefined);
    assert.equal(metrics.vibe_metrics.total_tokens, 130);
    assert.equal(metrics.vibe_metrics.provider_tokens_by_period.this_year <= 130, true);

    // Episode candidates / session metadata / manifest counts exclude them too.
    const bundle = buildEpisodeCandidates({ homeDir: home, projectPath });
    assert.equal(bundle.analysis_manifest.session_count, 1);
    assert.equal(bundle.session_metadata.length, 1);
    assert.equal(bundle.coverage.tools.claude.session_count, 1);
    assert.equal(bundle.coverage.tools.codex.session_count, 0);
    assert.ok((bundle.coverage.tools.claude.dropped_reasons.measurement_session_excluded ?? 0) >= 1);
    assert.equal(JSON.stringify(bundle).includes("Use the viber skill"), false);

    // Discovery coverage and wrapped aggregates exclude them as well.
    const discovery = discoverLocalSources({ homeDir: home, projectPath });
    assert.equal(discovery.tools.claude.session_count, 1);
    assert.equal(discovery.tools.codex.session_count, 0);

    const aggregates = buildWrappedAggregates({ homeDir: home, projectPath });
    assert.equal(aggregates.vibe_extra.prompt_stats?.prompt_count, 1);
    const families = (aggregates.vibe_extra.model_usage ?? []).map((entry) => entry.model_family).sort();
    assert.deepEqual(families, ["Opus 4.8"], "measurement-only model families must not appear in model_usage");
  } finally {
    cleanup(root);
  }
});

test("profile_analysis_overhead aggregates the excluded measurement sessions, numbers only", () => {
  const root = makeTempDir();
  try {
    const home = path.join(root, "home");
    const projectPath = "/private/project";
    writeClaudeSession(home, projectPath, "session-normal.jsonl", normalClaudeLines(projectPath));
    writeClaudeSession(home, projectPath, "session-measure.jsonl", measurementClaudeLines(projectPath));
    const codexDir = path.join(home, ".codex", "sessions", "2026", "06", "10");
    mkdirSync(codexDir, { recursive: true });
    writeFileSync(
      path.join(codexDir, "rollout-measure.jsonl"),
      measurementCodexLines(projectPath)
        .map((line) => JSON.stringify(line))
        .join("\n"),
    );

    const metrics = buildActualMetrics({ homeDir: home, projectPath });
    const overhead = metrics.vibe_metrics.profile_analysis_overhead;
    assert.ok(overhead, "overhead block present when measurement sessions exist");
    assert.equal(overhead?.sessions, 2);
    assert.equal(overhead?.provider_tokens, 3500);
    assert.equal(overhead?.by_tool?.claude?.sessions, 1);
    assert.equal(overhead?.by_tool?.claude?.provider_tokens, 1500);
    assert.equal(overhead?.by_tool?.codex?.sessions, 1);
    assert.equal(overhead?.by_tool?.codex?.provider_tokens, 2000);
    assert.equal((overhead?.vibe_agent_hours ?? 0) > 0, true);
    assert.deepEqual(overhead?.model_families, ["GPT-5.5", "Haiku"]);
    assert.ok(overhead?.last_analysis_at, "last_analysis_at present");
    // Aggregate-only: no prompt text, paths, or session identifiers.
    const serialized = JSON.stringify(overhead);
    assert.equal(serialized.includes("Use the viber skill"), false);
    assert.equal(serialized.includes(projectPath), false);
    assert.equal(serialized.includes("SKILL.md"), false);
  } finally {
    cleanup(root);
  }
});

test("the overhead block is omitted entirely when there are zero measurement sessions", () => {
  const root = makeTempDir();
  try {
    const home = path.join(root, "home");
    const projectPath = "/private/project";
    writeClaudeSession(home, projectPath, "session-normal.jsonl", normalClaudeLines(projectPath));

    const metrics = buildActualMetrics({ homeDir: home, projectPath });
    assert.equal(metrics.vibe_metrics.profile_analysis_overhead, undefined);
    assert.equal(JSON.stringify(metrics).includes("profile_analysis_overhead"), false);
  } finally {
    cleanup(root);
  }
});

const sqliteAvailable = spawnSync("sqlite3", ["-version"], { encoding: "utf8" }).status === 0;

if (sqliteAvailable) {
  test("cursor sessions classify from the first user bubble and are excluded the same way", () => {
    const root = makeTempDir();
    try {
      const projectPath = "/private/project";
      const dbPath = path.join(root, "state.vscdb");
      const sqlString = (value: string) => `'${value.replace(/'/g, "''")}'`;
      execFileSync("sqlite3", [dbPath], {
        input: [
          "CREATE TABLE cursorDiskKV(key TEXT PRIMARY KEY, value TEXT);",
          `INSERT INTO cursorDiskKV VALUES('composerData:measure', ${sqlString(JSON.stringify({ workspacePath: projectPath }))});`,
          `INSERT INTO cursorDiskKV VALUES('bubbleId:measure:1', ${sqlString(
            JSON.stringify({ type: 1, text: MEASUREMENT_PROMPT, createdAt: minutesAgo(30) }),
          )});`,
          `INSERT INTO cursorDiskKV VALUES('bubbleId:measure:2', ${sqlString(
            JSON.stringify({
              type: 2,
              text: "Running the discovery tools now.",
              createdAt: minutesAgo(25),
              tokenCount: { inputTokens: 700, outputTokens: 300 },
            }),
          )});`,
        ].join("\n"),
      });

      const collected = collectNormalizedSessions({ homeDir: path.join(root, "home"), projectPath, cursorDbPath: dbPath });
      const cursorSession = collected.sessions.find((session) => session.tool === "cursor");
      assert.ok(cursorSession, "cursor session present");
      assert.equal(cursorSession?.measurementSession, true);

      const metrics = buildActualMetrics({ homeDir: path.join(root, "home"), projectPath, cursorDbPath: dbPath });
      assert.equal(metrics.vibe_metrics.metrics_coverage.tools.cursor.session_count, 0);
      assert.equal(metrics.vibe_metrics.profile_analysis_overhead?.by_tool?.cursor?.sessions, 1);
      assert.equal(metrics.vibe_metrics.profile_analysis_overhead?.by_tool?.cursor?.provider_tokens, 1000);
    } finally {
      cleanup(root);
    }
  });
} else {
  test("cursor sessions classify from the first user bubble and are excluded the same way", { skip: "sqlite3 not installed" }, () => {});
}
