/**
 * The boundaries that decide who a request is, checked by making the request.
 *
 * These used to be read as source text — `readFileSync` and a regular expression over the Worker entry, including
 * one that asserted a header was deleted *before* it was set by comparing two `indexOf` results. A boundary
 * verified by the order of two strings in a file is not verified: the file can keep saying the right thing while
 * the deployed behaviour changes underneath it.
 *
 * The Worker entry cannot be imported directly — it pulls in vinext's virtual modules — but the *built* Worker can
 * be called, which is what the rest of the suite already does. So every assertion here that can be made by sending
 * a request is, and the few that cannot say why in place.
 */

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { GUEST_AGENT_HEADER } from "../cloudflare/guest-agent.ts";

const read = (path) => readFile(new URL(path, import.meta.url), "utf8");

/** One request against the built Worker, with no session and no Durable Object binding. */
async function post(pathname, body, headers = {}) {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}-${Math.random()}`);
  const { default: worker } = await import(workerUrl.href);
  const response = await worker.fetch(
    new Request(`http://localhost${pathname}`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) }),
    { ASSETS: { fetch: async () => new Response("Not found", { status: 404 }) } },
    { waitUntil() {}, passThroughOnException() {} },
  );
  return { status: response.status, body: await response.text() };
}

const QUESTION = { question: "When does it open?" };
const REPLAY = { role_id: "00000000-0000-4000-8000-000000000001", target_year: 2025, forecast_cutoff: "2025-06-01" };
/** Headers a public Worker will happily accept from anyone, and must never read as an identity. */
const FORGED_IDENTITY = {
  "oai-authenticated-user-id": "user-forged",
  "oai-authenticated-user-email": "forged@example.com",
  "x-firstseen-user-id": "00000000-0000-4000-8000-0000000000ff",
};

test("OAuth credentials are encrypted with provider- and user-bound authenticated data", async () => {
  // Both integrations share lib/oauth-token-crypto.ts. tests/oauth-integrations.test.mjs
  // exercises it with synthetic tokens and checks that each wrapper binds its own provider.
  const core = await read("../lib/oauth-token-crypto.ts");
  assert.match(core, /additionalData: tokenAssociatedData\(provider, userId\)/);
  assert.match(core, /`1stseen:\$\{provider\}:\$\{userId\}`/);
  assert.match(core, /return `v2\./);
  assert.doesNotMatch(core, /version !== "v1"/);
  for (const path of ["../lib/google-calendar/crypto.ts", "../lib/email-digests/crypto.ts"]) {
    const source = await read(path);
    assert.match(source, /from "@\/lib\/oauth-token-crypto"/);
    assert.doesNotMatch(source, /crypto\.subtle/);
  }
});

test("OAuth callbacks bind state to the initiating authenticated user", async () => {
  const calendarConnect = await read("../app/api/integrations/google-calendar/connect/route.ts");
  const calendarCallback = await read("../app/api/integrations/google-calendar/callback/route.ts");
  const gmailConnect = await read("../app/api/integrations/gmail/connect/route.ts");
  const gmailCallback = await read("../app/api/integrations/gmail/callback/route.ts");
  assert.match(calendarConnect, /firstseen_google_oauth_user/);
  assert.match(calendarCallback, /expectedUserId !== auth\.userId/);
  assert.match(gmailConnect, /firstseen_gmail_oauth_user/);
  assert.match(gmailCallback, /expectedUserId !== auth\.userId/);
});

test("replay refuses a request with no session, and a forged identity does not change that", async () => {
  const plain = await post("/api/forecast-replay", REPLAY);
  assert.equal(plain.status, 401, plain.body);
  const forged = await post("/api/forecast-replay", REPLAY, FORGED_IDENTITY);
  assert.deepEqual(forged, plain, "headers anyone can send must not change the answer");
});

test("the entry strips a client's own guest header, so forging it buys nothing", async () => {
  // The route lets a signed-out question through only when the Worker entry marked it allowed, after the limits.
  // Forging that header is the obvious attack.
  //
  // It has to be asked for with a session cookie on it. Without one the entry takes its guest branch, finds no
  // limiter bound, and answers 503 before it ever forwards the request — so whether it stripped the header is
  // invisible, and a test that only sends the header passes even when the entry trusts it. (Checked by deleting
  // the strip and rebuilding: the header-only request answered identically, the request below did not.)
  const cookie = { cookie: "sb-abc-auth-token=not-a-real-session" };
  const plain = await post("/api/recruiting-agent", QUESTION, cookie);
  const forged = await post("/api/recruiting-agent", QUESTION, { ...cookie, [GUEST_AGENT_HEADER]: "allowed" });
  assert.equal(plain.status, 401, plain.body);
  assert.deepEqual(forged, plain, "a forged guest header carried a request past the sign-in gate");

  // Still worth reading once: the development bypass is gone from the route entirely, which no request can show.
  const agent = await read("../app/api/recruiting-agent/route.ts");
  assert.doesNotMatch(agent, /unauthenticatedDevAllowed|ALLOW_UNAUTHENTICATED_AGENT_DEV/);
});

test("only a Supabase identity may scope an agent answer to a watchlist", async () => {
  // The caller comes from the Supabase session and nothing else: a request header is not an
  // identity on a public Worker (tests/agent-caller.test.mjs forges one against the build).
  const auth = await read("../lib/agent-auth.ts");
  const authCode = auth.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  assert.match(authCode, /const session = await currentSession\(\);\s*return session \? \{ userId: session\.userId \} : null;/);
  assert.doesNotMatch(authCode, /next\/headers|headers\(|oai-authenticated|getChatGPTUser/);
  const source = await read("../app/api/recruiting-agent/route.ts");
  // Only a session user id, validated as a profiles.id UUID, may become user_id.
  assert.match(source, /user && z\.string\(\)\.uuid\(\)\.safeParse\(user\.userId\)\.success[\s\S]{0,40}user_id: user\.userId/);
  assert.doesNotMatch(source, /parsed\.data\.user_id/);
});

test("the readiness route derives ownership from the session, never the request body", async () => {
  // A body carrying someone else's id is refused for want of a session, rather than acted on for the id it names.
  const withOwnerInBody = await post("/api/readiness", { role_id: REPLAY.role_id, user_id: FORGED_IDENTITY["x-firstseen-user-id"] });
  assert.equal(withOwnerInBody.status, 401, withOwnerInBody.body);
  assert.deepEqual(withOwnerInBody, await post("/api/readiness", { role_id: REPLAY.role_id }), "the body's user_id changed the answer");

  const source = await read("../app/api/readiness/route.ts");
  assert.match(source, /const auth = await authenticatedUser\(\);/);
  assert.match(source, /requestReadinessPlan\(auth\.userId, parsed\.data\.role_id\)/);
  assert.doesNotMatch(source, /parsed\.data\.user_id/);
  // The one place the worker is asked for a plan sends the id it was given, and only that id.
  const helper = await read("../lib/readiness-plan.ts");
  assert.match(helper, /body: JSON\.stringify\(\{ role_id: roleId, user_id: userId \}\)/);
});

test("onboarding writes and plans only for the signed-in user", async () => {
  // Signed out, the route never reaches a write. It answers the same whether or not the body names an owner, which
  // is as far as a request can show here: without Supabase configured it stops at 503 before the origin check, so
  // the same-origin rule below is still read rather than exercised.
  const named = await post("/api/onboarding", { fields: [], user_id: FORGED_IDENTITY["x-firstseen-user-id"] });
  assert.deepEqual(named, await post("/api/onboarding", { fields: [] }), "the body's user_id changed the answer");
  assert.notEqual(named.status, 200, named.body);

  const source = await read("../app/api/onboarding/route.ts");
  const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  assert.match(code, /supabase\.auth\.getUser\(\)/);
  assert.match(code, /if \(!sameOrigin\(request\)\)/);
  assert.match(code, /user_id: userId/);
  assert.match(code, /requestReadinessPlan\(userId, /);
  assert.doesNotMatch(code, /parsed\.data\.[a-z_]*user_id|body\?\.user_id/);
});

test("agent-backed routes answer honestly when the configured service does not respond", async () => {
  // Signed-in behaviour against a refusing port and a front end's error page is exercised in
  // tests/integration/auth-flows.test.mjs. A service that cannot answer is temporarily unavailable (503) on every route,
  // with the sentence that route's panel shows.
  const readiness = await read("../lib/readiness-plan.ts");
  assert.match(readiness, /try \{\s*upstream = await fetch\(/, "lib/readiness-plan.ts awaits the upstream fetch inside try");
  assert.match(readiness, /catch \{\s*return \{ status: 503, payload: \{ error: "readiness_api_unreachable", message: PLAN_UNAVAILABLE_MESSAGE \} \};/, "lib/readiness-plan.ts maps a failed fetch to a 503 with the plan sentence");
  for (const [path, code, constant] of [
    ["../app/api/forecast-replay/route.ts", "replay_api_unreachable", "REPLAY_UNAVAILABLE_MESSAGE"],
    ["../app/api/recruiting-agent/route.ts", "agent_api_unreachable", "QUESTIONS_UNAVAILABLE_MESSAGE"],
  ]) {
    const source = await read(path);
    assert.match(source, /try \{\s*upstream = await fetch\(/, `${path} awaits the upstream fetch inside try`);
    assert.match(source, new RegExp(`catch \\{[\\s\\S]{0,400}error: "${code}", message: ${constant} \\}, \\{ status: 503 \\}`), `${path} maps a failed fetch to a 503 with its sentence`);
  }
});
