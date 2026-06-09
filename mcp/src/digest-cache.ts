import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";

/**
 * General digest-keyed cache for expensive local stages (host-agent
 * summaries, classification passes, extraction fingerprints), generalizing
 * the score replay cache pattern in score.ts.
 *
 * Privacy contract: keys are salted SHA-256 digests; values must be
 * ALREADY-REDACTED derived outputs (summaries that passed redactField,
 * numeric fingerprints) — never raw transcript text, paths, or identifiers.
 * File paths are never stored; file-fingerprint entries are keyed by a
 * salted digest of the path. The cache file lives in the caller-supplied
 * scratch dir with 0700/0600 permissions.
 */

interface CacheFileShape {
  version: 1;
  entries: Record<string, unknown>;
}

export interface DigestCache {
  get(stage: string, inputDigest: string): unknown;
  set(stage: string, inputDigest: string, value: unknown): void;
  /** True when the file's mtime+size match the cached fingerprint. */
  isFileUnchanged(filePath: string): boolean;
  /** Records the file's current mtime+size fingerprint. */
  rememberFile(filePath: string): void;
  flush(): void;
}

const MAX_ENTRIES = 20_000;

export function sha256DigestOf(parts: string[]): string {
  return createHash("sha256").update(parts.join("\0")).digest("hex");
}

export function openDigestCache(scratchDir: string, salt: string): DigestCache {
  mkdirSync(scratchDir, { recursive: true, mode: 0o700 });
  try {
    chmodSync(scratchDir, 0o700);
  } catch {
    // Best effort; the file mode below is the second line of defense.
  }
  const cachePath = path.join(scratchDir, "digest-cache.json");
  let state: CacheFileShape = { version: 1, entries: {} };
  if (existsSync(cachePath)) {
    try {
      const parsed = JSON.parse(readFileSync(cachePath, "utf8")) as CacheFileShape;
      if (parsed && parsed.version === 1 && parsed.entries && typeof parsed.entries === "object") {
        state = parsed;
      }
    } catch {
      // Corrupt cache is discarded; it is always safe to recompute.
    }
  }
  let dirty = false;

  const keyFor = (stage: string, inputDigest: string): string => sha256DigestOf([salt, stage, inputDigest]);

  const fileKey = (filePath: string): string => keyFor("file-fingerprint", sha256DigestOf([salt, filePath]));

  const fingerprint = (filePath: string): string | null => {
    try {
      const stats = statSync(filePath);
      return `${Math.floor(stats.mtimeMs)}:${stats.size}`;
    } catch {
      return null;
    }
  };

  return {
    get(stage, inputDigest) {
      return state.entries[keyFor(stage, inputDigest)];
    },
    set(stage, inputDigest, value) {
      if (Object.keys(state.entries).length >= MAX_ENTRIES) {
        state.entries = {};
      }
      state.entries[keyFor(stage, inputDigest)] = value;
      dirty = true;
    },
    isFileUnchanged(filePath) {
      const current = fingerprint(filePath);
      if (current === null) {
        return false;
      }
      return state.entries[fileKey(filePath)] === current;
    },
    rememberFile(filePath) {
      const current = fingerprint(filePath);
      if (current === null) {
        return;
      }
      state.entries[fileKey(filePath)] = current;
      dirty = true;
    },
    flush() {
      if (!dirty) {
        return;
      }
      writeFileSync(cachePath, JSON.stringify(state), { mode: 0o600 });
      try {
        chmodSync(cachePath, 0o600);
      } catch {
        // Already created with 0600; ignore.
      }
      dirty = false;
    },
  };
}
