/**
 * A minimal SCHEMA-VALID profile fixture used across tests. Every required
 * field is present; opaque ids are hex; the nonce fields match their patterns;
 * all free-text is already paraphrased + clean so the redaction backstop passes.
 */
export function makeValidProfile(): Record<string, unknown> {
  const episodeId = "a1b2c3d4e5f60718";
  return {
    schema_version: "1.1.0",
    rubric_version: "1.0.0",
    handle: "octocat",
    generated_at: "2026-06-07T12:00:00Z",
    agent: { tool: "claude", tool_version: "1.2.3", parallelism: "parallel" },
    analysis_manifest: {
      session_count: 12,
      episode_count: 30,
      scored_episode_count: 1,
      project_scope: { single_project: true, repos_considered: 1 },
    },
    dimensions: {
      steering: {
        score: 78,
        confidence: 0.7,
        rationale: "Caught the agent drifting off scope early and redirected with a crisp constraint.",
        evidence: [
          {
            episode_id: episodeId,
            excerpt: "The builder noticed a wrong turn and steered back to the agreed plan in one message.",
            why: "Shows early, precise course correction.",
          },
          {
            episode_id: episodeId,
            excerpt: "Supplied the missing context the agent needed instead of accepting the first guess.",
            why: "Demonstrates supplying missing context to steer.",
          },
        ],
      },
      debugging: {
        score: 55,
        confidence: 0.5,
        rationale: "Mostly root-caused issues but occasionally accepted a plausible patch without verifying.",
        evidence: [
          {
            episode_id: episodeId,
            excerpt: "Formed a hypothesis about the failing case and isolated the cause before fixing.",
            why: "Root-cause behavior.",
          },
          {
            episode_id: episodeId,
            excerpt: "Once declared the fix done without re-running the failing scenario.",
            why: "A band-aid without verification, lowering the score.",
          },
        ],
      },
    },
    archetype: "Pragmatic Steerer",
    overall_grade: "proficient",
    overall_score: 68,
    overall_summary:
      "A builder who steers the agent well and usually reaches a verified outcome, with debugging rigor as the main growth edge.",
    top_strengths: ["Precise, well-scoped steering", "Reaches finished outcomes efficiently"],
    growth_edges: ["Verify fixes before declaring done"],
    episode_scores: [
      {
        episode_id: episodeId,
        title: "Add a small feature and steer the agent through it",
        type: "feature",
        scores: { steering: 78, debugging: 55 },
        confidence: 0.6,
        nonce: {
          request_id: "req_abcDEF0123456789",
          signature: "c2lnbmF0dXJlX3BsYWNlaG9sZGVyX3ZhbHVlX2Jhc2U2NHVybA",
          digest: "abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG",
          issued_at: "2026-06-07T11:59:00Z",
        },
      },
    ],
    redaction_report: {
      secret_scrubber_applied: true,
      code_path_identifier_redactor_applied: true,
      fail_closed: true,
      secrets_scrubbed_count: 0,
      paths_scrubbed_count: 3,
      identifiers_scrubbed_count: 7,
    },
  };
}
