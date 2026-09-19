#!/usr/bin/env node
/**
 * Collection health: is scheduled collection actually running, and is it writing?
 *
 * Reports from the system of record, plus GitHub Actions when a token is present:
 *   - rows added per table in the last 24 hours, next to each table's total
 *   - the last successful run of each collection workflow, and the last pass each
 *     pipeline recorded in agent_runs
 *   - sources whose most recent N collection attempts all failed
 *   - runs still marked `running` long after every workflow timeout, which is what
 *     a cancelled or timed-out job leaves behind (it never reaches finish_agent_run)
 *
 * Reads through PostgREST with the service-role key using plain fetch, so the
 * workflow needs no `npm ci`. Never prints a credential or the project URL.
 *
 * In GitHub Actions the markdown report is appended to $GITHUB_STEP_SUMMARY and each
 * problem is also raised as a ::warning:: annotation. Locally it goes to stdout.
 *
 * Exits 0 once the report is produced, warnings included, so it can run after
 * forecast regeneration without failing that job; `--strict` exits 1 on any warning.
 * Exits 1 when the database cannot be read at all.
 *
 * `--alert` also opens or updates the "Collection health" ops-alert issue while any warning
 * stands and closes it when none does (scripts/lib/ops-issues.mjs, docs/operations.md), so a
 * collector that silently stopped writing reaches the owner, not only a job summary.
 *
 * Usage: node scripts/collection-health.mjs [--strict] [--alert]
 */

import { appendFileSync } from "node:fs";
import { loadDotEnv, requireEnv } from "./lib/db.mjs";
import { raiseAlert, resolveAlert } from "./lib/ops-issues.mjs";

loadDotEnv();

const HOUR = 3_600_000;
const WINDOW_HOURS = 24;
const LOOKBACK_DAYS = 14;
const STRICT = process.argv.includes("--strict");
const ALERT = process.argv.includes("--alert");
const FAILURE_STREAK = Math.max(1, Number(process.env.COLLECTION_HEALTH_FAILURE_STREAK || 3));
// Longer than the longest workflow timeout (historical enrichment, 90 minutes).
const ABANDONED_AFTER_HOURS = 3;

/** Tables with an insertion timestamp. Column names verified against supabase/migrations. */
const TABLES = [
  ["companies", "created_at"],
  ["sources", "created_at"],
  ["source_fetches", "fetched_at"],
  ["raw_job_observations", "created_at"],
  ["archive_captures", "created_at"],
  ["canonical_roles", "created_at"],
  ["observation_role_matches", "created_at"],
  ["role_aliases", "created_at"],
  ["historical_opening_events", "created_at"],
  ["signals", "created_at"],
  ["forecasts", "created_at"],
  ["forecast_evidence", "created_at"],
  ["forecast_changes", "created_at"],
  ["readiness_milestones", "created_at"],
  ["inference_decisions", "decided_at"],
  ["model_usage", "created_at"],
  ["agent_runs", "started_at"],
  ["agent_tool_calls", "started_at"],
  ["backtest_runs", "created_at"],
];

/**
 * Each workflow, the pipeline it records, and how old its last success may be before
 * it counts as dead: twice the schedule interval. Backtest is manual, so never stale.
 * current-jobs and historical-enrichment both run `ingest`, which records one
 * `source_ingestion` agent name; a run is historical when it touched a Wayback source.
 */
const WORKFLOWS = [
  { file: "current-jobs.yml", label: "Current jobs", pipeline: "current", staleHours: 24 },
  { file: "career-page-signals.yml", label: "Career page signals", pipeline: "signals", staleHours: 12 },
  { file: "historical-enrichment.yml", label: "Historical enrichment", pipeline: "historical", staleHours: 24 * 14 },
  { file: "forecast-regeneration.yml", label: "Forecast regeneration", pipeline: "regeneration", staleHours: 12 },
  { file: "backtest.yml", label: "Backtest (manual)", pipeline: "backtest", staleHours: null },
];

/* ----------------------------------------------------------------------- IO */

const restBase = `${requireEnv("SUPABASE_URL").replace(/\/+$/, "")}/rest/v1`;
const serviceKey = requireEnv("SUPABASE_SERVICE_ROLE_KEY");
const now = Date.now();
const iso = (ms) => new Date(ms).toISOString();

async function rest(path, { method = "GET", prefer } = {}) {
  const response = await fetch(`${restBase}/${path}`, {
    method,
    headers: {
      apikey: serviceKey,
      authorization: `Bearer ${serviceKey}`,
      ...(prefer ? { prefer } : {}),
    },
  });
  if (!response.ok) {
    // The table name is enough to act on; the URL and any response body are not echoed.
    throw new Error(`read of ${path.split("?")[0]} failed with HTTP ${response.status}`);
  }
  return response;
}

async function count(table, filter) {
  const response = await rest(`${table}?select=*${filter ? `&${filter}` : ""}&limit=1`, {
    method: "HEAD",
    prefer: "count=exact",
  });
  const total = response.headers.get("content-range")?.split("/")[1];
  return total === undefined || total === "*" ? null : Number(total);
}

/**
 * Every row of a query, paged under the PostgREST row cap. The order must end in the unique `id`, or offset paging can
 * repeat one row and skip another between pages; reaching `cap` throws rather than reporting a partial count as whole.
 */
async function all(path, cap = 500_000) {
  if (!/[?&]order=[^&]*\bid(\.(asc|desc))?(&|$)/.test(path)) throw new Error(`paged read of ${path.split("?")[0]} must order by id last`);
  const rows = [];
  for (let offset = 0; offset < cap; offset += 1000) {
    const page = await (await rest(`${path}&limit=1000&offset=${offset}`)).json();
    if (page.length === 0) return rows;
    rows.push(...page);
  }
  throw new Error(`paged read of ${path.split("?")[0]} exceeded ${cap} rows`);
}

async function inBatches(ids, query) {
  const rows = [];
  for (let index = 0; index < ids.length; index += 50) {
    rows.push(...(await query(ids.slice(index, index + 50).join(","))));
  }
  return rows;
}

async function actionsRun(file, query = "") {
  const token = process.env.GITHUB_TOKEN;
  const repository = process.env.GITHUB_REPOSITORY;
  if (!token || !repository) return { unavailable: "no GITHUB_TOKEN" };
  const response = await fetch(
    `https://api.github.com/repos/${repository}/actions/workflows/${file}/runs?per_page=1&exclude_pull_requests=true${query}`,
    {
      headers: {
        authorization: `Bearer ${token}`,
        accept: "application/vnd.github+json",
        "x-github-api-version": "2022-11-28",
      },
    },
  );
  if (!response.ok) return { unavailable: `GitHub API HTTP ${response.status}` };
  return { run: (await response.json()).workflow_runs?.[0] ?? null };
}

/* ------------------------------------------------------------------ helpers */

const warnings = [];
const warn = (title, message) => warnings.push({ title, message });

function ago(value) {
  if (!value) return "never";
  const hours = (now - new Date(value).getTime()) / HOUR;
  if (hours < 1) return `${Math.max(0, Math.round(hours * 60))}m ago`;
  if (hours < 48) return `${Math.round(hours)}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

const hoursSince = (value) => (value ? (now - new Date(value).getTime()) / HOUR : Infinity);
const cell = (value) => String(value ?? "—").replace(/\|/g, "\\|");

/* ------------------------------------------------------------------ queries */

async function rowsAdded() {
  const since = iso(now - WINDOW_HOURS * HOUR);
  return Promise.all(
    TABLES.map(async ([table, column]) => ({
      table,
      added: await count(table, `${column}=gte.${since}`),
      total: await count(table),
    })),
  );
}

async function pipelineRuns() {
  const select = "select=id,status,started_at,finished_at";
  // The 200 newest ingestion runs, one request under the row cap: the report is about recent runs, not all of them.
  const ingestion = await (await rest(`agent_runs?${select}&agent_name=eq.source_ingestion&order=started_at.desc,id.desc&limit=200`)).json();
  const historicalIds = new Set(
    (
      await inBatches(ingestion.map((run) => run.id), async (ids) =>
        (await rest(`agent_tool_calls?select=agent_run_id&tool_name=eq.source_adapter.wayback&agent_run_id=in.(${ids})`)).json(),
      )
    ).map((row) => row.agent_run_id),
  );
  const latest = async (name) =>
    (await rest(`agent_runs?${select}&agent_name=eq.${name}&order=started_at.desc,id.desc&limit=50`)).json();
  return {
    current: ingestion.filter((run) => !historicalIds.has(run.id)),
    historical: ingestion.filter((run) => historicalIds.has(run.id)),
    signals: await latest("recruiting_signal_ingestion"),
    regeneration: await latest("scheduled_forecast_regeneration"),
    backtest: await (await rest("backtest_runs?select=status,started_at,finished_at&order=started_at.desc&limit=50")).json(),
  };
}

async function failingSources() {
  const since = iso(now - LOOKBACK_DAYS * 24 * HOUR);
  const calls = [];
  for (const [family, prefix] of [["collection", "source_adapter"], ["signals", "recruiting_signal"]]) {
    const rows = await all(
      `agent_tool_calls?select=tool_name,status,started_at,input_redacted,error&tool_name=like.${prefix}.*&started_at=gte.${since}&order=started_at.desc,id.desc`,
    );
    calls.push(...rows.map((row) => ({ ...row, family })));
  }

  // Calls arrive newest first, so a streak is the run of `failed` before anything else.
  const streaks = new Map();
  for (const call of calls) {
    const sourceId = call.input_redacted?.source_id;
    if (!sourceId || call.status === "running") continue;
    const key = `${call.family}:${sourceId}`;
    const entry = streaks.get(key) ?? { family: call.family, sourceId, failed: 0, open: true, lastError: null, lastAt: call.started_at };
    if (entry.open) {
      if (call.status === "failed") {
        entry.failed += 1;
        entry.lastError ??= call.error?.type ?? null;
      } else {
        entry.open = false;
      }
    }
    streaks.set(key, entry);
  }
  const failing = [...streaks.values()].filter((entry) => entry.failed >= FAILURE_STREAK);
  const sources = new Map(
    (
      await inBatches([...new Set(failing.map((entry) => entry.sourceId))], async (ids) =>
        (await rest(`sources?select=id,url,adapter,companies(name)&id=in.(${ids})`)).json(),
      )
    ).map((row) => [row.id, row]),
  );
  return failing
    .map((entry) => ({ ...entry, source: sources.get(entry.sourceId) ?? null }))
    .sort((a, b) => b.failed - a.failed);
}

async function abandonedRuns() {
  return (
    await rest(
      `agent_runs?select=agent_name,started_at&status=eq.running&started_at=lt.${iso(now - ABANDONED_AFTER_HOURS * HOUR)}&order=started_at.desc&limit=50`,
    )
  ).json();
}

async function checkpoints() {
  return (await rest("collection_checkpoints?select=pipeline,cursor_at,last_status,updated_at")).json();
}

/* ------------------------------------------------------------------- report */

async function main() {
  const [tables, runs, failing, abandoned, cursors, actions] = await Promise.all([
    rowsAdded(),
    pipelineRuns(),
    failingSources(),
    abandonedRuns(),
    checkpoints(),
    Promise.all(
      WORKFLOWS.map(async (workflow) => ({
        latest: await actionsRun(workflow.file),
        success: await actionsRun(workflow.file, "&status=success"),
      })),
    ),
  ]);

  const lines = [];
  const out = (line = "") => lines.push(line);

  out("## Collection health");
  out();
  out(`Generated ${iso(now)}. Rows window ${WINDOW_HOURS}h; failure streak threshold ${FAILURE_STREAK}.`);
  out();

  out("### Workflows");
  out();
  out("| Workflow | Last success (Actions) | Latest run (Actions) | Last completed pass (DB) | Latest pass (DB) |");
  out("|---|---|---|---|---|");
  WORKFLOWS.forEach((workflow, index) => {
    const { latest, success } = actions[index];
    const history = runs[workflow.pipeline];
    const completed = history.find((run) => run.finished_at && (run.status === "succeeded" || run.status === "partial"));
    const newest = history[0];
    const actionsSuccess = success.unavailable
      ? `n/a (${success.unavailable})`
      : success.run ? `${ago(success.run.created_at)}` : "never";
    const actionsLatest = latest.unavailable
      ? "n/a"
      : latest.run ? `${latest.run.status === "completed" ? latest.run.conclusion : latest.run.status}, ${ago(latest.run.created_at)}` : "never";
    out(
      `| ${workflow.label} | ${cell(actionsSuccess)} | ${cell(actionsLatest)} | ${completed ? `${completed.status}, ${ago(completed.finished_at)}` : "never"} | ${newest ? `${newest.status}, ${ago(newest.started_at)}` : "never"} |`,
    );

    if (workflow.staleHours === null) return;
    // Prefer the Actions record when it is available; otherwise judge by the database.
    const lastGood = success.unavailable ? completed?.finished_at : success.run?.created_at;
    if (hoursSince(lastGood) > workflow.staleHours) {
      warn(
        `${workflow.label} looks stalled`,
        success.unavailable
          ? `no completed pass (succeeded or partial) recorded in agent_runs in the last ${workflow.staleHours}h (last: ${ago(lastGood)})`
          : `no successful workflow run in the last ${workflow.staleHours}h (last: ${ago(lastGood)})`,
      );
    }
  });
  out();

  if (cursors.length) {
    out("| Checkpoint | Cursor | Last status | Updated |");
    out("|---|---|---|---|");
    for (const row of cursors) out(`| ${cell(row.pipeline)} | ${cell(row.cursor_at)} | ${cell(row.last_status)} | ${ago(row.updated_at)} |`);
    out();
  }

  out(`### Rows added in the last ${WINDOW_HOURS}h`);
  out();
  out("| Table | Added | Total |");
  out("|---|---:|---:|");
  for (const row of tables) out(`| ${row.table} | ${row.added ?? "?"} | ${row.total ?? "?"} |`);
  out();
  const fetches = tables.find((row) => row.table === "source_fetches");
  // Every ingestion records a fetch row, unchanged pages included, so zero means nothing ran.
  if (fetches && fetches.total > 0 && fetches.added === 0) {
    warn("No source fetches in 24h", "source_fetches gained no rows; current collection did not run or reached no source");
  }

  out(`### Sources failing ${FAILURE_STREAK}+ consecutive attempts (last ${LOOKBACK_DAYS} days)`);
  out();
  if (!failing.length) {
    out("None.");
  } else {
    out("| Kind | Company | Adapter | Source | Consecutive failures | Last error | Last attempt |");
    out("|---|---|---|---|---:|---|---|");
    for (const entry of failing) {
      const source = entry.source;
      out(
        `| ${entry.family} | ${cell(source?.companies?.name)} | ${cell(source?.adapter)} | ${cell(source?.url ?? entry.sourceId)} | ${entry.failed} | ${cell(entry.lastError)} | ${ago(entry.lastAt)} |`,
      );
    }
    for (const entry of failing.slice(0, 10)) {
      warn(
        "Source failing repeatedly",
        `${entry.source?.companies?.name ?? "unknown company"} ${entry.source?.adapter ?? ""} source has failed ${entry.failed} consecutive ${entry.family} attempts`,
      );
    }
  }
  out();

  out(`### Runs still marked running after ${ABANDONED_AFTER_HOURS}h`);
  out();
  if (!abandoned.length) {
    out("None.");
  } else {
    out("A cancelled or timed-out job never reaches `finish_agent_run`. Successful work before the cut is committed; checkpoints did not advance.");
    out();
    out("| Agent | Started |");
    out("|---|---|");
    for (const run of abandoned) out(`| ${cell(run.agent_name)} | ${ago(run.started_at)} |`);
    warn("Unfinished runs", `${abandoned.length} agent run(s) never finished; the newest started ${ago(abandoned[0].started_at)}`);
  }
  out();

  out(`### Warnings: ${warnings.length}`);
  out();
  for (const item of warnings) out(`- **${item.title}**: ${item.message}`);
  out();

  const report = `${lines.join("\n")}\n`;
  process.stdout.write(report);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, report);
  if (process.env.GITHUB_ACTIONS === "true") {
    const escape = (value) => value.replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A");
    for (const item of warnings) process.stdout.write(`::warning title=${escape(item.title)}::${escape(item.message)}\n`);
  }
  if (ALERT) {
    const outcome = warnings.length
      ? await raiseAlert({
          key: "collection-health",
          title: `Ops alert: collection health, ${warnings.length} warning${warnings.length === 1 ? "" : "s"}`,
          summary: `**Collection health has ${warnings.length} warning${warnings.length === 1 ? "" : "s"}.**`,
          details: warnings.map((item) => `- **${item.title}**: ${item.message}`).join("\n"),
          // Which problems stand, not their counts or ages, decides whether this notifies again.
          state: warnings.map((item) => `${item.title}:${item.message.replace(/\d+/g, "#")}`).sort().join("|"),
        })
      : await resolveAlert({ key: "collection-health", summary: "collection health reports no warnings." });
    process.stdout.write(`collection-health: alert ${outcome}\n`);
  }
  if (STRICT && warnings.length) process.exitCode = 1;
}

main().catch((error) => {
  process.stderr.write(`collection-health failed: ${error.message}\n`);
  if (process.env.GITHUB_ACTIONS === "true") {
    process.stdout.write(`::error title=Collection health unavailable::${error.message}\n`);
  }
  process.exitCode = 1;
});
