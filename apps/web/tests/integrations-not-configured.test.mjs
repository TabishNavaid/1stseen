/**
 * What every visitor sees until Google OAuth credentials exist: both integrations
 * report "not configured" and never start an OAuth flow. Renders the built Worker
 * with no GOOGLE_CALENDAR_* or GMAIL_* configuration.
 */

import assert from "node:assert/strict";
import test from "node:test";
import "./support/retain-request-clones.mjs";

const INTEGRATION_VARIABLES = [
  "GOOGLE_CALENDAR_CLIENT_ID",
  "GOOGLE_CALENDAR_CLIENT_SECRET",
  "GOOGLE_CALENDAR_REDIRECT_URI",
  "GOOGLE_CALENDAR_TOKEN_ENCRYPTION_KEY",
  "GMAIL_OAUTH_CLIENT_ID",
  "GMAIL_OAUTH_CLIENT_SECRET",
  "GMAIL_OAUTH_REDIRECT_URI",
  "EMAIL_TOKEN_ENCRYPTION_KEY",
  "EMAIL_DIGEST_SEND_ENABLED",
];

async function request(pathname, { method = "GET", body } = {}) {
  for (const name of INTEGRATION_VARIABLES) delete process.env[name];
  delete process.env.FIRSTSEEN_DEMO_MODE;
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}-${Math.random()}`);
  const { default: worker } = await import(workerUrl.href);
  return worker.fetch(
    new Request(`http://localhost${pathname}`, {
      method,
      headers: body ? { "content-type": "application/json" } : {},
      body: body ? JSON.stringify(body) : undefined,
    }),
    { ASSETS: { fetch: async () => new Response("Not found", { status: 404 }) } },
    { waitUntil() {}, passThroughOnException() {} },
  );
}

test("Google Calendar status reports not configured before any authentication", async () => {
  const response = await request("/api/integrations/google-calendar");
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { configured: false, connected: false, synced_source_keys: [] });
});

test("Gmail status reports not configured and sending disabled", async () => {
  const response = await request("/api/integrations/gmail");
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { configured: false, connected: false, send_enabled: false });
});

test("neither connect route redirects anywhere near Google without a session and credentials", async () => {
  for (const pathname of ["/api/integrations/google-calendar/connect", "/api/integrations/gmail/connect"]) {
    const response = await request(pathname);
    assert.ok([401, 503].includes(response.status), `${pathname} answered ${response.status}`);
    assert.equal(response.headers.get("location"), null, `${pathname} must not redirect`);
    const payload = await response.json();
    assert.match(payload.error, /unauthorized|unavailable/);
  }
});

test("calendar sync refuses without a session instead of attempting a Google write", async () => {
  const response = await request("/api/integrations/google-calendar/sync", {
    method: "POST",
    body: { events: [] },
  });
  assert.ok([401, 503].includes(response.status), `sync answered ${response.status}`);
  assert.equal(response.headers.get("location"), null);
});
