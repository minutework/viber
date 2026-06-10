import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import { openDigestCache, sha256DigestOf } from "../src/digest-cache.ts";
import { buildEpisodeCandidates } from "../src/extractors.ts";
import { normalizeModelId } from "../src/signals.ts";
import { writeClaudeCorpus, writeCodexCorpus } from "./fixture-corpus.ts";

function makeTempDir(): string {
  return mkdtempSync(path.join(tmpdir(), "viber-signals-"));
}

function cleanup(dir: string): void {
  rmSync(dir, { recursive: true, force: true });
}

test("behavior signals capture models, modes, tools, interrupts, and telemetry per session", () => {
  const root = makeTempDir();
  try {
    const home = path.join(root, "home");
    const projectPath = "/private/project";
    writeClaudeCorpus(home, projectPath, { includeSubagent: true });
    writeCodexCorpus(home, projectPath);

    const bundle = buildEpisodeCandidates({ homeDir: home, projectPath });
    assert.ok(Array.isArray(bundle.behavior_signals));

    const claude = bundle.behavior_signals.find((entry) => entry.tool === "claude" && !entry.is_subagent);
    assert.ok(claude, "claude main session signals present");
    assert.equal(claude.signals.models["claude-opus-4-8"], 2);
    assert.equal(claude.signals.permissionModes.plan >= 1, true);
    assert.equal(claude.signals.interruptCount, 1);
    assert.equal(claude.signals.queueOperations.enqueue, 1);
    assert.ok(claude.signals.gitBranchRef && /^[a-f0-9]{24}$/.test(claude.signals.gitBranchRef));
    assert.equal(claude.signals.sidechainEventCount >= 1, true);

    const subagent = bundle.behavior_signals.find((entry) => entry.tool === "claude" && entry.is_subagent);
    assert.ok(subagent, "subagent session signals present and flagged");

    const codex = bundle.behavior_signals.find((entry) => entry.tool === "codex");
    assert.ok(codex, "codex session signals present");
    assert.equal(codex.signals.models["gpt-5.5"], 1);
    assert.equal(codex.signals.collaborationModes.plan, 1);
    assert.equal(codex.signals.approvalPolicies.never, 1);
    assert.equal(codex.signals.efforts.high, 1);
    assert.equal(codex.signals.interruptCount, 1, "turn_aborted(reason=interrupted) counts as interrupt");
    assert.equal(codex.signals.updatePlanCount, 1);
    assert.equal(codex.signals.originator, "codex_cli");
    // Shell function_calls feed the same linkage stats Claude gets natively.
    assert.equal(codex.signals.commitEventTimesMs.length, 1, "git commit shell call recorded");
    assert.equal(codex.signals.testCommandTimesMs.length, 1, "test shell call recorded");
  } finally {
    cleanup(root);
  }
});

test("behavior signals never serialize raw branch names, shas, timezone strings, or queued content", () => {
  const root = makeTempDir();
  try {
    const home = path.join(root, "home");
    const projectPath = "/private/project";
    writeClaudeCorpus(home, projectPath, { includeSubagent: false });
    writeCodexCorpus(home, projectPath, { repositoryUrl: "https://github.com/acme/secret-repo.git" });

    const bundle = buildEpisodeCandidates({ homeDir: home, projectPath });
    const serialized = JSON.stringify(bundle.behavior_signals);
    assert.equal(serialized.includes("codex/fixture-branch"), false, "raw branch name must not appear");
    assert.equal(serialized.includes("secret-repo"), false, "remote URL must not appear");
    assert.equal(serialized.includes("Queued follow-up instruction"), false, "queue-op content must not appear");
    assert.equal(serialized.includes("America/"), false);
    assert.equal(serialized.includes(projectPath), false);
  } finally {
    cleanup(root);
  }
});

test("normalizeModelId maps known ids to families and fails closed on free text", () => {
  assert.equal(normalizeModelId("claude-opus-4-8"), "Opus 4.8");
  assert.equal(normalizeModelId("claude-haiku-4-5-20251001"), "Haiku");
  assert.equal(normalizeModelId("gpt-5.5"), "GPT-5.5");
  assert.equal(normalizeModelId("gemini-3-pro-preview"), "Gemini 3");
  assert.equal(normalizeModelId("composer-2.5-fast"), "Cursor Composer");
  assert.equal(normalizeModelId("totally made up model"), undefined);
  assert.equal(normalizeModelId("/etc/passwd"), undefined);
  assert.equal(normalizeModelId("a".repeat(200)), undefined);
});

test("digest cache stores stage outputs and tracks file fingerprints without raw paths", () => {
  const root = makeTempDir();
  try {
    const scratch = path.join(root, "scratch");
    const cache = openDigestCache(scratch, "test-salt");
    const digest = sha256DigestOf(["input-a"]);
    assert.equal(cache.get("summary", digest), undefined);
    cache.set("summary", digest, "a redacted summary");
    cache.flush();

    const reopened = openDigestCache(scratch, "test-salt");
    assert.equal(reopened.get("summary", digest), "a redacted summary");

    const tracked = path.join(root, "session.jsonl");
    writeFileSync(tracked, "line\n");
    assert.equal(reopened.isFileUnchanged(tracked), false);
    reopened.rememberFile(tracked);
    assert.equal(reopened.isFileUnchanged(tracked), true);
    // mtime change invalidates the fingerprint.
    utimesSync(tracked, new Date(), new Date(Date.now() + 5_000));
    assert.equal(reopened.isFileUnchanged(tracked), false);
    reopened.flush();

    const cacheFile = path.join(scratch, "digest-cache.json");
    const raw = JSON.stringify(JSON.parse(readFileSync(cacheFile, "utf8")));
    assert.equal(raw.includes("session.jsonl"), false, "raw paths must not appear in the cache file");
  } finally {
    cleanup(root);
  }
});
