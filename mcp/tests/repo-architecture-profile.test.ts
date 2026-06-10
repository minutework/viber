/**
 * Schema 1.2.0 repo_architecture block tests.
 *
 * Covers the new OPTIONAL top-level `repo_architecture` /`combined_score` /
 * `combined_grade` properties: closure of every nested object (dimensions,
 * markers, notes, portfolio), the submitted dimension shape (scored|na only —
 * the scanner-side "llm_required" never ships), the meanOrNa union, the
 * dependentRequired coupling of the blended headline, and the redaction
 * backstop's coverage of the new free-text note fields.
 *
 * Math pins are tied directly to the scanner exports (computeOverall,
 * gradeForOverall, W_SESSION, W_ARTIFACT) so a constant drift fails here.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { loadProfileSchema, validateProfileAgainstSchema } from "../src/schema.ts";
import { scanProfileForLeaks } from "../src/submit.ts";
import {
  computeOverall,
  gradeForOverall,
  W_ARTIFACT,
  W_SESSION,
} from "../src/repo-architecture.ts";
import {
  makeValidProfile,
  makeValidProfileWithRepoArchitecture,
} from "./fixtures.ts";

// Tests need free-form nested mutation; the fixtures are plain JSON data.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyRecord = Record<string, any>;

function cloneRepoProfile(): AnyRecord {
  return structuredClone(makeValidProfileWithRepoArchitecture()) as AnyRecord;
}

function assertValid(profile: unknown, message?: string): void {
  const result = validateProfileAgainstSchema(profile);
  assert.equal(result.valid, true, `${message ?? "expected valid"}: ${result.errors.join("; ")}`);
}

function assertInvalid(profile: unknown, message?: string): void {
  const result = validateProfileAgainstSchema(profile);
  assert.equal(result.valid, false, message ?? "expected the profile to be rejected");
}

// 1. Back-compat: optional-block additions are non-breaking by construction;
// the ONLY breaking change is the schema_version const itself. A byte-identical
// 1.1.0-shaped payload validates once stamped 1.2.0, and the same profile
// carrying the literal "1.1.0" rejects (const-pinned versioning convention;
// servers keep accepting archived 1.1.0 payloads against their vendored 1.1.0
// schema via the server-side compatibility map — out of scope here).
test("a 1.1.0-shaped profile (no repo block) still validates under 1.2.0", () => {
  assertValid(makeValidProfile(), "repo-block-free profile must stay valid");
});

test("the literal schema_version 1.1.0 rejects against the 1.2.0 schema", () => {
  const profile = structuredClone(makeValidProfile()) as AnyRecord;
  profile.schema_version = "1.1.0";
  assertInvalid(profile, "old schema_version const must reject");
});

// 2. Happy path.
test("the full repo_architecture fixture validates", () => {
  assertValid(makeValidProfileWithRepoArchitecture());
});

// 3. Missing dimension key.
test("a scorecard missing one of the 10 dimension keys is rejected", () => {
  const profile = cloneRepoProfile();
  delete profile.repo_architecture.scorecards[0].dimensions.release_ops;
  assertInvalid(profile, "all 10 dimension keys are required");
});

// 4. Unknown 11th dimension key.
test("an unknown extra dimension key is rejected (closed object)", () => {
  const profile = cloneRepoProfile();
  profile.repo_architecture.scorecards[0].dimensions.extra_dim = { status: "scored", score: 50 };
  assertInvalid(profile, "dimensions object must be closed");
});

// 5. Marker closure both ways.
test("an unknown marker key is rejected (closed marker objects)", () => {
  const profile = cloneRepoProfile();
  profile.repo_architecture.scorecards[0].markers.documentation.surprise_marker = 1;
  assertInvalid(profile, "marker objects must be closed");
});

test("a missing pinned marker key is rejected (full set required)", () => {
  const profile = cloneRepoProfile();
  delete profile.repo_architecture.scorecards[0].markers.documentation.readme_present;
  assertInvalid(profile, "the full pinned marker key set is required");
});

// 6. Scorecard array bounds.
test("scorecards array bounds: 20 valid, 21 invalid, empty invalid", () => {
  const base = cloneRepoProfile();
  const card = base.repo_architecture.scorecards[0];

  const at20 = cloneRepoProfile();
  at20.repo_architecture.scorecards = Array.from({ length: 20 }, () => structuredClone(card));
  at20.repo_architecture.portfolio.repo_count = 20;
  assertValid(at20, "exactly 20 scorecards must be accepted");

  const at21 = cloneRepoProfile();
  at21.repo_architecture.scorecards = Array.from({ length: 21 }, () => structuredClone(card));
  assertInvalid(at21, "21 scorecards must be rejected (maxItems 20)");

  const empty = cloneRepoProfile();
  empty.repo_architecture.scorecards = [];
  assertInvalid(empty, "an empty scorecards array must be rejected (minItems 1)");
});

// 7. Note bounds.
test("note bounds: 400 chars valid, 401 invalid, empty notes object invalid", () => {
  const at400 = cloneRepoProfile();
  at400.repo_architecture.scorecards[0].notes.architecture = "a".repeat(400);
  assertValid(at400, "a 400-char note must be accepted");

  const at401 = cloneRepoProfile();
  at401.repo_architecture.scorecards[0].notes.architecture = "a".repeat(401);
  assertInvalid(at401, "a 401-char note must be rejected (maxLength 400)");

  const emptyNotes = cloneRepoProfile();
  emptyNotes.repo_architecture.scorecards[0].notes = {};
  assertInvalid(emptyNotes, "an empty notes object must be rejected (minProperties 1)");
});

// 8. Redaction is procedural, not structural: a path-bearing note is
// SCHEMA-valid (length bounds do not exclude PII — mirrors the existing
// data-handling stance) but the leak-scan backstop catches it, proving the
// backstop covers the new field (note names are not in STRUCTURED_FIELD_SEGMENTS).
test("a path-bearing note is schema-valid but caught by the leak-scan backstop", () => {
  const profile = cloneRepoProfile();
  profile.repo_architecture.scorecards[0].notes.architecture =
    "The main entry lives at /Users/dev/project/src/index.ts and wires the layers together.";
  assertValid(profile, "the schema does not (and cannot) catch PII inside bounded notes");

  const scan = scanProfileForLeaks(profile);
  assert.equal(scan.clean, false, "the leak scan must flag the path-bearing note");
  const pointers = scan.violations.map((violation) => violation.pointer);
  assert.ok(
    pointers.includes("/repo_architecture/scorecards/0/notes/architecture"),
    `expected a violation at the note pointer, got: ${pointers.join(", ")}`,
  );
});

// 9. Hex/enum values do not trip the backstop. Precedent: 1.1.0 ships
// unexempted stream_ref/model_family/metrics_scope values clean. If this test
// fails, STOP and report the inconsistency — submit.ts is out of scope.
test("the happy-path repo profile passes the leak-scan backstop clean", () => {
  const scan = scanProfileForLeaks(makeValidProfileWithRepoArchitecture());
  assert.equal(
    scan.clean,
    true,
    `repo block values (24-hex repo_ref, enums, versions) must not trip the backstop: ${JSON.stringify(scan.violations)}`,
  );
});

// 10. Combined headline bounds + dependentRequired coupling.
test("combined_score/combined_grade bounds and coupling", () => {
  const over = cloneRepoProfile();
  over.combined_score = 101;
  assertInvalid(over, "combined_score above 100 must be rejected");

  const under = cloneRepoProfile();
  under.combined_score = -1;
  assertInvalid(under, "negative combined_score must be rejected");

  const badGrade = cloneRepoProfile();
  badGrade.combined_grade = "amazing";
  assertInvalid(badGrade, "unknown combined_grade must be rejected");

  const noRepoBlock = cloneRepoProfile();
  delete noRepoBlock.repo_architecture;
  assertInvalid(noRepoBlock, "combined_* without repo_architecture must be rejected");

  const noGrade = cloneRepoProfile();
  delete noGrade.combined_grade;
  assertInvalid(noGrade, "combined_score without combined_grade must be rejected");

  const noScore = cloneRepoProfile();
  delete noScore.combined_score;
  assertInvalid(noScore, "combined_grade without combined_score must be rejected");
});

// 11. The by_dimension meanOrNa union.
test("portfolio by_dimension accepts a 0-100 mean or the literal 'na' only", () => {
  const cases: Array<{ value: unknown; valid: boolean }> = [
    { value: 50, valid: true },
    { value: "na", valid: true },
    { value: "NA", valid: false },
    { value: "none", valid: false },
    { value: 101, valid: false },
    { value: -3, valid: false },
    { value: true, valid: false },
  ];
  for (const { value, valid } of cases) {
    const profile = cloneRepoProfile();
    profile.repo_architecture.portfolio.by_dimension.architecture = value;
    const result = validateProfileAgainstSchema(profile);
    assert.equal(
      result.valid,
      valid,
      `by_dimension.architecture = ${JSON.stringify(value)} expected valid=${valid}: ${result.errors.join("; ")}`,
    );
  }
});

// 12. Submitted-shape statuses and enums.
test("scanner-side 'llm_required' status never validates in a profile", () => {
  const profile = cloneRepoProfile();
  profile.repo_architecture.scorecards[0].dimensions.architecture = { status: "llm_required" };
  assertInvalid(profile, "llm_required must be rejected (host agent scores before assembly)");
});

test("non-hex repo_ref and unknown enum values are rejected", () => {
  const badRef = cloneRepoProfile();
  badRef.repo_architecture.scorecards[0].repo_ref = "Repo-Name";
  assertInvalid(badRef, "repo_ref must be salted hex, never a name");

  const badRubric = cloneRepoProfile();
  badRubric.repo_architecture.repo_rubric_version = "2.0.0";
  assertInvalid(badRubric, "unknown repo_rubric_version must be rejected");

  const badLanguage = cloneRepoProfile();
  badLanguage.repo_architecture.scorecards[0].primary_language = "cobol";
  assertInvalid(badLanguage, "unknown primary_language must be rejected");

  const badBand = cloneRepoProfile();
  badBand.repo_architecture.scorecards[0].size_band = "huge";
  assertInvalid(badBand, "unknown size_band must be rejected");
});

// 13. The scanner's local_only block (repo-relative paths) has no schema home.
test("no 'local_only' property exists anywhere in the schema", () => {
  const offenders: string[] = [];
  const walk = (node: unknown, path: string): void => {
    if (Array.isArray(node)) {
      node.forEach((item, index) => walk(item, `${path}[${index}]`));
      return;
    }
    if (node && typeof node === "object") {
      for (const [key, child] of Object.entries(node)) {
        if (key === "local_only") {
          offenders.push(`${path}.${key}`);
        }
        walk(child, `${path}.${key}`);
      }
    }
  };
  walk(loadProfileSchema(), "$");
  assert.deepEqual(offenders, [], `local_only must never appear in the schema: ${offenders.join(", ")}`);
});

// 14. Math pins tied to the scanner exports — fixture self-consistency.
test("fixture scores match the pinned scanner math (computeOverall/gradeForOverall/W_*)", () => {
  const profile = cloneRepoProfile();
  const card = profile.repo_architecture.scorecards[0];
  assert.equal(card.overall, computeOverall(80, 1), "scorecard overall must match computeOverall");
  assert.equal(card.grade, gradeForOverall(card.overall), "scorecard grade must match gradeForOverall");
  const sessionOverall = profile.overall_score as number;
  const portfolioMean = profile.repo_architecture.portfolio.mean_overall as number;
  assert.equal(
    profile.combined_score,
    Math.round(W_SESSION * sessionOverall + W_ARTIFACT * portfolioMean),
    "combined_score must match the pinned W_SESSION/W_ARTIFACT blend",
  );
});
