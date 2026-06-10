/**
 * Shipped-candidate detection tests: deterministic read-only git inspection,
 * repo/commit caps, and the strict local-only split (repo labels, suggested
 * titles, and source keys never enter the aggregate).
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import { buildShippedAggregate, detectShippedCandidates } from "../src/shipped.ts";

function makeTempDir(): string {
  return mkdtempSync(path.join(tmpdir(), "viber-shipped-"));
}

function cleanup(dir: string): void {
  rmSync(dir, { recursive: true, force: true });
}

function git(repo: string, args: string[], env: Record<string, string> = {}): void {
  execFileSync("git", ["-C", repo, ...args], { stdio: "ignore", env: { ...process.env, ...env } });
}

function initRepo(repo: string): void {
  mkdirSync(repo, { recursive: true });
  execFileSync("git", ["init", repo], { stdio: "ignore" });
  git(repo, ["config", "user.email", "builder@example.com"]);
  git(repo, ["config", "user.name", "Builder One"]);
  git(repo, ["config", "commit.gpgsign", "false"]);
}

function commitFiles(repo: string, files: Record<string, string>, message: string, date: string): void {
  for (const [file, content] of Object.entries(files)) {
    const filePath = path.join(repo, file);
    mkdirSync(path.dirname(filePath), { recursive: true });
    writeFileSync(filePath, content);
  }
  git(repo, ["add", "."]);
  git(repo, ["commit", "-m", message], { GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date });
}

/** Repo with release tags, deploy paths, merged-PR subjects, and docs. */
function initSignalRepo(repo: string): void {
  initRepo(repo);
  git(repo, ["remote", "add", "origin", "https://github.com/acme/widget.git"]);
  commitFiles(
    repo,
    { "Dockerfile": "FROM node:20\n", ".github/workflows/ci.yml": "name: ci\n" },
    "Add deployment pipeline",
    "2026-04-20T10:00:00+00:00",
  );
  commitFiles(
    repo,
    { "apps/web/index.ts": "export const app = 1;\n" },
    "Add payment flow (#12)",
    "2026-05-10T10:00:00+00:00",
  );
  commitFiles(repo, { "CHANGELOG.md": "## 1.2.0\n" }, "release 1.2.0", "2026-05-15T10:00:00+00:00");
  git(repo, ["tag", "v1.2.0"]);
}

/** Repo with commits but no shipped signals at all. */
function initQuietRepo(repo: string): void {
  initRepo(repo);
  commitFiles(repo, { "src/util.ts": "export const u = 1;\n" }, "wip tweak helper wording", "2026-05-01T10:00:00+00:00");
}

test("detects per-repo per-month candidates from release tags, deploy paths, and PR subjects", () => {
  const root = makeTempDir();
  try {
    const signalRepo = path.join(root, "widget");
    const quietRepo = path.join(root, "quiet");
    initSignalRepo(signalRepo);
    initQuietRepo(quietRepo);

    const detection = detectShippedCandidates({ repos: [signalRepo, quietRepo] });
    assert.equal(detection.candidates.length, 2, "the quiet repo must contribute nothing");

    const april = detection.candidates.find((candidate) => candidate.period === "2026-04");
    assert.ok(april, "April deploy cluster present");
    assert.equal(april?.source_key, "github.com/acme/widget:2026-04");
    assert.equal(april?.repo_label, "widget");
    assert.equal(april?.commit_count, 1);
    assert.deepEqual(april?.categories, ["infra", "oss"]);
    assert.deepEqual(april?.evidence, ["git_evidence", "deploy_signal"]);

    const may = detection.candidates.find((candidate) => candidate.period === "2026-05");
    assert.ok(may, "May release cluster present");
    assert.equal(may?.source_key, "github.com/acme/widget:2026-05");
    assert.equal(may?.commit_count, 2);
    assert.deepEqual(may?.categories, ["feature", "docs", "oss"]);
    assert.deepEqual(may?.evidence, ["release_tag"]);
    assert.ok(may?.suggested_title.startsWith("widget: "), "suggested title is local display only");
  } finally {
    cleanup(root);
  }
});

test("detection is deterministic across runs", () => {
  const root = makeTempDir();
  try {
    const signalRepo = path.join(root, "widget");
    initSignalRepo(signalRepo);
    const first = detectShippedCandidates({ repos: [signalRepo] });
    const second = detectShippedCandidates({ repos: [signalRepo] });
    assert.deepEqual(second, first);
  } finally {
    cleanup(root);
  }
});

test("the 20-repo cap applies before scanning (repos beyond the cap are ignored)", () => {
  const root = makeTempDir();
  try {
    const signalRepo = path.join(root, "widget");
    initSignalRepo(signalRepo);
    const fillers = Array.from({ length: 20 }, (_, index) => path.join(root, `filler-${index}`));
    for (const filler of fillers) {
      mkdirSync(filler, { recursive: true });
    }
    const detection = detectShippedCandidates({ repos: [...fillers, signalRepo] });
    assert.equal(detection.candidates.length, 0, "the signal repo sits beyond the 20-repo cap");
    assert.ok(detection.warnings.includes("shipped_repo_cap_applied"));

    const inCap = detectShippedCandidates({ repos: [signalRepo, ...fillers] });
    assert.equal(inCap.candidates.length, 2, "inside the cap the signal repo is scanned");
  } finally {
    cleanup(root);
  }
});

test("the per-repo commit cap limits how far back detection looks", () => {
  const root = makeTempDir();
  try {
    const signalRepo = path.join(root, "widget");
    initSignalRepo(signalRepo);
    // Only the newest commit (the May release) is within a 1-commit window.
    const detection = detectShippedCandidates({ repos: [signalRepo], maxCommitsPerRepo: 1 });
    assert.equal(detection.candidates.length, 1);
    assert.equal(detection.candidates[0].period, "2026-05");
    assert.equal(detection.candidates[0].commit_count, 1);
  } finally {
    cleanup(root);
  }
});

test("buildShippedAggregate is numbers-only: no paths, labels, source keys, hashes, or emails", () => {
  const root = makeTempDir();
  try {
    const signalRepo = path.join(root, "widget");
    initSignalRepo(signalRepo);
    const detection = detectShippedCandidates({ repos: [signalRepo] });
    const aggregate = buildShippedAggregate(detection.candidates);

    assert.equal(aggregate.total, 2);
    assert.equal(aggregate.by_category?.feature, 1);
    assert.equal(aggregate.by_category?.infra, 1);
    assert.equal(aggregate.by_evidence?.release_tag, 1);
    assert.equal(aggregate.by_evidence?.git_evidence, 1);
    // total === sum(by_category) === sum(by_evidence): each candidate counts once.
    const categorySum = Object.values(aggregate.by_category ?? {}).reduce((sum, count) => sum + count, 0);
    const evidenceSum = Object.values(aggregate.by_evidence ?? {}).reduce((sum, count) => sum + count, 0);
    assert.equal(categorySum, aggregate.total);
    assert.equal(evidenceSum, aggregate.total);

    const serialized = JSON.stringify(aggregate);
    assert.equal(serialized.includes("widget"), false, "repo label must not enter the aggregate");
    assert.equal(serialized.includes("acme"), false, "remote org must not enter the aggregate");
    assert.equal(serialized.includes(root), false, "no paths in the aggregate");
    assert.equal(serialized.includes("@"), false, "no emails in the aggregate");
    assert.equal(serialized.includes("source_key"), false);
    assert.equal(serialized.includes("repo_label"), false);
    assert.equal(serialized.includes("suggested_title"), false);
    assert.equal(/\b[0-9a-f]{40}\b/.test(serialized), false, "no commit hashes in the aggregate");
    assert.equal(serialized.includes("release 1.2.0"), false, "no commit subjects in the aggregate");
  } finally {
    cleanup(root);
  }
});

test("a repo without a remote still gets a stable local source key", () => {
  const root = makeTempDir();
  try {
    const localRepo = path.join(root, "local-tool");
    initRepo(localRepo);
    commitFiles(localRepo, { "CHANGELOG.md": "## 0.1\n" }, "prepare first release", "2026-06-01T10:00:00+00:00");
    const detection = detectShippedCandidates({ repos: [localRepo] });
    assert.equal(detection.candidates.length, 1);
    assert.equal(detection.candidates[0].source_key, "local/local-tool:2026-06");
  } finally {
    cleanup(root);
  }
});
