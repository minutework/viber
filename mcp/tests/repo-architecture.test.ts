import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import { isGeneratedArtifactPath } from "../src/extractors.ts";
import {
  analyzeRepoArchitecture,
  computeCoverage,
  computeOverall,
  computeQuality,
  DIMENSION_KEYS,
  gradeForOverall,
  REPO_LOCK_BASENAMES,
  REPO_RUBRIC_VERSION,
  type DimensionKey,
  type RepoArchitectureDimensions,
} from "../src/repo-architecture.ts";

const SIZE_BANDS = ["tiny", "small", "medium", "large", "very_large"];

// Built by concatenation so the assembled key never sits in this file as one literal.
const PLANTED_AWS_ID = "AKIA" + "ABCDEFGHIJKLMNOP";

function makeTempDir(): string {
  return mkdtempSync(path.join(tmpdir(), "viber-repoarch-"));
}

function cleanup(dir: string): void {
  rmSync(dir, { recursive: true, force: true });
}

function write(root: string, relPath: string, content: string): void {
  const full = path.join(root, relPath);
  mkdirSync(path.dirname(full), { recursive: true });
  writeFileSync(full, content);
}

function initRepoWithCommits(repo: string): void {
  execFileSync("git", ["init", repo], { stdio: "ignore" });
  const git = (args: string[], env: Record<string, string> = {}) =>
    execFileSync("git", ["-C", repo, ...args], { stdio: "ignore", env: { ...process.env, ...env } });
  git(["config", "user.email", "builder@example.com"]);
  git(["config", "user.name", "Builder One"]);
  git(["config", "commit.gpgsign", "false"]);
  const commitAll = (message: string, date: string) => {
    git(["add", "-A"]);
    git(["commit", "-m", message], { GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date });
  };
  commitAll("Add initial tree", "2026-06-01T10:00:00-07:00");
  write(repo, "src/module0.ts", "export function compute0(value: number): number {\n  return value + 100;\n}\n");
  commitAll("Refine module zero", "2026-06-02T11:00:00-07:00");
  write(repo, "src/module1.ts", "export function compute1(value: number): number {\n  return value + 101;\n}\n");
  commitAll("Refine module one", "2026-06-03T12:00:00-07:00");
}

// Rich TS repo: every deterministic dimension has strong evidence; git history present.
function writeRichTsRepo(repo: string): void {
  mkdirSync(repo, { recursive: true });
  const readme =
    "# Rich Fixture\n\n" +
    "This project documents its architecture and operating practices in depth. ".repeat(60) +
    "\n";
  write(repo, "README.md", readme); // > 3000 bytes
  write(repo, "CONTRIBUTING.md", "# Contributing\n\nOpen a pull request with a clear description.\n");
  write(repo, "CHANGELOG.md", "# Changelog\n\n- 1.0.0 initial release\n");
  write(repo, "SECURITY.md", "# Security Policy\n\nReport issues privately to the maintainers.\n");
  write(repo, "docs/index.md", "# Docs Index\n\nStart here.\n");
  write(repo, "docs/adr/0001-record.md", "# ADR 0001\n\nUse a layered module design.\n");
  write(
    repo,
    ".github/workflows/ci.yml",
    "name: ci\non: push\njobs:\n  build:\n    runs-on: ubuntu-latest\n    steps:\n      - run: npm test\n",
  );
  write(
    repo,
    ".github/workflows/release.yml",
    "name: release\non: push\njobs:\n  publish:\n    runs-on: ubuntu-latest\n    steps:\n      - run: npm run build\n",
  );
  write(repo, ".github/dependabot.yml", "version: 2\nupdates: []\n");
  write(repo, ".pre-commit-config.yaml", "repos: []\n");
  write(repo, "Makefile", "test:\n\tnpm test\n\nlint:\n\tnpm run lint\n");
  write(repo, "tsconfig.json", '{\n  "compilerOptions": {\n    "strict": true\n  }\n}\n');
  write(repo, ".eslintrc.json", "{}\n");
  write(repo, ".prettierrc", "{}\n");
  write(repo, "package.json", '{\n  "name": "rich-fixture",\n  "version": "1.0.0",\n  "private": true\n}\n');
  write(repo, "pnpm-lock.yaml", "lockfileVersion: '9.0'\n");
  write(repo, ".gitignore", ".env\nnode_modules\n");
  write(repo, ".env.example", "EXAMPLE_FLAG=1\n");
  write(repo, "Dockerfile", 'FROM node:20-alpine\nCMD ["node", "server.js"]\n');
  for (let index = 0; index < 10; index += 1) {
    write(
      repo,
      `src/module${index}.ts`,
      `export function compute${index}(value: number): number {\n  return value + ${index};\n}\n`,
    );
  }
  for (let index = 0; index < 3; index += 1) {
    write(repo, `tests/module${index}.test.ts`, `export const expectation${index} = ${index} >= 0;\n`);
  }
  initRepoWithCommits(repo);
}

// Bare repo: two small python files at root, nothing else, no git.
function writeBareRepo(repo: string): void {
  mkdirSync(repo, { recursive: true });
  write(repo, "alpha.py", "def alpha():\n    return 1\n");
  write(repo, "beta.py", "def beta():\n    return 2\n");
}

// Weak-but-present repo: one trivial test among 50 source files, a thin README, a manifest.
function writeWeakRepo(repo: string): void {
  mkdirSync(repo, { recursive: true });
  write(repo, "README.md", "# Weak Fixture\n\nMinimal notes.\n"); // < 500 bytes
  write(repo, "package.json", '{\n  "name": "weak-fixture"\n}\n');
  for (let index = 0; index < 50; index += 1) {
    write(repo, `src/file${index}.ts`, `export const value${index} = ${index};\n`);
  }
  write(repo, "src/util.test.ts", "export const utilExpectation = true;\n");
}

function writePythonRepo(repo: string): void {
  mkdirSync(repo, { recursive: true });
  write(
    repo,
    "pyproject.toml",
    '[project]\nname = "py-fixture"\nversion = "1.0.0"\n\n[tool.ruff]\nline-length = 100\n\n[tool.mypy]\nstrict = true\n',
  );
  write(repo, "poetry.lock", "# locked\n");
  write(repo, "pytest.ini", "[pytest]\n");
  write(repo, "src/pkg/app.py", "def add(left: int, right: int) -> int:\n    return left + right\n");
  write(repo, "src/pkg/util.py", "def double(value: int) -> int:\n    return value * 2\n");
  write(repo, "tests/test_app.py", "def test_add() -> None:\n    assert 1 + 1 == 2\n");
}

function writeGoRepo(repo: string): void {
  mkdirSync(repo, { recursive: true });
  write(repo, "go.mod", "module example.com/fixture\n\ngo 1.22\n");
  write(repo, "go.sum", "example.com/dep v1.0.0/go.mod h1:abcdef=\n");
  write(repo, "main.go", "package main\n\nfunc main() {\n}\n");
  write(repo, "main_test.go", 'package main\n\nimport "testing"\n\nfunc TestMain(t *testing.T) {\n}\n');
  write(repo, ".golangci.yml", "linters:\n  enable:\n    - govet\n");
}

// Leak repo: minimal tree with two planted fake AWS key ids, a tellingly named file, a deep
// dir, and git history including a churn-heavy non-ASCII filename — so the leak assertions
// also exercise the git-derived local_only channel (churn paths) and the quotePath handling
// (a quoted/octal-escaped numstat path would carry '"' and '\' into local_only).
function writeLeakRepo(repo: string): void {
  mkdirSync(repo, { recursive: true });
  write(repo, "README.md", "# Leak Fixture\n\nSmall tree used for leak-proof checks.\n");
  write(repo, "package.json", '{\n  "name": "leak-fixture"\n}\n');
  write(repo, "src/index.ts", "export const bootstrap = true;\n");
  write(repo, "src/creds.ts", `export const awsId = "${PLANTED_AWS_ID}";\n`);
  write(repo, "config/settings.yml", `aws_id: ${PLANTED_AWS_ID}\n`);
  write(repo, "supersecretfixturefile.ts", "export const marker = 1;\n");
  write(repo, "nested/inner/leaf.ts", "export const leaf = true;\n");
  const cafeLines = Array.from({ length: 40 }, (_, index) => `  ${index},`).join("\n");
  write(repo, "src/café.ts", `export const cafeValues = [\n${cafeLines}\n];\n`);
  initRepoWithCommits(repo);
}

type DimensionSeed = number | "na" | "llm_required";

// Builds synthetic dimension literals for the math helpers. The pinned vector with all 10
// dimensions scored models the LATER slice in which the host agent has LLM-scored
// `architecture`; that shape is intentionally outside ArchitectureDimension, hence the cast.
function makeDimensions(seed: Partial<Record<DimensionKey, DimensionSeed>>): RepoArchitectureDimensions {
  const built: Record<string, unknown> = {};
  for (const key of DIMENSION_KEYS) {
    const value = seed[key] ?? "na";
    if (value === "na" || value === "llm_required") {
      built[key] = { status: value, markers: {} };
    } else if (key === "maintainability") {
      built[key] = { status: "scored", score: value, deterministic_score: value, markers: {} };
    } else {
      built[key] = { status: "scored", score: value, markers: {} };
    }
  }
  return built as unknown as RepoArchitectureDimensions;
}

test("rich repo scan carries all 10 dimension keys in fixed order with version and language metadata", () => {
  const root = makeTempDir();
  try {
    const repo = path.join(root, "repo");
    writeRichTsRepo(repo);
    const scan = analyzeRepoArchitecture({ repoPath: repo });

    assert.equal(scan.repo_rubric_version, REPO_RUBRIC_VERSION);
    assert.deepEqual(Object.keys(scan.dimensions), [...DIMENSION_KEYS], "all 10 keys in declaration order");
    assert.equal(scan.primary_language, "typescript");
    assert.ok(SIZE_BANDS.includes(scan.size_band), "size_band is a valid band");
    assert.equal(scan.scan_meta.truncated, false);
    for (const key of DIMENSION_KEYS) {
      const dimension = scan.dimensions[key];
      assert.ok(dimension.markers && typeof dimension.markers === "object", `${key} carries a markers object`);
    }
  } finally {
    cleanup(root);
  }
});

test("rich repo pins documentation, ci, and dependency hygiene at 100 and marks architecture llm_required", () => {
  const root = makeTempDir();
  try {
    const repo = path.join(root, "repo");
    writeRichTsRepo(repo);
    const scan = analyzeRepoArchitecture({ repoPath: repo });

    assert.equal(scan.dimensions.architecture.status, "llm_required");
    const scoredCount = DIMENSION_KEYS.filter((key) => scan.dimensions[key].status === "scored").length;
    assert.ok(scoredCount >= 8, `at least 8 dimensions scored, got ${scoredCount}`);

    // documentation: readme +20, bytes>=500 +15, bytes>=3000 +10, docs dir +20,
    // docs index +5, adr +10, contributing +10, doc count>=5 +10 = 100.
    assert.equal(scan.dimensions.documentation.score, 100);
    // ci_automation: ci present +40, 2 workflows +15, runs tests +15, pre-commit +15, make targets +15 = 100.
    assert.equal(scan.dimensions.ci_automation.score, 100);
    // dependency_hygiene: manifest +25, lockfile +30, dependabot +20, SECURITY.md +10, pinned-via-lockfile +15 = 100.
    assert.equal(scan.dimensions.dependency_hygiene.score, 100);

    assert.equal(typeof scan.dimensions.maintainability.score, "number");
    assert.equal(scan.dimensions.maintainability.score, scan.dimensions.maintainability.deterministic_score);

    // Helper coherence on a real scan: 9 of 10 scored (architecture is llm_required).
    const quality = computeQuality(scan.dimensions);
    const coverage = computeCoverage(scan.dimensions);
    assert.equal(coverage, 0.9);
    assert.equal(computeOverall(quality, coverage), Math.round(quality * (0.5 + 0.5 * coverage)));
  } finally {
    cleanup(root);
  }
});

test("scoring helpers reproduce the pinned math vectors and grade boundaries", () => {
  const allHundredSeed: Partial<Record<DimensionKey, DimensionSeed>> = {};
  for (const key of DIMENSION_KEYS) {
    allHundredSeed[key] = 100;
  }
  const vectorA = makeDimensions(allHundredSeed);
  assert.equal(computeQuality(vectorA), 100);
  assert.equal(computeCoverage(vectorA), 1);
  assert.equal(computeOverall(100, 1), 100);
  assert.equal(gradeForOverall(100), "exceptional");

  const vectorB = makeDimensions({
    documentation: 80,
    testing: 80,
    ci_automation: 80,
    type_safety: 80,
    dependency_hygiene: 80,
    security_posture: 80,
    modularity: 80,
    architecture: "llm_required",
    maintainability: 80,
    release_ops: "na",
  });
  assert.equal(computeQuality(vectorB), 80);
  assert.equal(computeCoverage(vectorB), 0.8);
  assert.equal(computeOverall(80, 0.8), 72); // 80 * (0.5 + 0.5 * 0.8) = 72
  assert.equal(gradeForOverall(72), "proficient");

  const vectorC = makeDimensions({
    documentation: 90,
    testing: 80,
    ci_automation: 70,
    type_safety: 60,
    architecture: "llm_required",
  });
  assert.equal(computeQuality(vectorC), 75);
  assert.equal(computeCoverage(vectorC), 0.4);
  assert.equal(computeOverall(75, 0.4), 53); // 75 * 0.7 = 52.5 rounds up
  assert.equal(gradeForOverall(53), "developing");

  // Overall always follows round(quality * (0.5 + 0.5 * coverage)).
  assert.equal(computeOverall(75, 0.4), Math.round(75 * (0.5 + 0.5 * 0.4)));
  assert.equal(computeOverall(80, 0.8), Math.round(80 * (0.5 + 0.5 * 0.8)));

  // Grade band edges, inclusive integer ranges.
  assert.equal(gradeForOverall(88), "exceptional");
  assert.equal(gradeForOverall(87), "strong");
  assert.equal(gradeForOverall(74), "strong");
  assert.equal(gradeForOverall(73), "proficient");
  assert.equal(gradeForOverall(58), "proficient");
  assert.equal(gradeForOverall(57), "developing");
  assert.equal(gradeForOverall(40), "developing");
  assert.equal(gradeForOverall(39), "emerging");
  assert.equal(gradeForOverall(0), "emerging");
});

test("bare repo goes na-heavy without dropping keys and coverage falls below the rich repo", () => {
  const root = makeTempDir();
  try {
    const bare = path.join(root, "bare");
    writeBareRepo(bare);
    const scan = analyzeRepoArchitecture({ repoPath: bare });

    assert.deepEqual(Object.keys(scan.dimensions), [...DIMENSION_KEYS], "na never drops a key");
    const naKeys = ["documentation", "testing", "ci_automation", "dependency_hygiene", "release_ops"] as const;
    for (const key of naKeys) {
      const dimension = scan.dimensions[key];
      assert.equal(dimension.status, "na", `${key} is na on the bare repo`);
      assert.ok(!("score" in dimension), `${key} omits the score key when na`);
      assert.ok(dimension.markers && typeof dimension.markers === "object", `${key} keeps markers when na`);
    }
    assert.equal(scan.dimensions.architecture.status, "na", "fewer than 5 source files is too small to assess");
    assert.equal(scan.dimensions.modularity.status, "scored");
    assert.equal(scan.dimensions.maintainability.status, "scored");
    assert.equal(scan.primary_language, "python");

    // Coverage is what drops on the bare repo: 4 scored of 10.
    assert.equal(computeCoverage(scan.dimensions), 0.4);
    const bareQuality = computeQuality(scan.dimensions);
    const bareOverall = computeOverall(bareQuality, 0.4);
    assert.equal(bareOverall, Math.round(bareQuality * (0.5 + 0.5 * 0.4)), "overall is pulled down by the coverage multiplier");

    const rich = path.join(root, "rich");
    writeRichTsRepo(rich);
    const richScan = analyzeRepoArchitecture({ repoPath: rich });
    assert.ok(
      computeCoverage(scan.dimensions) < computeCoverage(richScan.dimensions),
      "bare coverage sits below rich coverage",
    );
  } finally {
    cleanup(root);
  }
});

test("weak practice is scored low, never na", () => {
  const root = makeTempDir();
  try {
    const repo = path.join(root, "repo");
    writeWeakRepo(repo);
    const scan = analyzeRepoArchitecture({ repoPath: repo });

    // One test among 50 source files is EVIDENCE of weak practice, not missing evidence.
    assert.equal(scan.dimensions.testing.status, "scored", "tests exist, so testing is scored, not na");
    assert.equal(scan.dimensions.testing.markers.test_to_source_ratio, 0.02);
    // presence +30; ratio 0.02 below every band; no framework config; no test dir = 30.
    assert.equal(scan.dimensions.testing.score, 30);

    // A thin README is weak documentation, not absent documentation.
    assert.equal(scan.dimensions.documentation.status, "scored", "a thin README is scored, not na");
    // readme present +20; under every byte band; no docs dir/adr/contributing; 1 doc file = 20.
    assert.equal(scan.dimensions.documentation.score, 20);
  } finally {
    cleanup(root);
  }
});

test("python and go fixtures drive stack-aware type safety markers", () => {
  const root = makeTempDir();
  try {
    const pyRepo = path.join(root, "py");
    writePythonRepo(pyRepo);
    const pyScan = analyzeRepoArchitecture({ repoPath: pyRepo });
    assert.equal(pyScan.primary_language, "python");
    assert.equal(pyScan.dimensions.type_safety.status, "scored");
    assert.equal(pyScan.dimensions.type_safety.markers.type_config_present, true);
    assert.equal(pyScan.dimensions.type_safety.markers.linter_config_present, true);
    assert.equal(pyScan.dimensions.dependency_hygiene.markers.lockfile_present, true);
    assert.equal(pyScan.dimensions.testing.markers.test_framework_config_present, true);

    const goRepo = path.join(root, "go");
    writeGoRepo(goRepo);
    const goScan = analyzeRepoArchitecture({ repoPath: goRepo });
    assert.equal(goScan.primary_language, "go");
    assert.equal(goScan.dimensions.type_safety.status, "scored");
    assert.equal(goScan.dimensions.type_safety.markers.statically_typed_language, true);
    // 50 statically typed + 30 golangci linter + 20 built-in gofmt = 100.
    assert.equal(goScan.dimensions.type_safety.score, 100);
  } finally {
    cleanup(root);
  }
});

test("unknown stacks send stack-specific dimensions to na instead of guessing", () => {
  const root = makeTempDir();
  try {
    const shellRepo = path.join(root, "shell");
    write(shellRepo, "scripts/run.sh", "#!/bin/sh\necho run\n");
    write(shellRepo, "tools/setup.sh", "#!/bin/sh\necho setup\n");
    const shellScan = analyzeRepoArchitecture({ repoPath: shellRepo });
    assert.equal(shellScan.primary_language, "other");
    assert.deepEqual(shellScan.languages, { other: 1 });
    assert.equal(shellScan.dimensions.type_safety.status, "na", "untyped stack with no configs is na");
    assert.ok(!("score" in shellScan.dimensions.type_safety));
    assert.equal(shellScan.dimensions.dependency_hygiene.status, "na", "no manifest means na, not zero");
    assert.ok(!("score" in shellScan.dimensions.dependency_hygiene));

    const dataRepo = path.join(root, "data");
    write(dataRepo, "notes.txt", "plain notes\n");
    const dataScan = analyzeRepoArchitecture({ repoPath: dataRepo });
    assert.equal(dataScan.primary_language, "unknown");
    assert.deepEqual(dataScan.languages, {});
    assert.equal(dataScan.dimensions.type_safety.status, "na");
    assert.equal(dataScan.dimensions.dependency_hygiene.status, "na");
  } finally {
    cleanup(root);
  }
});

test("DETERMINISM: identical repo state yields identical scans minus duration", () => {
  const root = makeTempDir();
  try {
    const repo = path.join(root, "repo");
    writeRichTsRepo(repo);
    const first = analyzeRepoArchitecture({ repoPath: repo });
    const second = analyzeRepoArchitecture({ repoPath: repo });
    first.scan_meta.duration_ms = 0;
    second.scan_meta.duration_ms = 0;
    assert.deepEqual(first, second);
  } finally {
    cleanup(root);
  }
});

test("secret scan emits a count only and never the planted secret value", () => {
  const root = makeTempDir();
  try {
    const repo = path.join(root, "repo");
    writeLeakRepo(repo);
    const scan = analyzeRepoArchitecture({ repoPath: repo });

    assert.equal(scan.dimensions.security_posture.markers.secret_match_count, 2);
    const serialized = JSON.stringify(scan);
    assert.equal(serialized.includes(PLANTED_AWS_ID), false, "the planted key must never appear in any output");
    assert.equal(serialized.includes("AKIA"), false, "no AKIA fragment may appear anywhere in the scan");
  } finally {
    cleanup(root);
  }
});

test("every repo lock basename matches the upstream generated-artifact classifier", () => {
  // Drift guard: REPO_LOCK_BASENAMES mirrors the private GENERATED_LOCK_BASENAMES set
  // in extractors.ts; if the upstream denylist changes, this test flags the divergence.
  for (const name of REPO_LOCK_BASENAMES) {
    assert.equal(isGeneratedArtifactPath(name), true, `${name} should classify as generated upstream`);
  }
});

test("LEAK PROOF: publishable output carries no paths, names, or secrets", () => {
  const root = makeTempDir();
  try {
    const repo = path.join(root, "repo");
    writeLeakRepo(repo);
    const scan = analyzeRepoArchitecture({ repoPath: repo });

    const { local_only, ...publishable } = scan;
    const serialized = JSON.stringify(publishable);
    assert.equal(serialized.includes("/"), false, "publishable output must not contain path separators");
    assert.equal(serialized.includes("Users"), false, "publishable output must not contain home directory segments");
    assert.equal(serialized.includes("supersecretfixturefile"), false, "publishable output must not contain file names");
    assert.equal(serialized.includes("AKIA"), false, "publishable output must not contain secret material");

    // The git-derived channel must actually be exercised: the leak fixture has
    // history, so churn paths flow into local_only and get leak-checked below.
    assert.equal(scan.dimensions.maintainability.markers.churn_available, true, "leak fixture carries git history");
    assert.ok(
      local_only.maintainability.most_churned_files.length > 0,
      "most_churned_files must be populated so the git channel is leak-checked",
    );

    const localStrings = [
      ...local_only.architecture.candidate_files,
      ...local_only.architecture.top_level_dirs,
      ...local_only.architecture.entry_points,
      ...local_only.maintainability.largest_files,
      ...local_only.maintainability.most_churned_files,
      ...local_only.maintainability.todo_hotspots,
    ];
    for (const value of localStrings) {
      assert.equal(value.startsWith("/"), false, `local_only path must be repo-relative: ${value}`);
      assert.equal(value.includes(".."), false, `local_only path must not contain parent traversal: ${value}`);
      assert.equal(value.includes("Users"), false, `local_only path must not contain home segments: ${value}`);
      assert.equal(value.includes('"'), false, `local_only path must not carry C-style quoting: ${value}`);
      assert.equal(value.includes("\\"), false, `local_only path must not carry escape sequences: ${value}`);
    }
  } finally {
    cleanup(root);
  }
});

test("scan completes gracefully without git and reports churn availability honestly", () => {
  const root = makeTempDir();
  try {
    const bare = path.join(root, "bare");
    writeBareRepo(bare);
    const bareScan = analyzeRepoArchitecture({ repoPath: bare });
    assert.equal(bareScan.dimensions.maintainability.markers.churn_available, false);
    assert.deepEqual(bareScan.local_only.maintainability.most_churned_files, []);

    const rich = path.join(root, "rich");
    writeRichTsRepo(rich);
    const richScan = analyzeRepoArchitecture({ repoPath: rich });
    assert.equal(richScan.dimensions.maintainability.markers.churn_available, true);
  } finally {
    cleanup(root);
  }
});

test("git signals from a foreign ancestor repository are rejected, never leaked", () => {
  const root = makeTempDir();
  try {
    // Parent repo with history and a tag; the scan target is a NESTED non-repo
    // directory inside it. Git's repository discovery would find the parent —
    // the scanner must reject it: ancestor churn paths name files outside the
    // scanned root and ancestor tags/history are another repo's data.
    const parent = path.join(root, "parent");
    mkdirSync(parent, { recursive: true });
    write(parent, "parentonlysecretledger.ts", "export const parentMarker = 1;\n");
    writeFileSync(path.join(parent, "README.md"), "# Parent\n");
    initRepoWithCommits(parent);
    execFileSync("git", ["-C", parent, "tag", "v1.0.0"], { stdio: "ignore" });

    const nested = path.join(parent, "nested-app");
    write(nested, "package.json", '{\n  "name": "nested-fixture"\n}\n');
    write(nested, "src/app.ts", "export const nestedApp = true;\n");

    const scan = analyzeRepoArchitecture({ repoPath: nested });
    assert.equal(scan.dimensions.maintainability.markers.churn_available, false, "ancestor churn is rejected");
    assert.deepEqual(scan.local_only.maintainability.most_churned_files, [], "no ancestor paths in local_only");
    assert.equal(scan.dimensions.release_ops.markers.git_tag_count, 0, "ancestor tags are rejected");
    assert.equal(
      scan.dimensions.security_posture.markers.env_check_via_git,
      false,
      "env check falls back to the walked inventory",
    );
    assert.equal(
      JSON.stringify(scan).includes("parentonlysecretledger"),
      false,
      "no parent-repo file name may appear anywhere in the scan",
    );
  } finally {
    cleanup(root);
  }
});

test("backup artifacts of source files count as dead-code hints", () => {
  const root = makeTempDir();
  try {
    const repo = path.join(root, "repo");
    write(repo, "src/app.ts", "export const app = 1;\n");
    // "app.ts.bak" has extension ".bak", so it is never classified as a source
    // file — the detector must strip the backup suffix before classifying.
    write(repo, "src/app.ts.bak", "export const app = 1;\n");
    write(repo, "src/app_old.ts", "export const appOld = 1;\n");
    write(repo, "notes.txt.bak", "plain notes\n");

    const scan = analyzeRepoArchitecture({ repoPath: repo });
    // app.ts.bak (backup of a source file) + app_old.ts (infix pattern) = 2;
    // notes.txt.bak strips to a non-source name and does not count.
    assert.equal(scan.dimensions.maintainability.markers.dead_code_hint_count, 2);
  } finally {
    cleanup(root);
  }
});

test("skip list and generated artifact classification keep vendored code out of language stats", () => {
  const root = makeTempDir();
  try {
    const repo = path.join(root, "repo");
    write(repo, "package.json", '{\n  "name": "pruned-fixture"\n}\n');
    write(repo, "pnpm-lock.yaml", "lockfileVersion: '9.0'\n");
    write(repo, "src/app.ts", "export const app = 1;\n");
    const vendored = Array.from({ length: 200 }, (_, index) => `var vendored${index} = ${index};`).join("\n");
    write(repo, "node_modules/junk/big.js", vendored + "\n");
    write(repo, "dist/app.min.js", "var a=1;var b=2;\n");

    const scan = analyzeRepoArchitecture({ repoPath: repo });
    assert.equal(scan.primary_language, "typescript");
    assert.deepEqual(scan.languages, { typescript: 1 }, "pruned javascript contributes no LOC");
    assert.equal(scan.dimensions.modularity.markers.source_file_count, 1);
    assert.equal(scan.dimensions.dependency_hygiene.markers.lockfile_present, true);
    // Inventory holds package.json, pnpm-lock.yaml, src/app.ts; node_modules and dist are pruned dirs.
    assert.equal(scan.scan_meta.files_scanned, 3);
    assert.equal(scan.scan_meta.files_skipped, 2);
  } finally {
    cleanup(root);
  }
});
