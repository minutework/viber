import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import { buildEpisodeCandidates } from "../src/extractors.ts";

function makeTempDir(): string {
  return mkdtempSync(path.join(tmpdir(), "viber-decisions-"));
}

function writeSession(home: string, lines: unknown[]): void {
  const projectDir = path.join(home, ".claude", "projects", "-private-project");
  mkdirSync(projectDir, { recursive: true });
  writeFileSync(path.join(projectDir, "session-decisions.jsonl"), lines.map((line) => JSON.stringify(line)).join("\n"));
}

test("decision candidates carry initiative, outcome linkage, topics, and outcome-linked confidence", () => {
  const root = makeTempDir();
  try {
    const home = path.join(root, "home");
    const projectPath = "/private/project";
    writeSession(home, [
      {
        type: "user",
        timestamp: "2026-06-09T10:00:00Z",
        cwd: projectPath,
        message: { role: "user", content: "Work through the data layer changes for the export feature." },
      },
      {
        type: "assistant",
        timestamp: "2026-06-09T10:01:00Z",
        message: {
          role: "assistant",
          model: "claude-opus-4-8",
          content: [
            {
              type: "text",
              text: "There is a tradeoff here: I suggest we choose the denormalized schema for the export instead of joining at read time.",
            },
            { type: "tool_use", id: "tu_bash_t", name: "Bash", input: { command: "pnpm test" } },
          ],
        },
      },
      {
        type: "user",
        timestamp: "2026-06-09T10:02:00Z",
        message: {
          role: "user",
          content: [
            { type: "tool_result", tool_use_id: "tu_bash_t", content: [{ type: "text", text: "12 passed in 2.1s" }] },
          ],
        },
      },
      {
        type: "user",
        timestamp: "2026-06-09T10:03:00Z",
        message: {
          role: "user",
          content: "Accepted, go with the denormalized table but keep the migration reversible.",
        },
      },
      {
        type: "git_commit",
        timestamp: "2026-06-09T10:45:00Z",
        sha: "abc123def4567890abc123def4567890abc123de",
      },
      {
        type: "assistant",
        timestamp: "2026-06-09T10:46:00Z",
        message: {
          role: "assistant",
          model: "claude-opus-4-8",
          content: [
            { type: "tool_use", id: "tu_bash_t2", name: "Bash", input: { command: "pnpm test" } },
          ],
        },
      },
      {
        type: "user",
        timestamp: "2026-06-09T10:50:00Z",
        message: {
          role: "user",
          content: [
            { type: "tool_result", tool_use_id: "tu_bash_t2", content: [{ type: "text", text: "13 passed in 2.3s" }] },
          ],
        },
      },
    ]);

    const bundle = buildEpisodeCandidates({ homeDir: home, projectPath });
    assert.ok(bundle.decisions.length >= 1, "at least one decision extracted");
    const decision = bundle.decisions[0];
    // The agent put the tradeoff language on the table first.
    assert.equal(decision.initiative.raised_by, "agent");
    // Commit event at +42min => within 2h; a passing test run follows the decision.
    assert.equal(decision.outcome_evidence?.commit_within_2h, true);
    assert.equal(decision.outcome_evidence?.test_signal_after, "pass");
    // Outcome-linked confidence: 0.5 + 0.15 (commit) + 0.1 (pass) = 0.75, not the old 0.55.
    assert.equal(decision.confidence, 0.75);
    // Topic lexicon proposes data_modeling from "schema"/"migration" language.
    assert.ok(decision.topics?.includes("data_modeling"));
    assert.equal(decision.outcome, "accepted");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("human-raised decisions are attributed to the human and unvalidated ones keep base confidence", () => {
  const root = makeTempDir();
  try {
    const home = path.join(root, "home");
    const projectPath = "/private/project";
    writeSession(home, [
      {
        type: "user",
        timestamp: "2026-06-09T11:00:00Z",
        cwd: projectPath,
        message: { role: "user", content: "Start wiring the webhook receiver." },
      },
      {
        type: "assistant",
        timestamp: "2026-06-09T11:01:00Z",
        message: {
          role: "assistant",
          model: "claude-opus-4-8",
          content: [{ type: "text", text: "The webhook receiver is wired up and responding." }],
        },
      },
      {
        type: "user",
        timestamp: "2026-06-09T11:02:00Z",
        message: {
          role: "user",
          content: "Hold on — we should defer the retry queue and keep idempotency keys as a hard constraint instead.",
        },
      },
    ]);

    const bundle = buildEpisodeCandidates({ homeDir: home, projectPath });
    assert.ok(bundle.decisions.length >= 1);
    const decision = bundle.decisions[0];
    // The assistant's message carried no decision language; the human raised it.
    assert.equal(decision.initiative.raised_by, "human");
    // No commit event and no test run in session: evidence present but unvalidated.
    assert.equal(decision.outcome_evidence?.commit_within_2h, false);
    assert.equal(decision.outcome_evidence?.test_signal_after, "none");
    assert.equal(decision.confidence, 0.5);
    // distributed_systems via idempotency/retry/queue language.
    assert.ok(decision.topics?.includes("distributed_systems"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
