#!/usr/bin/env node
// Vendor the frozen profile schema into dist/ so the built package validates
// against the exact same allowlist that public-dj ingestion enforces. The
// canonical copy lives at <repo-root>/schema/profile.schema.json; a working
// copy is kept at mcp/schema/profile.schema.json for editor/CI convenience.
import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const pkgRoot = join(here, "..");
const repoRoot = join(pkgRoot, "..");

const candidates = [
  join(repoRoot, "schema", "profile.schema.json"),
  join(pkgRoot, "schema", "profile.schema.json"),
];

const source = candidates.find((candidate) => existsSync(candidate));
if (!source) {
  console.error("[copy-schema] could not find profile.schema.json in any known location");
  process.exit(1);
}

const targets = [
  join(pkgRoot, "schema", "profile.schema.json"),
  join(pkgRoot, "dist", "schema", "profile.schema.json"),
];

for (const target of targets) {
  if (target === source) {
    continue;
  }
  mkdirSync(dirname(target), { recursive: true });
  copyFileSync(source, target);
}

console.log("[copy-schema] vendored profile.schema.json into package + dist");
