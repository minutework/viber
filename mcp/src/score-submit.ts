import { scoreEpisodes, type ScoreEpisodesOutcome } from "./score.js";
import { submitProfile, type SubmitOutcome } from "./submit.js";

export interface ScoreAndSubmitProfileOptions {
  profileDraft: unknown;
  episodes: unknown;
  token: string;
  scoreUrl: string;
  ingestUrl: string;
  dryRun: boolean;
  cacheDir?: string;
  fetchImpl?: typeof fetch;
}

export interface ScoreAndSubmitProfileOutcome extends SubmitOutcome {
  scoreOutcome?: ScoreEpisodesOutcome;
}

export async function scoreAndSubmitProfile(options: ScoreAndSubmitProfileOptions): Promise<ScoreAndSubmitProfileOutcome> {
  if (!options.profileDraft || typeof options.profileDraft !== "object" || Array.isArray(options.profileDraft)) {
    return {
      ok: false,
      dryRun: options.dryRun,
      payload: options.profileDraft,
      errors: ["Profile draft must be an object before score_and_submit_profile can submit it."],
    };
  }
  const requestedEpisodeCount = Array.isArray(options.episodes) ? options.episodes.length : null;

  const scoreOutcome = await scoreEpisodes({
    episodes: options.episodes,
    token: options.token,
    scoreUrl: options.scoreUrl,
    cacheDir: options.cacheDir,
    fetchImpl: options.fetchImpl,
  });
  if (!scoreOutcome.ok) {
    return {
      ok: false,
      dryRun: options.dryRun,
      payload: options.profileDraft,
      status: scoreOutcome.status,
      responseBody: scoreOutcome.responseBody,
      errors: ["score_and_submit_profile failed during scoring:", ...scoreOutcome.errors],
      scoreOutcome,
    };
  }

  const scoredEpisodes = extractScoredEpisodes(scoreOutcome.responseBody);
  if (!scoredEpisodes || scoredEpisodes.length === 0) {
    return {
      ok: false,
      dryRun: options.dryRun,
      payload: options.profileDraft,
      status: scoreOutcome.status,
      responseBody: scoreOutcome.responseBody,
      errors: ["score_and_submit_profile failed: score response did not include scored episodes."],
      scoreOutcome,
    };
  }
  if (requestedEpisodeCount === null || scoredEpisodes.length !== requestedEpisodeCount) {
    return {
      ok: false,
      dryRun: options.dryRun,
      payload: options.profileDraft,
      status: scoreOutcome.status,
      responseBody: scoreOutcome.responseBody,
      errors: [
        "score_and_submit_profile failed: score response episode count did not match requested episode count.",
        `requested=${requestedEpisodeCount ?? "invalid"} scored=${scoredEpisodes.length}`,
      ],
      scoreOutcome,
    };
  }
  const nonceErrors = scoredEpisodes.flatMap((episode, index) => validateScoredEpisodeNonce(episode, index));
  if (nonceErrors.length > 0) {
    return {
      ok: false,
      dryRun: options.dryRun,
      payload: options.profileDraft,
      status: scoreOutcome.status,
      responseBody: scoreOutcome.responseBody,
      errors: ["score_and_submit_profile failed: score response had invalid nonce coverage.", ...nonceErrors],
      scoreOutcome,
    };
  }

  const finalProfile = {
    ...(options.profileDraft as Record<string, unknown>),
    episode_scores: scoredEpisodes,
  };

  const submitOutcome = await submitProfile({
    profile: finalProfile,
    token: options.token,
    ingestUrl: options.ingestUrl,
    dryRun: options.dryRun,
    fetchImpl: options.fetchImpl,
  });
  return {
    ...submitOutcome,
    scoreOutcome,
  };
}

function extractScoredEpisodes(responseBody: unknown): unknown[] | null {
  if (!responseBody || typeof responseBody !== "object") {
    return null;
  }
  const episodes = (responseBody as Record<string, unknown>).episodes;
  return Array.isArray(episodes) ? episodes : null;
}

function validateScoredEpisodeNonce(episode: unknown, index: number): string[] {
  if (!episode || typeof episode !== "object" || Array.isArray(episode)) {
    return [`response.episodes[${index}] is not an object.`];
  }
  const nonce = (episode as Record<string, unknown>).nonce;
  if (!nonce || typeof nonce !== "object" || Array.isArray(nonce)) {
    return [`response.episodes[${index}] is missing nonce.`];
  }
  const nonceRecord = nonce as Record<string, unknown>;
  const missing = ["request_id", "signature", "digest", "issued_at"].filter(
    (key) => typeof nonceRecord[key] !== "string" || String(nonceRecord[key]).length === 0,
  );
  return missing.length > 0 ? [`response.episodes[${index}].nonce missing ${missing.join(", ")}.`] : [];
}
