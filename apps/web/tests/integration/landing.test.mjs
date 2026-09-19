/**
 * Integration test: the landing page's live parts, against the local rig.
 *
 * The status line and the hero chart are drawn from the corpus, so both are checked against direct SQL: the line states
 * the companies and this month's openings, and the chart draws one dot per recorded opening, each linking to the page it
 * was seen on. Needs the local rig and `npm run build`.
 */

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

import { loadDotEnv, sqlClient } from "../../../../scripts/lib/db.mjs";

loadDotEnv();

async function page(path) {
  const { default: worker } = await import(new URL(`../../dist/server/index.js?landing=${randomUUID()}`, import.meta.url).href);
  const response = await worker.fetch(
    new Request(`http://localhost${path}`, { headers: { accept: "text/html" } }),
    { ASSETS: { fetch: async () => new Response("Not found", { status: 404 }) } },
    { waitUntil() {}, passThroughOnException() {} },
  );
  return { status: response.status, html: await response.text() };
}

const text = (html) => html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/g, " ").replace(/<!-- -->/g, "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");

test("the landing page states what the corpus holds, and draws the program's own openings", async () => {
  const sql = await sqlClient();
  assert.ok(sql, "SUPABASE_DB_URL is not set. Start the local rig first: scripts/local-rig.sh up");
  try {
    const { html, status } = await page("/");
    assert.equal(status, 200);
    const visible = text(html);

    // The status line: the programs in the product, and this month's openings.
    const { rows: [counts] } = await sql.query(`
      select (select count(*) from public.canonical_roles where scope_status = 'in_scope' and active)::int programs,
             (select count(*) from public.historical_opening_events e join public.canonical_roles r on r.id = e.canonical_role_id
               where r.scope_status = 'in_scope' and r.active and e.date_precision = 'exact'
                 and e.opened_on >= date_trunc('month', current_date) and e.opened_on >= current_date - 45)::int this_month`);
    // The line is drawn only while collection is fresh; a stalled corpus says nothing rather than something old.
    const { rows: [freshness] } = await sql.query(
      `select extract(epoch from now() - max(observed_at)) / 3600 hours from public.raw_job_observations`);
    const stated = /Updated ([^·]+)· ([\d,]+) programs · ([\d,]+) openings this month/.exec(visible);
    if (Number(freshness.hours) < 48) {
      assert.ok(stated, `the status line is drawn: ${visible.slice(0, 200)}`);
      assert.equal(Number(stated[2].replace(/,/g, "")), counts.programs);
      assert.equal(Number(stated[3].replace(/,/g, "")), counts.this_month);
      assert.match(stated[1], /ago/);
    } else {
      assert.equal(stated, null, `collection last wrote ${Math.round(freshness.hours)} hours ago, so the line is left out`);
    }

    // The hero chart: one dot per opening the card lists, each a link to where that date was seen.
    const chartStart = html.indexOf('role="group"');
    const chart = html.slice(chartStart, html.indexOf("</svg>", chartStart));
    const dots = [...chart.matchAll(/<circle[^>]*class="[^"]*drop-in[^"]*"/g)];
    const links = [...chart.matchAll(/<a href="(https?:[^"]+)"[^>]*aria-label="([^"]+)"/g)];
    assert.ok(dots.length > 0, "the chart draws the program's openings");
    assert.equal(links.length, dots.length, "every dot is a link to the page it was seen on");
    const { rows: [role] } = await sql.query(`
      select r.id::text, count(e.id)::int openings from public.canonical_roles r
      join public.historical_opening_events e on e.canonical_role_id = r.id
      where r.id = $1 group by r.id`, [/href="\/roles\/([0-9a-f-]{36})"/.exec(html)?.[1]]);
    assert.ok(role, "the card links a program that exists");
    assert.ok(dots.length <= role.openings, "no dot without an opening behind it");

    // A window is drawn only when the program has one, and it says the date in words as well.
    const likely = /Likely around ([A-Z][a-z]{2} \d{1,2}, \d{4})/.exec(visible);
    if (likely) {
      const { rows: [forecast] } = await sql.query(`
        select to_char(point_date, 'Mon DD, YYYY') expected from (
          select distinct on (canonical_role_id) canonical_role_id, point_date, forecasted_at from public.forecasts order by canonical_role_id, forecasted_at desc
        ) f where f.canonical_role_id = $1`, [/href="\/roles\/([0-9a-f-]{36})"/.exec(html)?.[1]]);
      assert.equal(likely[1].replace(/ 0(\d),/, " $1,"), forecast.expected.replace(/ 0(\d),/, " $1,"));
    }
  } finally {
    await sql.end();
  }
});
