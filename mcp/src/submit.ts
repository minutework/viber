/**
 * submit_profile core logic.
 *
 * Pipeline (fail-closed):
 *   1. Validate the profile against the FROZEN allowlist schema (ajv).
 *   2. Re-scan every free-text field with both redaction layers; ANY residual
 *      path/secret/code/identifier hit aborts the submission (mirrors public-dj's
 *      independent re-scrub-and-REJECT). The agent is expected to have already
 *      paraphrased + redacted; this is the deterministic backstop.
 *   3. If --dry-run: print the EXACT payload that would be sent and send nothing.
 *   4. Otherwise POST { token, profile } to the public-dj ingest endpoint.
 *
 * The token is the bearer of the verified GitHub handle; the body's `handle`
 * field is overwritten/validated against the token by public-dj on ingestion.
 */
import { detectViolations } from "./redaction.js";
import { validateProfileAgainstSchema } from "./schema.js";

/** Free-text fields in the profile that must pass the redaction backstop. */
function collectTextFields(value: unknown, out: Array<{ pointer: string; text: string }>, pointer = ""): void {
  if (typeof value === "string") {
    out.push({ pointer: pointer || "(root)", text: value });
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => collectTextFields(item, out, `${pointer}/${index}`));
    return;
  }
  if (value && typeof value === "object") {
    for (const [key, child] of Object.entries(value)) {
      collectTextFields(child, out, `${pointer}/${key}`);
    }
  }
}

/**
 * Fields whose string values are structured opaque tokens / enums / timestamps
 * — NOT free-text narrative — and therefore must not be run through the prose
 * redactor (their content is already structurally constrained by the schema:
 * hex ids, base64url nonces, ISO timestamps, version strings, enums).
 */
const STRUCTURED_FIELD_SEGMENTS = new Set<string>([
  "schema_version",
  "rubric_version",
  "handle",
  "generated_at",
  "tool_version",
  "skill_version",
  "mcp_version",
  "episode_id",
  "decision_id",
  "session_ref",
  "session_refs",
  "content_digest",
  "request_id",
  "signature",
  "digest",
  "issued_at",
  "first_activity_at",
  "last_activity_at",
  "started_at",
  "ended_at",
  "authored_at",
  "last_stats_refresh_at",
  "next_stats_refresh_at",
  "last_ai_analysis_at",
  "next_ai_analysis_at",
  "analysis_cadence",
  "metrics_refresh_cadence",
  "metrics_scope",
  "token_source",
  "status",
  "type",
  "tool",
  "parallelism",
  "agent_type",
  "session_intent",
  "significance",
  "reversibility",
  "outcome",
  "overall_grade",
  "os_family",
]);

function isStructuredPointer(pointer: string): boolean {
  const segments = pointer.split("/").filter(Boolean);
  return segments.some((segment) => STRUCTURED_FIELD_SEGMENTS.has(segment));
}

export interface RedactionScan {
  clean: boolean;
  violations: Array<{ pointer: string; layers: string[] }>;
}

export function scanProfileForLeaks(profile: unknown): RedactionScan {
  const fields: Array<{ pointer: string; text: string }> = [];
  collectTextFields(profile, fields);
  const violations: Array<{ pointer: string; layers: string[] }> = [];
  for (const field of fields) {
    if (isStructuredPointer(field.pointer)) {
      continue;
    }
    const layers = detectViolations(field.text);
    if (layers.length > 0) {
      violations.push({ pointer: field.pointer, layers });
    }
  }
  return { clean: violations.length === 0, violations };
}

export interface SubmitOptions {
  profile: unknown;
  token: string;
  ingestUrl: string;
  dryRun: boolean;
  /** Injectable for tests; defaults to global fetch. */
  fetchImpl?: typeof fetch;
}

export interface SubmitOutcome {
  ok: boolean;
  dryRun: boolean;
  /** The exact JSON body that was (or would be) sent. */
  payload: unknown;
  status?: number;
  responseBody?: unknown;
  errors: string[];
}

export interface MetricsRefreshOptions {
  vibeMetrics: unknown;
  gitMetrics?: unknown;
  clientTelemetry?: unknown;
  token: string;
  metricsRefreshUrl: string;
  dryRun: boolean;
  /** Injectable for tests; defaults to global fetch. */
  fetchImpl?: typeof fetch;
}

export async function refreshProfileMetrics(options: MetricsRefreshOptions): Promise<SubmitOutcome> {
  const payload = {
    vibe_metrics: options.vibeMetrics,
    ...(options.gitMetrics && typeof options.gitMetrics === "object" ? { git_metrics: options.gitMetrics } : {}),
    ...(options.clientTelemetry && typeof options.clientTelemetry === "object"
      ? { client_telemetry: options.clientTelemetry }
      : {}),
  };

  const scan = scanProfileForLeaks(payload);
  if (!scan.clean) {
    return {
      ok: false,
      dryRun: options.dryRun,
      payload,
      errors: [
        "Metrics refresh failed the client redaction backstop (fail-closed):",
        ...scan.violations.map((violation) => `Redaction backstop hit at ${violation.pointer}: ${violation.layers.join(", ")}`),
      ],
    };
  }

  if (options.dryRun) {
    return {
      ok: true,
      dryRun: true,
      payload,
      errors: [],
    };
  }

  if (!options.token) {
    return {
      ok: false,
      dryRun: false,
      payload,
      errors: ["No submission token provided; cannot refresh profile metrics."],
    };
  }

  const fetchImpl = options.fetchImpl ?? fetch;
  let response: Response;
  try {
    response = await fetchImpl(options.metricsRefreshUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: options.token, ...payload }),
    });
  } catch (cause) {
    return {
      ok: false,
      dryRun: false,
      payload,
      errors: [`Network error POSTing to metrics refresh endpoint: ${cause instanceof Error ? cause.message : String(cause)}`],
    };
  }

  let responseBody: unknown = null;
  const rawText = await response.text();
  try {
    responseBody = rawText ? JSON.parse(rawText) : null;
  } catch {
    responseBody = rawText;
  }

  if (!response.ok) {
    return {
      ok: false,
      dryRun: false,
      payload,
      status: response.status,
      responseBody,
      errors: [`Metrics refresh endpoint returned ${response.status}`],
    };
  }

  return {
    ok: true,
    dryRun: false,
    payload,
    status: response.status,
    responseBody,
    errors: [],
  };
}

export async function submitProfile(options: SubmitOptions): Promise<SubmitOutcome> {
  const errors: string[] = [];

  // 1. Schema validation (hard allowlist).
  const schemaResult = validateProfileAgainstSchema(options.profile);
  if (!schemaResult.valid) {
    return {
      ok: false,
      dryRun: options.dryRun,
      payload: options.profile,
      errors: ["Profile failed schema validation:", ...schemaResult.errors],
    };
  }

  // 2. Redaction backstop over every free-text field.
  const scan = scanProfileForLeaks(options.profile);
  if (!scan.clean) {
    for (const violation of scan.violations) {
      errors.push(`Redaction backstop hit at ${violation.pointer}: ${violation.layers.join(", ")}`);
    }
    return {
      ok: false,
      dryRun: options.dryRun,
      payload: options.profile,
      errors: ["Profile failed the client redaction backstop (fail-closed):", ...errors],
    };
  }

  // 3. Dry run: print the exact payload, send nothing.
  if (options.dryRun) {
    return {
      ok: true,
      dryRun: true,
      payload: options.profile,
      errors: [],
    };
  }

  // 4. Live submit.
  if (!options.token) {
    return {
      ok: false,
      dryRun: false,
      payload: options.profile,
      errors: ["No submission token provided; cannot submit (use --dry-run to preview without a token)."],
    };
  }

  const fetchImpl = options.fetchImpl ?? fetch;
  let response: Response;
  try {
    response = await fetchImpl(options.ingestUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: options.token, profile: options.profile }),
    });
  } catch (cause) {
    return {
      ok: false,
      dryRun: false,
      payload: options.profile,
      errors: [`Network error POSTing to ingest endpoint: ${cause instanceof Error ? cause.message : String(cause)}`],
    };
  }

  let responseBody: unknown = null;
  const rawText = await response.text();
  try {
    responseBody = rawText ? JSON.parse(rawText) : null;
  } catch {
    responseBody = rawText;
  }

  if (!response.ok) {
    return {
      ok: false,
      dryRun: false,
      payload: options.profile,
      status: response.status,
      responseBody,
      errors: [`Ingest endpoint returned ${response.status}`],
    };
  }

  return {
    ok: true,
    dryRun: false,
    payload: options.profile,
    status: response.status,
    responseBody,
    errors: [],
  };
}
