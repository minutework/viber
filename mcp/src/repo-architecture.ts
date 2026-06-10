/**
 * Local-only deterministic repo-architecture scanner — repo_rubric 1.0.0.
 *
 * Walks ONE repository working tree (bounded, read-only) and emits the fixed
 * 10-dimension scorecard defined in skill/repo_rubric.md: documentation,
 * testing, ci_automation, type_safety, dependency_hygiene, security_posture,
 * modularity, architecture, maintainability, release_ops. Every scan result
 * carries ALL 10 keys; missing evidence is status "na" (never a dropped key),
 * while evidence of weak practice is a LOW SCORE, never "na".
 *
 * Privacy contract: outside `local_only` the result carries only numbers,
 * booleans, and pinned enum strings — no paths, file names, repo names, or
 * free text. The secret scan emits COUNTS only (never values or locations,
 * not even inside `local_only`). `local_only` strings are repo-relative POSIX
 * paths consumed LOCALLY by the host agent for the LLM-judged dimensions and
 * must never be copied into a profile. Repos are identified downstream by
 * primary language + size band, never by name or path.
 *
 * Determinism contract: same repo state (working tree + git state) yields a
 * byte-identical result minus `scan_meta.duration_ms`. Traversal and all
 * tie-breaking are lexicographic by repo-relative POSIX path. Git signals are
 * accepted only when the scanned root IS the git worktree root (verified via
 * `git rev-parse --show-toplevel`); a foreign ancestor repository never leaks
 * into markers or `local_only`. Sends nothing over the network.
 */

import { execFileSync } from "node:child_process";
import { lstatSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import path from "node:path";

import { isGeneratedArtifactPath } from "./extractors.js";
import { scrubSecrets } from "./redaction.js";

export const REPO_RUBRIC_VERSION = "1.0.0";
export const W_SESSION = 0.65; // blended-headline weight for session_overall (later slice)
export const W_ARTIFACT = 0.35; // blended-headline weight for portfolio_mean_overall (later slice)

export const DIMENSION_KEYS = [
  "documentation",
  "testing",
  "ci_automation",
  "type_safety",
  "dependency_hygiene",
  "security_posture",
  "modularity",
  "architecture",
  "maintainability",
  "release_ops",
] as const;
export type DimensionKey = (typeof DIMENSION_KEYS)[number];

export const REPO_SCAN_CAPS = {
  maxFilesWalked: 20000,
  maxContentBytes: 1048576, // 1 MiB per-file read cap for LOC/config/content checks
  maxSecretScanFileBytes: 262144, // 256 KiB
  maxSecretScanFiles: 2000,
  maxLocScanFiles: 8000,
  maxTodoScanFiles: 2000,
  timeBudgetMs: 10000,
  gitLogCommits: 500,
  gitTimeoutMs: 5000,
  gitMaxBufferBytes: 16777216,
} as const;

// Mirrors the private GENERATED_LOCK_BASENAMES set in extractors.ts (drift-guarded by test).
export const REPO_LOCK_BASENAMES = [
  "pnpm-lock.yaml",
  "package-lock.json",
  "yarn.lock",
  "poetry.lock",
  "cargo.lock",
  "gemfile.lock",
  "composer.lock",
  "uv.lock",
  "go.sum",
  "bun.lockb",
] as const;

export type PrimaryLanguage =
  | "typescript"
  | "javascript"
  | "python"
  | "go"
  | "rust"
  | "ruby"
  | "java"
  | "other"
  | "unknown";
export type SizeBand = "tiny" | "small" | "medium" | "large" | "very_large";
export type OverallGrade = "exceptional" | "strong" | "proficient" | "developing" | "emerging";

export type MarkerValue = number | boolean;

export interface ScanMeta {
  files_scanned: number; // files added to the inventory (post symlink/prune skips)
  files_skipped: number; // symlink entries + pruned dirs (1 each) + unreadable entries + entries discarded after caps
  truncated: boolean; // true if ANY bounded stage hit its cap (walk, time budget, LOC scan, TODO scan, secret scan)
  duration_ms: number; // wall clock; the ONLY time-derived value anywhere in the result
}

export interface ScoredDimension {
  status: "scored" | "na";
  score?: number; // integer 0-100; key OMITTED when status === "na"
  markers: Record<string, MarkerValue>; // full pinned key set, always present
}

export interface ArchitectureDimension {
  status: "llm_required" | "na";
  markers: Record<string, MarkerValue>;
}

export interface MaintainabilityDimension {
  status: "scored" | "na";
  score?: number; // === deterministic_score at scan time; OMITTED when na
  deterministic_score?: number; // OMITTED when na
  markers: Record<string, MarkerValue>;
}

export interface RepoArchitectureDimensions {
  documentation: ScoredDimension;
  testing: ScoredDimension;
  ci_automation: ScoredDimension;
  type_safety: ScoredDimension;
  dependency_hygiene: ScoredDimension;
  security_posture: ScoredDimension;
  modularity: ScoredDimension;
  architecture: ArchitectureDimension;
  maintainability: MaintainabilityDimension;
  release_ops: ScoredDimension;
}

export interface RepoArchitectureLocalOnly {
  // Consumed LOCALLY by the host agent for the LLM-judged dimensions.
  // The skill (later slice) MUST NEVER copy anything under local_only into a profile.
  architecture: {
    candidate_files: string[]; // repo-relative POSIX paths, max 40
    top_level_dirs: string[]; // repo-relative dir names with trailing "/", max 20
    entry_points: string[]; // repo-relative POSIX paths, max 10
  };
  maintainability: {
    largest_files: string[]; // top 5 by LOC (ties: lexicographic), repo-relative
    most_churned_files: string[]; // top 5 by churn lines, [] when churn unavailable
    todo_hotspots: string[]; // top 5 by TODO/FIXME match count (count>0 only)
  };
}

export interface RepoArchitectureScan {
  repo_rubric_version: typeof REPO_RUBRIC_VERSION;
  scan_meta: ScanMeta;
  primary_language: PrimaryLanguage;
  languages: Record<string, number>; // keys: subset of the 8 non-"unknown" languages with loc > 0; values: 2dp share of source LOC
  size_band: SizeBand;
  dimensions: RepoArchitectureDimensions;
  local_only: RepoArchitectureLocalOnly;
}

export interface RepoArchitectureOptions {
  repoPath?: string; // defaults to process.cwd() (matches LocalExtractorOptions convention)
}

// ---------------------------------------------------------------------------
// Internal constants
// ---------------------------------------------------------------------------

const SKIP_DIR_BASENAMES = new Set([
  ".git",
  "node_modules",
  "vendor",
  "dist",
  "build",
  "out",
  ".next",
  "target",
  "__generated__",
  "generated",
  "coverage",
  ".venv",
  "venv",
  "__pycache__",
  ".mypy_cache",
  ".pytest_cache",
  ".ruff_cache",
  ".tox",
  ".turbo",
  ".cache",
  ".idea",
  ".vscode",
  ".terraform",
  ".gradle",
  "Pods",
  "DerivedData",
  ".svelte-kit",
  ".nuxt",
  ".expo",
]);

const REPO_LOCK_BASENAME_SET = new Set<string>(REPO_LOCK_BASENAMES);

const SOURCE_EXT_LANGUAGE = new Map<string, PrimaryLanguage>([
  [".ts", "typescript"],
  [".tsx", "typescript"],
  [".mts", "typescript"],
  [".cts", "typescript"],
  [".js", "javascript"],
  [".jsx", "javascript"],
  [".mjs", "javascript"],
  [".cjs", "javascript"],
  [".py", "python"],
  [".pyi", "python"],
  [".go", "go"],
  [".rs", "rust"],
  [".rb", "ruby"],
  [".rake", "ruby"],
  [".java", "java"],
  [".c", "other"],
  [".h", "other"],
  [".cc", "other"],
  [".cpp", "other"],
  [".hpp", "other"],
  [".cs", "other"],
  [".php", "other"],
  [".swift", "other"],
  [".kt", "other"],
  [".kts", "other"],
  [".scala", "other"],
  [".clj", "other"],
  [".ex", "other"],
  [".exs", "other"],
  [".erl", "other"],
  [".hs", "other"],
  [".lua", "other"],
  [".pl", "other"],
  [".r", "other"],
  [".sh", "other"],
  [".bash", "other"],
  [".zsh", "other"],
  [".sql", "other"],
  [".vue", "other"],
  [".svelte", "other"],
  [".dart", "other"],
  [".zig", "other"],
  [".m", "other"],
  [".mm", "other"],
]);

const SOURCE_BASENAME_LANGUAGE = new Map<string, PrimaryLanguage>([
  ["gemfile", "ruby"],
  ["rakefile", "ruby"],
]);

const LANGUAGE_ORDER: PrimaryLanguage[] = [
  "typescript",
  "javascript",
  "python",
  "go",
  "rust",
  "ruby",
  "java",
  "other",
];

const DOC_EXTENSIONS = new Set([".md", ".mdx", ".rst", ".adoc"]);

const README_RE = /^readme(\.(md|markdown|rst|txt|adoc))?$/i;
const CONTRIBUTING_RE = /^contributing(\.(md|rst|txt))?$/i;
const CHANGELOG_RE = /^changelog(\.(md|rst|txt))?$/i;
const ADR_PATH_RE = /(^|\/)(adrs?|decisions)\//i;

const TEST_PATH_RE = /(^|\/)(__tests__|tests?|specs?)(\/|$)/;
const TEST_BASENAME_RE = /(\.|_|-)(test|spec)s?\.[a-z0-9]+$/;
const PY_TEST_PREFIX_RE = /^test_.+\.py$/;
const SUFFIX_TEST_RE = /_test\.(go|py|rb)$/;
const JAVA_TEST_RE = /tests?\.java$/;

const TODO_RE = /\b(TODO|FIXME)\b/g;
const HEALTH_RE = /\/health(z|check)?\b|healthcheck/i;
const OBSERVABILITY_RE = /prometheus|opentelemetry|open-telemetry|otel|statsd|datadog|sentry/i;
const PY_TYPED_RE = /(->\s*[\w"'\[])|(^\s*from\s+typing\s+import)|(^\s*import\s+typing\b)/m;

const ESLINT_BASENAMES = new Set([
  ".eslintrc",
  ".eslintrc.js",
  ".eslintrc.cjs",
  ".eslintrc.json",
  ".eslintrc.yml",
  ".eslintrc.yaml",
  "eslint.config.js",
  "eslint.config.mjs",
  "eslint.config.cjs",
  "eslint.config.ts",
]);

const GOLANGCI_BASENAMES = new Set([".golangci.yml", ".golangci.yaml", ".golangci.toml", ".golangci.json"]);

const TASK_RUNNER_BASENAMES = new Set(["Makefile", "makefile", "GNUmakefile", "justfile", "Justfile", ".justfile"]);
const TASK_RUNNER_TARGET_RE = /^(test|tests|lint|check|ci)[\w-]*\s*:/m;

const ENV_EXAMPLE_BASENAMES = new Set([".env.example", ".env.sample", ".env.template", "example.env"]);

const MONOREPO_BASENAMES = new Set(["pnpm-workspace.yaml", "lerna.json", "turbo.json", "go.work"]);

const LAYER_DIR_NAMES = new Set([
  "adapters",
  "api",
  "app",
  "application",
  "cmd",
  "components",
  "controllers",
  "core",
  "domain",
  "handlers",
  "infra",
  "infrastructure",
  "internal",
  "lib",
  "middleware",
  "models",
  "pkg",
  "repositories",
  "routes",
  "schemas",
  "services",
  "src",
  "ui",
  "usecases",
  "utils",
  "views",
  "workers",
]);

const ENTRY_POINT_RES = [
  /^(src\/)?(index|main|app|server|cli)\.[a-z]+$/,
  /^cmd\/[^/]+\/main\.go$/,
  /^src\/(main|lib)\.rs$/,
  /^manage\.py$/,
  /^(src\/)?__main__\.py$/,
];

const SECRET_SCAN_EXTRA_EXTENSIONS = new Set([
  ".json",
  ".yml",
  ".yaml",
  ".toml",
  ".ini",
  ".cfg",
  ".conf",
  ".txt",
  ".md",
  ".properties",
  ".tf",
  ".tfvars",
  ".env",
]);

const NUMSTAT_LINE_RE = /^(\d+|-)\t(\d+|-)\t(.+)$/;
const CONFIG_CONTENT_FILE_LIMIT = 20;

// ---------------------------------------------------------------------------
// Bounded walker (self-contained; deliberately differs from the extractors
// walkers: lstatSync so symlinks are SKIPPED, a prune list applied during
// traversal, and lexicographic — not mtime — ordering for determinism).
// ---------------------------------------------------------------------------

interface WalkedFile {
  relPath: string;
  absPath: string;
  sizeBytes: number;
}

interface WalkResult {
  files: WalkedFile[];
  filesSkipped: number;
  truncated: boolean;
  topLevelDirs: string[]; // non-pruned direct child dirs of root, lexicographic
}

function walkRepository(root: string, startMs: number): WalkResult {
  const files: WalkedFile[] = [];
  const topLevelDirs: string[] = [];
  let filesSkipped = 0;
  let truncated = false;
  const stack: string[] = [root];

  outer: while (stack.length > 0) {
    if (Date.now() - startMs > REPO_SCAN_CAPS.timeBudgetMs) {
      truncated = true;
      break;
    }
    const dir = stack.pop();
    if (dir === undefined) {
      break;
    }
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      filesSkipped += 1;
      continue;
    }
    entries.sort();
    const childDirs: string[] = [];
    for (const entry of entries) {
      const full = path.join(dir, entry);
      let stats;
      try {
        stats = lstatSync(full);
      } catch {
        filesSkipped += 1;
        continue;
      }
      if (stats.isSymbolicLink()) {
        filesSkipped += 1;
        continue;
      }
      if (stats.isDirectory()) {
        if (SKIP_DIR_BASENAMES.has(entry)) {
          filesSkipped += 1;
          continue;
        }
        childDirs.push(full);
        if (dir === root) {
          topLevelDirs.push(entry);
        }
        continue;
      }
      if (!stats.isFile()) {
        continue;
      }
      if (files.length >= REPO_SCAN_CAPS.maxFilesWalked) {
        filesSkipped += 1;
        truncated = true;
        break outer;
      }
      files.push({
        relPath: path.relative(root, full).split(path.sep).join("/"),
        absPath: full,
        sizeBytes: stats.size,
      });
    }
    // Reverse lexicographic push so the lexicographically first child is popped next.
    for (let index = childDirs.length - 1; index >= 0; index -= 1) {
      const child = childDirs[index];
      if (child !== undefined) {
        stack.push(child);
      }
    }
  }

  topLevelDirs.sort();
  return { files, filesSkipped, truncated, topLevelDirs };
}

// ---------------------------------------------------------------------------
// Per-file classification and content helpers
// ---------------------------------------------------------------------------

interface ClassifiedFile extends WalkedFile {
  base: string; // original-case basename
  lowerRel: string;
  lowerBase: string;
  ext: string; // lowercased basename extension including ".", "" when none
  generated: boolean;
  isLockfile: boolean;
  language: PrimaryLanguage | null; // null = not a source file shape
  isDoc: boolean;
  isSource: boolean; // non-generated && language matched
  isTest: boolean; // source files only
  loc: number; // filled by the bounded LOC scan; 0 when unread/binary/over-cap
}

function extOf(lowerBase: string): string {
  const dotIndex = lowerBase.lastIndexOf(".");
  if (dotIndex <= 0) {
    return "";
  }
  return lowerBase.slice(dotIndex);
}

function isTestSourcePath(lowerRel: string, lowerBase: string): boolean {
  return (
    TEST_PATH_RE.test(lowerRel) ||
    TEST_BASENAME_RE.test(lowerBase) ||
    PY_TEST_PREFIX_RE.test(lowerBase) ||
    SUFFIX_TEST_RE.test(lowerBase) ||
    JAVA_TEST_RE.test(lowerBase)
  );
}

function classifyFile(file: WalkedFile): ClassifiedFile {
  const base = file.relPath.split("/").pop() ?? "";
  const lowerRel = file.relPath.toLowerCase();
  const lowerBase = base.toLowerCase();
  const ext = extOf(lowerBase);
  const generated = isGeneratedArtifactPath(file.relPath);
  const language = SOURCE_EXT_LANGUAGE.get(ext) ?? SOURCE_BASENAME_LANGUAGE.get(lowerBase) ?? null;
  const isDoc = !generated && DOC_EXTENSIONS.has(ext);
  const isSource = !generated && language !== null;
  const isTest = isSource && isTestSourcePath(lowerRel, lowerBase);
  return {
    ...file,
    base,
    lowerRel,
    lowerBase,
    ext,
    generated,
    isLockfile: REPO_LOCK_BASENAME_SET.has(lowerBase),
    language,
    isDoc,
    isSource,
    isTest,
    loc: 0,
  };
}

function isBinaryBuffer(buffer: Buffer): boolean {
  const probeLength = Math.min(buffer.length, 8192);
  for (let index = 0; index < probeLength; index += 1) {
    if (buffer[index] === 0) {
      return true;
    }
  }
  return false;
}

function countLoc(buffer: Buffer): number {
  let lines = 0;
  for (let index = 0; index < buffer.length; index += 1) {
    if (buffer[index] === 0x0a) {
      lines += 1;
    }
  }
  if (buffer.length > 0 && buffer[buffer.length - 1] !== 0x0a) {
    lines += 1;
  }
  return lines;
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

function round4(value: number): number {
  return Math.round(value * 10000) / 10000;
}

function compareStrings(left: string, right: string): number {
  if (left < right) {
    return -1;
  }
  if (left > right) {
    return 1;
  }
  return 0;
}

function isRepoRelativePath(candidate: string): boolean {
  if (candidate.length === 0 || candidate.startsWith("/")) {
    return false;
  }
  return !candidate.split("/").includes("..");
}

// Returns the named manifest pattern a basename belongs to (null when none).
// The pattern key exists so content checks can apply the per-pattern 20-file
// budget (§2 common rules) instead of a single budget over the union.
function manifestPatternOf(lowerBase: string): string | null {
  if (lowerBase === "package.json") {
    return "package.json";
  }
  if (lowerBase === "pyproject.toml") {
    return "pyproject.toml";
  }
  if (lowerBase === "setup.py") {
    return "setup.py";
  }
  if (lowerBase === "setup.cfg") {
    return "setup.cfg";
  }
  if (lowerBase.startsWith("requirements") && lowerBase.endsWith(".txt")) {
    return "requirements*.txt";
  }
  if (lowerBase === "pipfile") {
    return "Pipfile";
  }
  if (lowerBase === "go.mod") {
    return "go.mod";
  }
  if (lowerBase === "cargo.toml") {
    return "Cargo.toml";
  }
  if (lowerBase === "gemfile") {
    return "Gemfile";
  }
  if (lowerBase.endsWith(".gemspec")) {
    return "*.gemspec";
  }
  if (lowerBase === "pom.xml") {
    return "pom.xml";
  }
  if (lowerBase === "build.gradle") {
    return "build.gradle";
  }
  if (lowerBase === "build.gradle.kts") {
    return "build.gradle.kts";
  }
  return null;
}

function isManifestBasename(lowerBase: string): boolean {
  return manifestPatternOf(lowerBase) !== null;
}

function isCommittedEnvBasename(lowerBase: string): boolean {
  if (ENV_EXAMPLE_BASENAMES.has(lowerBase)) {
    return false;
  }
  return lowerBase === ".env" || lowerBase.startsWith(".env.");
}

// Backup/merge artifacts of source files: an "app.ts.bak" carries the extension
// ".bak", so it is never classified as a source file — the suffix check must
// strip the backup suffix first and classify what remains, otherwise the
// dead-code branch for .bak/.orig/.rej could never fire.
const DEAD_CODE_BACKUP_SUFFIXES = [".bak", ".orig", ".rej"];

function isBackupOfSourceBasename(lowerBase: string): boolean {
  for (const suffix of DEAD_CODE_BACKUP_SUFFIXES) {
    if (!lowerBase.endsWith(suffix)) {
      continue;
    }
    const stripped = lowerBase.slice(0, -suffix.length);
    if (SOURCE_EXT_LANGUAGE.has(extOf(stripped)) || SOURCE_BASENAME_LANGUAGE.has(stripped)) {
      return true;
    }
  }
  return false;
}

function sizeBandFor(totalSourceLoc: number): SizeBand {
  if (totalSourceLoc < 2000) {
    return "tiny";
  }
  if (totalSourceLoc < 10000) {
    return "small";
  }
  if (totalSourceLoc < 50000) {
    return "medium";
  }
  if (totalSourceLoc < 200000) {
    return "large";
  }
  return "very_large";
}

// ---------------------------------------------------------------------------
// Bounded, graceful git access (three calls max; any failure degrades)
// ---------------------------------------------------------------------------

function runGit(root: string, args: string[]): string | null {
  // Scrub redirection variables so git can only describe the repository at the
  // scan root (an inherited GIT_DIR/GIT_WORK_TREE could otherwise point every
  // call at an arbitrary foreign repo), and ceiling-bound upward discovery so
  // git does not walk above the scan root's parent looking for an ancestor.
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env.GIT_DIR;
  delete env.GIT_WORK_TREE;
  delete env.GIT_INDEX_FILE;
  delete env.GIT_OBJECT_DIRECTORY;
  delete env.GIT_COMMON_DIR;
  delete env.GIT_ALTERNATE_OBJECT_DIRECTORIES;
  env.GIT_CEILING_DIRECTORIES = path.dirname(root);
  try {
    return execFileSync("git", args, {
      cwd: root,
      encoding: "utf8",
      env,
      timeout: REPO_SCAN_CAPS.gitTimeoutMs,
      maxBuffer: REPO_SCAN_CAPS.gitMaxBufferBytes,
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch {
    return null;
  }
}

// The scanned root must BE the git worktree root before any git output is
// trusted. Without this gate, git discovers the nearest ANCESTOR repository
// when scanning a nested directory (a monorepo package, any folder under a
// home-directory dotfiles repo), and the churn/tag signals — including the
// `local_only` churn paths — would describe a FOREIGN repo: out-of-tree paths
// in `local_only`, foreign history in profile-bound markers, and scan output
// that changes with ancestor git state. Scope failure degrades to the no-git
// fallbacks (churn unavailable, zero tags, inventory env check); never throws.
function isGitScopedToRoot(root: string): boolean {
  const output = runGit(root, ["rev-parse", "--show-toplevel"]);
  if (output === null) {
    return false;
  }
  const toplevel = output.trim();
  if (toplevel.length === 0) {
    return false;
  }
  try {
    // realpath both sides: git reports a symlink-resolved toplevel (e.g. macOS
    // /var/folders -> /private/var/folders) while the caller may pass either form.
    return realpathSync(toplevel) === realpathSync(root);
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Scan
// ---------------------------------------------------------------------------

export function analyzeRepoArchitecture(options: RepoArchitectureOptions = {}): RepoArchitectureScan {
  const startMs = Date.now();
  const root = path.resolve(options.repoPath ?? process.cwd());
  let rootStats;
  try {
    rootStats = lstatSync(root);
  } catch {
    throw new Error("repo path is not a directory");
  }
  if (!rootStats.isDirectory()) {
    throw new Error("repo path is not a directory");
  }

  const walk = walkRepository(root, startMs);
  const files = walk.files.map((file) => classifyFile(file));
  const rootFiles = files.filter((file) => !file.relPath.includes("/"));
  const sourceFiles = files.filter((file) => file.isSource);

  // --- bounded config-content reader (cached; never reads files over the cap)
  const configTextCache = new Map<string, string | null>();
  const readConfigText = (file: ClassifiedFile): string | null => {
    const cached = configTextCache.get(file.relPath);
    if (cached !== undefined) {
      return cached;
    }
    let text: string | null = null;
    if (file.sizeBytes <= REPO_SCAN_CAPS.maxContentBytes) {
      try {
        const buffer = readFileSync(file.absPath);
        text = isBinaryBuffer(buffer) ? null : buffer.toString("utf8");
      } catch {
        text = null;
      }
    }
    configTextCache.set(file.relPath, text);
    return text;
  };
  const anyContentMatches = (candidates: ClassifiedFile[], pattern: RegExp): boolean => {
    for (const file of candidates.slice(0, CONFIG_CONTENT_FILE_LIMIT)) {
      const text = readConfigText(file);
      if (text !== null && pattern.test(text)) {
        return true;
      }
    }
    return false;
  };
  const filterContentMatches = (candidates: ClassifiedFile[], pattern: RegExp): ClassifiedFile[] =>
    candidates.slice(0, CONFIG_CONTENT_FILE_LIMIT).filter((file) => {
      const text = readConfigText(file);
      return text !== null && pattern.test(text);
    });
  // The 20-file content budget applies PER named config pattern, never to a
  // union of patterns: each group below is one named pattern's matches in walk
  // order, and the budget is applied inside `anyContentMatches` per group.
  const anyContentMatchesPerPattern = (groups: ClassifiedFile[][], pattern: RegExp): boolean =>
    groups.some((group) => anyContentMatches(group, pattern));

  // All git-derived signals are gated on the scanned root being the git
  // worktree root itself; a foreign ancestor repository is never consulted.
  const gitScoped = isGitScopedToRoot(root);

  // --- LOC scan + TODO/health/python-typing scan (bounded, walk order) ------
  let locTruncated = sourceFiles.some((file) => file.sizeBytes > REPO_SCAN_CAPS.maxContentBytes);
  const locEligible = sourceFiles.filter((file) => file.sizeBytes <= REPO_SCAN_CAPS.maxContentBytes);
  if (locEligible.length > REPO_SCAN_CAPS.maxLocScanFiles) {
    locTruncated = true;
  }
  const locScanSet = locEligible.slice(0, REPO_SCAN_CAPS.maxLocScanFiles);
  const todoTruncated = locScanSet.length > REPO_SCAN_CAPS.maxTodoScanFiles;

  let todoFixmeCount = 0;
  let healthSignalFromScan = false;
  let pythonFilesScanned = 0;
  let pythonTypedFiles = 0;
  const todoHotspotCounts: Array<{ relPath: string; count: number }> = [];

  locScanSet.forEach((file, index) => {
    let buffer: Buffer;
    try {
      buffer = readFileSync(file.absPath);
    } catch {
      return; // content unavailable — contributes 0 LOC, never throws
    }
    if (isBinaryBuffer(buffer)) {
      return; // binary: 0 LOC, excluded from all content scans
    }
    file.loc = countLoc(buffer);
    if (index < REPO_SCAN_CAPS.maxTodoScanFiles) {
      const text = buffer.toString("utf8");
      const matches = text.match(TODO_RE);
      const matchCount = matches === null ? 0 : matches.length;
      todoFixmeCount += matchCount;
      if (matchCount > 0) {
        todoHotspotCounts.push({ relPath: file.relPath, count: matchCount });
      }
      if (!healthSignalFromScan && HEALTH_RE.test(text)) {
        healthSignalFromScan = true;
      }
      if (file.ext === ".py") {
        pythonFilesScanned += 1;
        if (PY_TYPED_RE.test(text)) {
          pythonTypedFiles += 1;
        }
      }
    }
  });

  // --- languages, primary_language, size_band -------------------------------
  const languageLoc = new Map<PrimaryLanguage, number>();
  let totalSourceLoc = 0;
  for (const file of sourceFiles) {
    totalSourceLoc += file.loc;
    if (file.language !== null) {
      languageLoc.set(file.language, (languageLoc.get(file.language) ?? 0) + file.loc);
    }
  }
  const languages: Record<string, number> = {};
  let primaryLanguage: PrimaryLanguage = "unknown";
  let primaryLoc = 0;
  for (const language of LANGUAGE_ORDER) {
    const loc = languageLoc.get(language) ?? 0;
    if (loc > 0 && totalSourceLoc > 0) {
      languages[language] = round2(loc / totalSourceLoc);
    }
    if (loc > primaryLoc) {
      primaryLoc = loc;
      primaryLanguage = language; // ties broken by enum order: earlier wins (strict >)
    }
  }
  const sizeBand = sizeBandFor(totalSourceLoc);

  // --- shared file lookups ---------------------------------------------------
  const rootPackageJson = files.find((file) => file.lowerRel === "package.json");
  const rootPackageJsonText = rootPackageJson === undefined ? null : readConfigText(rootPackageJson);
  const rootPyproject = files.find((file) => file.lowerRel === "pyproject.toml");
  const rootPyprojectText = rootPyproject === undefined ? null : readConfigText(rootPyproject);
  const rootSetupCfg = files.find((file) => file.lowerRel === "setup.cfg");
  const rootSetupCfgText = rootSetupCfg === undefined ? null : readConfigText(rootSetupCfg);
  const rootCargoFiles = files.filter((file) => file.lowerRel === "cargo.toml");
  const pyprojectFiles = files.filter((file) => file.lowerBase === "pyproject.toml");
  const setupCfgFiles = files.filter((file) => file.lowerBase === "setup.cfg");
  // pom.xml / build.gradle / build.gradle.kts are three named patterns; keep
  // them as separate groups so content checks budget per pattern.
  const javaBuildGroups: ClassifiedFile[][] = [
    files.filter((file) => file.lowerBase === "pom.xml"),
    files.filter((file) => file.lowerBase === "build.gradle"),
    files.filter((file) => file.lowerBase === "build.gradle.kts"),
  ];
  const manifestFiles = files.filter((file) => isManifestBasename(file.lowerBase));
  const manifestGroupsByPattern = new Map<string, ClassifiedFile[]>();
  for (const file of manifestFiles) {
    const patternKey = manifestPatternOf(file.lowerBase);
    if (patternKey === null) {
      continue;
    }
    const group = manifestGroupsByPattern.get(patternKey);
    if (group === undefined) {
      manifestGroupsByPattern.set(patternKey, [file]);
    } else {
      group.push(file);
    }
  }
  const manifestGroups = [...manifestGroupsByPattern.values()];
  const lockfileFiles = files.filter((file) => file.isLockfile);

  // --- 6.1 documentation -----------------------------------------------------
  const readmeFile = rootFiles.find((file) => README_RE.test(file.base));
  const readmePresent = readmeFile !== undefined;
  const readmeBytes = readmeFile === undefined ? 0 : readmeFile.sizeBytes;
  const docDirNames = ["doc", "docs", "documentation"].filter(
    (name) =>
      walk.topLevelDirs.includes(name) && files.some((file) => file.isDoc && file.relPath.startsWith(`${name}/`)),
  );
  const docsDirPresent = docDirNames.length > 0;
  const docsIndexPresent = docDirNames.some((name) =>
    files.some((file) => file.lowerRel === `${name}/index.md` || file.lowerRel === `${name}/readme.md`),
  );
  const adrPresent = files.some((file) => file.isDoc && file.ext === ".md" && ADR_PATH_RE.test(file.relPath));
  const contributingPresent = rootFiles.some((file) => CONTRIBUTING_RE.test(file.base));
  const docFileCount = files.filter((file) => file.isDoc).length;

  const documentationMarkers: Record<string, MarkerValue> = {
    readme_present: readmePresent,
    readme_bytes: readmeBytes,
    docs_dir_present: docsDirPresent,
    docs_index_present: docsIndexPresent,
    adr_present: adrPresent,
    contributing_present: contributingPresent,
    doc_file_count: docFileCount,
    doc_to_source_file_ratio: round4(docFileCount / Math.max(sourceFiles.length, 1)),
  };
  let documentationScore = 0;
  if (readmePresent) {
    documentationScore += 20;
  }
  if (readmeBytes >= 500) {
    documentationScore += 15;
  }
  if (readmeBytes >= 3000) {
    documentationScore += 10;
  }
  if (docsDirPresent) {
    documentationScore += 20;
  }
  if (docsIndexPresent) {
    documentationScore += 5;
  }
  if (adrPresent) {
    documentationScore += 10;
  }
  if (contributingPresent) {
    documentationScore += 10;
  }
  if (docFileCount >= 5) {
    documentationScore += 10;
  }
  const documentationNa = !readmePresent && docFileCount === 0 && !contributingPresent && !docsDirPresent;

  // --- 6.2 testing -----------------------------------------------------------
  const testFiles = sourceFiles.filter((file) => file.isTest);
  const nonTestSourceCount = sourceFiles.length - testFiles.length;
  const testToSourceRatio = round4(testFiles.length / Math.max(nonTestSourceCount, 1));
  const testDirPresent = files.some((file) => {
    const segments = file.lowerRel.split("/");
    return segments
      .slice(0, -1)
      .some(
        (segment) =>
          segment === "__tests__" || segment === "test" || segment === "tests" || segment === "spec" || segment === "specs",
      );
  });
  let testFrameworkConfigPresent = files.some(
    (file) =>
      file.lowerBase.startsWith("jest.config.") ||
      file.lowerBase.startsWith("vitest.config.") ||
      file.lowerBase.startsWith("vitest.workspace.") ||
      file.lowerBase.startsWith("playwright.config.") ||
      file.lowerBase.startsWith("cypress.config.") ||
      file.lowerBase === "karma.conf.js" ||
      file.lowerBase === "pytest.ini" ||
      file.lowerBase === "tox.ini" ||
      file.lowerBase === "conftest.py" ||
      file.lowerBase === ".rspec" ||
      /(^|\/)spec\/(spec_helper|rails_helper)\.rb$/.test(file.lowerRel),
  );
  if (!testFrameworkConfigPresent && rootPyprojectText !== null && /\[tool\.pytest\.ini_options\]/.test(rootPyprojectText)) {
    testFrameworkConfigPresent = true;
  }
  if (!testFrameworkConfigPresent && rootSetupCfgText !== null && /\[tool:pytest\]/.test(rootSetupCfgText)) {
    testFrameworkConfigPresent = true;
  }
  if (!testFrameworkConfigPresent && anyContentMatchesPerPattern(javaBuildGroups, /junit|testng/i)) {
    testFrameworkConfigPresent = true;
  }
  if ((primaryLanguage === "go" || primaryLanguage === "rust") && testFiles.length > 0) {
    testFrameworkConfigPresent = true; // built-in toolchain
  }

  const testingMarkers: Record<string, MarkerValue> = {
    test_file_count: testFiles.length,
    source_file_count: nonTestSourceCount,
    test_to_source_ratio: testToSourceRatio,
    test_framework_config_present: testFrameworkConfigPresent,
    test_dir_present: testDirPresent,
  };
  let testingScore = 0;
  if (testFiles.length >= 1) {
    testingScore += 30;
  }
  if (testToSourceRatio >= 0.05) {
    testingScore += 10;
  }
  if (testToSourceRatio >= 0.15) {
    testingScore += 15;
  }
  if (testToSourceRatio >= 0.3) {
    testingScore += 15;
  }
  if (testToSourceRatio >= 0.5) {
    testingScore += 10;
  }
  if (testFrameworkConfigPresent) {
    testingScore += 10;
  }
  if (testDirPresent) {
    testingScore += 10;
  }
  const testingNa = testFiles.length === 0 && !testFrameworkConfigPresent && !testDirPresent;

  // --- 6.3 ci_automation -----------------------------------------------------
  const workflowFiles = files.filter((file) => /^\.github\/workflows\/[^/]+\.(yml|yaml)$/.test(file.lowerRel));
  const altCiKinds: Array<(file: ClassifiedFile) => boolean> = [
    (file) => file.lowerBase === ".gitlab-ci.yml",
    (file) => file.lowerRel === ".circleci/config.yml",
    (file) => file.lowerBase === "azure-pipelines.yml",
    (file) => file.lowerBase === "jenkinsfile",
    (file) => file.lowerBase === ".travis.yml",
    (file) => file.lowerRel === ".buildkite/pipeline.yml",
    (file) => file.lowerBase === ".drone.yml",
  ];
  let ciWorkflowCount = workflowFiles.length;
  const ciFileGroups: ClassifiedFile[][] = [workflowFiles];
  for (const matchesKind of altCiKinds) {
    const kindFiles = files.filter(matchesKind);
    if (kindFiles.length > 0) {
      ciWorkflowCount += 1;
      ciFileGroups.push(kindFiles);
    }
  }
  const ciPresent = ciWorkflowCount >= 1;
  const ciRunsTests = anyContentMatchesPerPattern(ciFileGroups, /\btests?\b/i);
  const precommitPresent =
    files.some(
      (file) =>
        file.lowerBase === ".pre-commit-config.yaml" || file.lowerBase === "lefthook.yml" || file.lowerBase === ".lefthook.yml",
    ) ||
    files.some((file) => file.lowerRel.startsWith(".husky/")) ||
    (rootPackageJsonText !== null && /"(husky|lint-staged|simple-git-hooks)"/.test(rootPackageJsonText));
  const taskRunnerFiles = rootFiles.filter((file) => TASK_RUNNER_BASENAMES.has(file.base));
  const taskRunnerQualityTargets = anyContentMatches(taskRunnerFiles, TASK_RUNNER_TARGET_RE);

  const ciMarkers: Record<string, MarkerValue> = {
    ci_workflow_count: ciWorkflowCount,
    ci_present: ciPresent,
    ci_runs_tests: ciRunsTests,
    precommit_present: precommitPresent,
    task_runner_quality_targets: taskRunnerQualityTargets,
  };
  let ciScore = 0;
  if (ciPresent) {
    ciScore += 40;
  }
  if (ciWorkflowCount >= 2) {
    ciScore += 15;
  }
  if (ciRunsTests) {
    ciScore += 15;
  }
  if (precommitPresent) {
    ciScore += 15;
  }
  if (taskRunnerQualityTargets) {
    ciScore += 15;
  }
  const ciNa = !ciPresent && !precommitPresent && !taskRunnerQualityTargets;

  // --- 6.4 type_safety -------------------------------------------------------
  const tsconfigFiles = files.filter((file) => /^tsconfig[^/]*\.json$/.test(file.lowerBase));
  const tsconfigPresent = tsconfigFiles.length > 0;
  const tsconfigStrict = anyContentMatches(tsconfigFiles, /"strict"\s*:\s*true/);

  const mypyIniFiles = files.filter((file) => file.lowerBase === "mypy.ini");
  const dotMypyIniFiles = files.filter((file) => file.lowerBase === ".mypy.ini");
  const pyrightConfigFiles = files.filter((file) => file.lowerBase === "pyrightconfig.json");
  const setupCfgMypyFiles = filterContentMatches(setupCfgFiles, /\[mypy\]/);
  const pyprojectTypeFiles = filterContentMatches(pyprojectFiles, /\[tool\.(mypy|pyright)\]/);
  const pythonTypeConfigGroups: ClassifiedFile[][] = [
    mypyIniFiles,
    dotMypyIniFiles,
    setupCfgMypyFiles,
    pyprojectTypeFiles,
    pyrightConfigFiles,
  ];
  const pythonTypeConfigPresent = pythonTypeConfigGroups.some((group) => group.length > 0);
  const pythonStrict = anyContentMatchesPerPattern(pythonTypeConfigGroups, /strict\s*[=:]\s*true/i);
  const pyTypedMarkerPresent = files.some((file) => file.lowerBase === "py.typed");

  const sorbetConfigPresent = files.some((file) => file.lowerRel === "sorbet/config");
  const sigRbsPresent = files.some((file) => file.lowerRel.startsWith("sig/") && file.lowerRel.endsWith(".rbs"));

  const linterConfigPresent =
    files.some((file) => ESLINT_BASENAMES.has(file.lowerBase)) ||
    files.some((file) => file.lowerBase === "biome.json" || file.lowerBase === "biome.jsonc") ||
    files.some((file) => file.lowerBase === "ruff.toml" || file.lowerBase === ".ruff.toml") ||
    anyContentMatches(pyprojectFiles, /\[tool\.ruff\]/) ||
    files.some((file) => file.lowerBase === ".flake8") ||
    anyContentMatches(setupCfgFiles, /\[flake8\]/) ||
    files.some((file) => file.lowerBase === ".pylintrc") ||
    anyContentMatches(pyprojectFiles, /\[tool\.pylint/) ||
    files.some((file) => GOLANGCI_BASENAMES.has(file.lowerBase)) ||
    files.some((file) => file.lowerBase === "clippy.toml" || file.lowerBase === ".clippy.toml") ||
    files.some((file) => file.lowerBase === ".rubocop.yml") ||
    files.some(
      (file) => file.lowerBase === "checkstyle.xml" || file.lowerBase === "pmd.xml" || file.lowerBase === "spotbugs.xml",
    ) ||
    anyContentMatchesPerPattern(javaBuildGroups, /checkstyle|pmd|spotbugs|spotless|errorprone/i);

  const formatterConfigPresent =
    files.some(
      (file) =>
        file.lowerBase.startsWith(".prettierrc") ||
        file.lowerBase === "prettier.config.js" ||
        file.lowerBase === "prettier.config.cjs" ||
        file.lowerBase === "prettier.config.mjs",
    ) ||
    files.some((file) => file.lowerBase === "biome.json" || file.lowerBase === "biome.jsonc") ||
    (rootPackageJsonText !== null && /"prettier"\s*:/.test(rootPackageJsonText)) ||
    anyContentMatches(pyprojectFiles, /\[tool\.black\]/) ||
    anyContentMatches(pyprojectFiles, /\[tool\.ruff\.format\]/) ||
    files.some((file) => file.lowerBase === ".style.yapf") ||
    files.some((file) => file.lowerBase === "rustfmt.toml" || file.lowerBase === ".rustfmt.toml") ||
    files.some((file) => file.lowerBase === ".rubocop.yml") ||
    anyContentMatchesPerPattern(javaBuildGroups, /spotless|google-java-format/i) ||
    files.some((file) => file.lowerRel === ".editorconfig") ||
    primaryLanguage === "go" || // gofmt built-in
    primaryLanguage === "rust"; // rustfmt built-in

  let typeConfigPresent = false;
  let strictMode = false;
  let typedRatio = 0;
  let staticallyTypedLanguage = false;
  if (primaryLanguage === "typescript" || primaryLanguage === "javascript") {
    typeConfigPresent = tsconfigPresent;
    strictMode = tsconfigStrict;
    const tsLoc = languageLoc.get("typescript") ?? 0;
    const jsLoc = languageLoc.get("javascript") ?? 0;
    typedRatio = tsLoc + jsLoc > 0 ? round4(tsLoc / (tsLoc + jsLoc)) : 0;
  } else if (primaryLanguage === "python") {
    typeConfigPresent = pythonTypeConfigPresent;
    strictMode = pythonTypeConfigPresent && pythonStrict;
    typedRatio = pythonFilesScanned > 0 ? round4(pythonTypedFiles / pythonFilesScanned) : 0;
  } else if (primaryLanguage === "go" || primaryLanguage === "rust" || primaryLanguage === "java") {
    staticallyTypedLanguage = true;
  } else if (primaryLanguage === "ruby") {
    typeConfigPresent = sorbetConfigPresent || sigRbsPresent;
  }

  let typedComponent = 0;
  if (primaryLanguage === "typescript" || primaryLanguage === "javascript") {
    if (typeConfigPresent) {
      typedComponent += 20;
    }
    if (strictMode) {
      typedComponent += 15;
    }
    if (typedRatio >= 0.8) {
      typedComponent += 15;
    } else if (typedRatio >= 0.5) {
      typedComponent += 8;
    }
  } else if (primaryLanguage === "python") {
    if (typeConfigPresent) {
      typedComponent += 25;
    }
    if (typedRatio >= 0.5) {
      typedComponent += 15;
    } else if (typedRatio >= 0.2) {
      typedComponent += 8;
    }
    if (pyTypedMarkerPresent) {
      typedComponent += 10;
    }
  } else if (staticallyTypedLanguage) {
    typedComponent = 50;
  } else if (primaryLanguage === "ruby") {
    if (sorbetConfigPresent) {
      typedComponent += 30;
    }
    if (sigRbsPresent) {
      typedComponent += 20;
    }
  }

  const typeSafetyMarkers: Record<string, MarkerValue> = {
    type_config_present: typeConfigPresent,
    strict_mode: strictMode,
    typed_ratio: typedRatio,
    statically_typed_language: staticallyTypedLanguage,
    linter_config_present: linterConfigPresent,
    formatter_config_present: formatterConfigPresent,
  };
  const typeSafetyScore = typedComponent + (linterConfigPresent ? 30 : 0) + (formatterConfigPresent ? 20 : 0);
  const anyTypeConfigAnyStack = tsconfigPresent || pythonTypeConfigPresent || sorbetConfigPresent || sigRbsPresent;
  const typeSafetyNa =
    (primaryLanguage === "other" || primaryLanguage === "unknown") &&
    !anyTypeConfigAnyStack &&
    !linterConfigPresent &&
    !formatterConfigPresent;

  // --- 6.5 dependency_hygiene --------------------------------------------------
  const manifestPresent = manifestFiles.length > 0;
  const lockfilePresent = lockfileFiles.length > 0;
  const updateAutomationPresent = files.some(
    (file) =>
      file.lowerRel === ".github/dependabot.yml" ||
      file.lowerRel === ".github/dependabot.yaml" ||
      file.lowerBase === "renovate.json" ||
      file.lowerBase === "renovate.json5" ||
      file.lowerBase === ".renovaterc" ||
      file.lowerBase === ".renovaterc.json",
  );
  const securityPolicyPresent = files.some(
    (file) =>
      file.lowerRel === "security.md" || file.lowerRel === ".github/security.md" || file.lowerRel === "docs/security.md",
  );
  const rootRequirementsFiles = rootFiles.filter(
    (file) => file.lowerBase.startsWith("requirements") && file.lowerBase.endsWith(".txt"),
  );
  let requirementsPinned = false;
  const requirementLines: string[] = [];
  for (const file of rootRequirementsFiles.slice(0, CONFIG_CONTENT_FILE_LIMIT)) {
    const text = readConfigText(file);
    if (text === null) {
      continue;
    }
    for (const rawLine of text.split("\n")) {
      const line = rawLine.trim();
      if (line.length === 0 || line.startsWith("#") || line.startsWith("-r") || line.startsWith("--")) {
        continue;
      }
      requirementLines.push(line);
    }
  }
  if (requirementLines.length > 0) {
    const pinnedLines = requirementLines.filter((line) => line.includes("==")).length;
    requirementsPinned = pinnedLines / requirementLines.length >= 0.8;
  }
  const pinnedDeps = lockfilePresent || requirementsPinned;

  const dependencyMarkers: Record<string, MarkerValue> = {
    manifest_present: manifestPresent,
    manifest_count: manifestFiles.length,
    lockfile_present: lockfilePresent,
    lockfile_count: lockfileFiles.length,
    update_automation_present: updateAutomationPresent,
    security_policy_present: securityPolicyPresent,
    pinned_deps: pinnedDeps,
  };
  let dependencyScore = 0;
  if (manifestPresent) {
    dependencyScore += 25;
  }
  if (lockfilePresent) {
    dependencyScore += 30;
  }
  if (updateAutomationPresent) {
    dependencyScore += 20;
  }
  if (securityPolicyPresent) {
    dependencyScore += 10;
  }
  if (pinnedDeps) {
    dependencyScore += 15;
  }
  const dependencyNa = !manifestPresent;

  // --- 6.6 security_posture (secret scan emits COUNTS ONLY) -------------------
  let secretMatchCount = 0;
  let secretScanUnconfidentFiles = 0;
  let filesSecretScanned = 0;
  let secretScanTruncated = false;
  for (const file of files) {
    if (file.generated || file.sizeBytes > REPO_SCAN_CAPS.maxSecretScanFileBytes) {
      continue;
    }
    const extEligible =
      SOURCE_EXT_LANGUAGE.has(file.ext) || SECRET_SCAN_EXTRA_EXTENSIONS.has(file.ext) || file.lowerBase.startsWith(".env");
    if (!extEligible) {
      continue;
    }
    if (filesSecretScanned >= REPO_SCAN_CAPS.maxSecretScanFiles) {
      secretScanTruncated = true;
      break;
    }
    let buffer: Buffer;
    try {
      buffer = readFileSync(file.absPath);
    } catch {
      continue;
    }
    if (isBinaryBuffer(buffer)) {
      continue;
    }
    const result = scrubSecrets(buffer.toString("utf8"));
    secretMatchCount += result.count;
    secretScanUnconfidentFiles += result.confident ? 0 : 1;
    filesSecretScanned += 1;
  }

  const rootGitignore = rootFiles.find((file) => file.lowerBase === ".gitignore");
  let gitignoreCoversEnv = false;
  if (rootGitignore !== undefined) {
    const text = readConfigText(rootGitignore);
    if (text !== null) {
      for (const rawLine of text.split("\n")) {
        const line = rawLine.trim();
        if (line.length === 0 || line.startsWith("#") || line.startsWith("!")) {
          continue;
        }
        if (line === ".env" || line === "*.env" || line === ".env*" || line.startsWith(".env")) {
          gitignoreCoversEnv = true;
          break;
        }
      }
    }
  }
  const envExamplePresent = files.some((file) => ENV_EXAMPLE_BASENAMES.has(file.lowerBase));

  let envCheckViaGit = false;
  let committedEnvPresent = false;
  const lsFilesOutput = gitScoped ? runGit(root, ["ls-files", "-z"]) : null;
  if (lsFilesOutput !== null) {
    envCheckViaGit = true;
    for (const trackedPath of lsFilesOutput.split("\0")) {
      if (trackedPath.length === 0) {
        continue;
      }
      const trackedBase = (trackedPath.split("/").pop() ?? "").toLowerCase();
      if (isCommittedEnvBasename(trackedBase)) {
        committedEnvPresent = true;
        break;
      }
    }
  } else {
    committedEnvPresent = files.some((file) => isCommittedEnvBasename(file.lowerBase));
  }

  const securityMarkers: Record<string, MarkerValue> = {
    secret_match_count: secretMatchCount,
    secret_scan_unconfident_files: secretScanUnconfidentFiles,
    files_secret_scanned: filesSecretScanned,
    secret_scan_truncated: secretScanTruncated,
    gitignore_covers_env: gitignoreCoversEnv,
    env_example_present: envExamplePresent,
    committed_env_present: committedEnvPresent,
    env_check_via_git: envCheckViaGit,
  };
  let securityScore = 0;
  if (secretMatchCount === 0 && secretScanUnconfidentFiles === 0) {
    securityScore += 40;
  } else if (secretMatchCount <= 2) {
    securityScore += 20;
  }
  if (gitignoreCoversEnv) {
    securityScore += 25;
  }
  if (envExamplePresent) {
    securityScore += 15;
  }
  if (!committedEnvPresent) {
    securityScore += 20;
  }
  const envFamilyPresent = files.some(
    (file) => file.lowerBase === ".env" || file.lowerBase.startsWith(".env.") || ENV_EXAMPLE_BASENAMES.has(file.lowerBase),
  );
  const securityNa = filesSecretScanned === 0 && rootGitignore === undefined && !envFamilyPresent;

  // --- 6.7 modularity ----------------------------------------------------------
  const sourceDirSet = new Set<string>();
  let maxDirDepth = 0;
  for (const file of sourceFiles) {
    const slashIndex = file.relPath.lastIndexOf("/");
    sourceDirSet.add(slashIndex === -1 ? "." : file.relPath.slice(0, slashIndex));
    const depth = file.relPath.split("/").length - 1;
    if (depth > maxDirDepth) {
      maxDirDepth = depth;
    }
  }
  const largestFileLoc = sourceFiles.reduce((max, file) => Math.max(max, file.loc), 0);
  const filesOver500Ratio = round4(sourceFiles.filter((file) => file.loc > 500).length / Math.max(sourceFiles.length, 1));
  const avgFileLoc = Math.round(totalSourceLoc / Math.max(sourceFiles.length, 1));

  const modularityMarkers: Record<string, MarkerValue> = {
    source_file_count: sourceFiles.length,
    source_dir_count: sourceDirSet.size,
    top_level_dir_count: walk.topLevelDirs.length,
    max_dir_depth: maxDirDepth,
    largest_file_loc: largestFileLoc,
    files_over_500_loc_ratio: filesOver500Ratio,
    avg_file_loc: avgFileLoc,
  };
  let modularityScore = 0;
  modularityScore += largestFileLoc < 500 ? 25 : largestFileLoc < 1000 ? 18 : largestFileLoc < 2000 ? 10 : 0;
  modularityScore += filesOver500Ratio <= 0.02 ? 25 : filesOver500Ratio <= 0.05 ? 18 : filesOver500Ratio <= 0.1 ? 10 : 0;
  modularityScore += avgFileLoc <= 150 ? 20 : avgFileLoc <= 300 ? 14 : avgFileLoc <= 500 ? 7 : 0;
  modularityScore += maxDirDepth >= 1 && maxDirDepth <= 7 ? 15 : 5;
  modularityScore += sourceDirSet.size >= 2 || sourceFiles.length <= 3 ? 15 : 0;
  const modularityNa = sourceFiles.length === 0;

  // --- 6.8 architecture (scanner emits structural inputs only) ----------------
  const layerDirNames = new Set<string>();
  for (const file of files) {
    const segments = file.lowerRel.split("/");
    const dirSegmentCount = segments.length - 1;
    for (let depth = 1; depth <= Math.min(3, dirSegmentCount); depth += 1) {
      const segment = segments[depth - 1];
      if (segment !== undefined && LAYER_DIR_NAMES.has(segment)) {
        layerDirNames.add(segment);
      }
    }
  }
  const monorepoMarkersPresent =
    files.some((file) => MONOREPO_BASENAMES.has(file.lowerBase)) || anyContentMatches(rootCargoFiles, /\[workspace\]/);

  const architectureMarkers: Record<string, MarkerValue> = {
    top_level_dir_count: walk.topLevelDirs.length,
    source_dir_count: sourceDirSet.size,
    source_file_count: sourceFiles.length,
    layer_dir_signal_count: layerDirNames.size,
    monorepo_markers_present: monorepoMarkersPresent,
  };

  const largestSourceFiles = [...sourceFiles]
    .sort((left, right) => right.loc - left.loc || compareStrings(left.relPath, right.relPath))
    .slice(0, 5);
  const topLevelDirLabels = walk.topLevelDirs.map((name) => `${name}/`).slice(0, 20);
  const entryPoints = files
    .filter((file) => ENTRY_POINT_RES.some((pattern) => pattern.test(file.lowerRel)))
    .map((file) => file.relPath)
    .filter(isRepoRelativePath)
    .sort(compareStrings)
    .slice(0, 10);
  const candidateSeed: string[] = [];
  if (readmeFile !== undefined) {
    candidateSeed.push(readmeFile.relPath);
  }
  for (const file of rootFiles) {
    if (isManifestBasename(file.lowerBase)) {
      candidateSeed.push(file.relPath);
    }
  }
  candidateSeed.push(...topLevelDirLabels);
  candidateSeed.push(...largestSourceFiles.map((file) => file.relPath));
  candidateSeed.push(...entryPoints);
  const candidateFiles: string[] = [];
  const seenCandidates = new Set<string>();
  for (const candidate of candidateSeed) {
    const normalized = candidate.endsWith("/") ? candidate.slice(0, -1) : candidate;
    if (!isRepoRelativePath(normalized) || seenCandidates.has(candidate)) {
      continue;
    }
    seenCandidates.add(candidate);
    candidateFiles.push(candidate);
    if (candidateFiles.length >= 40) {
      break;
    }
  }

  // --- 6.9 maintainability -----------------------------------------------------
  // Two disjoint detectors: the infix patterns run over live source files; the
  // .bak/.orig/.rej suffix branch runs over non-generated backup/merge
  // artifacts whose pre-suffix name still classifies as source (a file named
  // "app.ts.bak" is itself never a source file, so a source-only suffix check
  // could never fire).
  const deadCodeHintCount = files.filter(
    (file) =>
      (!file.generated && isBackupOfSourceBasename(file.lowerBase)) ||
      (file.isSource &&
        (file.lowerBase.includes("_old.") ||
          file.lowerBase.includes(".old.") ||
          file.lowerBase.includes("_backup") ||
          file.lowerBase.includes("_deprecated") ||
          file.lowerBase.includes("_unused"))),
  ).length;

  const duplicateGroups = new Map<string, number>();
  for (const file of sourceFiles) {
    if (file.sizeBytes < 256) {
      continue;
    }
    const key = `${file.lowerBase} ${file.sizeBytes}`;
    duplicateGroups.set(key, (duplicateGroups.get(key) ?? 0) + 1);
  }
  let duplicateCandidateCount = 0;
  for (const groupSize of duplicateGroups.values()) {
    duplicateCandidateCount += groupSize - 1;
  }

  // Bounded churn: denylisted "lines you wrote" semantics (generated paths
  // excluded via isGeneratedArtifactPath), NOT the raw headline-vibe-LOC
  // semantics of gitAggregateMetrics. Graceful when git is absent.
  const churnByPath = new Map<string, number>();
  let churnAvailable = false;
  // -c core.quotePath=false keeps non-ASCII paths raw instead of octal-escaped
  // inside double quotes (which would put invalid quoted paths into
  // `most_churned_files` and defeat the generated-path denylist's anchors).
  const gitLogOutput = gitScoped
    ? runGit(root, [
        "-c",
        "core.quotePath=false",
        "log",
        "--numstat",
        "--no-renames",
        "-n",
        String(REPO_SCAN_CAPS.gitLogCommits),
      ])
    : null;
  if (gitLogOutput !== null) {
    churnAvailable = true;
    for (const line of gitLogOutput.split("\n")) {
      const match = NUMSTAT_LINE_RE.exec(line);
      if (match === null) {
        continue;
      }
      const added = match[1];
      const deleted = match[2];
      const churnPath = match[3];
      if (added === undefined || deleted === undefined || churnPath === undefined) {
        continue;
      }
      if (added === "-" || deleted === "-") {
        continue; // binary entries
      }
      if (churnPath.startsWith('"')) {
        continue; // control-character paths stay C-quoted even with quotePath off; drop rather than mis-parse
      }
      if (isGeneratedArtifactPath(churnPath)) {
        continue;
      }
      churnByPath.set(churnPath, (churnByPath.get(churnPath) ?? 0) + Number(added) + Number(deleted));
    }
  }
  let churnTotalLines = 0;
  for (const lines of churnByPath.values()) {
    churnTotalLines += lines;
  }
  const churnEntries = [...churnByPath.entries()].sort(
    (left, right) => right[1] - left[1] || compareStrings(left[0], right[0]),
  );
  const churnTop10Lines = churnEntries.slice(0, 10).reduce((sum, [, lines]) => sum + lines, 0);
  const churnTop10Share = churnTotalLines > 0 ? round2(churnTop10Lines / churnTotalLines) : 0;

  const todoPerKloc = round2((todoFixmeCount * 1000) / Math.max(totalSourceLoc, 1));
  const filesOver400Ratio = round4(sourceFiles.filter((file) => file.loc > 400).length / Math.max(sourceFiles.length, 1));

  const maintainabilityMarkers: Record<string, MarkerValue> = {
    todo_fixme_count: todoFixmeCount,
    todo_per_kloc: todoPerKloc,
    files_over_400_loc_ratio: filesOver400Ratio,
    avg_file_loc: avgFileLoc,
    dead_code_hint_count: deadCodeHintCount,
    duplicate_candidate_count: duplicateCandidateCount,
    churn_available: churnAvailable,
    churn_total_lines: churnTotalLines,
    churn_files_touched: churnByPath.size,
    churn_top10_share: churnTop10Share,
  };
  let deterministicScore = 0;
  deterministicScore += todoPerKloc <= 1 ? 20 : todoPerKloc <= 5 ? 12 : todoPerKloc <= 15 ? 5 : 0;
  deterministicScore += filesOver400Ratio <= 0.05 ? 20 : filesOver400Ratio <= 0.15 ? 12 : 0;
  deterministicScore += avgFileLoc <= 200 ? 15 : avgFileLoc <= 400 ? 8 : 0;
  deterministicScore += deadCodeHintCount === 0 ? 10 : 0;
  if (churnAvailable && churnTotalLines > 0) {
    deterministicScore += churnTop10Share <= 0.5 ? 20 : churnTop10Share <= 0.75 ? 10 : 0;
  } else {
    deterministicScore += 10; // neutral — absence of git is not evidence
  }
  deterministicScore += duplicateCandidateCount === 0 ? 15 : duplicateCandidateCount <= 3 ? 8 : 0;
  deterministicScore = Math.min(100, deterministicScore);
  const maintainabilityNa = sourceFiles.length === 0;

  const largestFiles = largestSourceFiles.map((file) => file.relPath).filter(isRepoRelativePath);
  const mostChurnedFiles = churnAvailable
    ? churnEntries
        .map(([churnPath]) => churnPath)
        .filter(isRepoRelativePath)
        .slice(0, 5)
    : [];
  const todoHotspots = [...todoHotspotCounts]
    .sort((left, right) => right.count - left.count || compareStrings(left.relPath, right.relPath))
    .map((entry) => entry.relPath)
    .filter(isRepoRelativePath)
    .slice(0, 5);

  // --- 6.10 release_ops ----------------------------------------------------------
  const changelogPresent =
    rootFiles.some((file) => CHANGELOG_RE.test(file.base)) || files.some((file) => file.lowerRel === "docs/changelog.md");
  const versionMarkerPresent =
    (rootPackageJsonText !== null && /"version"\s*:/.test(rootPackageJsonText)) ||
    (rootPyprojectText !== null && /^version\s*=/m.test(rootPyprojectText)) ||
    anyContentMatches(rootCargoFiles, /^version\s*=/m) ||
    rootFiles.some((file) => file.lowerBase === "version");
  const tagListOutput = gitScoped ? runGit(root, ["tag", "--list"]) : null;
  const gitTagCount =
    tagListOutput === null ? 0 : tagListOutput.split("\n").filter((line) => line.trim().length > 0).length;
  const containerFiles = files.filter(
    (file) => file.lowerBase.startsWith("dockerfile") || file.lowerBase.endsWith(".dockerfile"),
  );
  const composeFiles = files.filter(
    (file) =>
      (file.lowerBase.startsWith("docker-compose") && (file.lowerBase.endsWith(".yml") || file.lowerBase.endsWith(".yaml"))) ||
      file.lowerBase === "compose.yml" ||
      file.lowerBase === "compose.yaml",
  );
  const containerPresent = containerFiles.length > 0 || composeFiles.length > 0;
  const orchestrationPresent = files.some(
    (file) =>
      /(^|\/)(k8s|kubernetes|helm|charts?)\//.test(file.lowerRel) ||
      ((file.ext === ".nomad" || file.ext === ".hcl") && /(^|\/)nomad\//.test(file.lowerRel)) ||
      file.ext === ".tf",
  );
  const envContractPresent = envExamplePresent;
  const healthcheckSignal =
    healthSignalFromScan || anyContentMatchesPerPattern([containerFiles, composeFiles], HEALTH_RE);
  const observabilitySignal = anyContentMatchesPerPattern(manifestGroups, OBSERVABILITY_RE);

  const releaseOpsMarkers: Record<string, MarkerValue> = {
    changelog_present: changelogPresent,
    version_marker_present: versionMarkerPresent,
    git_tag_count: gitTagCount,
    container_present: containerPresent,
    orchestration_present: orchestrationPresent,
    env_contract_present: envContractPresent,
    healthcheck_signal: healthcheckSignal,
    observability_signal: observabilitySignal,
  };
  let releaseOpsScore = 0;
  if (changelogPresent) {
    releaseOpsScore += 20;
  }
  if (versionMarkerPresent || gitTagCount >= 1) {
    releaseOpsScore += 15;
  }
  if (containerPresent) {
    releaseOpsScore += 20;
  }
  if (orchestrationPresent) {
    releaseOpsScore += 15;
  }
  if (envContractPresent) {
    releaseOpsScore += 10;
  }
  if (healthcheckSignal) {
    releaseOpsScore += 10;
  }
  if (observabilitySignal) {
    releaseOpsScore += 10;
  }
  const releaseOpsNa =
    !changelogPresent &&
    !versionMarkerPresent &&
    gitTagCount === 0 &&
    !containerPresent &&
    !orchestrationPresent &&
    !envContractPresent &&
    !healthcheckSignal &&
    !observabilitySignal;

  // --- assemble (fixed key order; score keys omitted when na) -------------------
  const buildScored = (na: boolean, rawScore: number, markers: Record<string, MarkerValue>): ScoredDimension =>
    na ? { status: "na", markers } : { status: "scored", score: Math.min(100, rawScore), markers };

  const dimensions: RepoArchitectureDimensions = {
    documentation: buildScored(documentationNa, documentationScore, documentationMarkers),
    testing: buildScored(testingNa, testingScore, testingMarkers),
    ci_automation: buildScored(ciNa, ciScore, ciMarkers),
    type_safety: buildScored(typeSafetyNa, typeSafetyScore, typeSafetyMarkers),
    dependency_hygiene: buildScored(dependencyNa, dependencyScore, dependencyMarkers),
    security_posture: buildScored(securityNa, securityScore, securityMarkers),
    modularity: buildScored(modularityNa, modularityScore, modularityMarkers),
    architecture: {
      status: sourceFiles.length < 5 ? "na" : "llm_required",
      markers: architectureMarkers,
    },
    maintainability: maintainabilityNa
      ? { status: "na", markers: maintainabilityMarkers }
      : {
          status: "scored",
          score: deterministicScore,
          deterministic_score: deterministicScore,
          markers: maintainabilityMarkers,
        },
    release_ops: buildScored(releaseOpsNa, releaseOpsScore, releaseOpsMarkers),
  };

  const truncated = walk.truncated || locTruncated || todoTruncated || secretScanTruncated;

  return {
    repo_rubric_version: REPO_RUBRIC_VERSION,
    scan_meta: {
      files_scanned: files.length,
      files_skipped: walk.filesSkipped,
      truncated,
      duration_ms: Date.now() - startMs,
    },
    primary_language: primaryLanguage,
    languages,
    size_band: sizeBand,
    dimensions,
    local_only: {
      architecture: {
        candidate_files: candidateFiles,
        top_level_dirs: topLevelDirLabels.filter((label) => isRepoRelativePath(label.slice(0, -1))),
        entry_points: entryPoints,
      },
      maintainability: {
        largest_files: largestFiles,
        most_churned_files: mostChurnedFiles,
        todo_hotspots: todoHotspots,
      },
    },
  };
}

// ---------------------------------------------------------------------------
// Scoring math (pinned; used by tests and the later skill slice)
// ---------------------------------------------------------------------------

// Quality = mean of scores over dimensions with status === "scored" (unrounded float; 0 when none).
// "llm_required" (architecture) and "na" dims are EXCLUDED. maintainability contributes `score`.
export function computeQuality(dimensions: RepoArchitectureDimensions): number {
  const scores: number[] = [];
  for (const key of DIMENSION_KEYS) {
    const dimension = dimensions[key];
    if (dimension.status === "scored" && typeof dimension.score === "number") {
      scores.push(dimension.score);
    }
  }
  if (scores.length === 0) {
    return 0;
  }
  return scores.reduce((sum, score) => sum + score, 0) / scores.length;
}

// Coverage = scoredCount / 10 (exact float; architecture "llm_required" is NOT scored locally).
export function computeCoverage(dimensions: RepoArchitectureDimensions): number {
  let scoredCount = 0;
  for (const key of DIMENSION_KEYS) {
    if (dimensions[key].status === "scored") {
      scoredCount += 1;
    }
  }
  return scoredCount / 10;
}

// Overall = Math.round(quality * (0.5 + 0.5 * coverage)), clamped to [0, 100].
export function computeOverall(quality: number, coverage: number): number {
  const overall = Math.round(quality * (0.5 + 0.5 * coverage));
  return Math.min(100, Math.max(0, overall));
}

// Grade bands — EXACTLY the skill/rubric.md §4 table (inclusive integer ranges).
export function gradeForOverall(overall: number): OverallGrade {
  if (overall >= 88) {
    return "exceptional";
  }
  if (overall >= 74) {
    return "strong";
  }
  if (overall >= 58) {
    return "proficient";
  }
  if (overall >= 40) {
    return "developing";
  }
  return "emerging";
}
