/**
 * score_episodes core logic.
 *
 * The bootstrap already passed the signed submission token into this MCP
 * process. Keep scoring behind the MCP so the agent never has to print, persist,
 * or shell-interpolate the token when requesting public-dj integrity nonces.
 */
export interface ScoreEpisodesOptions {
  episodes: unknown;
  token: string;
  scoreUrl: string;
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

  const fetchImpl = options.fetchImpl ?? fetch;
  let response: Response;
  try {
    response = await fetchImpl(options.scoreUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: options.token, episodes: options.episodes }),
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

  return {
    ok: true,
    status: response.status,
    responseBody,
    errors: [],
  };
}
