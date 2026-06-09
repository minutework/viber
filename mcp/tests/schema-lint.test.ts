import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import { loadProfileSchema, SCHEMA_VERSION } from "../src/schema.ts";

const here = dirname(fileURLToPath(import.meta.url));
const schemaSourcePath = join(here, "..", "..", "schema", "profile.schema.json");

/**
 * Walks every schema node and asserts the hard-allowlist invariants the
 * data-handling contract promises: closed objects everywhere and bounds on
 * every string. New fields added in any version bump get checked for free.
 */

interface SchemaNode {
  type?: string | string[];
  properties?: Record<string, SchemaNode>;
  patternProperties?: Record<string, SchemaNode>;
  items?: SchemaNode;
  additionalProperties?: unknown;
  enum?: unknown[];
  const?: unknown;
  pattern?: string;
  maxLength?: number;
  format?: string;
  $defs?: Record<string, SchemaNode>;
  $ref?: string;
  description?: string;
}

function walk(node: SchemaNode, path: string, visit: (node: SchemaNode, path: string) => void): void {
  visit(node, path);
  for (const [key, child] of Object.entries(node.properties ?? {})) {
    walk(child, `${path}.${key}`, visit);
  }
  for (const [key, child] of Object.entries(node.patternProperties ?? {})) {
    walk(child, `${path}.<${key}>`, visit);
  }
  if (node.items) {
    walk(node.items, `${path}[]`, visit);
  }
  for (const [key, child] of Object.entries(node.$defs ?? {})) {
    walk(child, `${path}#${key}`, visit);
  }
}

test("every object in the schema is closed (additionalProperties:false or patternProperties-only)", () => {
  const schema = loadProfileSchema() as SchemaNode;
  const offenders: string[] = [];
  walk(schema, "$", (node, path) => {
    if (node.type === "object" || node.properties) {
      const closed = node.additionalProperties === false;
      if (!closed) {
        offenders.push(path);
      }
    }
  });
  assert.deepEqual(offenders, [], `open objects found: ${offenders.join(", ")}`);
});

test("every string field is bounded by enum/const/pattern/maxLength/format", () => {
  const schema = loadProfileSchema() as SchemaNode;
  const offenders: string[] = [];
  walk(schema, "$", (node, path) => {
    if (node.type !== "string") {
      return;
    }
    const bounded =
      node.enum !== undefined ||
      node.const !== undefined ||
      node.pattern !== undefined ||
      node.maxLength !== undefined ||
      node.format === "date-time";
    if (!bounded) {
      offenders.push(path);
    }
  });
  assert.deepEqual(offenders, [], `unbounded strings found: ${offenders.join(", ")}`);
});

test("schema_version pin matches the schema document", () => {
  const schema = loadProfileSchema() as SchemaNode;
  const versionNode = (schema.properties ?? {}).schema_version;
  assert.equal(versionNode?.const, SCHEMA_VERSION);
});

/**
 * Cross-repo drift guard: the sha256 of the authored schema source. The same
 * constant is asserted in public-dj's test suite against ITS vendored copy;
 * updating this constant is an explicit step of the schema-bump checklist.
 */
test("schema source digest matches the pinned cross-repo constant", () => {
  const raw = readFileSync(schemaSourcePath);
  const digest = createHash("sha256").update(raw).digest("hex");
  const vendored = createHash("sha256")
    .update(readFileSync(join(here, "..", "schema", "profile.schema.json")))
    .digest("hex");
  assert.equal(digest, vendored, "authored schema and package-vendored copy must be byte-identical");
  // PINNED_SCHEMA_SHA256: update on every intentional schema change (bump checklist).
  const pinPath = join(here, "..", "..", "schema", "profile.schema.sha256");
  const pinned = readFileSync(pinPath, "utf8").trim();
  assert.equal(digest, pinned, "schema changed without updating schema/profile.schema.sha256");
});
