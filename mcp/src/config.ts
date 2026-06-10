/**
 * Runtime configuration for the viber submit MCP, resolved from environment.
 *
 * No localhost fallbacks are baked in for the live endpoint: the bootstrap
 * (upload.sh) sets these explicitly, and the platform default is the public
 * production host. The token is passed in env by the bootstrap after the
 * browser OAuth handoff; it is never persisted to disk by this MCP.
 */
import { readFileSync } from "node:fs";

const DEFAULT_PUBLIC_DJ_BASE_URL = "https://profile.vibexp.com";
const INGEST_PATH = "/api/v1/builder-profiles/ingest/";
const SCORE_PATH = "/api/v1/builder-profiles/score/";
const SCORE_HEALTH_PATH = "/api/v1/builder-profiles/score-health/";
const METRICS_REFRESH_PATH = "/api/v1/builder-profiles/metrics-refresh/";

export interface ViberMcpConfig {
  ingestUrl: string;
  scoreUrl: string;
  scoreHealthUrl: string;
  metricsRefreshUrl: string;
  token: string;
  tokenFile: string;
  dryRun: boolean;
  selectedProjectPath: string;
  scratchDir: string;
  cacheDir: string;
  submitResultFile: string;
  progressFile: string;
}

export function resolveConfig(env: NodeJS.ProcessEnv, argDryRun: boolean): ViberMcpConfig {
  const base = (env.VIBER_PUBLIC_DJ_BASE_URL ?? DEFAULT_PUBLIC_DJ_BASE_URL).replace(/\/+$/, "");
  const ingestUrl = env.VIBER_INGEST_URL ?? `${base}${INGEST_PATH}`;
  const scoreUrl = env.VIBER_SCORE_URL ?? `${base}${SCORE_PATH}`;
  const scoreHealthUrl = env.VIBER_SCORE_HEALTH_URL ?? `${base}${SCORE_HEALTH_PATH}`;
  const metricsRefreshUrl = env.VIBER_METRICS_REFRESH_URL ?? `${base}${METRICS_REFRESH_PATH}`;
  const token = env.VIBER_SUBMIT_TOKEN ?? "";
  const tokenFile = env.VIBER_SUBMIT_TOKEN_FILE ?? "";
  const dryRun = argDryRun || env.VIBER_DRY_RUN === "1" || env.VIBER_DRY_RUN === "true";
  const selectedProjectPath = env.VIBER_SELECTED_PROJECT_PATH ?? process.cwd();
  const scratchDir = env.VIBER_SCRATCH_DIR ?? "";
  const cacheDir = env.VIBER_CACHE_DIR ?? "";
  const submitResultFile = env.VIBER_SUBMIT_RESULT_FILE ?? "";
  const progressFile = env.VIBER_PROGRESS_FILE ?? "";
  return {
    ingestUrl,
    scoreUrl,
    scoreHealthUrl,
    metricsRefreshUrl,
    token,
    tokenFile,
    dryRun,
    selectedProjectPath,
    scratchDir,
    cacheDir,
    submitResultFile,
    progressFile,
  };
}

export function readSubmissionToken(config: ViberMcpConfig): string {
  if (config.tokenFile) {
    try {
      const token = readFileSync(config.tokenFile, "utf8").trim();
      if (token) {
        return token;
      }
    } catch {
      // Fall back to the startup token. The caller still fails closed if empty.
    }
  }
  return config.token;
}
