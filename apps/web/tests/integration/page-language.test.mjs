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

import { loadDotEnv, sqlClient } from "../../../../scripts/lib/db.mjs";
import { pageLanguageLeaks } from "../support/page-language.mjs";

loadDotEnv();

let workerModule;
async function html(path) {
  workerModule ??= (await import(new URL(`../../dist/server/index.js?page-language=${randomUUID()}`, import.meta.url).href)).default;
  const response = await workerModule.fetch(
    new Request(`http://localhost${path}`, { headers: { accept: "text/html" } }),
    { ASSETS: { fetch: async () => new Response("Not found", { status: 404 }) } },
    { waitUntil() {}, passThroughOnException() {} },
  );
  return { status: response.status, body: await response.text() };
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
      "/methodology", "/signin", "/replay",
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
