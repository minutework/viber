import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import { validateProfileAgainstSchema } from "../src/schema.ts";
import { scoreAndSubmitProfile } from "../src/score-submit.ts";
import { scoreEpisodes } from "../src/score.ts";
import { refreshProfileMetrics, scanProfileForLeaks, submitProfile } from "../src/submit.ts";
import { makeShippedWithAi, makeValidProfile, makeValidProfileWithRepoArchitecture } from "./fixtures.ts";

test("the fixture profile passes the frozen schema", () => {
  const result = validateProfileAgainstSchema(makeValidProfile());
  assert.equal(result.valid, true, result.errors.join("; "));
});

test("schema rejects an unknown top-level field (additionalProperties:false)", () => {
  const profile = makeValidProfile();
  (profile as Record<string, unknown>).rogue_field = "nope";
  const result = validateProfileAgainstSchema(profile);
  assert.equal(result.valid, false);
});

test("schema rejects a bad rubric_version (const-pinned)", () => {
  const profile = makeValidProfile();
  profile.rubric_version = "9.9.9";
  const result = validateProfileAgainstSchema(profile);
  assert.equal(result.valid, false);
});

test("dry-run validates, returns the EXACT payload, and sends nothing", async () => {
  const profile = makeValidProfile();
  let fetchCalled = false;
  const outcome = await submitProfile({
    profile,
    token: "irrelevant-in-dry-run",
    ingestUrl: "https://example.invalid/ingest/",
    dryRun: true,
    fetchImpl: (async () => {
      fetchCalled = true;
      return new Response("", { status: 200 });
    }) as unknown as typeof fetch,
  });
  assert.equal(fetchCalled, false, "dry-run must not perform any network call");
  assert.equal(outcome.ok, true);
  assert.equal(outcome.dryRun, true);
  assert.deepEqual(outcome.payload, profile);
});

test("a planted secret in a free-text field aborts submission (redaction backstop)", async () => {
  const profile = makeValidProfile();
  // Plant an AWS key inside an allowed free-text field.
  profile.overall_summary = "Builder leaked a key AKIAIOSFODNN7EXAMPLE in the summary.";
  const scan = scanProfileForLeaks(profile);
  assert.equal(scan.clean, false);

  const outcome = await submitProfile({
    profile,
    token: "tok",
    ingestUrl: "https://example.invalid/ingest/",
    dryRun: true,
  });
  assert.equal(outcome.ok, false);
  assert.ok(outcome.errors.some((e) => /redaction backstop/i.test(e)));
});

test("a planted path in an excerpt aborts submission", async () => {
  const profile = makeValidProfile();
  const dims = profile.dimensions as Record<string, { evidence: Array<{ excerpt: string }> }>;
  dims.steering.evidence[0].excerpt = "The fix lived in /Users/jane/repo/src/auth/login.ts";
  const scan = scanProfileForLeaks(profile);
  assert.equal(scan.clean, false);
});

test("realistic wrapped profile enums, warnings, and shipped titles pass leak scan", () => {
  const profile = makeValidProfileWithRepoArchitecture();
  profile.overall_summary =
    "A builder who shapes platform systems through sustained multi-agent orchestration. Plan updates are frequent (316 total), with a 24-day build streak and strong verification habits.";
  profile.git_metrics = {
    pr_metrics: { merged_pr_count_30d: 36, source: "merge_commit_heuristic" },
  };
  profile.vibe_metrics = {
    token_sources: {
      cursor: { status: "unavailable", warnings: ["cursor_provider_tokens_unavailable"] },
    },
    metrics_coverage: {
      tools: {
        cursor: {
          tool: "cursor",
          session_count: 179,
          timestamped_event_count: 1000,
          active_hours: 120,
          active_days: 45,
          token_source: "unavailable",
          warnings: ["cursor_provider_tokens_unavailable"],
        },
      },
    },
    warnings: ["cursor_provider_tokens_unavailable"],
  };
  profile.decisions = [
    { decision_id: "abcdefabcdef1234", type: "architecture", topics: ["data_modeling"], significance: "high" },
    { decision_id: "abcdefabcdef1235", type: "tooling", topics: ["distributed_systems"], significance: "medium" },
  ];
  profile.operating_level = {
    band: "platform_shaper",
    confidence: 0.72,
    evidence: ["Coordinated parallel agents while preserving system boundaries."],
  };
  profile.shipped_with_ai = {
    ...makeShippedWithAi(),
    items: [
      {
        title: "minutework-mono - developer site and docs",
        category: "feature",
        shipped_on: "2026-05",
        ai_contribution: "unknown",
        evidence_status: "git_evidence",
      },
      {
        title: "viber - Repo arch profile block",
        category: "platform",
        shipped_on: "2026-06",
        ai_contribution: "unknown",
        evidence_status: "deploy_signal",
      },
    ],
  };
  const scorecards = (profile.repo_architecture as Record<string, unknown>).scorecards as Array<Record<string, unknown>>;
  scorecards[0].size_band = "very_large";
  scorecards[0].notes = {
    architecture: "Clear layered structure with deliberate boundaries between entry points and core services.",
    maintainability:
      "Very low churn concentration (top-10 share 0.13) and near-zero technical-debt markers (0.01 per thousand lines). Deterministic score retained without adjustment.",
  };

  const scan = scanProfileForLeaks(profile);
  assert.equal(scan.clean, true, JSON.stringify(scan.violations));
});

test("live submit POSTs token and profile in the ingest body", async () => {
  const profile = makeValidProfile();
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return new Response(JSON.stringify({ accepted: true }), { status: 201 });
  }) as unknown as typeof fetch;

  const outcome = await submitProfile({
    profile,
    token: "signed-token-xyz",
    ingestUrl: "https://viber.minutework.ai/api/v1/builder-profiles/ingest/",
    dryRun: false,
    fetchImpl,
  });

  assert.equal(outcome.ok, true);
  assert.equal(outcome.status, 201);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].init.method, "POST");
  const headers = calls[0].init.headers as Record<string, string>;
  assert.equal(headers["content-type"], "application/json");
  assert.deepEqual(JSON.parse(calls[0].init.body as string), {
    token: "signed-token-xyz",
    profile,
  });
});

test("score_and_submit_profile scores, attaches returned episodes, and submits with the same token", async () => {
  const profile = makeValidProfile();
  const staleEpisodeScores = [{ episode_id: "deadbeefdeadbeef", type: "feature" }];
  const draft = { ...profile, episode_scores: staleEpisodeScores };
  const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
  const scoredEpisode = {
    episode_id: "a1b2c3d4e5f60718",
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
  };
  const fetchImpl = (async (url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body));
    calls.push({ url, body });
    if (url.endsWith("/score/")) {
      return new Response(JSON.stringify({ handle: "octocat", episodes: [scoredEpisode] }), { status: 200 });
    }
    return new Response(JSON.stringify({ accepted: true }), { status: 201 });
  }) as unknown as typeof fetch;

  const outcome = await scoreAndSubmitProfile({
    profileDraft: draft,
    episodes: [{ episode_id: "a1b2c3d4e5f60718", type: "feature", summary: "Redacted steering episode." }],
    token: "signed-token-xyz",
    scoreUrl: "https://profile.vibexp.com/api/v1/builder-profiles/score/",
    ingestUrl: "https://profile.vibexp.com/api/v1/builder-profiles/ingest/",
    dryRun: false,
    fetchImpl,
  });

  assert.equal(outcome.ok, true);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].url, "https://profile.vibexp.com/api/v1/builder-profiles/score/");
  assert.equal(calls[1].url, "https://profile.vibexp.com/api/v1/builder-profiles/ingest/");
  assert.equal(calls[0].body.token, "signed-token-xyz");
  assert.equal(calls[1].body.token, "signed-token-xyz");
  const submittedProfile = calls[1].body.profile as Record<string, unknown>;
  assert.deepEqual(submittedProfile.episode_scores, [scoredEpisode]);
  assert.notDeepEqual(submittedProfile.episode_scores, staleEpisodeScores);
});

test("score_and_submit_profile refuses to ingest scored episodes without nonces", async () => {
  const calls: string[] = [];
  const fetchImpl = (async (url: string) => {
    calls.push(url);
    return new Response(
      JSON.stringify({
        handle: "octocat",
        episodes: [{ episode_id: "abc123", type: "feature", scores: { steering: 80 }, confidence: 0.7 }],
      }),
      { status: 200 },
    );
  }) as unknown as typeof fetch;

  const outcome = await scoreAndSubmitProfile({
    profileDraft: makeValidProfile(),
    episodes: [{ episode_id: "abc123", type: "feature", summary: "Redacted steering episode." }],
    token: "signed-token-xyz",
    scoreUrl: "https://profile.vibexp.com/api/v1/builder-profiles/score/",
    ingestUrl: "https://profile.vibexp.com/api/v1/builder-profiles/ingest/",
    dryRun: false,
    fetchImpl,
  });

  assert.equal(outcome.ok, false);
  assert.equal(calls.length, 1, "ingest must not be called when scoring returns an invalid nonce payload");
  assert.ok(outcome.errors.some((error) => error.includes("invalid nonce coverage")));
});

test("metrics refresh POSTs only deterministic metrics blocks", async () => {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return new Response(JSON.stringify({ accepted: true }), { status: 200 });
  }) as unknown as typeof fetch;

  const outcome = await refreshProfileMetrics({
    token: "signed-token-xyz",
    metricsRefreshUrl: "https://profile.vibexp.com/api/v1/builder-profiles/metrics-refresh/",
    vibeMetrics: {
      metrics_scope: "all_project_sessions_uncapped",
      total_vibe_agent_hours: 2,
      total_tokens: 100,
    },
    gitMetrics: {
      lines_added: 20,
      vibe_loc_sources: { committed: 10, tracked_working_tree: 5, untracked: 5 },
    },
    dryRun: false,
    fetchImpl,
  });

  assert.equal(outcome.ok, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://profile.vibexp.com/api/v1/builder-profiles/metrics-refresh/");
  assert.deepEqual(JSON.parse(calls[0].init.body as string), {
    token: "signed-token-xyz",
    vibe_metrics: {
      metrics_scope: "all_project_sessions_uncapped",
      total_vibe_agent_hours: 2,
      total_tokens: 100,
    },
    git_metrics: {
      lines_added: 20,
      vibe_loc_sources: { committed: 10, tracked_working_tree: 5, untracked: 5 },
    },
  });
});

test("metrics refresh dry-run sends nothing and returns exact payload", async () => {
  let fetchCalled = false;
  const outcome = await refreshProfileMetrics({
    token: "",
    metricsRefreshUrl: "https://profile.vibexp.com/api/v1/builder-profiles/metrics-refresh/",
    vibeMetrics: { metrics_scope: "all_project_sessions_uncapped", total_vibe_agent_hours: 2 },
    dryRun: true,
    fetchImpl: (async () => {
      fetchCalled = true;
      return new Response("", { status: 200 });
    }) as unknown as typeof fetch,
  });

  assert.equal(fetchCalled, false);
  assert.equal(outcome.ok, true);
  assert.deepEqual(outcome.payload, {
    vibe_metrics: { metrics_scope: "all_project_sessions_uncapped", total_vibe_agent_hours: 2 },
  });
});

test("score_episodes POSTs token inside JSON body and returns scored nonce payload", async () => {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return new Response(
      JSON.stringify({
        handle: "octocat",
        episodes: [
          {
            episode_id: "abc123",
            type: "feature",
            scores: { steering: 80 },
            confidence: 0.7,
            nonce: {
              request_id: "req_abcDEF0123456789",
              signature: "sig",
              digest: "dig",
              issued_at: "2026-06-07T11:59:00Z",
            },
          },
        ],
      }),
      { status: 200 },
    );
  }) as unknown as typeof fetch;

  const outcome = await scoreEpisodes({
    token: "signed-token-xyz",
    scoreUrl: "https://viber.minutework.ai/api/v1/builder-profiles/score/",
    episodes: [{ episode_id: "abc123", type: "feature", summary: "Redacted steering episode." }],
    fetchImpl,
  });

  assert.equal(outcome.ok, true);
  assert.equal(outcome.status, 200);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://viber.minutework.ai/api/v1/builder-profiles/score/");
  assert.equal(calls[0].init.method, "POST");
  assert.deepEqual(JSON.parse(calls[0].init.body as string), {
    token: "signed-token-xyz",
    episodes: [{ episode_id: "abc123", type: "feature", summary: "Redacted steering episode." }],
  });
});

test("score_episodes replays from digest-only scratch cache without another network call", async () => {
  const cacheDir = mkdtempSync(path.join(tmpdir(), "viber-score-cache-"));
  try {
    let fetchCount = 0;
    const fetchImpl = (async () => {
      fetchCount += 1;
      return new Response(
        JSON.stringify({
          handle: "octocat",
          episodes: [
            {
              episode_id: "abc123",
              type: "feature",
              scores: { steering: 80 },
              confidence: 0.7,
              nonce: {
                request_id: "req_abcDEF0123456789",
                signature: "sig",
                digest: "dig",
                issued_at: "2026-06-07T11:59:00Z",
              },
            },
          ],
        }),
        { status: 200 },
      );
    }) as unknown as typeof fetch;

    const episode = { episode_id: "abc123", type: "feature", summary: "Redacted steering episode." };
    const first = await scoreEpisodes({
      token: "signed-token-xyz",
      scoreUrl: "https://viber.minutework.ai/api/v1/builder-profiles/score/",
      episodes: [episode],
      cacheDir,
      fetchImpl,
    });
    const second = await scoreEpisodes({
      token: "signed-token-xyz",
      scoreUrl: "https://viber.minutework.ai/api/v1/builder-profiles/score/",
      episodes: [episode],
      cacheDir,
      fetchImpl,
    });

    assert.equal(first.ok, true);
    assert.equal(second.ok, true);
    assert.equal(fetchCount, 1);
    assert.deepEqual(second.responseBody, first.responseBody);
  } finally {
    rmSync(cacheDir, { recursive: true, force: true });
  }
});

test("score_episodes cache is scoped to the submission token fingerprint", async () => {
  const cacheDir = mkdtempSync(path.join(tmpdir(), "viber-score-cache-token-"));
  try {
    const seenTokens: string[] = [];
    const fetchImpl = (async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body));
      seenTokens.push(String(body.token));
      const requestId = body.token === "signed-token-one" ? "q".repeat(20) : "r".repeat(20);
      return new Response(
        JSON.stringify({
          handle: "octocat",
          episodes: [
            {
              episode_id: "abc123",
              type: "feature",
              scores: { steering: 80 },
              confidence: 0.7,
              nonce: {
                request_id: requestId,
                signature: "sig",
                digest: "dig",
                issued_at: "2026-06-07T11:59:00Z",
              },
            },
          ],
        }),
        { status: 200 },
      );
    }) as unknown as typeof fetch;

    const episode = { episode_id: "abc123", type: "feature", summary: "Redacted steering episode." };
    const first = await scoreEpisodes({
      token: "signed-token-one",
      scoreUrl: "https://viber.minutework.ai/api/v1/builder-profiles/score/",
      episodes: [episode],
      cacheDir,
      fetchImpl,
    });
    const second = await scoreEpisodes({
      token: "signed-token-two",
      scoreUrl: "https://viber.minutework.ai/api/v1/builder-profiles/score/",
      episodes: [episode],
      cacheDir,
      fetchImpl,
    });

    assert.equal(first.ok, true);
    assert.equal(second.ok, true);
    assert.deepEqual(seenTokens, ["signed-token-one", "signed-token-two"]);
    assert.notDeepEqual(second.responseBody, first.responseBody);
  } finally {
    rmSync(cacheDir, { recursive: true, force: true });
  }
});
