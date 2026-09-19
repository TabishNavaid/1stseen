/**
 * `npm run preflight` against synthetic environments. Every credential here is fake and
 * built in this file; the script runs with a scrubbed environment so the developer's own
 * .env and exported variables cannot leak in or change the outcome.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const b64 = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
const jwt = (role, marker) => `${b64({ alg: "HS256", typ: "JWT" })}.${b64({ role, marker })}.c2lnbmF0dXJl`;

const SERVICE_KEY = jwt("service_role", "SERVICE-SENTINEL");
const TOKEN = "TOKENSENTINEL_abcdefghijklmnopqrstuvwxyz0123";

const PRODUCTION = {
  SUPABASE_URL: "https://abcdefgh.supabase.co",
  SUPABASE_SERVICE_ROLE_KEY: SERVICE_KEY,
  NEXT_PUBLIC_SUPABASE_URL: "https://abcdefgh.supabase.co",
  NEXT_PUBLIC_SUPABASE_ANON_KEY: jwt("anon", "ANON"),
  NEXT_PUBLIC_APP_URL: "https://firstseen.example",
  FIRSTSEEN_AGENT_API_URL: "https://firstseen-agent-abc.a.run.app",
  AGENT_API_BEARER_TOKEN: TOKEN,
  FIRSTSEEN_ENV: "production",
  FIRSTSEEN_CONTACT_EMAIL: "contact@firstseen.example",
};

function preflight(values, { args = [], exported = {} } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "firstseen-preflight-"));
  try {
    const file = join(dir, ".env.test");
    writeFileSync(file, Object.entries(values).map(([name, value]) => `${name}=${value}`).join("\n"));
    const result = spawnSync(process.execPath, ["scripts/preflight.mjs", "--env-file", file, ...args], {
      cwd: ROOT,
      env: { PATH: process.env.PATH, ...exported },
      encoding: "utf8",
    });
    return { code: result.status, out: result.stdout + result.stderr };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
const row = (out, name) => out.split("\n").find((line) => line.trim().startsWith(`${name} `)) ?? "";

test("an empty environment fails and names every missing required variable", () => {
  const { code, out } = preflight({});
  assert.equal(code, 1);
  for (const name of ["SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY", "NEXT_PUBLIC_SUPABASE_URL", "NEXT_PUBLIC_SUPABASE_ANON_KEY", "FIRSTSEEN_AGENT_API_URL", "AGENT_API_BEARER_TOKEN"]) {
    assert.match(row(out, name), /missing/, `${name} should be reported missing`);
  }
  assert.match(row(out, "FIRSTSEEN_ENV"), /default/);
  assert.match(out, /^REQUIRED$/m);
  assert.match(out, /^OPTIONAL-FEATURE$/m);
  assert.match(out, /^TUNING$/m);
  assert.match(out, /NOT READY/);
});

test("a complete production environment passes without printing any value", () => {
  const { code, out } = preflight(PRODUCTION, { args: ["--production"] });
  assert.equal(code, 0, out);
  assert.match(out, /READY: every required variable is set/);
  assert.match(out, /Google Calendar sync off; Gmail digest delivery off/);
  for (const value of Object.values(PRODUCTION)) {
    if (value.length > 12) assert.ok(!out.includes(value), "a value was printed");
  }
  assert.ok(!out.includes("SENTINEL"), "a secret was printed");
});

test("a contact address is required in production and optional in development", () => {
  const withoutContact = Object.fromEntries(Object.entries(PRODUCTION).filter(([name]) => name !== "FIRSTSEEN_CONTACT_EMAIL"));
  const production = preflight(withoutContact, { args: ["--production"] });
  assert.equal(production.code, 1);
  assert.match(row(production.out, "FIRSTSEEN_CONTACT_EMAIL"), /missing.*no contact address is configured/);
  const development = preflight({ ...withoutContact, FIRSTSEEN_ENV: "development", NEXT_PUBLIC_APP_URL: "http://localhost:3000" });
  assert.equal(development.code, 0, development.out);
  assert.match(row(development.out, "FIRSTSEEN_CONTACT_EMAIL"), /not set.*Required in production/);
  const malformed = preflight({ ...PRODUCTION, FIRSTSEEN_CONTACT_EMAIL: "Write to us <contact@firstseen.example>" }, { args: ["--production"] });
  assert.match(row(malformed.out, "FIRSTSEEN_CONTACT_EMAIL"), /malformed.*one plain email address/);
});

test("production refuses demo mode even when it is false", () => {
  const { code, out } = preflight({ ...PRODUCTION, FIRSTSEEN_DEMO_MODE: "false" }, { args: ["--production"] });
  assert.equal(code, 1);
  assert.match(row(out, "FIRSTSEEN_DEMO_MODE"), /malformed.*unset in production/);
});

test("a service_role key in the browser-bundled anon slot fails", () => {
  const { code, out } = preflight({ ...PRODUCTION, NEXT_PUBLIC_SUPABASE_ANON_KEY: SERVICE_KEY }, { args: ["--production"] });
  assert.equal(code, 1);
  assert.match(row(out, "NEXT_PUBLIC_SUPABASE_ANON_KEY"), /malformed.*browser bundle/);
  assert.ok(!out.includes("SERVICE-SENTINEL"));
});

test("a malformed secret is reported without echoing it", () => {
  const { code, out } = preflight({ ...PRODUCTION, AGENT_API_BEARER_TOKEN: "SHORTSENTINEL" }, { args: ["--production"] });
  assert.equal(code, 1);
  assert.match(row(out, "AGENT_API_BEARER_TOKEN"), /malformed/);
  assert.ok(!out.includes("SHORTSENTINEL"));
});

test("a blank typed worker setting is malformed, because it stops every worker command", () => {
  const { code, out } = preflight({ ...PRODUCTION, MAX_SOURCE_BYTES: "" }, { args: ["--production"] });
  assert.equal(code, 1);
  assert.match(row(out, "MAX_SOURCE_BYTES"), /malformed.*blank/);
});

test("enabling Reddit without its credentials fails, because the worker would refuse to start", () => {
  const { code, out } = preflight({ ...PRODUCTION, REDDIT_API_ENABLED: "true" }, { args: ["--production"] });
  assert.equal(code, 1);
  assert.match(row(out, "REDDIT_API_ENABLED"), /REDDIT_CLIENT_ID/);
});

test("a partly configured optional feature is reported but does not block", () => {
  const { code, out } = preflight({ ...PRODUCTION, GOOGLE_CALENDAR_CLIENT_ID: "123-abc.apps.googleusercontent.com" }, { args: ["--production"] });
  assert.equal(code, 0, out);
  assert.match(row(out, "GOOGLE_CALENDAR_CLIENT_SECRET"), /needed.*partly configured/);
  assert.match(out, /Google Calendar sync partial/);
});

test("the redirect URIs .env.example ships do not count as starting an OAuth setup", () => {
  const { code, out } = preflight({
    ...PRODUCTION,
    GOOGLE_CALENDAR_REDIRECT_URI: "https://firstseen.example/api/integrations/google-calendar/callback",
    GMAIL_OAUTH_REDIRECT_URI: "https://firstseen.example/api/integrations/gmail/callback",
  }, { args: ["--production"] });
  assert.equal(code, 0, out);
  assert.match(out, /Google Calendar sync off; Gmail digest delivery off/);
  assert.match(row(out, "GOOGLE_CALENDAR_CLIENT_ID"), /not set/);
});

test("a fully configured OAuth feature reports on", () => {
  const key = Buffer.alloc(32, 9).toString("base64url");
  const { code, out } = preflight({
    ...PRODUCTION,
    GOOGLE_CALENDAR_CLIENT_ID: "123-abc.apps.googleusercontent.com",
    GOOGLE_CALENDAR_CLIENT_SECRET: "synthetic-client-secret-for-tests",
    GOOGLE_CALENDAR_REDIRECT_URI: "https://firstseen.example/api/integrations/google-calendar/callback",
    GOOGLE_CALENDAR_TOKEN_ENCRYPTION_KEY: key,
  }, { args: ["--production"] });
  assert.equal(code, 0, out);
  assert.match(out, /Google Calendar sync on/);
  assert.ok(!out.includes(key));
});

test("exported variables override the file, like the worker and the build", () => {
  const { code, out } = preflight({ ...PRODUCTION, SUPABASE_URL: "not a url" }, { args: ["--production"], exported: { SUPABASE_URL: PRODUCTION.SUPABASE_URL } });
  assert.equal(code, 0, out);
  assert.match(row(out, "SUPABASE_URL"), /\bset\b/);
});
