/**
 * Versioned, deterministic shell-command + tool-output classifier for the
 * Wave 2 transcript stats (red_to_green_velocity, test_before_ship_rate,
 * tool_error_recovery_rate).
 *
 * CLASSIFIER_VERSION ships in the public payload so derived stats stay
 * reproducible: the same transcript bytes plus the same version string must
 * always yield identical classifications. Everything here is pure string
 * analysis — no Date, no randomness, no env access, no I/O. Bump the version
 * whenever classification behavior changes.
 */

export const CLASSIFIER_VERSION = "1.0.0";

export type CommandKind =
  | "test"
  | "build"
  | "lint"
  | "typecheck"
  | "run"
  | "git"
  | "install"
  | "format"
  | "other";

export type TestOutcome = "pass" | "fail" | null;

const ENV_ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;
const QUOTED_ENV_OPEN = /^[A-Za-z_][A-Za-z0-9_]*=(["'])/;
const DURATION_TOKEN = /^\d+(\.\d+)?[smhd]?$/;
const PYTHON_HEAD = /^python(\d+(\.\d+)?)?$/;

/** Tools classified by their first effective token alone. */
const TOOL_KINDS: Record<string, CommandKind> = {
  pytest: "test",
  jest: "test",
  vitest: "test",
  mocha: "test",
  rspec: "test",
  phpunit: "test",
  mypy: "typecheck",
  pyright: "typecheck",
  eslint: "lint",
  flake8: "lint",
  pylint: "lint",
  "golangci-lint": "lint",
  stylelint: "lint",
  prettier: "format",
  black: "format",
  gofmt: "format",
  rustfmt: "format",
  webpack: "build",
  uvicorn: "run",
  git: "git",
  gh: "git",
};

/** `python -m <module>` modules with a known kind; other modules count as "run". */
const PYTHON_MODULE_KINDS: Record<string, CommandKind> = {
  pytest: "test",
  unittest: "test",
  mypy: "typecheck",
  pyright: "typecheck",
  flake8: "lint",
  pylint: "lint",
  ruff: "lint",
  black: "format",
  pip: "install",
};

/** Flags that consume the following token as a value. */
const PNPM_VALUE_FLAGS = new Set(["-C", "--dir", "-F", "--filter"]);
const NPX_VALUE_FLAGS = new Set(["-p", "--package", "-c", "--call"]);

function basename(token: string): string {
  const parts = token.split("/");
  return parts[parts.length - 1] ?? token;
}

function tokenize(segment: string): string[] {
  return segment
    .trim()
    .split(/\s+/)
    .filter((token) => token.length > 0);
}

function firstPositional(args: string[]): string | undefined {
  return args.find((arg) => !arg.startsWith("-"));
}

/** Package.json-style script names with a conventional kind. */
function classifyScriptName(name: string): CommandKind {
  const script = name.toLowerCase();
  if (script === "test" || script === "tests" || script.startsWith("test:")) return "test";
  if (script === "typecheck" || script === "type-check") return "typecheck";
  if (script === "lint" || script.startsWith("lint:")) return "lint";
  if (script === "format" || script === "fmt") return "format";
  if (script === "build" || script.startsWith("build:")) return "build";
  if (script === "dev" || script === "start" || script === "serve") return "run";
  return "other";
}

function classifyNpm(args: string[]): CommandKind {
  const sub = firstPositional(args);
  if (sub === undefined) return "other";
  if (sub === "test" || sub === "t") return "test";
  if (sub === "start") return "run";
  if (sub === "install" || sub === "ci" || sub === "i" || sub === "add") return "install";
  if (sub === "run" || sub === "run-script" || sub === "exec") {
    const rest = args.slice(args.indexOf(sub) + 1);
    if (sub === "exec") return classifyTokens(rest);
    const script = firstPositional(rest);
    return script === undefined ? "other" : classifyScriptName(script);
  }
  return "other";
}

function classifyPnpm(args: string[]): CommandKind {
  let i = 0;
  while (i < args.length && args[i].startsWith("-")) {
    i += PNPM_VALUE_FLAGS.has(args[i]) ? 2 : 1;
  }
  const sub = args[i];
  if (sub === undefined) return "other";
  const rest = args.slice(i + 1);
  if (sub === "install" || sub === "i" || sub === "add") return "install";
  if (sub === "exec" || sub === "dlx") return classifyTokens(rest);
  if (sub === "run" || sub === "run-script") {
    const script = firstPositional(rest);
    return script === undefined ? "other" : classifyScriptName(script);
  }
  if (sub === "test" || sub === "t") return "test";
  const byScript = classifyScriptName(sub);
  if (byScript !== "other") return byScript;
  // `pnpm <tool>` falls through to exec behavior when <tool> is not a known script name.
  return classifyTokens(args.slice(i));
}

function classifyYarn(args: string[]): CommandKind {
  const sub = firstPositional(args);
  if (sub === undefined) return "other";
  const rest = args.slice(args.indexOf(sub) + 1);
  if (sub === "install" || sub === "add") return "install";
  if (sub === "exec" || sub === "dlx") return classifyTokens(rest);
  if (sub === "run") {
    const script = firstPositional(rest);
    return script === undefined ? "other" : classifyScriptName(script);
  }
  if (sub === "test") return "test";
  const byScript = classifyScriptName(sub);
  if (byScript !== "other") return byScript;
  // `yarn <tool>` runs node_modules binaries directly.
  return classifyTokens(args.slice(args.indexOf(sub)));
}

function classifyNpx(args: string[]): CommandKind {
  let i = 0;
  while (i < args.length && args[i].startsWith("-")) {
    i += NPX_VALUE_FLAGS.has(args[i]) ? 2 : 1;
  }
  return classifyTokens(args.slice(i));
}

function classifyManagePy(args: string[]): CommandKind {
  const sub = firstPositional(args);
  if (sub === "test") return "test";
  if (sub === "runserver") return "run";
  return "other";
}

function classifyPython(args: string[]): CommandKind {
  let i = 0;
  while (i < args.length) {
    const arg = args[i];
    if (arg === "-m") {
      const module = args[i + 1];
      if (module === undefined) return "other";
      return PYTHON_MODULE_KINDS[module.toLowerCase()] ?? "run";
    }
    if (arg.startsWith("-")) {
      i += 1;
      continue;
    }
    if (basename(arg).toLowerCase() === "manage.py") return classifyManagePy(args.slice(i + 1));
    return "run";
  }
  return "other";
}

/** Classify one pre-tokenized command segment (no chaining operators inside). */
function classifyTokens(tokens: string[]): CommandKind {
  let i = 0;
  // Strip env assignments and transparent wrapper prefixes.
  for (;;) {
    const token = tokens[i];
    if (token === undefined) return "other";
    if (ENV_ASSIGNMENT.test(token)) {
      const quote = QUOTED_ENV_OPEN.exec(token)?.[1];
      i += 1;
      if (quote !== undefined && !token.endsWith(quote)) {
        while (i < tokens.length && !tokens[i].endsWith(quote)) i += 1;
        if (i < tokens.length) i += 1;
      }
      continue;
    }
    if (token === "sudo" || token === "env") {
      i += 1;
      continue;
    }
    if (token === "timeout") {
      i += 1;
      while (i < tokens.length && (tokens[i].startsWith("-") || DURATION_TOKEN.test(tokens[i]))) {
        i += 1;
      }
      continue;
    }
    break;
  }

  const rest = tokens.slice(i);
  const head = basename(rest[0]).toLowerCase();
  const args = rest.slice(1);

  const direct = TOOL_KINDS[head];
  if (direct !== undefined) return direct;

  if (PYTHON_HEAD.test(head)) return classifyPython(args);

  switch (head) {
    case "tsc":
    case "vue-tsc":
      return args.includes("--build") || args.includes("-b") ? "build" : "typecheck";
    case "ruff":
      return firstPositional(args) === "format" ? "format" : "lint";
    case "node": {
      if (args.includes("--test")) return "test";
      return firstPositional(args) === undefined ? "other" : "run";
    }
    case "manage.py":
      return classifyManagePy(args);
    case "go": {
      const sub = firstPositional(args);
      if (sub === "test") return "test";
      if (sub === "build") return "build";
      if (sub === "run") return "run";
      if (sub === "vet") return "lint";
      return "other";
    }
    case "cargo": {
      const sub = firstPositional(args);
      if (sub === "test") return "test";
      if (sub === "clippy") return "lint";
      if (sub === "build") return "build";
      if (sub === "add") return "install";
      if (sub === "fmt") return "format";
      if (sub === "run") return "run";
      return "other";
    }
    case "make": {
      const target = firstPositional(args);
      if (target === undefined) return "build";
      const byScript = classifyScriptName(target);
      return byScript === "other" ? "build" : byScript;
    }
    case "docker": {
      const sub = firstPositional(args);
      return sub === "build" || sub === "buildx" ? "build" : "other";
    }
    case "gradle":
    case "gradlew": {
      const sub = firstPositional(args);
      if (sub === "test") return "test";
      if (sub === "build" || sub === "assemble") return "build";
      return "other";
    }
    case "mvn": {
      const sub = firstPositional(args);
      if (sub === "test") return "test";
      if (sub === "package" || sub === "compile" || sub === "verify" || sub === "install") {
        return "build";
      }
      return "other";
    }
    case "pip":
    case "pip3":
      return firstPositional(args) === "install" ? "install" : "other";
    case "apt":
    case "apt-get":
      return args.includes("install") ? "install" : "other";
    case "brew":
      return firstPositional(args) === "install" ? "install" : "other";
    case "poetry": {
      const sub = firstPositional(args);
      if (sub === "run") return classifyTokens(args.slice(args.indexOf("run") + 1));
      if (sub === "install" || sub === "add") return "install";
      return "other";
    }
    case "npm":
      return classifyNpm(args);
    case "pnpm":
      return classifyPnpm(args);
    case "yarn":
      return classifyYarn(args);
    case "npx":
    case "bunx":
      return classifyNpx(args);
    case "next": {
      const sub = firstPositional(args);
      if (sub === "build") return "build";
      if (sub === "dev" || sub === "start") return "run";
      return "other";
    }
    case "vite":
      return firstPositional(args) === "build" ? "build" : "run";
    case "playwright":
      return firstPositional(args) === "test" ? "test" : "other";
    case "cypress":
      return firstPositional(args) === "run" ? "test" : "other";
    default:
      return "other";
  }
}

/**
 * Classify a raw shell command line. Chained commands (`&&`, `;`, `||`) are
 * split into segments; "test" wins if any segment is a test, otherwise the
 * first recognized non-"other" segment decides.
 */
export function classifyCommand(command: string): CommandKind {
  const segments = command.split(/&&|\|\||;/);
  let first: CommandKind = "other";
  for (const segment of segments) {
    const kind = classifyTokens(tokenize(segment));
    if (kind === "test") return "test";
    if (kind !== "other" && first === "other") first = kind;
  }
  return first;
}

/** Window scanned for pass/fail markers; longer outputs are truncated. */
const OUTPUT_SCAN_LIMIT = 4000;

// Failure-count regexes use [1-9]\d* so summaries like "0 failed, 12 passed"
// do not register as failures.
const FAIL_MARKERS: RegExp[] = [
  /\bFAILED\b/,
  /\bFAIL\b/,
  /[✗✘]/,
  /\b[1-9]\d* (failing|failed)\b/,
  /AssertionError/,
  /Traceback \(most recent call last\)/,
  /npm ERR!/,
  /error TS\d+/,
  /# fail [1-9]/,
  /Tests:\s+[1-9]\d* failed/,
  /\bnot ok \d+/,
];

function hasPassMarker(text: string): boolean {
  // "pass(ed/ing)" needs at least one digit nearby so prose does not match.
  if (/\d[^\n]{0,40}\bpass(ed|ing)?\b/i.test(text)) return true;
  if (/\bpass(ed|ing)?\b[^\n]{0,40}\d/i.test(text)) return true;
  if (/\bok\b.*\d+ (tests|passing)/.test(text)) return true;
  if (/Tests:\s+\d+ passed/.test(text)) return true;
  if (/\bPASSED\b/.test(text)) return true;
  if (/All checks passed/.test(text)) return true;
  if (/✓/.test(text)) return true;
  if (/BUILD SUCCESS/.test(text)) return true;
  return false;
}

/**
 * Map tool-output text to a pass/fail signal, or null when neither side
 * matches confidently. Fail markers beat pass markers, except a node-tap
 * style summary with "# fail 0" is authoritative for pass.
 */
export function classifyTestOutput(text: string): TestOutcome {
  const scanned = text.slice(0, OUTPUT_SCAN_LIMIT);
  if (/# fail [1-9]/.test(scanned)) return "fail";
  if (/# pass [1-9]\d*/.test(scanned) && /# fail 0\b/.test(scanned)) return "pass";
  if (FAIL_MARKERS.some((marker) => marker.test(scanned))) return "fail";
  if (hasPassMarker(scanned)) return "pass";
  return null;
}
