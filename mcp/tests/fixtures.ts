/**
 * A minimal SCHEMA-VALID profile fixture used across tests. Every required
 * field is present; opaque ids are hex; the nonce fields match their patterns;
 * all free-text is already paraphrased + clean so the redaction backstop passes.
 */
export function makeValidProfile(): Record<string, unknown> {
  const episodeId = "a1b2c3d4e5f60718";
  return {
    schema_version: "1.2.0",
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

/**
 * Full 10-dimension marker sets with realistic values — the exact pinned key
 * sets the scanner (mcp/src/repo-architecture.ts) emits, copied verbatim into
 * a submitted scorecard's `markers` object.
 */
export function makeRepoMarkers(): Record<string, Record<string, number | boolean>> {
  return {
    documentation: {
      readme_present: true,
      readme_bytes: 4096,
      docs_dir_present: true,
      docs_index_present: false,
      adr_present: false,
      contributing_present: true,
      doc_file_count: 6,
      doc_to_source_file_ratio: 0.12,
    },
    testing: {
      test_file_count: 24,
      source_file_count: 50,
      test_to_source_ratio: 0.48,
      test_framework_config_present: true,
      test_dir_present: true,
    },
    ci_automation: {
      ci_workflow_count: 2,
      ci_present: true,
      ci_runs_tests: true,
      precommit_present: false,
      task_runner_quality_targets: true,
    },
    type_safety: {
      type_config_present: true,
      strict_mode: true,
      typed_ratio: 0.96,
      statically_typed_language: true,
      linter_config_present: true,
      formatter_config_present: false,
    },
    dependency_hygiene: {
      manifest_present: true,
      manifest_count: 1,
      lockfile_present: true,
      lockfile_count: 1,
      update_automation_present: false,
      security_policy_present: false,
      pinned_deps: true,
    },
    security_posture: {
      secret_match_count: 0,
      secret_scan_unconfident_files: 0,
      files_secret_scanned: 50,
      secret_scan_truncated: false,
      gitignore_covers_env: true,
      env_example_present: true,
      committed_env_present: false,
      env_check_via_git: true,
    },
    modularity: {
      source_file_count: 50,
      source_dir_count: 8,
      top_level_dir_count: 5,
      max_dir_depth: 4,
      largest_file_loc: 480,
      files_over_500_loc_ratio: 0,
      avg_file_loc: 140,
    },
    architecture: {
      top_level_dir_count: 5,
      source_dir_count: 8,
      source_file_count: 50,
      layer_dir_signal_count: 3,
      monorepo_markers_present: false,
    },
    maintainability: {
      todo_fixme_count: 4,
      todo_per_kloc: 0.57,
      files_over_400_loc_ratio: 0.02,
      avg_file_loc: 140,
      dead_code_hint_count: 1,
      duplicate_candidate_count: 0,
      churn_available: true,
      churn_total_lines: 12000,
      churn_files_touched: 45,
      churn_top10_share: 0.55,
    },
    release_ops: {
      changelog_present: true,
      version_marker_present: true,
      git_tag_count: 8,
      container_present: false,
      orchestration_present: false,
      env_contract_present: true,
      healthcheck_signal: false,
      observability_signal: true,
    },
  };
}

/**
 * A schema-valid `repo_architecture` block: one scorecard with all 10
 * dimensions scored at 80 (maintainability refined 78 -> 80), full verbatim
 * markers, clean paraphrased notes, and a self-consistent portfolio rollup.
 * quality 80, coverage 1, overall round(80 * (0.5 + 0.5 * 1)) == 80, "strong".
 */
export function makeRepoArchitecture(): Record<string, unknown> {
  const scoredAt80 = { status: "scored", score: 80 };
  return {
    repo_rubric_version: "1.0.0",
    scorecards: [
      {
        repo_ref: "b2c3d4e5f60718a9b2c3d4e5",
        primary_language: "typescript",
        size_band: "small",
        quality: 80,
        coverage: 1,
        overall: 80,
        grade: "strong",
        dimensions: {
          documentation: { ...scoredAt80 },
          testing: { ...scoredAt80 },
          ci_automation: { ...scoredAt80 },
          type_safety: { ...scoredAt80 },
          dependency_hygiene: { ...scoredAt80 },
          security_posture: { ...scoredAt80 },
          modularity: { ...scoredAt80 },
          architecture: { ...scoredAt80 },
          maintainability: { status: "scored", score: 80, deterministic_score: 78 },
          release_ops: { ...scoredAt80 },
        },
        markers: makeRepoMarkers(),
        notes: {
          architecture: "Clear layered structure with deliberate boundaries between the entry layer and the domain core, corroborated by three layer signals across eight source directories.",
          maintainability: "Raised two points above the deterministic anchor: churn is concentrated but TODO density stays under one per thousand lines and oversized files are rare.",
        },
      },
    ],
    portfolio: {
      repo_count: 1,
      mean_overall: 80,
      mean_coverage: 1,
      by_dimension: {
        documentation: 80,
        testing: 80,
        ci_automation: 80,
        type_safety: 80,
        dependency_hygiene: 80,
        security_posture: 80,
        modularity: 80,
        architecture: 80,
        maintainability: 80,
        release_ops: 80,
      },
      primary_languages: ["typescript"],
    },
  };
}

/**
 * The happy-path 1.2.0 profile: the base fixture plus the optional
 * repo_architecture block and the advisory blended headline.
 * combined_score 72 == round(0.65 * 68 + 0.35 * 80) — self-consistent with
 * the base fixture's overall_score of 68.
 */
export function makeValidProfileWithRepoArchitecture(): Record<string, unknown> {
  return {
    ...makeValidProfile(),
    repo_architecture: makeRepoArchitecture(),
    combined_score: 72,
    combined_grade: "proficient",
  };
}
