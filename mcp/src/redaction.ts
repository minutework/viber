/**
 * viber redaction library — clean-room reimplementation.
 *
 * Two fail-closed layers, exactly as specified in docs/data-handling.md:
 *
 *   Layer 1 — secret scrubber: high-confidence credential patterns (vendor API
 *             keys, AWS AKIA prefixes, GitHub ghp/gho/github_pat tokens, Google
 *             AIza keys, Slack xox tokens, Stripe sk/rk keys, generic Bearer and
 *             JWT, PEM PRIVATE KEY blocks, DB URLs with embedded creds).
 *
 *   Layer 2 — code / identifier / path redactor: strips fenced & indented code,
 *             long inline code, absolute and repo-relative paths, filenames, and
 *             code identifiers. Excerpts are meant to be paraphrased, not quoted;
 *             this layer is the backstop that catches anything that slipped
 *             through paraphrasing.
 *
 * These patterns were derived from first principles against the public shapes
 * the credentials/paths actually take; no third-party scanner source was copied.
 *
 * Fail-closed contract: every layer reports whether it could *confidently* scrub
 * the field. The validator treats "not confident" as a drop, never a send. For
 * narrative re-scrubbing we always return the scrubbed text plus the hit counts.
 *
 * IMPORTANT (injection resistance): this module only transforms text. It never
 * interprets transcript content as instructions. Callers wrap untrusted
 * transcript text in a labeled block before it ever reaches an LLM; this library
 * is the deterministic last line of defense before any text is packaged.
 */

export const SECRET_PLACEHOLDER = "[REDACTED_SECRET]";
export const PATH_PLACEHOLDER = "[path]";
export const CODE_PLACEHOLDER = "[code]";
export const IDENT_PLACEHOLDER = "[id]";

export interface LayerResult {
  /** The scrubbed text. */
  text: string;
  /** Number of matches replaced by this layer. */
  count: number;
  /**
   * Whether the layer is confident the field is clean after scrubbing. A field
   * that still looks like it contains a residual secret/path after substitution
   * is marked not-confident so the caller can drop it (fail-closed).
   */
  confident: boolean;
}

export interface RedactionResult {
  /** Fully scrubbed text (both layers applied), or null if the field was dropped. */
  text: string | null;
  /** True when the field was dropped fail-closed (could not confidently scrub). */
  dropped: boolean;
  secretsScrubbed: number;
  pathsScrubbed: number;
  identifiersScrubbed: number;
}

/* ------------------------------------------------------------------ *
 * Layer 1 — secret scrubber
 * ------------------------------------------------------------------ */

/**
 * Each rule is a high-confidence credential shape. Order does not matter; all
 * are applied. We deliberately favor precision: these match credential tokens,
 * not ordinary prose.
 */
const SECRET_RULES: Array<{ name: string; re: RegExp }> = [
  // PEM private key blocks (any key type). Multiline.
  {
    name: "pem_private_key",
    re: /-----BEGIN(?:\s[A-Z0-9]+)*\sPRIVATE KEY-----[\s\S]*?-----END(?:\s[A-Z0-9]+)*\sPRIVATE KEY-----/g,
  },
  // AWS access key id.
  { name: "aws_akia", re: /\b(?:AKIA|ASIA|AGPA|AIDA|AROA|ANPA|ANVA)[0-9A-Z]{16}\b/g },
  // GitHub tokens (classic, oauth, app, user-to-server, refresh, fine-grained).
  { name: "github_token", re: /\b(?:ghp|gho|ghu|ghs|ghr|github_pat)_[A-Za-z0-9_]{20,255}\b/g },
  // Google API key.
  { name: "google_api_key", re: /\bAIza[0-9A-Za-z_-]{35}\b/g },
  // Slack token.
  { name: "slack_token", re: /\bxox[baprs]-[0-9A-Za-z-]{10,}\b/g },
  // Stripe secret / restricted keys (live and test).
  { name: "stripe_key", re: /\b(?:sk|rk)_(?:live|test)_[0-9A-Za-z]{16,}\b/g },
  // OpenAI / OpenRouter style keys.
  { name: "openai_key", re: /\bsk-(?:proj-|or-v1-|ant-)?[A-Za-z0-9_-]{20,}\b/g },
  // Anthropic keys.
  { name: "anthropic_key", re: /\bsk-ant-[A-Za-z0-9_-]{20,}\b/g },
  // Bearer tokens in headers / prose.
  { name: "bearer", re: /\bBearer\s+[A-Za-z0-9._~+/-]{16,}={0,2}/gi },
  // JSON Web Tokens (header.payload.signature, all base64url).
  { name: "jwt", re: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g },
  // DB / connection URLs carrying inline credentials (user:pass@host).
  {
    name: "db_url_with_creds",
    re: /\b[a-z][a-z0-9+.-]*:\/\/[^\s:@/]+:[^\s:@/]+@[^\s/]+/gi,
  },
  // Generic high-entropy assignments: KEY=..., SECRET: "...", TOKEN='...'.
  {
    name: "generic_assigned_secret",
    re: /\b(?:[A-Za-z0-9_]*(?:SECRET|TOKEN|API[_-]?KEY|PASSWORD|PASSWD|PRIVATE[_-]?KEY|ACCESS[_-]?KEY|CLIENT[_-]?SECRET|AUTH))\b\s*[:=]\s*['"]?[A-Za-z0-9._~+/=-]{12,}['"]?/gi,
  },
];

/** Residual-secret heuristics: if any of these still match after scrubbing, fail closed. */
const RESIDUAL_SECRET_HINTS: RegExp[] = [
  /-----BEGIN/,
  /\beyJ[A-Za-z0-9_-]{8,}\./,
  /\bAKIA[0-9A-Z]{16}\b/,
];

export function scrubSecrets(input: string): LayerResult {
  let text = input;
  let count = 0;
  for (const rule of SECRET_RULES) {
    text = text.replace(rule.re, () => {
      count += 1;
      return SECRET_PLACEHOLDER;
    });
  }
  const confident = !RESIDUAL_SECRET_HINTS.some((re) => re.test(text));
  return { text, count, confident };
}

/* ------------------------------------------------------------------ *
 * Layer 2 — code / identifier / path redactor
 * ------------------------------------------------------------------ */

// POSIX absolute paths and Windows paths. Repo-relative paths (a/b/c.ts) are
// caught by the dotted-extension and slash-path rules below.
const ABSOLUTE_POSIX_PATH = /(?<![\w$])(?:~?\/[\w.@%+-]+){2,}\/?/g;
const WINDOWS_PATH = /\b[A-Za-z]:\\(?:[\w .@%+-]+\\?)+/g;
// Any token containing a slash plus a filename-with-extension, e.g. src/app/main.ts
const SLASH_PATH = /(?<![\w$/])(?:[\w.@%+-]+\/){1,}[\w.@%+-]+\.[A-Za-z0-9]{1,8}\b/g;
// Bare filename with a known-ish code/config extension.
const FILENAME_WITH_EXT =
  /\b[\w.@%+-]+\.(?:ts|tsx|js|jsx|mjs|cjs|py|rb|go|rs|java|kt|swift|c|h|cpp|hpp|cs|php|sh|bash|zsh|sql|html|css|scss|json|jsonl|yaml|yml|toml|ini|cfg|env|md|mdx|txt|lock|xml|vue|svelte|astro)\b/gi;

// Fenced code blocks ``` ... ``` (and ~~~).
const FENCED_CODE = /(?:```|~~~)[\s\S]*?(?:```|~~~)/g;
// Inline backtick spans.
const INLINE_CODE = /`[^`\n]{1,}`/g;
// Long indented code lines (4+ leading spaces or a tab), per markdown convention.
const INDENTED_CODE_LINE = /^[ \t]{4,}\S.*$/gm;

// Dotted member-access / namespaced identifiers, e.g. foo.bar.baz, MyClass.method.
// Two or more segments joined by dots, each an identifier-ish token.
const DOTTED_IDENTIFIER =
  /\b[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*){1,}\b/g;
// snake_case / camelCase / PascalCase identifiers that are clearly code-y:
// require an underscore OR an internal case change OR a trailing () call.
//
// Contract pin: this call-expression pattern intentionally mirrors
// apps/mwv3-public-dj/apps/builder_profile/redaction.py exactly. In
// particular, there is no optional whitespace between the word and "(", so
// ordinary prose like "sessions (316 total)" is not treated as a function call.
export const PUBLIC_DJ_CALL_EXPRESSION_PATTERN = String.raw`\b[A-Za-z_]\w+\([^)]*[A-Za-z_=][^)]*\)`;
const CALL_IDENTIFIER = new RegExp(PUBLIC_DJ_CALL_EXPRESSION_PATTERN, "g");
const SNAKE_OR_MIXED_CASE =
  /\b(?:[a-z]+_[a-z0-9_]+|[a-z][a-z0-9]*[A-Z][A-Za-z0-9]*|[A-Z][a-z0-9]+[A-Z][A-Za-z0-9]*)\b/g;

/**
 * A small allowlist of common English/product words that match the case-shape
 * identifier rule but are not code. Keeps prose readable while still stripping
 * real identifiers. Anything not on this list and matching the shape is redacted.
 */
const IDENTIFIER_WORD_ALLOWLIST = new Set<string>([
  "GitHub",
  "JavaScript",
  "TypeScript",
  "PostgreSQL",
  "MySQL",
  "OpenAI",
  "OpenRouter",
  "MinuteWork",
  "iOS",
  "macOS",
  "GraphQL",
  "OAuth",
  "JSON",
  "YAML",
]);

const RESIDUAL_CODE_HINTS: RegExp[] = [
  FENCED_CODE,
  /(?<![\w$])(?:~?\/[\w.@%+-]+){2,}/,
  /\b[A-Za-z]:\\/,
];

export function redactCodePathsIdentifiers(input: string): LayerResult & {
  pathCount: number;
  identifierCount: number;
} {
  let text = input;
  let pathCount = 0;
  let identifierCount = 0;
  let count = 0;

  const replacePath = () => {
    pathCount += 1;
    count += 1;
    return PATH_PLACEHOLDER;
  };
  const replaceCode = () => {
    count += 1;
    return CODE_PLACEHOLDER;
  };
  const replaceIdent = () => {
    identifierCount += 1;
    count += 1;
    return IDENT_PLACEHOLDER;
  };

  // Code blocks first (so their contents do not get partially matched).
  text = text.replace(FENCED_CODE, replaceCode);
  text = text.replace(INDENTED_CODE_LINE, replaceCode);
  text = text.replace(INLINE_CODE, replaceCode);

  // Paths before filenames before identifiers (most specific first).
  text = text.replace(WINDOWS_PATH, replacePath);
  text = text.replace(ABSOLUTE_POSIX_PATH, replacePath);
  text = text.replace(SLASH_PATH, replacePath);
  text = text.replace(FILENAME_WITH_EXT, replacePath);

  // Code-shaped identifiers.
  text = text.replace(CALL_IDENTIFIER, replaceIdent);
  text = text.replace(DOTTED_IDENTIFIER, replaceIdent);
  text = text.replace(SNAKE_OR_MIXED_CASE, (match) => {
    if (IDENTIFIER_WORD_ALLOWLIST.has(match)) {
      return match;
    }
    return replaceIdent();
  });

  const confident = !RESIDUAL_CODE_HINTS.some((re) => re.test(text));
  return { text, count, confident, pathCount, identifierCount };
}

/* ------------------------------------------------------------------ *
 * Combined two-layer redaction (fail-closed)
 * ------------------------------------------------------------------ */

/**
 * Apply both layers to a single free-text field. Returns the scrubbed text, or
 * drops the field (text=null, dropped=true) when either layer cannot confidently
 * scrub it. This is the function the Validator runs over EVERY text field, and
 * that the synthesizer re-applies to all LLM-generated narrative.
 */
export function redactField(input: string): RedactionResult {
  if (typeof input !== "string") {
    return {
      text: null,
      dropped: true,
      secretsScrubbed: 0,
      pathsScrubbed: 0,
      identifiersScrubbed: 0,
    };
  }

  const layer1 = scrubSecrets(input);
  if (!layer1.confident) {
    return {
      text: null,
      dropped: true,
      secretsScrubbed: layer1.count,
      pathsScrubbed: 0,
      identifiersScrubbed: 0,
    };
  }

  const layer2 = redactCodePathsIdentifiers(layer1.text);
  if (!layer2.confident) {
    return {
      text: null,
      dropped: true,
      secretsScrubbed: layer1.count,
      pathsScrubbed: layer2.pathCount,
      identifiersScrubbed: layer2.identifierCount,
    };
  }

  return {
    text: layer2.text,
    dropped: false,
    secretsScrubbed: layer1.count,
    pathsScrubbed: layer2.pathCount,
    identifiersScrubbed: layer2.identifierCount,
  };
}

/**
 * Scan-only check: does this string still contain a path / secret / code /
 * identifier signal *after* a redaction pass? Used by the Validator to decide
 * whether a field is safe to send, mirroring public-dj's re-scrub-and-REJECT.
 * Returns the list of layer names that fired (empty == clean).
 */
export function detectViolations(input: string): string[] {
  const violations: string[] = [];
  const layer1 = scrubSecrets(input);
  if (layer1.count > 0 || !layer1.confident) {
    violations.push("secret");
  }
  const layer2 = redactCodePathsIdentifiers(input);
  if (layer2.pathCount > 0 || !layer2.confident) {
    violations.push("path_or_code");
  }
  if (layer2.identifierCount > 0) {
    violations.push("identifier");
  }
  return violations;
}

/* ------------------------------------------------------------------ *
 * shipped_with_ai carve-out (schema 1.3.0)
 * ------------------------------------------------------------------ */

/**
 * shipped_with_ai.items[*].title is one of the two approved public free-name
 * fields (the other is public_url). The SHARED CONTRACT split, mirrored by
 * public-dj's server-side re-scrub:
 *
 *   - The SECRETS layer is ALWAYS enforced.
 *   - The path/identifier layer is enforced EXCEPT exactly these categories,
 *     which are SKIPPED BY DESIGN so explicitly user-approved product/repo
 *     names can ship: relative_path, filename, dotted_identifier (and the
 *     bare case-shape identifier rule that exists only to support them).
 *     That is what lets titles like "vibexp-next", "minutework.ai console",
 *     and "schema.mw compiler" pass.
 *   - These categories STILL REJECT: absolute_path, home_path, windows_path,
 *     email, fenced_code, inline_code, call_expression.
 */
const SHIPPED_TITLE_REJECT_RULES: Array<{ category: string; re: RegExp }> = [
  // Non-global copies: module-level /g regexes are stateful under .test().
  { category: "fenced_code", re: /(?:```|~~~)[\s\S]*?(?:```|~~~)/ },
  { category: "inline_code", re: /`[^`\n]{1,}`/ },
  { category: "windows_path", re: /\b[A-Za-z]:\\(?:[\w .@%+-]+\\?)+/ },
  { category: "home_path", re: /(?<![\w$])~\/[\w.@%+-]+(?:\/[\w.@%+-]+)*\/?/ },
  { category: "absolute_path", re: /(?<![\w$])(?:\/[\w.@%+-]+){2,}\/?/ },
  { category: "email", re: /\b[\w.+%-]+@[\w-]+(?:\.[\w-]+)*\.[A-Za-z]{2,}\b/ },
  { category: "call_expression", re: new RegExp(PUBLIC_DJ_CALL_EXPRESSION_PATTERN) },
];

/**
 * Title scan for shipped_with_ai items per the shared contract above.
 * Returns the categories that fired (empty == clean).
 */
export function detectShippedTitleViolations(input: string): string[] {
  const violations: string[] = [];
  const layer1 = scrubSecrets(input);
  if (layer1.count > 0 || !layer1.confident) {
    violations.push("secret");
  }
  for (const rule of SHIPPED_TITLE_REJECT_RULES) {
    if (rule.re.test(input)) {
      violations.push(rule.category);
    }
  }
  return violations;
}

const IPV4_HOST_RE = /^\d{1,3}(?:\.\d{1,3}){3}$/;

/**
 * Dedicated public_url validator for shipped_with_ai items per the shared
 * contract: the secrets layer is ALWAYS enforced; the entire path/identifier
 * layer is SKIPPED (URLs are paths by construction); instead the URL must be
 * https://, carry no userinfo (no '@' before the host), resolve to a public
 * hostname (not an IP literal, localhost, *.local, or *.internal), and be at
 * most 300 characters. Returns the violation categories (empty == clean).
 */
export function detectShippedUrlViolations(input: string): string[] {
  const violations: string[] = [];
  const layer1 = scrubSecrets(input);
  if (layer1.count > 0 || !layer1.confident) {
    violations.push("secret");
  }
  if (input.length > 300) {
    violations.push("url_too_long");
  }
  if (/\s/.test(input)) {
    violations.push("url_whitespace");
  }
  if (!input.startsWith("https://")) {
    violations.push("url_not_https");
    return violations;
  }
  if (/^https:\/\/[^/?#]*@/.test(input)) {
    violations.push("url_userinfo");
  }
  let parsed: URL;
  try {
    parsed = new URL(input);
  } catch {
    violations.push("url_unparseable");
    return violations;
  }
  if (parsed.username || parsed.password) {
    if (!violations.includes("url_userinfo")) {
      violations.push("url_userinfo");
    }
  }
  const host = parsed.hostname.toLowerCase();
  if (!host) {
    violations.push("url_no_host");
  } else {
    if (IPV4_HOST_RE.test(host) || host.includes(":") || host.startsWith("[")) {
      violations.push("url_ip_host");
    }
    if (
      host === "localhost" ||
      host.endsWith(".localhost") ||
      host === "local" ||
      host.endsWith(".local") ||
      host === "internal" ||
      host.endsWith(".internal")
    ) {
      violations.push("url_internal_host");
    }
  }
  return violations;
}
