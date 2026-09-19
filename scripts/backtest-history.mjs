#!/usr/bin/env node
/**
 * Backtest history: how many held-out openings the leak-safe backtest could score, run by run.
 *
 * Every `firstseen backtest` persists one backtest_runs row with its target count, its completed (scored) cases, and every
 * skipped target with the runner's own reason. This lists those rows oldest first, so the evaluable-case count can be
 * watched leaving zero as collection accumulates. It reports what the runs recorded and nothing else: no reason is
 * reworded, merged, or recomputed, and eligibility is the runner's alone (docs/backtesting-methodology.md).
 *
 * Reads through PostgREST with the service-role key using plain fetch, so a workflow needs no `npm ci`. Never prints a
 * credential or the project URL. In GitHub Actions the report is also appended to $GITHUB_STEP_SUMMARY.
 *
 * Usage: node scripts/backtest-history.mjs [--limit 24]
 */

import { appendFileSync } from "node:fs";
import { loadDotEnv, requireEnv } from "./lib/db.mjs";

loadDotEnv();

const argv = process.argv.slice(2);
const limitIndex = argv.indexOf("--limit");
const LIMIT = Math.min(500, Math.max(1, Number(limitIndex >= 0 ? argv[limitIndex + 1] : 24) || 24));

const restBase = `${requireEnv("SUPABASE_URL").replace(/\/+$/, "")}/rest/v1`;
const serviceKey = requireEnv("SUPABASE_SERVICE_ROLE_KEY");

async function rest(path) {
  const response = await fetch(`${restBase}/${path}`, {
    headers: { apikey: serviceKey, authorization: `Bearer ${serviceKey}` },
  });
  // The table name is enough to act on; the URL and any response body are not echoed.
  if (!response.ok) throw new Error(`read of ${path.split("?")[0]} failed with HTTP ${response.status}`);
  return response.json();
}

const cell = (value) => String(value ?? "—").replace(/\|/g, "\\|");
const day = (value) => (value ? String(value).slice(0, 16).replace("T", " ") : "—");

/** The newest LIMIT runs, returned oldest first, with each run's skip reasons counted exactly as persisted. */
async function loadRuns() {
  const rows = await rest(
    "backtest_runs?select=id,status,started_at,finished_at,cutoff_days,from_year,to_year,target_count,completed_cases,skipped_cases,model_version,dataset_fingerprint,skipped:calibration_metrics->skipped_targets"
      + `&order=started_at.desc&limit=${LIMIT}`,
  );
  return rows.reverse().map((row) => {
    const reasons = new Map();
    for (const target of Array.isArray(row.skipped) ? row.skipped : []) {
      const reason = target?.reason ?? "(no reason recorded)";
      reasons.set(reason, (reasons.get(reason) ?? 0) + 1);
    }
    return { ...row, reasons: [...reasons].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])) };
  });
}

function report(runs) {
  const lines = ["## Backtest history", ""];
  if (!runs.length) {
    lines.push("No backtest run has been persisted. Run `firstseen backtest` (or dispatch backtest.yml).", "");
    return lines.join("\n");
  }
  const latest = runs.at(-1);
  const previous = runs.length > 1 ? runs.at(-2) : null;
  const change = previous ? latest.completed_cases - previous.completed_cases : null;
  lines.push(
    `Latest run ${day(latest.finished_at)} UTC: **${latest.completed_cases} evaluable case${latest.completed_cases === 1 ? "" : "s"}** of ${latest.target_count} targets`
      + ` at a ${latest.cutoff_days}-day cutoff`
      + (change === null ? "." : `, ${change === 0 ? "unchanged" : change > 0 ? `up ${change}` : `down ${-change}`} from the run before.`),
    "",
    "An evaluable case is a held-out opening the leak-safe backtest could score. Skip reasons are the runner's own words;",
    "they are honest output, not errors. Runs at different cutoffs are not comparable with each other.",
    "",
    "| Finished (UTC) | Status | Cutoff | Years | Targets | Evaluable | Skipped | Skip reasons (count, the runner's words) | Model | Dataset |",
    "|---|---|---:|---|---:|---:|---:|---|---|---|",
  );
  for (const run of runs) {
    const years = run.from_year || run.to_year ? `${run.from_year ?? "…"}–${run.to_year ?? "…"}` : "all";
    const reasons = run.reasons.map(([reason, count]) => `${count} ${reason}`).join("; ") || "none";
    lines.push(
      `| ${day(run.finished_at)} | ${cell(run.status)} | ${cell(run.cutoff_days)} d | ${years} | ${cell(run.target_count)} | **${cell(run.completed_cases)}** | ${cell(run.skipped_cases)} | ${cell(reasons)} | ${cell(run.model_version)} | ${cell(run.dataset_fingerprint?.slice(0, 12))} |`,
    );
  }
  lines.push("");
  return lines.join("\n");
}

async function main() {
  const text = report(await loadRuns());
  process.stdout.write(`${text}\n`);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${text}\n`);
}

main().catch((error) => {
  process.stderr.write(`backtest-history failed: ${error.message}\n`);
  process.exitCode = 1;
});
