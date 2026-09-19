/**
 * Integration test: a role page answers 404 for any id that is not a role in the product, with real data configured.
 *
 * The page renders "This program isn't tracked anymore", but the root loading boundary sends the shell with 200 before
 * the page body runs, so every missing role used to answer 200. The Worker entry now checks the id beside the render
 * (cloudflare/index.ts, roleIsListed) and reads the page's own status (cloudflare/page-status.ts). Needs the local rig
 * and `npm run build`.
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
              (select id::text from public.canonical_roles where scope_status = 'out_of_scope' order by id limit 1) as outside,
              (select r.id::text from public.canonical_roles r where r.scope_status = 'out_of_scope' and exists (
                 select 1 from public.canonical_roles o where o.company_id = r.company_id and o.scope_status = 'in_scope' and o.active)
               order by r.id limit 1) as sibling`,
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
      assert.equal(response.headers.get("cache-control") === "no-store", status === 404, path);
      if (status === 404) {
        assert.match(html, /<title>Program no longer tracked · 1stSeen<\/title>/, path);
        assert.match(html, /This program isn’t tracked anymore\./, path);
      }
    }
    // A program the product no longer lists links to its company's other programs, and names nothing else about it.
    const { rows: [company] } = await sql.query(`select c.id::text, c.name, r.canonical_title from public.canonical_roles r join public.companies c on c.id = r.company_id where r.id = $1`, [ids.sibling]);
    const sibling = await render(`/roles/${ids.sibling}`);
    assert.equal(sibling.status, 404);
    const siblingHtml = (await sibling.text()).replace(/<script\b[^>]*>[\s\S]*?<\/script>/g, "");
    assert.match(siblingHtml, new RegExp(`href="/roles\\?company=${company.id}"`));
    assert.match(siblingHtml, /See other roles at/);
    assert.ok(!siblingHtml.includes(company.canonical_title), "the program itself is not named");
  } finally {
    await sql.end();
  }
});

test("with the database unreachable, a role page answers 500, not that the role does not exist", async () => {
  const saved = process.env.SUPABASE_URL;
  process.env.SUPABASE_URL = "http://127.0.0.1:9";
  try {
    const response = await render("/roles/1f8c981b-96a3-578a-b901-3a1272c45743");
    assert.equal(response.status, 500);
    assert.equal(response.headers.get("cache-control"), "no-store");
    // What a reader sees: the document without its inline RSC payload. The error view ("Something broke on our side")
    // is drawn by the error boundary in the browser; on the server the page must not say the program is gone.
    const html = (await response.text()).replace(/<script\b[^>]*>[\s\S]*?<\/script>/g, "");
    assert.doesNotMatch(html, /tracked anymore|This page could not be found/);
  } finally {
    process.env.SUPABASE_URL = saved;
  }
});
