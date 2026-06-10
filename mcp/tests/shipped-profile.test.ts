/**
 * Schema 1.3.0 shipped_with_ai + profile_analysis_overhead profile tests:
 * mode<->items coupling, bounds, the leak-scan carve-out for the two approved
 * public free-name fields (title / public_url), and the approvals-file
 * round-trip (permissions, local-key stripping, opt_out).
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import { detectShippedUrlViolations } from "../src/redaction.ts";
import { validateProfileAgainstSchema } from "../src/schema.ts";
import {
  approvalsFilePath,
  buildShippedWithAiBlock,
  readShippedApprovals,
  writeShippedApprovals,
  type ShippedApprovalsFile,
} from "../src/shipped.ts";
import { scanProfileForLeaks } from "../src/submit.ts";
import { makeProfileAnalysisOverhead, makeShippedWithAi, makeValidProfile } from "./fixtures.ts";

// Tests need free-form nested mutation; the fixtures are plain JSON data.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyRecord = Record<string, any>;

function makeShippedProfile(): AnyRecord {
  return { ...makeValidProfile(), shipped_with_ai: makeShippedWithAi() } as AnyRecord;
}

function assertValid(profile: unknown, message?: string): void {
  const result = validateProfileAgainstSchema(profile);
  assert.equal(result.valid, true, `${message ?? "expected valid"}: ${result.errors.join("; ")}`);
}

function assertInvalid(profile: unknown, message?: string): void {
  const result = validateProfileAgainstSchema(profile);
  assert.equal(result.valid, false, message ?? "expected the profile to be rejected");
}

// ---------------------------------------------------------------------------
// Schema matrix
// ---------------------------------------------------------------------------

test("the shipped_with_ai fixture validates and passes the leak scan", () => {
  const profile = makeShippedProfile();
  assertValid(profile);
  const scan = scanProfileForLeaks(profile);
  assert.equal(scan.clean, true, JSON.stringify(scan.violations));
});

test("mode<->items coupling rejects both ways", () => {
  const withoutItems = makeShippedProfile();
  delete withoutItems.shipped_with_ai.items;
  assertInvalid(withoutItems, "approved_items without items must reject");

  const aggregateWithItems = makeShippedProfile();
  aggregateWithItems.shipped_with_ai.mode = "aggregate_only";
  assertInvalid(aggregateWithItems, "aggregate_only carrying items must reject");

  const aggregateOnly = makeShippedProfile();
  aggregateOnly.shipped_with_ai.mode = "aggregate_only";
  delete aggregateOnly.shipped_with_ai.items;
  assertValid(aggregateOnly, "aggregate_only without items must validate");
});

test("21 items reject (maxItems 20); 20 validate", () => {
  const item = makeShippedProfile().shipped_with_ai.items[0];
  const at20 = makeShippedProfile();
  at20.shipped_with_ai.items = Array.from({ length: 20 }, () => structuredClone(item));
  assertValid(at20, "exactly 20 items must be accepted");

  const at21 = makeShippedProfile();
  at21.shipped_with_ai.items = Array.from({ length: 21 }, () => structuredClone(item));
  assertInvalid(at21, "21 items must be rejected");
});

test("title/url/shipped_on bounds and enums reject", () => {
  const shortTitle = makeShippedProfile();
  shortTitle.shipped_with_ai.items[0].title = "ab";
  assertInvalid(shortTitle, "title under 3 chars must reject");

  const httpUrl = makeShippedProfile();
  httpUrl.shipped_with_ai.items[1].public_url = "http://example.com/app";
  assertInvalid(httpUrl, "http:// must reject (schema pattern is https-only)");

  const spaceUrl = makeShippedProfile();
  spaceUrl.shipped_with_ai.items[1].public_url = "https://example.com/a b";
  assertInvalid(spaceUrl, "whitespace in the URL must reject");

  const badMonth = makeShippedProfile();
  badMonth.shipped_with_ai.items[0].shipped_on = "2026-13";
  assertInvalid(badMonth, "month 13 must reject");

  const badCategory = makeShippedProfile();
  badCategory.shipped_with_ai.items[0].category = "saas";
  assertInvalid(badCategory, "unknown category must reject");

  const extraKey = makeShippedProfile();
  extraKey.shipped_with_ai.items[0].source_key = "github.com/acme/widget:2026-05";
  assertInvalid(extraKey, "the LOCAL-ONLY source_key must never validate in a profile");
});

test("the profile_analysis_overhead fixture validates and passes the leak scan", () => {
  const profile = { ...makeValidProfile(), vibe_metrics: { profile_analysis_overhead: makeProfileAnalysisOverhead() } };
  assertValid(profile);
  const scan = scanProfileForLeaks(profile);
  assert.equal(scan.clean, true, JSON.stringify(scan.violations));

  const tooManyFamilies = structuredClone(profile) as AnyRecord;
  tooManyFamilies.vibe_metrics.profile_analysis_overhead.model_families = Array.from(
    { length: 13 },
    (_, index) => `Family ${index}`,
  );
  assertInvalid(tooManyFamilies, "more than 12 model families must reject");
});

// ---------------------------------------------------------------------------
// Leak-scan carve-out matrix (shared-contract redaction split)
// ---------------------------------------------------------------------------

test("leak-scan carve-out: approved product names pass, paths and secrets still reject", () => {
  // Titles that MUST pass: dotted identifiers / filenames / relative paths
  // are skipped by design for this one field.
  for (const title of ["minutework.ai console", "vibexp-next", "schema.mw compiler"]) {
    const profile = makeShippedProfile();
    profile.shipped_with_ai.items[0].title = title;
    const scan = scanProfileForLeaks(profile);
    assert.equal(scan.clean, true, `title ${JSON.stringify(title)} must pass: ${JSON.stringify(scan.violations)}`);
  }

  // Titles that MUST still reject.
  const rejectTitles: Array<{ title: string; layer: string }> = [
    { title: "shipped /Users/dev/project tooling", layer: "absolute_path" },
    { title: "shipped ~/projects/secret-app rework", layer: "home_path" },
    { title: "ported C:\\code\\legacy importer", layer: "windows_path" },
    { title: "ask dev@example.com for access", layer: "email" },
    { title: "wired up `internalHelper` glue", layer: "inline_code" },
    { title: "calls fetchData(userId) directly", layer: "call_expression" },
    { title: "leaked key sk-abcdefabcdefabcdefabcdef here", layer: "secret" },
  ];
  for (const { title, layer } of rejectTitles) {
    const profile = makeShippedProfile();
    profile.shipped_with_ai.items[0].title = title;
    const scan = scanProfileForLeaks(profile);
    assert.equal(scan.clean, false, `title ${JSON.stringify(title)} must be rejected`);
    const violation = scan.violations.find((entry) => entry.pointer === "/shipped_with_ai/items/0/title");
    assert.ok(violation, "violation must point at the title");
    assert.ok(violation?.layers.includes(layer), `expected layer ${layer}, got ${violation?.layers.join(", ")}`);
  }
});

test("leak-scan carve-out: public_url uses the dedicated https validator", () => {
  const goodUrl = makeShippedProfile();
  goodUrl.shipped_with_ai.items[1].public_url = "https://github.com/acme/console";
  assert.equal(scanProfileForLeaks(goodUrl).clean, true);

  const cases: Array<{ url: string; layer: string }> = [
    { url: "http://example.com/app", layer: "url_not_https" },
    { url: "https://example.com/sk-abcdefabcdefabcdefabcdef", layer: "secret" },
    { url: "https://user@github.com/acme/console", layer: "url_userinfo" },
    { url: "https://192.168.1.10/app", layer: "url_ip_host" },
    { url: "https://localhost/app", layer: "url_internal_host" },
    { url: "https://dash.corp.internal/app", layer: "url_internal_host" },
    { url: "https://printer.local/app", layer: "url_internal_host" },
    { url: `https://example.com/${"a".repeat(300)}`, layer: "url_too_long" },
  ];
  for (const { url, layer } of cases) {
    const profile = makeShippedProfile();
    profile.shipped_with_ai.items[1].public_url = url;
    const scan = scanProfileForLeaks(profile);
    assert.equal(scan.clean, false, `url ${JSON.stringify(url.slice(0, 60))} must be rejected`);
    const violation = scan.violations.find((entry) => entry.pointer === "/shipped_with_ai/items/1/public_url");
    assert.ok(violation, "violation must point at the public_url");
    assert.ok(violation?.layers.includes(layer), `expected layer ${layer}, got ${violation?.layers.join(", ")}`);
  }

  // The validator itself: a path-shaped https URL is fine (the path/identifier
  // layer is skipped for URLs by design).
  assert.deepEqual(detectShippedUrlViolations("https://docs.example.com/guides/getting-started.html"), []);
});

// ---------------------------------------------------------------------------
// Approvals-file round-trip
// ---------------------------------------------------------------------------

function makeApprovals(mode: ShippedApprovalsFile["mode"]): ShippedApprovalsFile {
  return {
    version: 1,
    updated_at: "2026-06-09T18:00:00.000Z",
    mode,
    items: [
      {
        title: "vibexp-next builder profiles",
        category: "feature",
        shipped_on: "2026-05",
        ai_contribution: "majority_ai",
        evidence_status: "release_tag",
        source_key: "github.com/acme/widget:2026-05",
      },
      {
        title: "minutework.ai console",
        public_url: "https://github.com/acme/console",
        category: "oss",
        shipped_on: "2026-04",
        ai_contribution: "ai_led",
        evidence_status: "public_url",
        source_key: "github.com/acme/console:2026-04",
      },
    ],
    aggregate: { total: 3, by_category: { feature: 2, infra: 1 }, by_evidence: { git_evidence: 2, release_tag: 1 } },
    source_keys_reviewed: ["github.com/acme/widget:2026-05", "github.com/acme/console:2026-04"],
  };
}

test("approvals round-trip: 0600 file, 0700 dir, source_key stripped, schema-valid block", () => {
  const home = mkdtempSync(path.join(tmpdir(), "viber-home-"));
  try {
    const filePath = approvalsFilePath({ VIBER_HOME: home } as NodeJS.ProcessEnv);
    assert.equal(filePath, path.join(home, "shipped", "approved.json"));
    writeShippedApprovals(filePath, makeApprovals("approved_items"));

    assert.equal(statSync(filePath).mode & 0o777, 0o600, "approvals file must be 0600");
    assert.equal(statSync(path.dirname(filePath)).mode & 0o777, 0o700, "shipped dir must be 0700");

    const read = readShippedApprovals(filePath);
    assert.ok(read, "approvals must read back");
    assert.equal(read?.mode, "approved_items");
    assert.equal(read?.items?.length, 2);

    const block = buildShippedWithAiBlock(read);
    assert.ok(block, "approved_items must produce a block");
    assert.equal(block?.mode, "approved_items");
    assert.equal(block?.items?.length, 2);
    assert.equal(block?.last_detected_at, "2026-06-09T18:00:00.000Z");
    // Summary is recomputed from the items, not taken from the stored aggregate.
    assert.equal(block?.summary.total, 2);
    assert.equal(block?.summary.by_category?.feature, 1);
    assert.equal(block?.summary.by_category?.oss, 1);
    assert.equal(block?.summary.by_evidence?.release_tag, 1);
    assert.equal(block?.summary.by_evidence?.public_url, 1);
    // Local-only keys never survive into the profile block.
    const serialized = JSON.stringify(block);
    assert.equal(serialized.includes("source_key"), false);
    assert.equal(serialized.includes("source_keys_reviewed"), false);

    const profile = { ...makeValidProfile(), shipped_with_ai: block };
    assertValid(profile, "the built block must drop into a profile schema-valid");
    assert.equal(scanProfileForLeaks(profile).clean, true);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("aggregate_only uses the stored aggregate counts; opt_out and missing file yield null", () => {
  const home = mkdtempSync(path.join(tmpdir(), "viber-home-"));
  try {
    const filePath = approvalsFilePath({ VIBER_HOME: home } as NodeJS.ProcessEnv);

    const aggregateApprovals = makeApprovals("aggregate_only");
    delete aggregateApprovals.items;
    writeShippedApprovals(filePath, aggregateApprovals);
    const block = buildShippedWithAiBlock(readShippedApprovals(filePath));
    assert.equal(block?.mode, "aggregate_only");
    assert.equal(block?.items, undefined);
    assert.equal(block?.summary.total, 3);
    assert.equal(block?.summary.by_category?.feature, 2);
    assert.equal(block?.summary.by_evidence?.release_tag, 1);
    const profile = { ...makeValidProfile(), shipped_with_ai: block };
    assertValid(profile, "aggregate_only block must validate in a profile");

    writeShippedApprovals(filePath, makeApprovals("opt_out"));
    assert.equal(buildShippedWithAiBlock(readShippedApprovals(filePath)), null, "opt_out must yield null");

    assert.equal(readShippedApprovals(path.join(home, "missing.json")), null);
    assert.equal(buildShippedWithAiBlock(null), null);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
