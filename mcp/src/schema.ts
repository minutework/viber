/**
 * Client-side schema validation against the FROZEN allowlist.
 *
 * The submit MCP validates a profile against schema/profile.schema.json (the
 * exact same file public-dj ingestion uses) BEFORE transmitting anything. This
 * is the first of the two fail-closed enforcement points named in
 * docs/data-handling.md (client Validator + public-dj re-scrub-and-reject).
 *
 * The schema is the hard allowlist: additionalProperties:false at every level,
 * bounded strings, hex-only opaque ids. ajv enforces structure; the redaction
 * pass (redaction.ts) enforces PII-exclusion within allowed free-text fields.
 */
import { createRequire } from "node:module";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { Ajv2020, type ErrorObject, type ValidateFunction } from "ajv/dist/2020.js";
import addFormatsImport from "ajv-formats";

// ajv-formats ships as CommonJS with a default export; under NodeNext ESM the
// default may be the plugin function directly or wrapped one level in `.default`.
type AjvFormatsFn = (ajv: unknown, opts?: unknown) => unknown;
const addFormats: AjvFormatsFn = (
  (addFormatsImport as unknown as { default?: AjvFormatsFn }).default ??
  (addFormatsImport as unknown as AjvFormatsFn)
);

export const SCHEMA_VERSION = "1.3.0";
// The 1.3.0 schema accepts rubric 1.0.0 or 1.1.0 (the session rubric is
// unchanged); the exact pairing is enforced by public-dj's server-side compatibility map.
export const RUBRIC_VERSION = "1.1.0";

const here = dirname(fileURLToPath(import.meta.url));

/**
 * Resolve the vendored frozen schema. dist/schema and the package schema/ dir
 * are populated by scripts/copy-schema.mjs at build time; the src locations are
 * used when running from source (tests).
 */
function resolveSchemaPath(): string {
  const candidates = [
    join(here, "schema", "profile.schema.json"),
    join(here, "..", "schema", "profile.schema.json"),
    join(here, "..", "..", "schema", "profile.schema.json"),
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }
  throw new Error("viber: could not locate vendored profile.schema.json");
}

export function loadProfileSchema(): Record<string, unknown> {
  return JSON.parse(readFileSync(resolveSchemaPath(), "utf8")) as Record<string, unknown>;
}

let cachedValidator: ValidateFunction | null = null;

function buildValidator(): ValidateFunction {
  if (cachedValidator) {
    return cachedValidator;
  }
  // ajv-formats is published as CJS; normalize the default export shape.
  const ajv = new Ajv2020({ allErrors: true, strict: false });
  addFormats(ajv);
  cachedValidator = ajv.compile(loadProfileSchema());
  return cachedValidator;
}

export interface SchemaValidationResult {
  valid: boolean;
  errors: string[];
}

export function validateProfileAgainstSchema(profile: unknown): SchemaValidationResult {
  const validate = buildValidator();
  const valid = validate(profile) as boolean;
  if (valid) {
    return { valid: true, errors: [] };
  }
  const errors = (validate.errors ?? []).map(formatAjvError);
  return { valid: false, errors };
}

function formatAjvError(error: ErrorObject): string {
  const where = error.instancePath || "(root)";
  return `${where} ${error.message ?? "is invalid"}`.trim();
}

// `createRequire` kept available for any future CJS interop without breaking
// the NodeNext module graph; referenced here so tree-shakers/linters don't flag.
export const __require = createRequire(import.meta.url);
