#!/usr/bin/env node
/**
 * Production health check: is each deployed service up, and is scheduled work still happening?
 *
 * Probes, each reported as ok, FAILING, or not configured (never silently passed or failed when its inputs are unset):
 *   - Web app       GET  $FIRSTSEEN_WEB_URL/api/health          expects 200 {"service":"1stseen-web","status":"ok"}
 *   - Agent API     GET  $FIRSTSEEN_AGENT_API_URL/health        expects 200 {"status":"ok"}; allows a cold start
 *   - Database      HEAD $SUPABASE_URL/rest/v1/companies        with the service-role key; expects 200/206
 *   - Schedules     each scheduled workflow's last successful run is recent enough (GitHub API, `actions: read`)
 *   - Worker errors Cloudflare's GraphQL analytics for the Worker over the last 24 h, with requests and CPU for the
 *                   quota table in docs/operations.md (needs CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_ANALYTICS_TOKEN)
 *
 * With --alert, a FAILING check opens or updates the one "Production health" ops-alert issue and an all-clear closes it
 * (scripts/lib/ops-issues.mjs). The report goes to stdout and $GITHUB_STEP_SUMMARY; not-configured checks are raised as
 * ::warning:: annotations. Exits 0 once the report and any alert are delivered; 1 when it cannot report at all.
 *
 * Never prints or posts a credential, the Supabase project URL, or a response body.
 *
 * Usage: node scripts/ops-health.mjs [--alert]
 */

import { appendFileSync } from "node:fs";
import { loadDotEnv } from "./lib/db.mjs";
import { raiseAlert, redact, resolveAlert } from "./lib/ops-issues.mjs";

loadDotEnv();

const ALERT = process.argv.includes("--alert");
const HOUR = 3_600_000;
const env = process.env;

/** Scheduled workflows and how old their last success may be: their interval, plus the longest timeout, plus slack. */
const SCHEDULED = [
  { file: "current-jobs.yml", label: "Current job collection", staleHours: 19 },
  { file: "career-page-signals.yml", label: "Career page signals", staleHours: 13 },
  { file: "forecast-regeneration.yml", label: "Forecast regeneration", staleHours: 13 },
  { file: "historical-enrichment.yml", label: "Historical enrichment", staleHours: 24 * 8 },
  { file: "backup-corpus.yml", label: "Corpus backup", staleHours: 24 * 8 },
  { file: "backtest.yml", label: "Monthly backtest", staleHours: 24 * 33 },
];

const OK = "ok";
const FAILING = "FAILING";
const NOT_CONFIGURED = "not configured";

const bare = (value) => (value ?? "").trim().replace(/\/+$/, "");

async function timed(url, init, timeoutMs) {
  const started = performance.now();
  try {
    const response = await fetch(url, { ...init, redirect: "manual", signal: AbortSignal.timeout(timeoutMs) });
    return { response, ms: Math.round(performance.now() - started) };
  } catch (error) {
    const reason = error?.name === "TimeoutError" ? `no response in ${timeoutMs / 1000} s` : "connection failed";
    return { error: reason, ms: Math.round(performance.now() - started) };
  }
}

async function jsonHealth(name, base, path, expected, timeoutMs, variable) {
  if (!base) return { name, status: NOT_CONFIGURED, detail: `set the repository variable ${variable}` };
  const { response, error, ms } = await timed(`${base}${path}`, { headers: { accept: "application/json" } }, timeoutMs);
  if (error) return { name, status: FAILING, detail: `${path}: ${error}` };
  let body = null;
  try {
    body = await response.json();
  } catch {
    // Not JSON: reported by status below, and the body itself is never echoed.
  }
  const matches = body && Object.entries(expected).every(([key, value]) => body[key] === value);
  if (response.status !== 200 || !matches) {
    return { name, status: FAILING, detail: `${path}: HTTP ${response.status}${response.status === 200 ? ", unexpected body" : ""} (${ms} ms)` };
  }
  return { name, status: OK, detail: `${path}: HTTP 200 in ${ms} ms${body.version ? `, version ${body.version}` : ""}` };
}

function checkWeb() {
  return jsonHealth("Web app (Cloudflare Worker)", bare(process.env.FIRSTSEEN_WEB_URL), "/api/health", { service: "1stseen-web", status: "ok" }, 15_000, "FIRSTSEEN_WEB_URL");
}

function checkAgent() {
  // min-instances=0, so the first request after a quiet period starts an instance.
  return jsonHealth("Agent API (Cloud Run)", bare(process.env.FIRSTSEEN_AGENT_API_URL), "/health", { status: "ok" }, 45_000, "FIRSTSEEN_AGENT_API_URL");
}

async function checkDatabase() {
  const name = "Database (Supabase PostgREST)";
  const base = bare(process.env.SUPABASE_URL);
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!base || !key) return { name, status: NOT_CONFIGURED, detail: "set the repository secrets SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY" };
  const { response, error, ms } = await timed(
    `${base}/rest/v1/companies?select=id&limit=1`,
    { method: "HEAD", headers: { apikey: key, authorization: `Bearer ${key}` } },
    20_000,
  );
  if (error) return { name, status: FAILING, detail: `companies read: ${error} (a paused free project refuses connections)` };
  if (![200, 206].includes(response.status)) return { name, status: FAILING, detail: `companies read: HTTP ${response.status} (${ms} ms)` };
  return { name, status: OK, detail: `companies read: HTTP ${response.status} in ${ms} ms` };
}

async function checkSchedules() {
  const name = "Scheduled workflows";
  if (!env.GITHUB_TOKEN || !env.GITHUB_REPOSITORY) return { name, status: NOT_CONFIGURED, detail: "runs in GitHub Actions only (needs GITHUB_TOKEN)" };
  const api = (env.GITHUB_API_URL || "https://api.github.com").replace(/\/+$/, "");
  const headers = { authorization: `Bearer ${env.GITHUB_TOKEN}`, accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28" };
  const stale = [];
  const fresh = [];
  const unstarted = [];
  for (const workflow of SCHEDULED) {
    const base = `${api}/repos/${env.GITHUB_REPOSITORY}/actions/workflows/${workflow.file}/runs?per_page=1&exclude_pull_requests=true`;
    const [any, success] = await Promise.all([
      fetch(base, { headers }),
      fetch(`${base}&status=success`, { headers }),
    ]);
    if (any.status === 404) {
      unstarted.push(`${workflow.label} (not on the default branch)`);
      continue;
    }
    if (!any.ok || !success.ok) throw new Error(`GitHub API HTTP ${any.ok ? success.status : any.status} reading ${workflow.file} runs`);
    const latest = (await any.json()).workflow_runs?.[0];
    const lastSuccess = (await success.json()).workflow_runs?.[0];
    if (!latest) {
      unstarted.push(`${workflow.label} (never run)`);
      continue;
    }
    const hours = lastSuccess ? (Date.now() - Date.parse(lastSuccess.created_at)) / HOUR : Infinity;
    if (hours > workflow.staleHours) {
      stale.push(`${workflow.label}: ${lastSuccess ? `last success ${Math.round(hours)} h ago` : "has never succeeded"} (limit ${workflow.staleHours} h)`);
    } else {
      fresh.push(`${workflow.label} ${Math.round(hours)} h`);
    }
  }
  if (stale.length) return { name, status: FAILING, detail: stale.join("; "), state: stale.map((line) => line.split(":")[0]).join(",") };
  if (!fresh.length) return { name, status: NOT_CONFIGURED, detail: `no scheduled workflow has run yet: ${unstarted.join("; ")}` };
  return { name, status: OK, detail: `last success: ${fresh.join(", ")}${unstarted.length ? `; not started: ${unstarted.join(", ")}` : ""}` };
}

const WORKER_QUERY = `query WorkerHealth($account: string, $script: string, $since: string, $until: string) {
  viewer {
    accounts(filter: { accountTag: $account }) {
      workersInvocationsAdaptive(limit: 50, filter: { scriptName: $script, datetime_geq: $since, datetime_leq: $until }) {
        dimensions { status }
        sum { requests errors subrequests }
        quantiles { cpuTimeP50 cpuTimeP99 }
      }
    }
  }
}`;

async function checkWorkerErrors() {
  const name = "Worker errors, last 24 h (Cloudflare analytics)";
  const account = (process.env.CLOUDFLARE_ACCOUNT_ID ?? "").trim();
  const token = process.env.CLOUDFLARE_ANALYTICS_TOKEN;
  if (!account || !token) {
    return { name, status: NOT_CONFIGURED, detail: "set the repository variable CLOUDFLARE_ACCOUNT_ID and secret CLOUDFLARE_ANALYTICS_TOKEN (Account Analytics: Read)" };
  }
  const until = new Date();
  const since = new Date(until.getTime() - 24 * HOUR);
  const { response, error } = await timed(
    "https://api.cloudflare.com/client/v4/graphql",
    {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({
        query: WORKER_QUERY,
        variables: { account, script: "firstseen-web", since: since.toISOString(), until: until.toISOString() },
      }),
    },
    20_000,
  );
  if (error) return { name, status: FAILING, detail: `analytics API: ${error}` };
  const payload = await response.json().catch(() => null);
  if (!response.ok || !payload || payload.errors?.length) {
    // Cloudflare's error messages name fields, not credentials, but only the first one's code-level text is kept.
    const reason = payload?.errors?.[0]?.message ? String(payload.errors[0].message).slice(0, 160) : `HTTP ${response.status}`;
    return { name, status: FAILING, detail: `analytics query refused: ${reason}` };
  }
  const groups = payload.data?.viewer?.accounts?.[0]?.workersInvocationsAdaptive ?? [];
  const requests = groups.reduce((sum, group) => sum + (group.sum?.requests ?? 0), 0);
  const errors = groups.reduce((sum, group) => sum + (group.sum?.errors ?? 0), 0);
  const byStatus = groups
    .filter((group) => group.dimensions?.status && group.dimensions.status !== "success")
    .map((group) => `${group.dimensions.status} ${group.sum?.requests ?? 0}`);
  // cpuTime quantiles are microseconds.
  const cpu = groups.find((group) => group.dimensions?.status === "success")?.quantiles;
  const usage = `${requests} requests, CPU p50 ${cpu ? (cpu.cpuTimeP50 / 1000).toFixed(1) : "?"} ms / p99 ${cpu ? (cpu.cpuTimeP99 / 1000).toFixed(1) : "?"} ms`;
  if (errors > 0) {
    return {
      name,
      status: FAILING,
      detail: `${errors} invocation error${errors === 1 ? "" : "s"} (${byStatus.join(", ") || "status not reported"}); ${usage}`,
      state: byStatus.map((entry) => entry.split(" ")[0]).sort().join(","),
    };
  }
  return { name, status: OK, detail: `no invocation errors; ${usage}` };
}

function report(results) {
  const lines = [
    "## Production health",
    "",
    `Checked ${new Date().toISOString()}.`,
    "",
    "| Check | Status | Detail |",
    "|---|---|---|",
    ...results.map((result) => `| ${result.name} | ${result.status === FAILING ? "**FAILING**" : result.status} | ${String(result.detail).replace(/\|/g, "\\|")} |`),
    "",
  ];
  return redact(lines.join("\n"));
}

async function main() {
  const results = await Promise.all([checkWeb(), checkAgent(), checkDatabase(), checkSchedules(), checkWorkerErrors()]);
  const text = report(results);
  process.stdout.write(`${text}\n`);
  if (env.GITHUB_STEP_SUMMARY) appendFileSync(env.GITHUB_STEP_SUMMARY, `${text}\n`);
  if (env.GITHUB_ACTIONS === "true") {
    for (const result of results.filter((item) => item.status === NOT_CONFIGURED)) {
      process.stdout.write(`::warning title=${result.name} not configured::${redact(result.detail)}\n`);
    }
  }

  if (!ALERT) return;
  const failing = results.filter((result) => result.status === FAILING);
  if (failing.length) {
    const outcome = await raiseAlert({
      key: "health",
      title: `Ops alert: ${failing.map((result) => result.name.split(" (")[0]).join(", ")} failing`,
      summary: `**${failing.length} production health check${failing.length === 1 ? "" : "s"} failing.**`,
      details: text,
      // What is failing, not the numbers in it, decides whether this notifies again.
      state: failing.map((result) => `${result.name}:${result.state ?? ""}`).join("|"),
    });
    process.stdout.write(`ops-health: alert ${outcome}\n`);
  } else {
    const outcome = await resolveAlert({ key: "health", summary: "every configured production health check passes." });
    process.stdout.write(`ops-health: ${outcome === "resolved" ? "closed the open alert" : "nothing to alert"}\n`);
  }
}

main().catch((error) => {
  process.stderr.write(`ops-health failed: ${redact(error.message)}\n`);
  if (env.GITHUB_ACTIONS === "true") process.stdout.write(`::error title=Health check could not run::${redact(error.message)}\n`);
  process.exitCode = 1;
});
