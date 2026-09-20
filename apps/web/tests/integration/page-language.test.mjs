/**
 * Integration test: the pages a person reads, rendered from real data, show no identifiers, fingerprints, timings, tool
 * names, or words from inside the machine (tests/support/page-language.mjs).
 *
 * The gate runs the same check on the development pages; this one covers what only real rows can put on a page: stored
 * titles and places, source URLs, and the role pages of the most confident forecasts. Needs the local rig and
 * `npm run build`.
 */

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

import { createRequire } from "node:module";

import { loadDotEnv, sqlClient } from "../../../../scripts/lib/db.mjs";
import { pageLanguageLeaks } from "../support/page-language.mjs";

loadDotEnv();
const require = createRequire(new URL("../../package.json", import.meta.url));

let workerModule;
async function html(path, jar) {
  workerModule ??= (await import(new URL(`../../dist/server/index.js?page-language=${randomUUID()}`, import.meta.url).href)).default;
  const headers = { accept: "text/html" };
  if (jar?.size) headers.cookie = [...jar].map(([name, value]) => `${name}=${value}`).join("; ");
  const response = await workerModule.fetch(
    new Request(`http://localhost${path}`, { headers }),
    { ASSETS: { fetch: async () => new Response("Not found", { status: 404 }) } },
    { waitUntil() {}, passThroughOnException() {} },
  );
  return { status: response.status, body: await response.text() };
}

/** Signs in through the Worker's own route and keeps the cookies it set, the way a browser would. */
async function signIn(email, password) {
  workerModule ??= (await import(new URL(`../../dist/server/index.js?page-language=${randomUUID()}`, import.meta.url).href)).default;
  const response = await workerModule.fetch(
    new Request("http://localhost/api/auth/sign-in", {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({ email, password }),
    }),
    { ASSETS: { fetch: async () => new Response("Not found", { status: 404 }) } },
    { waitUntil() {}, passThroughOnException() {} },
  );
  assert.equal(response.status, 200, "the check account signs in");
  const jar = new Map();
  for (const line of response.headers.getSetCookie()) {
    const pair = line.split(";")[0];
    jar.set(pair.slice(0, pair.indexOf("=")), pair.slice(pair.indexOf("=") + 1));
  }
  return jar;
}

test("real pages read as product copy", async () => {
  const sql = await sqlClient();
  assert.ok(sql, "SUPABASE_DB_URL is not set. Start the local rig first: scripts/local-rig.sh up");
  try {
    // bounded: the five most confident current forecasts and the five roles with the most recorded openings.
    const confident = await sql.query(`select distinct on (f.canonical_role_id) f.canonical_role_id id, f.confidence
      from public.forecasts f join public.canonical_roles r on r.id = f.canonical_role_id
      where r.scope_status = 'in_scope' and r.active order by f.canonical_role_id, f.forecasted_at desc`);
    const topConfident = confident.rows.sort((a, b) => Number(b.confidence) - Number(a.confidence)).slice(0, 5).map((row) => row.id);
    const busiest = await sql.query(`select e.canonical_role_id id from public.historical_opening_events e
      join public.canonical_roles r on r.id = e.canonical_role_id where r.scope_status = 'in_scope' and r.active
      group by 1 order by count(*) desc, 1 limit 5`);
    const roleIds = [...new Set([...topConfident, ...busiest.rows.map((row) => row.id)])];
    assert.ok(roleIds.length > 0, "the rig has in-scope roles");

    const paths = [
      "/", "/roles", "/roles?page=2", "/roles?sort=window", "/opened", "/opened?page=2", "/ask", "/welcome",
      "/welcome?step=ready&for=internship&field=software_engineering&field=data&field=other_engineering",
      "/methodology", "/signin", "/replay", "/this-page-does-not-exist", "/roles/00000000-0000-4000-8000-000000000000",
      ...roleIds.map((id) => `/roles/${id}`),
    ];
    const failures = [];
    for (const path of paths) {
      const { status, body } = await html(path);
      assert.ok(status < 500, `${path} rendered (${status})`);
      for (const leak of pageLanguageLeaks(body)) failures.push(`${path} ${leak}`);
    }
    assert.deepEqual(failures, [], `pages show words from inside the machine:\n${failures.join("\n")}`);
  } finally {
    await sql.end();
  }
});


/**
 * The same check on the pages only a signed-in reader sees.
 *
 * These were never rendered by a test, and that is how "prediction_interval_threshold_crossed", "Since last run", and
 * a panel of programs the reader had never followed reached the watchlist. The account is created here, watches every
 * program with a recorded revision so the panel has something to draw, and is deleted at the end.
 */
test("the pages behind a sign-in read as product copy too", async () => {
  const sql = await sqlClient();
  assert.ok(sql, "SUPABASE_DB_URL is not set. Start the local rig first: scripts/local-rig.sh up");
  const { createClient } = require("@supabase/supabase-js");
  const admin = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
  const email = `page-language-${randomUUID().slice(0, 8)}@firstseen-test.invalid`;
  const password = `Correct-horse-${randomUUID().slice(0, 8)}`;
  let userId = null;
  try {
    const made = await admin.auth.admin.createUser({ email, password, email_confirm: true });
    assert.ifError(made.error);
    userId = made.data.user.id;

    // Watch what the rig can actually say something about: the programs whose forecasts were revised, then any others.
    const revised = await sql.query(`select distinct f.canonical_role_id id from public.forecast_changes c
      join public.forecasts f on f.id = c.after_forecast_id
      join public.canonical_roles r on r.id = f.canonical_role_id
      where r.scope_status = 'in_scope' and r.active limit 8`);
    const filler = await sql.query(`select id from public.canonical_roles
      where scope_status = 'in_scope' and active order by id limit 4`);
    const watched = [...new Set([...revised.rows, ...filler.rows].map((row) => row.id))];
    assert.ok(watched.length > 0, "the rig has in-scope programs to watch");
    for (const id of watched) {
      await sql.query(`insert into public.watchlist_items (user_id, target_type, canonical_role_id)
        values ($1, 'canonical_role', $2) on conflict do nothing`, [userId, id]);
    }

    const jar = await signIn(email, password);
    const paths = [
      "/roles?watched=1", "/roles", "/calendar", "/settings", "/digests", "/ask", "/welcome",
      ...watched.slice(0, 3).map((id) => `/roles/${id}`),
    ];
    const failures = [];
    for (const path of paths) {
      const { status, body } = await html(path, jar);
      assert.ok(status < 500, `${path} rendered (${status})`);
      for (const leak of pageLanguageLeaks(body)) failures.push(`${path} ${leak}`);
    }
    assert.deepEqual(failures, [], `signed-in pages show words from inside the machine:\n${failures.join("\n")}`);
  } finally {
    if (userId) await admin.auth.admin.deleteUser(userId);
    await sql.end();
  }
});
