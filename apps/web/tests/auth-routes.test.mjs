/**
 * Auth routes and pages against the built Worker, without a network.
 *
 * Every request here is rejected by local validation before Supabase could be called, so the
 * gate needs no database. The flows that do reach Supabase Auth (sign-up, confirmation,
 * reset, and the enumeration timing comparison) run against the local rig in
 * tests/integration/auth-flows.test.mjs.
 */

import assert from "node:assert/strict";
import test from "node:test";
import "./support/retain-request-clones.mjs";

async function worker() {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}-${Math.random()}`);
  return (await import(workerUrl.href)).default;
}

async function call(pathname, { method = "POST", body, headers = {} } = {}) {
  const { fetch } = await worker();
  return fetch(
    new Request(`http://localhost${pathname}`, {
      method,
      headers: { ...(body === undefined ? {} : { "content-type": "application/json" }), ...headers },
      body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
    }),
    { ASSETS: { fetch: async () => new Response("Not found", { status: 404 }) } },
    { waitUntil() {}, passThroughOnException() {} },
  );
}

/** The build inlines NEXT_PUBLIC_SUPABASE_*; without them every auth route honestly answers 503. */
async function authConfigured() {
  const response = await call("/api/auth/sign-up", { body: { email: "not-an-address", password: "x" } });
  return response.status !== 503;
}

test("auth routes validate input locally and never cache", async (t) => {
  if (!(await authConfigured())) return t.skip("build has no NEXT_PUBLIC_SUPABASE_* configuration; routes answer 503");
  const badEmail = await call("/api/auth/sign-up", { body: { email: "no-at-sign", password: "long enough password" } });
  assert.equal(badEmail.status, 400);
  assert.deepEqual(await badEmail.json(), { error: "invalid_email" });
  assert.equal(badEmail.headers.get("cache-control"), "no-store");

  const shortPassword = await call("/api/auth/sign-up", { body: { email: "person@firstseen-test.invalid", password: "short" } });
  assert.equal(shortPassword.status, 400);
  assert.deepEqual(await shortPassword.json(), { error: "invalid_password", problems: ["too_short"] });

  for (const route of ["/api/auth/resend", "/api/auth/forgot"]) {
    const response = await call(route, { body: { email: "" } });
    assert.equal(response.status, 400, route);
    assert.deepEqual(await response.json(), { error: "invalid_email" });
  }

  const garbage = await call("/api/auth/sign-up", { body: "{not json" });
  assert.equal(garbage.status, 400);
});

test("a sign-in failure is never faster than the floor, even when rejected before Supabase", async (t) => {
  if (!(await authConfigured())) return t.skip("build has no NEXT_PUBLIC_SUPABASE_* configuration; routes answer 503");
  const started = performance.now();
  const response = await call("/api/auth/sign-in", { body: { email: "person@firstseen-test.invalid", password: "" } });
  const elapsed = performance.now() - started;
  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), { error: "invalid_credentials" });
  assert.ok(elapsed >= 780, `answered in ${Math.round(elapsed)} ms, under the 800 ms floor`);
});

test("confirmation and recovery tokens are accepted only in a POST body, and only for their own link type", async (t) => {
  if (!(await authConfigured())) return t.skip("build has no NEXT_PUBLIC_SUPABASE_* configuration; routes answer 503");
  const token = "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8";

  const viaGet = await call(`/api/auth/confirm?token_hash=${token}&type=email`, { method: "GET" });
  assert.ok([404, 405].includes(viaGet.status), `GET confirm answered ${viaGet.status}`);

  const queryOnly = await call(`/api/auth/confirm?token_hash=${token}&type=email`, { body: {} });
  assert.equal(queryOnly.status, 400, "a token in the query string is ignored");
  assert.deepEqual(await queryOnly.json(), { error: "link_invalid" });

  const confirmationAsRecovery = await call("/api/auth/recovery", { body: { token_hash: token, type: "email" } });
  assert.equal(confirmationAsRecovery.status, 400);
  assert.deepEqual(await confirmationAsRecovery.json(), { error: "link_invalid" });

  const recoveryAsConfirmation = await call("/api/auth/confirm", { body: { token_hash: token, type: "recovery" } });
  assert.equal(recoveryAsConfirmation.status, 400);
  assert.deepEqual(await recoveryAsConfirmation.json(), { error: "link_invalid" });
});

test("auth routes refuse cross-origin browser requests", async (t) => {
  if (!(await authConfigured())) return t.skip("build has no NEXT_PUBLIC_SUPABASE_* configuration; routes answer 503");
  for (const route of ["/api/auth/sign-in", "/api/auth/sign-up", "/api/auth/forgot", "/api/auth/confirm", "/api/auth/update-password", "/api/auth/sign-out"]) {
    const response = await call(route, { body: { email: "person@firstseen-test.invalid", password: "long enough password" }, headers: { origin: "https://attacker.invalid" } });
    assert.equal(response.status, 403, route);
    assert.deepEqual(await response.json(), { error: "cross_origin" });
  }
});

test("setting a new password without a session is refused before anything changes", async (t) => {
  if (!(await authConfigured())) return t.skip("build has no NEXT_PUBLIC_SUPABASE_* configuration; routes answer 503");
  const tooShort = await call("/api/auth/update-password", { body: { password: "short" } });
  assert.equal(tooShort.status, 400);
  assert.deepEqual(await tooShort.json(), { error: "invalid_password", problems: ["too_short"] });
});

async function page(pathname) {
  const response = await call(pathname, { method: "GET", headers: { accept: "text/html" } });
  assert.equal(response.status, 200, `${pathname} answered ${response.status}`);
  return response.text();
}

test("auth pages render labelled, described fields, and stay out of search indexes", async () => {
  const signin = await page("/signin");
  assert.match(signin, /<h1[^>]*>Sign in<\/h1>/);
  if (/id="auth-email"/.test(signin)) {
    assert.match(signin, /<label[^>]*for="auth-email"[^>]*>Email address<\/label>/);
    assert.match(signin, /<label[^>]*for="auth-password"[^>]*>Password<\/label>/);
    assert.match(signin, /autoComplete="current-password"|autocomplete="current-password"/i);
    assert.match(signin, /aria-pressed="true"[^>]*>Sign in</);
    assert.match(signin, /href="\/auth\/forgot"/);
    // A submit before hydration can never become a GET that puts an email or password in the URL.
    assert.match(signin, /<form[^>]*method="post"/i);
    assert.match(signin, /<button type="submit" disabled=""/);
    assert.match(signin, /<noscript>/);
    // No browser-side Supabase client ships with the page any more.
    assert.doesNotMatch(signin, /createBrowserClient|supabase\.co\/auth\/v1/);
  } else {
    // Only a build with no NEXT_PUBLIC_SUPABASE_* reaches this. A checkout with a root .env inlines them, so this
    // branch never runs on a developer's machine and only CI sees it: keep its copy in step by hand.
    assert.match(signin, /Supabase authentication is not configured here/);
  }

  const forgot = await page("/auth/forgot");
  assert.match(forgot, /<meta name="robots" content="noindex, nofollow"/);
  if (/id="forgot-email"/.test(forgot)) {
    assert.match(forgot, /<label[^>]*for="forgot-email"[^>]*>Email address<\/label>/);
    assert.match(forgot, /<form[^>]*method="post"/i);
    assert.match(forgot, /<button type="submit" disabled=""/);
  }

  const confirm = await page("/auth/confirm");
  assert.match(confirm, /<meta name="robots" content="noindex, nofollow"/);
  if (/Confirming your email/.test(confirm)) {
    assert.match(confirm, /role="status"/);
    assert.match(confirm, /never sent inside a web address/);
  }

  const reset = await page("/auth/reset");
  assert.match(reset, /<meta name="robots" content="noindex, nofollow"/);
});
