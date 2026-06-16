#!/usr/bin/env node
import { chmodSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const cliPath = join(scriptDir, "..", "dist", "cli.js");

chmodSync(cliPath, 0o755);
