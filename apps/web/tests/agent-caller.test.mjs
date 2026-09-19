/**
 * The worker-backed routes take identity only from a Supabase session.
 *
 * Headers such as `oai-authenticated-user-id`, and the Worker entry's own guest header, are ordinary request headers on
 * a public Cloudflare deployment, so anyone can send them. These tests forge them against the built Worker with a
 * configured agent service (a local stub that records requests):
 *   - replay needs a session, so a forged identity gets a 401 and no upstream call;
 *   - a signed-out agent question is a guest question. Without the rate-limit bindings it is refused before the
 *     service is contacted; a forged guest header does not get it past a refusing limit; and a question that passes
 *     reaches the service with no user identity, whatever identity headers were forged.
 */

import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import "./support/retain-request-clones.mjs";

const FORGED = {
  "oai-authenticated-user-id": "user-forged",
  "oai-authenticated-user-email": "forged@example.com",
  "oai-authenticated-user-full-name": "Forged",
};

const ALLOW = { limit: async () => ({ success: true }) };
const REFUSE = { limit: async () => ({ success: false }) };

const STREAM = (response) => response.writeHead(200, { "content-type": "text/event-stream" }).end("event: run_started\ndata: {}\n\n");

async function withStubAgent(run, respond = STREAM) {
  const calls = [];
  const server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => { body += chunk; });
    request.on("end", () => {
      calls.push({ line: `${request.method} ${request.url}`, body });
      respond(response);
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const previous = { url: process.env.FIRSTSEEN_AGENT_API_URL, token: process.env.AGENT_API_BEARER_TOKEN, dev: process.env.ALLOW_UNAUTHENTICATED_AGENT_DEV };
  process.env.FIRSTSEEN_AGENT_API_URL = `http://127.0.0.1:${server.address().port}`;
  process.env.AGENT_API_BEARER_TOKEN = "synthetic-test-token-not-a-credential-0000";
  delete process.env.ALLOW_UNAUTHENTICATED_AGENT_DEV;
  try {
    await run(calls);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    for (const [name, value] of [["FIRSTSEEN_AGENT_API_URL", previous.url], ["AGENT_API_BEARER_TOKEN", previous.token], ["ALLOW_UNAUTHENTICATED_AGENT_DEV", previous.dev]]) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}

async function post(pathname, body, headers = {}, bindings = {}) {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}-${Math.random()}`);
  const { default: worker } = await import(workerUrl.href);
  return worker.fetch(
    new Request(`http://localhost${pathname}`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) }),
    { ASSETS: { fetch: async () => new Response("Not found", { status: 404 }) }, ...bindings },
    { waitUntil() {}, passThroughOnException() {} },
  );
}

const AGENT = ["/api/recruiting-agent", { question: "When does Stripe open its internship?" }];
const REPLAY = ["/api/forecast-replay", { role_id: "00000000-0000-4000-8000-000000000001", target_year: 2025, forecast_cutoff: "2025-06-01" }];

test("forged identity headers do not authenticate replay", async () => {
  await withStubAgent(async (calls) => {
    for (const headers of [FORGED, {}]) {
      const response = await post(...REPLAY, headers, { GUEST_AGENT_ADDRESS_LIMIT: ALLOW, GUEST_AGENT_OVERALL_LIMIT: ALLOW });
      assert.equal(response.status, 401);
      assert.deepEqual(await response.json(), { error: "unauthorized" });
    }
    assert.deepEqual(calls, [], "the replay service was called without a session");
  });
});

test("without the guest limits bound, a signed-out question is refused before the agent service is contacted", async () => {
  await withStubAgent(async (calls) => {
    for (const headers of [FORGED, {}, { ...FORGED, "x-firstseen-guest-agent": "allowed" }]) {
      const response = await post(...AGENT, headers);
      assert.equal(response.status, 503);
      assert.equal((await response.json()).error, "guest_agent_unavailable");
    }
    assert.deepEqual(calls, []);
  });
});

test("a forged guest header does not get a question past a refusing limit", async () => {
  await withStubAgent(async (calls) => {
    const response = await post(...AGENT, { ...FORGED, "x-firstseen-guest-agent": "allowed" }, { GUEST_AGENT_ADDRESS_LIMIT: REFUSE, GUEST_AGENT_OVERALL_LIMIT: ALLOW });
    assert.equal(response.status, 429);
    assert.equal((await response.json()).scope, "address");
    assert.deepEqual(calls, []);
  });
});

test("a guest question that passes the limits reaches the agent service with no user identity", async () => {
  await withStubAgent(async (calls) => {
    const response = await post(...AGENT, FORGED, { GUEST_AGENT_ADDRESS_LIMIT: ALLOW, GUEST_AGENT_OVERALL_LIMIT: ALLOW });
    assert.equal(response.status, 200);
    await response.text();
    assert.equal(calls.length, 1);
    assert.equal(calls[0].line, "POST /v1/recruiting/query");
    const sent = JSON.parse(calls[0].body);
    assert.equal(sent.audience, "guest");
    assert.equal("user_id" in sent, false);
    assert.equal(sent.question, AGENT[1].question);
  });
});

test("a paused or failing agent service gives a guest the temporarily-unavailable sentence, never an error page", async () => {
  const { QUESTIONS_UNAVAILABLE_MESSAGE } = await import("../lib/agent-availability.ts");
  // Google's front end refusing a stopped service (an HTML page), and a service that is up but failing.
  for (const [status, contentType, body] of [
    [403, "text/html", "<html><title>Error 403 (Forbidden)!!1</title></html>"],
    [503, "text/plain", "Service Unavailable"],
  ]) {
    await withStubAgent(async () => {
      const response = await post(...AGENT, FORGED, { GUEST_AGENT_ADDRESS_LIMIT: ALLOW, GUEST_AGENT_OVERALL_LIMIT: ALLOW });
      assert.equal(response.status, 503, `upstream ${status}`);
      assert.match(response.headers.get("content-type") ?? "", /application\/json/);
      assert.deepEqual(await response.json(), { error: "agent_api_failed", upstream_status: status, message: QUESTIONS_UNAVAILABLE_MESSAGE });
    }, (response) => response.writeHead(status, { "content-type": contentType }).end(body));
  }
  // No answer at all: port 9 refuses connections.
  const previous = { url: process.env.FIRSTSEEN_AGENT_API_URL, token: process.env.AGENT_API_BEARER_TOKEN };
  process.env.FIRSTSEEN_AGENT_API_URL = "http://127.0.0.1:9";
  process.env.AGENT_API_BEARER_TOKEN = "synthetic-test-token-not-a-credential-0000";
  try {
    const response = await post(...AGENT, FORGED, { GUEST_AGENT_ADDRESS_LIMIT: ALLOW, GUEST_AGENT_OVERALL_LIMIT: ALLOW });
    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), { error: "agent_api_unreachable", message: QUESTIONS_UNAVAILABLE_MESSAGE });
  } finally {
    for (const [name, value] of [["FIRSTSEEN_AGENT_API_URL", previous.url], ["AGENT_API_BEARER_TOKEN", previous.token]]) {
      if (value === undefined) delete process.env[name]; else process.env[name] = value;
    }
  }
});
