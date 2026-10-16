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
// Below this, a run of unskipped companies says nothing: a handful of new companies are all legitimately unchanged-
// never. Above it, zero skips means the skip is broken rather than the corpus being busy.
const ENRICHMENT_SKIP_FLOOR = 10;
// Current collection runs twice a day, so three days without a fetch means a source is not being reached at all.
// This is watched per source rather than per run on purpose: a run can report success while never reaching its tail.
const SOURCE_STALE_AFTER_HOURS = 72;
// Fetched this many times without ever producing a job, a signal, or a capture, and the source is not quiet: it is
// useless. Three, because one or two unproductive fetches is just a company with no openings this week.
const SOURCE_DEAD_AFTER_FETCHES = 3;

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
  // Once a day since 2026-09-23. GitHub starts these schedules up to eight hours late, so the limit is the
  // interval plus that lateness plus the job's own timeout, the way current jobs allows 24 for a 12-hour cron.
  { file: "forecast-regeneration.yml", label: "Forecast regeneration", pipeline: "regeneration", staleHours: 40 },
  { file: "backtest.yml", label: "Backtest (manual)", pipeline: "backtest", staleHours: null },
];

/* ----------------------------------------------------------------------- IO */

const restBase = `${requireEnv("SUPABASE_URL").replace(/\/+$/, "")}/rest/v1`;
const serviceKey = requireEnv("SUPABASE_SERVICE_ROLE_KEY");
const now = Date.now();
const iso = (ms) => new Date(ms).toISOString();

/** The five-character SQLSTATE from a PostgREST error body, and nothing else from it. 57014 is a statement timeout. */
async function sqlState(response) {
  try {
    const code = (await response.json())?.code;
    return typeof code === "string" && /^[0-9A-Z]{5}$/.test(code) ? code : null;
  } catch {
    return null;
  }
}

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
    // The URL and the response body stay out: a PostgREST error body can quote the query and the data. The
    // SQLSTATE goes in, because without it a 500 is unreadable -- `counted_table_totals` answered 500 for
    // thirteen days and the timeout could only be inferred, never confirmed.
    const code = await sqlState(response);
    throw new Error(`read of ${path.split("?")[0]} failed with HTTP ${response.status}${code ? ` (SQLSTATE ${code})` : ""}`);
  }
  return response;
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

// Supabase Pro allows 8 GB and the database goes read-only at the ceiling, which stops collection and every write the
// site makes. 60% is the line: at the growth this corpus has seen that is weeks of warning, not hours, and the check
// costs one catalogue read: `database_size_bytes` is its own function and cannot be slowed by anything else.
const DATABASE_CEILING_BYTES = 8 * 1024 * 1024 * 1024;
const DATABASE_WARN_FRACTION = 0.6;

/**
 * The storage ceiling, read on its own (migration 202608140056).
 *
 * Deliberately not folded into the table counts: the database going read-only stops collection and every write the
 * site makes, so the number that watches for it must not be reachable by anything that can be slow. This is one
 * catalogue read and takes no arguments.
 */
async function databaseSize() {
  const rows = await (await rest("rpc/database_size_bytes")).json();
  const bytes = Number(Array.isArray(rows) ? rows[0] : rows);
  return Number.isFinite(bytes) && bytes > 0 ? bytes : null;
}

/**
 * Every counted table's 24h growth, exact total, and size, in one request (migration 202608140054).
 *
 * This was thirty-eight `count=exact` requests fired together, and it is what took the report down for three nights:
 * the unfiltered half of each pair is a whole-table scan that no index helps, and nineteen of them at once crossed
 * PostgREST's eight seconds. The function scans each table once for both numbers, on one connection, in a fixed order.
 * The database's own size rides along, so the storage tripwire costs no second call.
 */
async function rowsAdded() {
  const since = iso(now - WINDOW_HOURS * HOUR);
  // A GET, not a POST: the function is `stable`, so PostgREST takes its argument in the query string.
  const response = await rest(`rpc/counted_table_totals?p_since=${encodeURIComponent(since)}`);
  const rows = await response.json();
  return rows.map((row) => ({
    table: row.table_name,
    added: Number(row.added),
    // The catalogue's estimate, null where the table has never been analysed. Never presented as a count.
    estimate: row.total === null ? null : Number(row.total),
  }));
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
        (await rest(`sources?select=id,url,adapter,enabled,companies(name)&id=in.(${ids})`)).json(),
      )
    ).map((row) => [row.id, row]),
  );
  // A streak is read from history, and history does not change when a source is turned off. A source nobody collects
  // any more cannot fail again, so reporting it would ask the owner to act on work that will never run: four sources
  // disabled on 2026-09-20 (three closed postings that answer 404 for ever, one page that answers 403) would have
  // warned for the rest of the lookback window. A source that has been deleted outright is dropped for the same
  // reason; only a source still enabled can still be failing.
  return failing
    .map((entry) => ({ ...entry, source: sources.get(entry.sourceId) ?? null }))
    .filter((entry) => entry.source?.enabled)
    .sort((a, b) => b.failed - a.failed);
}

/**
 * Whether enrichment's skip is firing, from the tool calls it records (enrichment_fingerprints.py).
 *
 * A company whose inputs are unchanged since a pass that changed nothing is not re-read, and the skip is recorded on
 * that company's own `enrichment.company` call. It is 70% of a collection run when it does not fire -- 1,782 of 2,535
 * seconds on 2026-10-16 -- and it has now silently stopped working three times: migration 046 hashed the whole row
 * including text and always timed out, 049 fixed that and the skip was still dead because `save_signal_observation`
 * keyed on the raw byte hash, and it is dead again. A skip that fails silently three times is a skip nobody watches.
 */
async function enrichmentSkips() {
  const since = iso(now - WINDOW_HOURS * HOUR);
  const calls = await all(
    `agent_tool_calls?select=id,output_redacted&tool_name=eq.enrichment.company&started_at=gte.${since}&order=started_at.desc,id.desc`,
  );
  const skipped = calls.filter((call) => String(call.output_redacted?.result || "").startsWith("skipped_inputs_unchanged")).length;
  return { considered: calls.length, skipped };
}

/**
 * How long since each enabled source was last fetched.
 *
 * Deliberately not "did the last run succeed". A run that exits cleanly on a budget, or is killed at its timeout,
 * can report success or cancellation while never reaching the end of a stable source order, and the first symptom
 * would be forecasts going stale for companies nobody can name. The oldest last-fetched time catches that whatever
 * the runs say, and a source that has never been fetched counts as the worst case rather than being skipped.
 */
async function sourceFetchAges() {
  const rows = await all("sources?select=id,url,adapter,last_fetched_at&enabled=is.true&order=id.asc");
  const never = rows.filter((row) => !row.last_fetched_at);
  const dated = rows.filter((row) => row.last_fetched_at).sort((a, b) => a.last_fetched_at.localeCompare(b.last_fetched_at));
  const stale = dated.filter((row) => hoursSince(row.last_fetched_at) > SOURCE_STALE_AFTER_HOURS);
  return { total: rows.length, never, stale, oldest: dated[0] ?? null };
}

/**
 * What each source has ever produced, and whether the path rules are refusing it (migration 202608140057).
 *
 * A source returning no jobs looks exactly like a source whose company has no openings today, so "registered but
 * useless" accumulated silently: Point72 had five sources over its careers search and Veeva three that had returned
 * nothing since the day they were registered, and nothing had ever mentioned it. Measured over 439: 90 had been
 * fetched successfully three or more times and produced nothing at all, and 112 were enabled while the recruiting-path
 * rules refused them outright. Every ATS board was productive; all of it was page scraping.
 *
 * Jobs alone would be the wrong test -- a careers page listing no openings can still emit change signals, and an
 * archive source produces captures rather than jobs -- so a source is dead only when it has produced none of them.
 */
async function sourceProduction() {
  // bounded: one row per source, and the function's own SQL orders and caps it.
  const rows = await (await rest("rpc/source_yield")).json();
  const live = rows.filter((row) => row.enabled);
  const dead = live.filter(
    (row) =>
      Number(row.successful_fetches) >= SOURCE_DEAD_AFTER_FETCHES
      && Number(row.jobs) === 0
      && Number(row.signals) === 0
      && Number(row.archive_captures) === 0,
  );
  return { live: live.length, dead, refused: live.filter((row) => row.refused) };
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
  const [tables, runs, failing, abandoned, cursors, actions, skips, fetchAges, production] = await Promise.all([
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
    enrichmentSkips(),
    sourceFetchAges(),
    sourceProduction(),
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
  out("| Table | Added | Rows (estimate) |");
  out("|---|---:|---:|");
  for (const row of tables) out(`| ${row.table} | ${row.added ?? "?"} | ${row.estimate === null ? "not analysed" : `~${row.estimate}`} |`);
  out();
  out("Rows added is exact, from each table's timestamp index. The row count is the catalogue's estimate: an exact");
  out("count of a growing table crossed PostgREST's statement timeout and took this report down for thirteen days");
  out("(migration 202608140056).");
  out();
  const fetches = tables.find((row) => row.table === "source_fetches");
  // Every ingestion records a fetch row, unchanged pages included, so zero added means nothing ran. Judged on the
  // exact `added` figure and a non-empty table; the estimate is never the thing a warning turns on.
  if (fetches && fetches.estimate !== 0 && fetches.added === 0) {
    warn("No source fetches in 24h", "source_fetches gained no rows; current collection did not run or reached no source");
  }

  const sizeBytes = await databaseSize().catch(() => null);
  if (sizeBytes === null) {
    warn("Database size unknown", "database_size_bytes did not answer, so the storage ceiling is unwatched");
  } else {
    const gib = (sizeBytes / 1024 / 1024 / 1024).toFixed(2);
    const share = Math.round((sizeBytes / DATABASE_CEILING_BYTES) * 100);
    out(`### Database size`);
    out();
    out(`${gib} GiB of 8 GiB (${share}%). Warns at ${Math.round(DATABASE_WARN_FRACTION * 100)}%.`);
    out();
    if (sizeBytes > DATABASE_CEILING_BYTES * DATABASE_WARN_FRACTION) {
      warn(
        "Database approaching its ceiling",
        `${gib} GiB of 8 GiB (${share}%); the database goes read-only at the ceiling, which stops collection and every write the site makes`,
      );
    }
  }

  // More than a handful of companies enriched and not one skipped means the skip is dead, which is 70% of the run.
  // Measured on the rig: three consecutive completed passes take it from 165.6 s to 1.1 s and 86.5 MB to 0.2 MB.
  out(`### Enrichment skip (last ${WINDOW_HOURS}h)`);
  out();
  out(`${skips.skipped} of ${skips.considered} companies skipped as unchanged.`);
  out();
  if (skips.considered >= ENRICHMENT_SKIP_FLOOR && skips.skipped === 0) {
    warn(
      "Enrichment skip is not firing",
      `${skips.considered} companies enriched in ${WINDOW_HOURS}h and none was skipped as unchanged; enrichment is `
        + "most of a collection run, and this skip has silently stopped working three times before",
    );
  }

  out(`### Source freshness`);
  out();
  out(
    `${fetchAges.total} enabled sources. Oldest fetch ${ago(fetchAges.oldest?.last_fetched_at)}; `
      + `${fetchAges.stale.length} not fetched in ${SOURCE_STALE_AFTER_HOURS}h; ${fetchAges.never.length} never fetched.`,
  );
  out();
  if (fetchAges.never.length) {
    warn(
      "Sources never fetched",
      `${fetchAges.never.length} enabled source(s) have never been fetched; collection is not reaching them`,
    );
  }
  if (fetchAges.stale.length) {
    warn(
      "Sources not being reached",
      `${fetchAges.stale.length} enabled source(s) have not been fetched in ${SOURCE_STALE_AFTER_HOURS}h, the oldest `
        + `${ago(fetchAges.oldest?.last_fetched_at)}; a run can report success without reaching the end of its list`,
    );
  }

  out(`### Sources that produce nothing`);
  out();
  out(
    `${production.dead.length} of ${production.live} enabled sources have been fetched `
      + `${SOURCE_DEAD_AFTER_FETCHES}+ times and produced no job, signal or capture. `
      + `${production.refused.length} are enabled while the recruiting-path rules refuse them.`,
  );
  out();
  if (production.dead.length) {
    out("| Company | Adapter | Source | Successful fetches |");
    out("|---|---|---|---:|");
    for (const row of production.dead.slice(0, 15)) {
      out(`| ${cell(row.company_name)} | ${cell(row.adapter)} | ${cell(row.url)} | ${row.successful_fetches} |`);
    }
    out();
    warn(
      "Sources producing nothing",
      `${production.dead.length} enabled source(s) have been fetched ${SOURCE_DEAD_AFTER_FETCHES}+ times and have `
        + "never produced a job, a signal or an archive capture; they are paid for on every run",
    );
  }
  if (production.refused.length) {
    warn(
      "Sources enabled but refused",
      `${production.refused.length} enabled source(s) are skipped by the recruiting-path rules on every run; `
        + "something the system refuses to use should not look live in the source list",
    );
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
