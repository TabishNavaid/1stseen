/**
 * Integration test: a role page answers 404 for any id that is not a role in the product, with real data configured.
 *
 * The page renders "Role not found", but the root loading boundary sends the shell with 200 before the page body runs,
 * so every missing role used to answer 200. The Worker entry now checks the id beside the render
 * (cloudflare/index.ts, roleIsListed). Needs the local rig and `npm run build`.
 */

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

import { loadDotEnv, sqlClient } from "../../../../scripts/lib/db.mjs";

loadDotEnv();

async function render(pathname) {
  const { default: worker } = await import(new URL(`../../dist/server/index.js?role-not-found=${randomUUID()}`, import.meta.url).href);
  return worker.fetch(
    new Request(`http://localhost${pathname}`, { headers: { accept: "text/html" } }),
    { ASSETS: { fetch: async () => new Response("Not found", { status: 404 }) } },
    { waitUntil() {}, passThroughOnException() {} },
  );
}

test("a role page is 404 for an unknown, malformed, fixture, or out-of-scope id, and 200 for a role in the product", async () => {
  const sql = await sqlClient();
  assert.ok(sql, "SUPABASE_DB_URL is not set. Start the local rig first: scripts/local-rig.sh up");
  try {
    const { rows: [ids] } = await sql.query(
      `select (select id::text from public.canonical_roles where scope_status = 'in_scope' and active order by id limit 1) as listed,
              (select id::text from public.canonical_roles where scope_status = 'out_of_scope' order by id limit 1) as outside`,
    );
    for (const [path, status] of [
      [`/roles/${ids.listed}`, 200],
      [`/roles/${ids.outside}`, 404],
      [`/roles/${randomUUID()}`, 404],
      ["/roles/not-a-role-id", 404],
      ["/roles/northstar-swe-intern", 404],
    ]) {
      const response = await render(path);
      assert.equal(response.status, status, path);
      const html = await response.text();
      // A malformed id never reaches the database, so the framework's own not-found page answers it.
      if (status === 404) assert.match(html, /<title>Role not found · 1stSeen<\/title>|This page could not be found/, path);
    }
  } finally {
    await sql.end();
  }
});

test("with the database unreachable, a role page says the data could not be loaded, not that the role does not exist", async () => {
  const saved = process.env.SUPABASE_URL;
  process.env.SUPABASE_URL = "http://127.0.0.1:9";
  try {
    const response = await render("/roles/1f8c981b-96a3-578a-b901-3a1272c45743");
    assert.notEqual(response.status, 404);
    // What a reader sees: the document without its inline RSC payload, which carries every boundary's template. The
    // error view itself ("Intelligence view unavailable ... could not be loaded") is rendered by the error boundary in
    // the browser; on the server it must at least not say the role does not exist, as it did before.
    const html = (await response.text()).replace(/<script\b[^>]*>[\s\S]*?<\/script>/g, "");
    assert.doesNotMatch(html, /Role not found|This page could not be found/);
  } finally {
    process.env.SUPABASE_URL = saved;
  }
});
