/**
 * score_episodes core logic.
 *
 * The bootstrap already passed the signed submission token into this MCP
 * process. Keep scoring behind the MCP so the agent never has to print, persist,
 * or shell-interpolate the token when requesting public-dj integrity nonces.
 */
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

export interface ScoreEpisodesOptions {
  episodes: unknown;
  token: string;
  scoreUrl: string;
  /** Optional 0700 scratch dir. Stores digest -> scored nonce only, never raw episode summaries. */
  cacheDir?: string;
  /** Injectable for tests; defaults to global fetch. */
  fetchImpl?: typeof fetch;
}

export interface ScoreEpisodesOutcome {
  ok: boolean;
  status?: number;
  responseBody?: unknown;
  errors: string[];
}

export async function scoreEpisodes(options: ScoreEpisodesOptions): Promise<ScoreEpisodesOutcome> {
  if (!options.token) {
    return { ok: false, errors: ["No submission token provided; cannot score episodes."] };
  }
  if (!Array.isArray(options.episodes) || options.episodes.length === 0) {
    return { ok: false, errors: ["At least one episode is required for scoring."] };
  }

  const episodeRequests = options.episodes.map((episode) => ({
    episode,
    requestDigest: scoreRequestDigest(episode),
  }));
  const tokenFingerprint = scoreTokenFingerprint(options.token);
  const cache = readScoreCache(options.cacheDir, tokenFingerprint);
  const cachedEpisodes = new Map<string, unknown>();
  const missingEpisodes: unknown[] = [];
  const missingDigests: string[] = [];
  for (const request of episodeRequests) {
    const cached = cache.entries[request.requestDigest];
    if (cached) {
      cachedEpisodes.set(request.requestDigest, cached);
    } else {
      missingEpisodes.push(request.episode);
      missingDigests.push(request.requestDigest);
    }
  }

  if (missingEpisodes.length === 0) {
    return {
      ok: true,
      status: 200,
      responseBody: {
        handle: cache.handle ?? null,
        episodes: episodeRequests.map((request) => cachedEpisodes.get(request.requestDigest)),
      },
      errors: [],
    };
  }

  const fetchImpl = options.fetchImpl ?? fetch;
  let response: Response;
  try {
    response = await fetchImpl(options.scoreUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: options.token, episodes: missingEpisodes }),
    });
  } catch (cause) {
    return {
      ok: false,
      errors: [`Network error POSTing to score endpoint: ${cause instanceof Error ? cause.message : String(cause)}`],
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
      status: response.status,
      responseBody,
      errors: [`Score endpoint returned ${response.status}`],
    };
  }

  const mergedBody = mergeAndCacheScoredEpisodes({
    responseBody,
    cache,
    cacheDir: options.cacheDir,
    tokenFingerprint,
    missingDigests,
    cachedEpisodes,
    episodeRequests,
  });

  return {
    ok: true,
    status: response.status,
    responseBody: mergedBody,
    errors: [],
  };
}

interface ScoreCache {
  handle?: string | null;
  tokenFingerprint?: string;
  entries: Record<string, unknown>;
}

function mergeAndCacheScoredEpisodes(options: {
  responseBody: unknown;
  cache: ScoreCache;
  cacheDir?: string;
  tokenFingerprint: string;
  missingDigests: string[];
  cachedEpisodes: Map<string, unknown>;
  episodeRequests: Array<{ episode: unknown; requestDigest: string }>;
}): unknown {
  if (!options.responseBody || typeof options.responseBody !== "object") {
    return options.responseBody;
  }
  const responseRecord = options.responseBody as Record<string, unknown>;
  const scoredEpisodes = Array.isArray(responseRecord.episodes) ? responseRecord.episodes : [];
  scoredEpisodes.forEach((episode, index) => {
    const digest = options.missingDigests[index];
    if (!digest) {
      return;
    }
    options.cache.entries[digest] = episode;
    options.cachedEpisodes.set(digest, episode);
  });
  if (typeof responseRecord.handle === "string") {
    options.cache.handle = responseRecord.handle;
  }
  options.cache.tokenFingerprint = options.tokenFingerprint;
  writeScoreCache(options.cacheDir, options.cache);
  return {
    ...responseRecord,
    episodes: options.episodeRequests.map((request) => options.cachedEpisodes.get(request.requestDigest)),
  };
}

function scoreRequestDigest(episode: unknown): string {
  const record = episode && typeof episode === "object" ? (episode as Record<string, unknown>) : {};
  const canonical = canonicalJson({
    episode_id: String(record.episode_id ?? ""),
    type: String(record.type ?? "other"),
    summary: String(record.summary ?? record.title ?? ""),
  });
  return createHash("sha256").update(canonical).digest("hex");
}

function scoreTokenFingerprint(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function emptyScoreCache(tokenFingerprint: string): ScoreCache {
  return { tokenFingerprint, entries: {} };
}

function readScoreCache(cacheDir: string | undefined, tokenFingerprint: string): ScoreCache {
  if (!cacheDir) {
    return emptyScoreCache(tokenFingerprint);
  }
  ensureCacheDir(cacheDir);
  const cachePath = path.join(cacheDir, "score-cache.json");
  if (!existsSync(cachePath)) {
    return emptyScoreCache(tokenFingerprint);
  }
  try {
    const parsed = JSON.parse(readFileSync(cachePath, "utf8")) as ScoreCache;
    if (!parsed || typeof parsed !== "object" || !parsed.entries || typeof parsed.entries !== "object") {
      return emptyScoreCache(tokenFingerprint);
    }
    if (parsed.tokenFingerprint !== tokenFingerprint) {
      return emptyScoreCache(tokenFingerprint);
    }
    return parsed;
  } catch {
    return emptyScoreCache(tokenFingerprint);
  }
}

function writeScoreCache(cacheDir: string | undefined, cache: ScoreCache): void {
  if (!cacheDir) {
    return;
  }
  ensureCacheDir(cacheDir);
  const cachePath = path.join(cacheDir, "score-cache.json");
  writeFileSync(cachePath, JSON.stringify(cache), { mode: 0o600 });
}

function ensureCacheDir(cacheDir: string): void {
  mkdirSync(cacheDir, { recursive: true, mode: 0o700 });
  try {
    chmodSync(cacheDir, 0o700);
  } catch {
    // Best effort; individual cache files are still written 0600.
  }
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((entry) => canonicalJson(entry)).join(",")}]`;
  }
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    .join(",")}}`;
}
