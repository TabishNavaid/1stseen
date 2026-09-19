#!/usr/bin/env node
/**
 * Measure what server-rendering a page reads from Supabase.
 *
 * Runs the built Worker (apps/web/dist/server/index.js) in-process, the same way
 * apps/web/tests/rendered-html.test.mjs does, and wraps fetch to record every
 * Supabase request a render makes: table, rows returned, response bytes, and time.
 * Nothing in the app is changed, so the numbers describe the production code path.
 * Network time is whatever the host running this script sees; run it near the
 * database for server-side numbers.
 *
 * Needs `npm run build` first, plus SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY from
 * the environment or .env. Prints neither.
 *
 * Usage:
 *   node scripts/measure-render.mjs [--runs 3] [path ...]
 *
 * With no paths: the dashboard, Forecast Replay, and one role page with a stored
 * forecast and one without.
 */

import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { ROOT, loadDotEnv, requireEnv } from "./lib/db.mjs";

loadDotEnv();

const argv = process.argv.slice(2);
const runsFlag = argv.indexOf("--runs");
const RUNS = runsFlag >= 0 ? Math.max(1, Number(argv[runsFlag + 1])) : 3;
const explicitPaths = argv.filter((value, index) => !value.startsWith("--") && argv[index - 1] !== "--runs");

const supabaseUrl = requireEnv("SUPABASE_URL").replace(/\/+$/, "");
const serviceKey = requireEnv("SUPABASE_SERVICE_ROLE_KEY");
const workerPath = resolve(ROOT, "apps/web/dist/server/index.js");
if (!existsSync(workerPath)) {
  process.stderr.write("apps/web/dist/server/index.js is missing. Run `npm run build` first.\n");
  process.exit(1);
}

const realFetch = globalThis.fetch;
let requests = null;

globalThis.fetch = async (input, init) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  if (!requests || !url.startsWith(supabaseUrl)) return realFetch(input, init);
  const method = (init?.method ?? (typeof input === "object" && "method" in input ? input.method : "GET")).toUpperCase();
  const started = performance.now();
  const response = await realFetch(input, init);
  const body = await response.clone().arrayBuffer();
  const elapsed = performance.now() - started;
  // Rows from PostgREST's Content-Range ("0-999/*"), not by re-parsing the body,
  // so the harness adds as little CPU as possible to the render it is measuring.
  let rows = 0;
  const range = /^(\d+)-(\d+)\//.exec(response.headers.get("content-range") ?? "");
  if (method !== "HEAD" && range) rows = Number(range[2]) - Number(range[1]) + 1;
  const path = new URL(url).pathname.replace(/^\/rest\/v1\//, "").replace(/^\/auth\/v1\//, "auth/");
  requests.push({ table: method === "HEAD" ? `${path} (count)` : path, status: response.status, rows, bytes: body.byteLength, ms: elapsed });
  return response;
};

async function pickRoles() {
  const headers = { apikey: serviceKey, authorization: `Bearer ${serviceKey}` };
  const get = async (query) => {
    const response = await realFetch(`${supabaseUrl}/rest/v1/${query}`, { headers });
    if (!response.ok) throw new Error(`role lookup failed with HTTP ${response.status}`);
    return response.json();
  };
  // Only an active, in-scope role has a page (migrations 202608140032 and 202608140036). The role without a forecast is
  // found by an anti-join in Postgres, not by comparing two lists that the row cap could each cut at 1000.
  const shown = "scope_status=eq.in_scope&active=eq.true";
  const [withForecast] = await get(`canonical_roles?select=id,forecasts!inner(id)&${shown}&order=created_at.desc,id&limit=1`);
  const [withoutForecast] = await get(`canonical_roles?select=id,forecasts(id)&forecasts=is.null&${shown}&order=created_at.desc,id&limit=1`);
  return [
    withForecast && `/roles/${withForecast.id}`,
    withoutForecast && `/roles/${withoutForecast.id}`,
  ].filter(Boolean);
}

const { default: worker } = await import(pathToFileURL(workerPath).href);
const env = { ASSETS: { fetch: async () => new Response("Not found", { status: 404 }) } };
const ctx = { waitUntil() {}, passThroughOnException() {} };

async function renderOnce(path) {
  requests = [];
  const cpuStart = process.cpuUsage();
  const started = performance.now();
  const response = await worker.fetch(new Request(`http://localhost${path}`, { headers: { accept: "text/html" } }), env, ctx);
  const firstByte = performance.now() - started;
  const html = await response.text();
  const total = performance.now() - started;
  const cpu = process.cpuUsage(cpuStart);
  const captured = requests;
  requests = null;
  // CPU time of this process across the render: JSON decoding, derivation, and React
  // rendering, excluding time spent waiting on the network. Cloudflare bills and limits
  // Workers on CPU time, so this is the number to compare with the plan's limit.
  return { status: response.status, firstByte, total, cpuMs: (cpu.user + cpu.system) / 1000, htmlBytes: Buffer.byteLength(html), captured };
}

const kib = (bytes) => `${(bytes / 1024).toFixed(1)} KiB`;
const ms = (value) => `${Math.round(value)} ms`;
const median = (values) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
};

const paths = explicitPaths.length ? explicitPaths : ["/", "/replay", ...(await pickRoles())];
process.stdout.write(`\nRender cost — ${new Date().toISOString()} — ${RUNS} run(s) per path, first run includes module warm-up\n\n`);

for (const path of paths) {
  const results = [];
  for (let run = 0; run < RUNS; run += 1) results.push(await renderOnce(path));
  const last = results.at(-1);
  const rowsTotal = last.captured.reduce((sum, item) => sum + item.rows, 0);
  const bytesTotal = last.captured.reduce((sum, item) => sum + item.bytes, 0);
  const warm = results.length > 1 ? results.slice(1) : results;

  process.stdout.write(`### ${path.replace(/[0-9a-f-]{36}/, "<role-id>")} (HTTP ${last.status})\n\n`);
  process.stdout.write("| Measure | Value |\n|---|---|\n");
  process.stdout.write(`| Wall time, each run | ${results.map((item) => ms(item.total)).join(", ")} |\n`);
  process.stdout.write(`| Median warm wall time / first byte | ${ms(median(warm.map((item) => item.total)))} / ${ms(median(warm.map((item) => item.firstByte)))} |\n`);
  process.stdout.write(`| CPU time, each run | ${results.map((item) => ms(item.cpuMs)).join(", ")} |\n`);
  process.stdout.write(`| Supabase requests | ${last.captured.length} |\n`);
  process.stdout.write(`| Rows read | ${rowsTotal.toLocaleString("en-US")} |\n`);
  process.stdout.write(`| Response bytes read | ${kib(bytesTotal)} |\n`);
  process.stdout.write(`| HTML sent | ${kib(last.htmlBytes)} |\n\n`);

  const byTable = new Map();
  for (const item of last.captured) {
    const entry = byTable.get(item.table) ?? { requests: 0, rows: 0, bytes: 0, ms: 0 };
    entry.requests += 1;
    entry.rows += item.rows;
    entry.bytes += item.bytes;
    entry.ms += item.ms;
    byTable.set(item.table, entry);
  }
  process.stdout.write("| Table | Requests | Rows | Bytes | Request time (sum) |\n|---|---:|---:|---:|---:|\n");
  for (const [table, entry] of [...byTable].sort((a, b) => b[1].bytes - a[1].bytes)) {
    process.stdout.write(`| ${table} | ${entry.requests} | ${entry.rows.toLocaleString("en-US")} | ${kib(entry.bytes)} | ${ms(entry.ms)} |\n`);
  }
  process.stdout.write("\n");
}
