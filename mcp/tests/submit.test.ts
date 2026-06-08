import assert from "node:assert/strict";
import { test } from "node:test";

import { validateProfileAgainstSchema } from "../src/schema.ts";
import { scoreEpisodes } from "../src/score.ts";
import { scanProfileForLeaks, submitProfile } from "../src/submit.ts";
import { makeValidProfile } from "./fixtures.ts";

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
