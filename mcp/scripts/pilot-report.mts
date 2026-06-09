/**
 * Read-only parity pilot report (counts only). Mirrors the methodology in
 * docs/paxel-parity-pilot.md: no transcript text, paths, filenames, remotes,
 * commit hashes, authors, or code ever print — only aggregate counts.
 *
 * Usage: pnpm -C mcp exec tsx scripts/pilot-report.mts [projectPath]
 *   VIBER_PILOT_MAX_SESSIONS=50 caps the episode path like the original pilot.
 */
import { buildActualMetrics, buildEpisodeCandidates, gitAggregateMetrics } from "../src/extractors.ts";

const projectPath = process.argv[2] ?? process.cwd();
const maxSessions = Number(process.env.VIBER_PILOT_MAX_SESSIONS ?? 50);

const startedAt = Date.now();
const bundle = buildEpisodeCandidates({ projectPath, maxSessions });
const episodeMs = Date.now() - startedAt;

console.log(`# Parity pilot report (${new Date().toISOString().slice(0, 10)})`);
console.log(`\nCap: ${maxSessions} sessions per tool. Episode path: ${episodeMs}ms.`);
console.log(`\n| Tool | Sessions | Messages | Episode Candidates | Dropped Reasons |`);
console.log(`|---|---:|---:|---:|---|`);
for (const tool of ["claude", "codex", "cursor"] as const) {
  const coverage = bundle.coverage.tools[tool];
  const dropped = Object.entries(coverage.dropped_reasons)
    .map(([key, count]) => `\`${key}=${count}\``)
    .join(", ");
  console.log(
    `| ${tool} | ${coverage.session_count} | ${coverage.message_count} | ${coverage.episode_candidate_count} | ${dropped || "none"} |`,
  );
}
console.log(
  `| Total | ${bundle.coverage.totals.session_count} | ${bundle.coverage.totals.message_count} | ${bundle.coverage.totals.episode_candidate_count} | |`,
);

console.log(`\nManifest:`);
console.log(`- session_count=${bundle.analysis_manifest.session_count}`);
console.log(`- episode_count=${bundle.analysis_manifest.episode_count}`);
console.log(`- decision_count=${bundle.decisions.length}`);
console.log(`- active_days=${bundle.analysis_manifest.time_window?.active_days ?? 0}`);
console.log(`- subagent_session_metadata=${bundle.session_metadata.filter((session) => session.is_subagent).length}`);

const gitStart = Date.now();
const git = gitAggregateMetrics({ projectPath });
console.log(`\nGit aggregates (${Date.now() - gitStart}ms):`);
if (git.git_metrics) {
  console.log(`- commit_count=${git.git_metrics.commit_count}`);
  console.log(`- lines_added=${git.git_metrics.lines_added}`);
  console.log(`- files_changed_count=${git.git_metrics.files_changed_count}`);
  console.log(`- active_days=${git.git_metrics.active_days}`);
  console.log(`- busiest_hour_utc=${git.git_metrics.velocity?.busiest_hour_utc}`);
  console.log(`- weekend_share=${git.git_metrics.velocity?.weekend_share?.toFixed(4)}`);
}
console.log(`- warnings: ${git.warnings.join(", ") || "none"}`);

const metricsStart = Date.now();
const metrics = buildActualMetrics({ projectPath });
console.log(`\nVibe metrics (uncapped, ${Date.now() - metricsStart}ms):`);
const vibe = metrics.vibe_metrics;
console.log(`- total_vibe_agent_hours=${vibe.total_vibe_agent_hours}`);
console.log(`- total_active_calendar_hours=${vibe.total_active_calendar_hours}`);
console.log(`- total_tokens=${vibe.total_tokens}`);
console.log(`- total_vibe_loc=${vibe.total_vibe_loc ?? 0}`);
for (const tool of ["claude", "codex", "cursor"] as const) {
  const coverage = vibe.metrics_coverage.tools[tool];
  console.log(
    `- ${tool}: sessions=${coverage.session_count} events=${coverage.timestamped_event_count} active_hours=${coverage.active_hours} token_source=${coverage.token_source} tokens=${coverage.total_tokens ?? 0}`,
  );
}
