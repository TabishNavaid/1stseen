import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const read = (path) => readFile(new URL(path, import.meta.url), "utf8");

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

test("agent and replay routes default closed outside authenticated sessions", async () => {
  const shared = await read("../lib/agent-auth.ts");
  assert.match(shared, /NODE_ENV !== "production"/);
  assert.match(shared, /ALLOW_UNAUTHENTICATED_AGENT_DEV === "true"/);
  const replay = await read("../app/api/forecast-replay/route.ts");
  assert.match(replay, /const allowUnauthenticatedDev = unauthenticatedDevAllowed\(\);/);
  assert.match(replay, /if \(!user && !allowUnauthenticatedDev\)/);
  // The agent route's only signed-out path is a guest the Worker entry has rate-limited; the development bypass is gone.
  const agent = await read("../app/api/recruiting-agent/route.ts");
  assert.match(agent, /const guest = !user && request\.headers\.get\(GUEST_AGENT_HEADER\) === "allowed";/);
  assert.match(agent, /if \(!user && !guest\)/);
  assert.doesNotMatch(agent, /unauthenticatedDevAllowed|ALLOW_UNAUTHENTICATED_AGENT_DEV/);
  const entry = await read("../cloudflare/index.ts");
  const dropped = entry.indexOf("headers.delete(GUEST_AGENT_HEADER);");
  const granted = entry.indexOf('headers.set(GUEST_AGENT_HEADER, "allowed");');
  assert.ok(dropped > 0 && granted > dropped, "the entry drops a client's guest header before it can set its own");
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
  const source = await read("../app/api/readiness/route.ts");
  assert.match(source, /const auth = await authenticatedUser\(\);/);
  assert.match(source, /requestReadinessPlan\(auth\.userId, parsed\.data\.role_id\)/);
  assert.doesNotMatch(source, /parsed\.data\.user_id/);
  // The one place the worker is asked for a plan sends the id it was given, and only that id.
  const helper = await read("../lib/readiness-plan.ts");
  assert.match(helper, /body: JSON\.stringify\(\{ role_id: roleId, user_id: userId \}\)/);
});

test("onboarding writes and plans only for the signed-in user", async () => {
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
