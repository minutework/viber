/**
 * Runtime configuration for the viber submit MCP, resolved from environment.
 *
 * No localhost fallbacks are baked in for the live endpoint: the bootstrap
 * (upload.sh) sets these explicitly, and the platform default is the public
 * production host. The token is passed in env by the bootstrap after the
 * browser OAuth handoff; it is never persisted to disk by this MCP.
 */
const DEFAULT_PUBLIC_DJ_BASE_URL = "https://viber.minutework.ai";
const INGEST_PATH = "/api/v1/builder-profiles/ingest/";

export interface ViberMcpConfig {
  ingestUrl: string;
  token: string;
  dryRun: boolean;
}

export function resolveConfig(env: NodeJS.ProcessEnv, argDryRun: boolean): ViberMcpConfig {
  const base = (env.VIBER_PUBLIC_DJ_BASE_URL ?? DEFAULT_PUBLIC_DJ_BASE_URL).replace(/\/+$/, "");
  const ingestUrl = env.VIBER_INGEST_URL ?? `${base}${INGEST_PATH}`;
  const token = env.VIBER_SUBMIT_TOKEN ?? "";
  const dryRun = argDryRun || env.VIBER_DRY_RUN === "1" || env.VIBER_DRY_RUN === "true";
  return { ingestUrl, token, dryRun };
}
