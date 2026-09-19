/**
 * Integration test: the authentication flows against the local rig's real Supabase Auth
 * and its Mailpit inbox, through the built Worker.
 *
 * Needs: `scripts/local-rig.sh up` with supabase/config.toml's email templates and local
 * email rate limit applied (restart the stack after changing them), and `npm run build`.
 * Runs in `npm run test:integration`, not the gate.
 *
 * Every account uses the reserved `.invalid` domain, is created by this file, and is deleted
 * at the end with its Mailpit messages.
 *
 * What it proves:
 *   - sign-up, resend, and reset requests answer identically (status, body, and a 1.5 s duration
 *     floor) for a new address, an unconfirmed account, a confirmed account, and an unknown address
 *   - a sign-in failure answers identically for a wrong password and an unknown address, and
 *     never faster than the floor
 *   - the confirmation email carries its token only in the URL fragment; confirming signs the
 *     user in with HttpOnly, SameSite=Lax session cookies; the link works once
 *   - signed in, the agent-backed routes report their service as not configured (503) when
 *     it is not, rather than failing or pretending
 *   - password reset end to end: the old password stops working, the new one works, and the
 *     link works once
 *   - sign-out clears the session
 */

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import test from "node:test";
import "../support/retain-request-clones.mjs";

import { loadDotEnv } from "../../../../scripts/lib/db.mjs";

loadDotEnv();
const require = createRequire(new URL("../../package.json", import.meta.url));
const { createClient } = require("@supabase/supabase-js");

const MAILPIT = process.env.MAILPIT_URL ?? "http://127.0.0.1:55424";
const RUN = randomUUID().slice(0, 8);
const address = (label) => `auth-${label}-${RUN}@firstseen-test.invalid`;
const median = (values) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];

let workerModule;
async function worker() {
  workerModule ??= (await import(new URL(`../../dist/server/index.js?auth=${RUN}`, import.meta.url).href)).default;
  return workerModule;
}

/** A request to the built Worker, carrying and collecting cookies like a browser would. */
async function call(pathname, { method = "POST", body, jar } = {}) {
  const headers = {};
  if (body !== undefined) headers["content-type"] = "application/json";
  if (jar?.size) headers.cookie = [...jar].map(([name, value]) => `${name}=${value}`).join("; ");
  const { fetch } = await worker();
  const started = performance.now();
  const response = await fetch(
    new Request(`http://localhost${pathname}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }),
    { ASSETS: { fetch: async () => new Response("Not found", { status: 404 }) } },
    { waitUntil() {}, passThroughOnException() {} },
  );
  const elapsed = performance.now() - started;
  const setCookies = response.headers.getSetCookie();
  if (jar) {
    for (const line of setCookies) {
      const [pair, ...attributes] = line.split(";").map((part) => part.trim());
      const name = pair.slice(0, pair.indexOf("="));
      const value = pair.slice(pair.indexOf("=") + 1);
      const expired = attributes.some((attribute) => /^max-age=0$/i.test(attribute)) || value === "";
      if (expired) jar.delete(name);
      else jar.set(name, value);
    }
  }
  return { response, elapsed, setCookies, text: () => response.text(), json: () => response.json() };
}

async function mailpitMessagesTo(recipient) {
  const { messages = [] } = await fetch(`${MAILPIT}/api/v1/messages?limit=200`).then((r) => r.json());
  return messages.filter((message) => (message.To ?? []).some((to) => to.Address === recipient));
}

async function waitForEmail(recipient, subjectPattern, seen = new Set()) {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const match = (await mailpitMessagesTo(recipient)).find((message) => subjectPattern.test(message.Subject) && !seen.has(message.ID));
    if (match) {
      seen.add(match.ID);
      return fetch(`${MAILPIT}/api/v1/message/${match.ID}`).then((r) => r.json());
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`no "${subjectPattern}" email reached ${recipient}`);
}

function linkFrom(message, expectedPath) {
  const href = /href="([^"]+)"/.exec(message.HTML ?? "")?.[1]?.replaceAll("&amp;", "&");
  assert.ok(href, "the email contains a link");
  const url = new URL(href);
  assert.equal(url.pathname, expectedPath);
  assert.equal(url.search, "", "the token must not be in the query string, where request logs would record it");
  const fragment = new URLSearchParams(url.hash.slice(1));
  return { tokenHash: fragment.get("token_hash"), type: fragment.get("type") };
}

test("authentication flows against the local rig", async (t) => {
  for (const name of ["SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY", "NEXT_PUBLIC_SUPABASE_ANON_KEY"]) {
    assert.ok(process.env[name], `${name} is not set. Start the local rig first: scripts/local-rig.sh up`);
  }
  const mailpitUp = await fetch(`${MAILPIT}/api/v1/messages?limit=1`).then((r) => r.ok).catch(() => false);
  assert.ok(mailpitUp, `Mailpit is not reachable at ${MAILPIT}`);

  const admin = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
  const password = `Correct-horse-${RUN}`;
  const confirmedEmail = address("confirmed");
  const unconfirmedEmail = address("unconfirmed");
  const created = [];

  try {
    const confirmed = await admin.auth.admin.createUser({ email: confirmedEmail, password, email_confirm: true });
    assert.ifError(confirmed.error);
    created.push(confirmed.data.user.id);
    const unconfirmed = await admin.auth.admin.createUser({ email: unconfirmedEmail, password, email_confirm: false });
    assert.ifError(unconfirmed.error);
    created.push(unconfirmed.data.user.id);

    await t.test("sign-up, resend, and reset requests reveal nothing about which addresses have accounts", async () => {
      const cases = [
        ["/api/auth/sign-up", (email) => ({ email, password: `Another-${RUN}-pw` })],
        ["/api/auth/resend", (email) => ({ email })],
        ["/api/auth/forgot", (email) => ({ email })],
      ];
      for (const [route, bodyFor] of cases) {
        const timings = new Map();
        for (let round = 0; round < 3; round += 1) {
          for (const [label, email] of [["unknown", address(`unknown-${round}`)], ["unconfirmed", unconfirmedEmail], ["confirmed", confirmedEmail]]) {
            const result = await call(route, { body: bodyFor(email) });
            assert.equal(result.response.status, 202, `${route} ${label}`);
            assert.deepEqual(await result.json(), { status: "check_email" }, `${route} ${label}`);
            assert.ok(result.elapsed >= 1_480, `${route} ${label} answered in ${Math.round(result.elapsed)} ms, under the 1,500 ms floor`);
            timings.set(label, [...(timings.get(label) ?? []), result.elapsed]);
          }
        }
        const medians = [...timings.values()].map(median);
        assert.ok(Math.max(...medians) - Math.min(...medians) < 150, `${route} timing differs by account state: ${medians.map(Math.round)}`);
      }
      // The sign-up requests above for unknown addresses really created accounts; track them for cleanup.
      const { data } = await admin.auth.admin.listUsers({ perPage: 1000 });
      for (const user of data.users.filter((item) => item.email?.endsWith(`-${RUN}@firstseen-test.invalid`))) {
        if (!created.includes(user.id)) created.push(user.id);
      }
    });

    await t.test("a sign-in failure is identical for a wrong password and an unknown address", async () => {
      const timings = { wrong: [], unknown: [] };
      for (let round = 0; round < 3; round += 1) {
        const wrong = await call("/api/auth/sign-in", { body: { email: confirmedEmail, password: "not-the-password" } });
        const unknown = await call("/api/auth/sign-in", { body: { email: address(`nobody-${round}`), password: "not-the-password" } });
        for (const [label, result] of [["wrong", wrong], ["unknown", unknown]]) {
          assert.equal(result.response.status, 400, label);
          assert.deepEqual(await result.json(), { error: "invalid_credentials" }, label);
          assert.ok(result.elapsed >= 780, `${label} answered in ${Math.round(result.elapsed)} ms`);
          assert.equal(result.setCookies.length, 0, `${label} set a cookie`);
          timings[label].push(result.elapsed);
        }
      }
      assert.ok(Math.abs(median(timings.wrong) - median(timings.unknown)) < 150, `timing: ${median(timings.wrong)} vs ${median(timings.unknown)}`);

      const notConfirmed = await call("/api/auth/sign-in", { body: { email: unconfirmedEmail, password } });
      assert.deepEqual(await notConfirmed.json(), { error: "email_not_confirmed" }, "reported only to someone holding the right password");
    });

    const jar = new Map();
    const newEmail = address("new");
    await t.test("confirming the emailed link signs the user in with HttpOnly cookies, once", async () => {
      const signUp = await call("/api/auth/sign-up", { body: { email: newEmail, password } });
      assert.equal(signUp.response.status, 202);
      const message = await waitForEmail(newEmail, /Confirm your 1stSeen account/);
      const link = linkFrom(message, "/auth/confirm");
      assert.equal(link.type, "email");
      assert.ok(link.tokenHash);

      const confirm = await call("/api/auth/confirm", { body: { token_hash: link.tokenHash, type: link.type }, jar });
      assert.equal(confirm.response.status, 200);
      // A confirmed address is a new account, so it lands on the first run; onboarding-flow.test.mjs covers the rest.
      assert.deepEqual(await confirm.json(), { status: "confirmed", redirect: "/welcome" });
      const sessionCookies = confirm.setCookies.filter((line) => /^sb-[^=]+-auth-token/.test(line));
      assert.ok(sessionCookies.length > 0, "a session cookie was set");
      for (const line of sessionCookies) {
        assert.match(line, /;\s*HttpOnly/i, "session cookie is HttpOnly");
        assert.match(line, /;\s*SameSite=Lax/i, "session cookie is SameSite=Lax");
        assert.match(line, /;\s*Path=\//i);
      }

      const dashboard = await call("/", { method: "GET", jar });
      // React's server render separates the text and the interpolated address with <!-- -->.
      const escaped = newEmail.replace(/[.+]/g, "\\$&");
      const dashboardHtml = await dashboard.text();
      assert.match(dashboardHtml, new RegExp(`Signed in as (?:<!-- -->)?${escaped}`));
      assert.match(dashboardHtml, /Start with a watchlist that fits/, "a new account is offered the first run");
      const welcome = await call("/welcome", { method: "GET", jar });
      assert.equal(welcome.response.status, 200, "the new account reaches the first run");

      const again = await call("/api/auth/confirm", { body: { token_hash: link.tokenHash, type: link.type } });
      assert.equal(again.response.status, 400);
      assert.deepEqual(await again.json(), { error: "link_unusable" });

      const { data } = await admin.auth.admin.listUsers({ perPage: 1000 });
      const user = data.users.find((item) => item.email === newEmail);
      if (user && !created.includes(user.id)) created.push(user.id);
    });

    await t.test("signed in, agent-backed routes say when their service is not configured or not reachable", async () => {
      const saved = { url: process.env.FIRSTSEEN_AGENT_API_URL, token: process.env.AGENT_API_BEARER_TOKEN };
      delete process.env.FIRSTSEEN_AGENT_API_URL;
      delete process.env.AGENT_API_BEARER_TOKEN;
      try {
        const roleId = randomUUID();
        for (const [route, body, error] of [
          ["/api/readiness", { role_id: roleId }, "readiness_api_unavailable"],
          ["/api/recruiting-agent", { question: "When does Stripe open its internship?" }, "agent_api_unavailable"],
          ["/api/forecast-replay", { role_id: roleId, target_year: 2025, forecast_cutoff: "2025-04-01" }, "replay_api_unavailable"],
        ]) {
          const result = await call(route, { body, jar });
          assert.equal(result.response.status, 503, route);
          assert.deepEqual(await result.json(), { error }, route);
        }
        // Configured but not answering (port 9 refuses connections): an honest 502, never a crash.
        process.env.FIRSTSEEN_AGENT_API_URL = "http://127.0.0.1:9";
        process.env.AGENT_API_BEARER_TOKEN = "synthetic-unreachable-service-token-000000";
        for (const [route, body, error] of [
          ["/api/readiness", { role_id: roleId }, "readiness_api_unreachable"],
          ["/api/recruiting-agent", { question: "When does Stripe open its internship?" }, "agent_api_unreachable"],
          ["/api/forecast-replay", { role_id: roleId, target_year: 2025, forecast_cutoff: "2025-04-01" }, "replay_api_unreachable"],
        ]) {
          const result = await call(route, { body, jar });
          assert.equal(result.response.status, 502, `${route} unreachable`);
          assert.deepEqual(await result.json(), { error }, `${route} unreachable`);
        }
      } finally {
        if (saved.url !== undefined) process.env.FIRSTSEEN_AGENT_API_URL = saved.url;
        else delete process.env.FIRSTSEEN_AGENT_API_URL;
        if (saved.token !== undefined) process.env.AGENT_API_BEARER_TOKEN = saved.token;
        else delete process.env.AGENT_API_BEARER_TOKEN;
      }
    });

    await t.test("sign-out clears the session", async () => {
      const signOut = await call("/api/auth/sign-out", { body: {}, jar });
      assert.equal(signOut.response.status, 200);
      assert.equal([...jar.keys()].filter((name) => name.startsWith("sb-")).length, 0, "session cookies were cleared");
      const dashboard = await call("/", { method: "GET", jar });
      assert.doesNotMatch(await dashboard.text(), /Signed in as/);
    });

    await t.test("password reset works end to end, and its link works once", async () => {
      const resetJar = new Map();
      const seen = new Set((await mailpitMessagesTo(confirmedEmail)).map((message) => message.ID));
      const request = await call("/api/auth/forgot", { body: { email: confirmedEmail } });
      assert.equal(request.response.status, 202);
      const message = await waitForEmail(confirmedEmail, /Reset your 1stSeen password/, seen);
      const link = linkFrom(message, "/auth/reset");
      assert.equal(link.type, "recovery");

      const recovery = await call("/api/auth/recovery", { body: { token_hash: link.tokenHash, type: link.type }, jar: resetJar });
      assert.equal(recovery.response.status, 200);
      const newPassword = `New-password-${RUN}`;
      const update = await call("/api/auth/update-password", { body: { password: newPassword }, jar: resetJar });
      assert.equal(update.response.status, 200);
      assert.deepEqual(await update.json(), { status: "password_updated", redirect: "/" });

      const oldPassword = await call("/api/auth/sign-in", { body: { email: confirmedEmail, password } });
      assert.deepEqual(await oldPassword.json(), { error: "invalid_credentials" });
      const signedIn = await call("/api/auth/sign-in", { body: { email: confirmedEmail, password: newPassword }, jar: new Map() });
      assert.equal(signedIn.response.status, 200);

      const reused = await call("/api/auth/recovery", { body: { token_hash: link.tokenHash, type: link.type } });
      assert.deepEqual(await reused.json(), { error: "link_unusable" });
    });
  } finally {
    const { data } = await admin.auth.admin.listUsers({ perPage: 1000 });
    for (const user of data.users.filter((item) => item.email?.endsWith(`-${RUN}@firstseen-test.invalid`))) {
      if (!created.includes(user.id)) created.push(user.id);
    }
    for (const id of created) await admin.auth.admin.deleteUser(id);
    const { messages = [] } = await fetch(`${MAILPIT}/api/v1/messages?limit=500`).then((r) => r.json()).catch(() => ({}));
    const ids = messages.filter((message) => (message.To ?? []).some((to) => to.Address.endsWith(`-${RUN}@firstseen-test.invalid`))).map((message) => message.ID);
    if (ids.length) await fetch(`${MAILPIT}/api/v1/messages`, { method: "DELETE", headers: { "content-type": "application/json" }, body: JSON.stringify({ IDs: ids }) }).catch(() => null);
  }
});
