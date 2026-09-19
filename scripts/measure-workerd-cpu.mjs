#!/usr/bin/env node
/**
 * Measure per-request CPU time inside workerd, the runtime Cloudflare runs and limits.
 *
 * measure-render.mjs runs the Worker in Node, which is only a proxy: Node's process CPU
 * includes its garbage-collector helper threads and its own HTTP client. This script
 * runs the built Worker under `wrangler dev` (local workerd), samples the Worker isolate
 * with the V8 CPU profiler over the DevTools inspector, and reports sampled non-idle
 * time per request.
 *
 * Every request is a guest request (no session cookie), so the dashboard and role pages go through the edge cache
 *: after the warm-up they are cache hits, and the "Edge cache" column counts what the measured requests got.
 * `--edge-cache off` renders every request instead, which is the uncached guest path and the signed-in cost.
 *
 * Needs `npm run build`, plus SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY from the
 * environment or .env. They reach workerd through a temporary env file readable only by
 * this user and removed on exit. Nothing secret is printed.
 *
 * Usage: node scripts/measure-workerd-cpu.mjs [--runs 20] [--edge-cache off] [path ...]
 */

import { loadDotEnv, requireEnv } from "./lib/db.mjs";
import { startWranglerDev } from "./lib/wrangler-dev.mjs";

loadDotEnv();

const argv = process.argv.slice(2);
const flag = (name) => {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : undefined;
};
const RUNS = flag("--runs") ? Math.max(1, Number(flag("--runs"))) : 20;
const EDGE_CACHE = flag("--edge-cache") === "off" ? "off" : "on";
const WARMUP = 5;
const paths = argv.filter((value, index) => !value.startsWith("--") && !["--runs", "--edge-cache"].includes(argv[index - 1]));
const PORT = 8790;
const INSPECTOR_PORT = 9239;

requireEnv("SUPABASE_URL");
requireEnv("SUPABASE_SERVICE_ROLE_KEY");

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

async function inspectorSession() {
  const targets = await (await fetch(`http://127.0.0.1:${INSPECTOR_PORT}/json`)).json();
  const target = targets.find((item) => /core:user/.test(item.webSocketDebuggerUrl ?? "")) ?? targets[0];
  if (!target) throw new Error("no inspector target");
  // wrangler's inspector proxy rejects an upgrade that has a User-Agent but no Origin,
  // and allows localhost origins. Node's WebSocket (undici) accepts headers here.
  const socket = new WebSocket(target.webSocketDebuggerUrl, { headers: { Origin: "http://localhost" } });
  await new Promise((done, fail) => {
    socket.onopen = done;
    socket.onerror = () => fail(new Error("inspector WebSocket handshake was rejected"));
  });
  let nextId = 0;
  const pending = new Map();
  socket.onmessage = (event) => {
    const message = JSON.parse(event.data);
    const waiter = message.id ? pending.get(message.id) : undefined;
    if (!waiter) return;
    pending.delete(message.id);
    if (message.error) waiter.reject(new Error(message.error.message));
    else waiter.resolve(message.result);
  };
  return {
    send: (method, params = {}) => new Promise((done, fail) => {
      nextId += 1;
      pending.set(nextId, { resolve: done, reject: fail });
      socket.send(JSON.stringify({ id: nextId, method, params }));
    }),
    close: () => socket.close(),
  };
}

/** Sampled microseconds split by the profiler's synthetic nodes. */
function summarize(profile) {
  const kind = new Map(profile.nodes.map((node) => [node.id, node.callFrame.functionName]));
  const totals = { all: 0, idle: 0, gc: 0 };
  profile.samples.forEach((nodeId, index) => {
    const delta = profile.timeDeltas[index] ?? 0;
    totals.all += delta;
    const name = kind.get(nodeId);
    if (name === "(idle)") totals.idle += delta;
    if (name === "(garbage collector)") totals.gc += delta;
  });
  return totals;
}

async function main() {
  const worker = await startWranglerDev({
    port: PORT,
    inspectorPort: INSPECTOR_PORT,
    vars: {
      SUPABASE_URL: process.env.SUPABASE_URL,
      SUPABASE_SERVICE_ROLE_KEY: process.env.SUPABASE_SERVICE_ROLE_KEY,
      FIRSTSEEN_AGENT_API_URL: process.env.FIRSTSEEN_AGENT_API_URL,
      AGENT_API_BEARER_TOKEN: process.env.AGENT_API_BEARER_TOKEN,
      FIRSTSEEN_EDGE_CACHE: EDGE_CACHE === "off" ? "off" : undefined,
    },
  });

  async function request(path) {
    let response;
    try {
      response = await fetch(`${worker.base}${path}`, { headers: { accept: "text/html" } });
    } catch (error) {
      throw new Error(`${path}: ${error.message}. workerd output:\n${worker.errors().slice(-2000) || "(none)"}`);
    }
    const body = await response.text();
    return {
      status: response.status,
      bytes: Buffer.byteLength(body),
      realData: body.includes("Real data"),
      cache: response.headers.get("x-firstseen-cache") ?? "none",
    };
  }

  try {
    const inspector = await inspectorSession();
    await inspector.send("Profiler.enable");
    await inspector.send("Profiler.setSamplingInterval", { interval: 100 });

    // Calibration: does this runtime report idle time? Profile a quiet second with no requests.
    await inspector.send("Profiler.start");
    await sleep(1000);
    const quiet = summarize((await inspector.send("Profiler.stop")).profile);
    const idleReported = quiet.all > 0 && quiet.idle / quiet.all > 0.5;
    process.stdout.write(`\nworkerd CPU per request (V8 sampling profiler, 100 µs interval, ${RUNS} runs after ${WARMUP} warm-up, edge cache ${EDGE_CACHE})\n`);
    process.stdout.write(`calibration: quiet second sampled ${(quiet.all / 1000).toFixed(0)} ms, ${(quiet.idle / 1000).toFixed(0)} ms reported idle${idleReported ? "" : " — idle NOT reported, so busy time below is an upper bound"}\n\n`);

    const targets = paths.length ? paths : ["/", "/replay", "/signin", "/calendar", "/digests"];
    process.stdout.write("| Path | HTTP | Real data | HTML | Edge cache | Busy CPU / request | of which GC | Sampled wall / request |\n|---|---|---|---:|---|---:|---:|---:|\n");
    for (const path of targets) {
      for (let index = 0; index < WARMUP; index += 1) await request(path);
      await inspector.send("Profiler.start");
      const started = performance.now();
      let last = null;
      const statuses = new Map();
      for (let index = 0; index < RUNS; index += 1) {
        last = await request(path);
        statuses.set(last.cache, (statuses.get(last.cache) ?? 0) + 1);
      }
      const wall = performance.now() - started;
      const totals = summarize((await inspector.send("Profiler.stop")).profile);
      const busy = (totals.all - totals.idle) / 1000 / RUNS;
      const cache = [...statuses].map(([status, count]) => `${status} ${count}`).join(", ");
      process.stdout.write(
        `| ${path.replace(/[0-9a-f-]{36}/, "<role-id>")} | ${last.status} | ${last.realData ? "yes" : "no"} | ${(last.bytes / 1024).toFixed(1)} KiB | ${cache} | ${busy.toFixed(1)} ms | ${(totals.gc / 1000 / RUNS).toFixed(1)} ms | ${(wall / RUNS).toFixed(1)} ms |\n`,
      );
    }
    process.stdout.write(
      "\nA page rendered without the edge cache that reads Supabase also counts the time spent awaiting each response body:"
        + " local workerd's profiler does not report that wait as idle, so its busy time grows with database latency at the"
        + " same bytes (docs/operations.md, \"Worker CPU\"). Cloudflare bills CPU without the wait; production CPU is"
        + " Cloudflare's own analytics, which scripts/ops-health.mjs reads.\n",
    );
    inspector.close();
  } finally {
    await worker.stop();
  }
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    process.stderr.write(`measure-workerd-cpu failed: ${error.message}\n`);
    process.exit(1);
  });
