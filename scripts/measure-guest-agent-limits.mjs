#!/usr/bin/env node
/**
 * Measure the guest agent limits in local workerd.
 *
 * Runs the built Worker under `wrangler dev`, whose Rate Limiting bindings are simulated locally, with the agent
 * service pointed at a local stub: the limits are enforced by the Worker entry before any question reaches the service,
 * so the stub keeps this measurement from writing agent audit rows. It sends signed-out questions and reports, for each,
 * the status, the refusal scope, and the time to the response headers.
 *
 *   1. Seven questions from one address: the address limit allows five a minute.
 *   2. Questions from distinct addresses until the shared limit refuses one, if local workerd passes a client's
 *      cf-connecting-ip through (Cloudflare's edge overwrites it in production).
 *   3. A question with a session cookie that does not verify: it skips the guest limits and must sign in again.
 *
 * Needs `npm run build`. Usage: node scripts/measure-guest-agent-limits.mjs
 */

import { createServer } from "node:http";
import { loadDotEnv, requireEnv } from "./lib/db.mjs";
import { startWranglerDev } from "./lib/wrangler-dev.mjs";

loadDotEnv();
requireEnv("SUPABASE_URL");
requireEnv("SUPABASE_SERVICE_ROLE_KEY");

const QUESTION = { question: "When does IMC open its quantitative trader internship?" };

async function main() {
  let serviceCalls = 0;
  const stub = createServer((request, response) => {
    request.resume();
    request.on("end", () => {
      serviceCalls += 1;
      response.writeHead(200, { "content-type": "text/event-stream" }).end("event: run_started\ndata: {}\n\n");
    });
  });
  await new Promise((resolve) => stub.listen(0, "127.0.0.1", resolve));
  const worker = await startWranglerDev({
    port: 8791,
    inspectorPort: 9241,
    vars: {
      SUPABASE_URL: process.env.SUPABASE_URL,
      SUPABASE_SERVICE_ROLE_KEY: process.env.SUPABASE_SERVICE_ROLE_KEY,
      FIRSTSEEN_AGENT_API_URL: `http://127.0.0.1:${stub.address().port}`,
      AGENT_API_BEARER_TOKEN: "synthetic-measurement-token-000000000000",
    },
  });

  async function ask(headers = {}) {
    const started = performance.now();
    const response = await fetch(`${worker.base}/api/recruiting-agent`, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(QUESTION),
    });
    const headersMs = performance.now() - started;
    const text = await response.text();
    let body = {};
    try { body = JSON.parse(text); } catch { /* an event stream */ }
    return { status: response.status, error: body.error ?? "", scope: body.scope ?? "", retryAfter: response.headers.get("retry-after") ?? "", headersMs, message: body.message ?? "" };
  }

  // Only a 2xx is an answer: a refusal the Worker did not write as JSON (from workerd itself) is still an error.
  const outcome = (result) => result.error || (result.status < 300 ? "answered" : `error, not from the app (HTTP ${result.status})`);
  const row = (label, result) => `| ${label} | ${result.status} | ${outcome(result)} | ${result.scope} | ${result.retryAfter} | ${result.headersMs.toFixed(1)} ms |\n`;
  const header = "| Request | HTTP | Outcome | Scope | Retry-After | Time to headers |\n|---|---:|---|---|---:|---:|\n";

  try {
    process.stdout.write("\n1. Seven signed-out questions from one address (limit 5 a minute)\n\n" + header);
    let message = "";
    for (let index = 1; index <= 7; index += 1) {
      const result = await ask({ "cf-connecting-ip": "198.51.100.7" });
      if (result.message) message = result.message;
      process.stdout.write(row(`#${index}`, result));
    }
    process.stdout.write(`\nRefusal message: "${message}"\n`);

    process.stdout.write("\n2. Distinct addresses until the shared limit refuses (limit 10 a minute across guests)\n\n");
    let allowed = 0;
    let firstRefusal = null;
    for (let index = 1; index <= 70; index += 1) {
      const result = await ask({ "cf-connecting-ip": `203.0.113.${index}` });
      if (result.status === 200) allowed += 1;
      else if (!firstRefusal) firstRefusal = { index, ...result };
      if (firstRefusal) break;
    }
    if (firstRefusal?.scope === "address" && allowed === 0) {
      process.stdout.write("Local workerd ignored the client's cf-connecting-ip, so every request shared one address; the shared limit could not be exercised locally.\n");
    } else if (firstRefusal) {
      process.stdout.write(`${allowed} questions from distinct addresses were answered, then request #${firstRefusal.index} was refused: HTTP ${firstRefusal.status}, scope ${firstRefusal.scope}. With the 5 from step 1, that is ${allowed + 5} guest questions in the minute.\n`);
    } else {
      process.stdout.write(`All ${allowed} questions from distinct addresses were answered; the shared limit did not refuse within 70.\n`);
    }

    process.stdout.write("\n3. A question carrying a session cookie that does not verify\n\n" + header);
    process.stdout.write(row("stale cookie", await ask({ cookie: "sb-local-auth-token=not-a-session", "cf-connecting-ip": "192.0.2.1" })));
    process.stdout.write(`\nThe stub agent service received ${serviceCalls} questions.\n`);
  } finally {
    await worker.stop();
    await new Promise((resolve) => stub.close(resolve));
  }
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    process.stderr.write(`measure-guest-agent-limits failed: ${error.message}\n`);
    process.exit(1);
  });
