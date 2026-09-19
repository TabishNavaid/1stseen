/**
 * Integration test: every number the product displays matches a direct query.
 *
 * Renders the landing section, dashboard summary and list totals, facets, cards, methodology, Forecast Replay, and the
 * five most confident role pages through the built Worker, and recomputes each claim with independent SQL rather than
 * the product's own functions. It exists because a 12-row list's length was once shown as the total of 181 confirmed
 * openings, a capped read showed 60 of 114 contributions, and a declined role kept showing a window its evidence no
 * longer supported. Needs the local rig and `npm run build`.
 */

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

import { loadDotEnv, sqlClient } from "../../../../scripts/lib/db.mjs";

loadDotEnv();

let workerModule;
async function page(path) {
  workerModule ??= (await import(new URL(`../../dist/server/index.js?displayed-numbers=${randomUUID()}`, import.meta.url).href)).default;
  const response = await workerModule.fetch(
    new Request(`http://localhost${path}`, { headers: { accept: "text/html" } }),
    { ASSETS: { fetch: async () => new Response("Not found", { status: 404 }) } },
    { waitUntil() {}, passThroughOnException() {} },
  );
  const html = await response.text();
  return html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/g, "").replace(/<!-- -->/g, "").replace(/<[^>]+>/g, " ")
    .replace(/&#x27;|&apos;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, "&").replace(/\s+/g, " ");
}
const num = (text, re) => { const m = re.exec(text); return m ? Number(m[1].replace(/,/g, "")) : null; };

test("every number the product displays matches a direct query", async () => {
  const sql = await sqlClient();
  assert.ok(sql, "SUPABASE_DB_URL is not set. Start the local rig first: scripts/local-rig.sh up");
  const one = async (text, values) => (await sql.query(text, values)).rows[0];
  const all = async (text, values) => (await sql.query(text, values)).rows;
  try {
    const results = [];
    const check = (surface, claim, shown, truth) => results.push({ surface, claim, shown, truth, ok: shown === Number(truth) });

    const inScope = "r.scope_status = 'in_scope' and r.active";
    // Current forecast: the latest version, unless the role was declined after it (migration 202608140043).
    const latest = `select distinct on (f.canonical_role_id) f.* from public.forecasts f join public.canonical_roles cr on cr.id = f.canonical_role_id where cr.forecast_refused_at is null or f.forecasted_at > cr.forecast_refused_at order by f.canonical_role_id, f.forecasted_at desc, f.id`;

    // ---------------------------------------------------------------- dashboard
    const dash = await page("/");
    const roles = await one(`select count(*)::int n from public.canonical_roles r where ${inScope}`);
    const withForecast = await one(`select count(*)::int n from (${latest}) l join public.canonical_roles r on r.id = l.canonical_role_id where ${inScope}`);
    const companies = await one(`select count(distinct r.company_id)::int n from public.canonical_roles r where ${inScope}`);
    const outside = await one(`select count(*)::int n from public.canonical_roles r where r.active and r.scope_status is distinct from 'in_scope'`);
    const opened = await one(`select count(*)::int n from public.historical_opening_events e join public.canonical_roles r on r.id = e.canonical_role_id where ${inScope} and e.date_precision = 'exact' and e.opened_on >= current_date - 45`);
    const soon = await one(`select count(*)::int n from (${latest}) l join public.canonical_roles r on r.id = l.canonical_role_id where ${inScope} and l.window_start <= current_date + 30 and l.window_end >= current_date`);
    check("/ landing", "companies", num(dash, /career pages of ([\d,]+) companies/), companies.n);
    check("/ landing", "roles tracked", num(dash, /([\d,]+) early-career technical roles tracked/), roles.n);
    check("/ landing", "with a forecast", num(dash, /· ([\d,]+) with a forecast today/), withForecast.n);
    check("/ summary", "likely in 30 days", num(dash, /Likely in 30 days ([\d,]+) of/), soon.n);
    check("/ summary", "of N forecasts", num(dash, /Likely in 30 days [\d,]+ of ([\d,]+) forecast/), withForecast.n);
    check("/ summary", "confirmed openings, last 45 days", num(dash, /Confirmed openings ([\d,]+) exact source dates/), opened.n);
    check("/ timeline", "most recent of", num(dash, /The \d+ most recent of ([\d,]+)/), opened.n);
    check("/ list", "all in-scope roles", num(dash, /All ([\d,]+) in-scope roles:/), roles.n);
    check("/ list", "with a forecast", num(dash, /in-scope roles: ([\d,]+) with a forecast/), withForecast.n);
    check("/ list", "without a forecast", num(dash, /listed first, and ([\d,]+) without/), roles.n - withForecast.n);
    check("/ list", "outside or not yet in scope", num(dash, /([\d,]+) collected roles outside/), outside.n);

    // Facets: each value's count, against a direct group-by.
    const facets = await all(`select r.discipline::text v, count(*)::int n from public.canonical_roles r where ${inScope} group by 1`);
    for (const { v, n } of facets) {
      const label = v.replace(/_/g, " ");
      const shown = num(dash, new RegExp(`${label.charAt(0).toUpperCase()}${label.slice(1)} \\((\\d+)\\)`, "i"));
      if (shown !== null) check("/ facets", `discipline ${v}`, shown, n);
    }
    const programs = await all(`select r.early_career_type::text v, count(*)::int n from public.canonical_roles r where ${inScope} group by 1`);
    for (const { v, n } of programs) {
      const labels = { internship: "Internship", co_op: "Co-op", new_grad: "New grad", graduate_program: "Graduate program", apprenticeship: "Apprenticeship" };
      const shown = labels[v] ? num(dash, new RegExp(`${labels[v]} \\((\\d+)\\)`)) : null;
      if (shown !== null) check("/ facets", `program ${v}`, shown, n);
    }

    // Each listed card: "N cycles behind it · a exact, b observed by" against the latest forecast and current events.
    const cards = [...dash.matchAll(/(\d+) cycles? behind it · ([^·]*?)(?= (?:Own history|Borrowed timing|\d+ ))/g)];
    const incoherent = await one(`select count(*)::int n from (${latest}) l join public.canonical_roles r on r.id = l.canonical_role_id
      left join (select canonical_role_id, count(*) n from public.historical_opening_events group by 1) e on e.canonical_role_id = l.canonical_role_id
      where ${inScope} and l.history_count > coalesce(e.n, 0)`);
    check("/ cards", "forecasts claiming more cycles than the role has openings", 0, incoherent.n);
    results.push({ surface: "/ cards", claim: `cards read`, shown: cards.length, truth: "-", ok: cards.length > 0 });

    // ---------------------------------------------------------------- methodology
    const meth = await page("/methodology");
    const depth = await all(`select least(coalesce(l.history_count, 0), 3) k, count(*)::int n from (${latest}) l join public.canonical_roles r on r.id = l.canonical_role_id where ${inScope} group by 1`);
    const byK = Object.fromEntries(depth.map((row) => [row.k, row.n]));
    check("/methodology", "have a forecast", num(meth, /Today ([\d,]+) of [\d,]+ early-career roles have a forecast/), withForecast.n);
    check("/methodology", "of N roles", num(meth, /Today [\d,]+ of ([\d,]+) early-career roles/), roles.n);
    check("/methodology", "one cycle or none", num(meth, /([\d,]+) of those rest on one recruiting cycle/), (byK[0] ?? 0) + (byK[1] ?? 0));
    check("/methodology", "two cycles", num(meth, /Two cycles ([\d,]+)/), byK[2] ?? 0);
    check("/methodology", "three or more", num(meth, /Three or more cycles ([\d,]+)/), byK[3] ?? 0);
    check("/methodology", "no forecast", num(meth, /No forecast ([\d,]+)/), roles.n - withForecast.n);
    const run = await one(`select target_count, completed_cases, skipped_cases from public.backtest_runs order by finished_at desc, created_at desc, id limit 1`);
    check("/methodology", "backtest targets", num(meth, /went back to ([\d,]+) past openings/), run.target_count);

    // ---------------------------------------------------------------- replay
    const replay = await page("/replay");
    const replayRoles = await one(`select count(*)::int n from (select e.canonical_role_id from public.historical_opening_events e join public.canonical_roles r on r.id = e.canonical_role_id where ${inScope} group by 1 having count(*) >= 2) x`);
    check("/replay", "roles with two or more recorded openings", num(replay, /Roles with two or more recorded openings ([\d,]+)/), replayRoles.n);
    check("/replay", "backtest targets", num(replay, /· ([\d,]+) targets, [\d,]+ scored/), run.target_count);
    check("/replay", "backtest scored", num(replay, /targets, ([\d,]+) scored/), run.completed_cases);
    check("/replay", "candidates shown of", num(replay, /Showing 1–\d+ of ([\d,]+)/), num(replay, /Replay candidates ([\d,]+)/));

    // ---------------------------------------------------------------- role pages: the landing's featured role and a sample
    const sample = await all(`select r.id from public.canonical_roles r join (${latest}) l on l.canonical_role_id = r.id where ${inScope} order by l.confidence desc, r.id limit 5`);
    for (const { id } of sample) {
      const text = await page(`/roles/${id}`);
      const counts = await one(`select count(*) filter (where date_precision = 'exact')::int exact, count(*) filter (where date_precision = 'bounded')::int bounded, count(*) filter (where date_precision = 'observed_by')::int observed from public.historical_opening_events where canonical_role_id = $1`, [id]);
      const observations = await one(`select count(*)::int n from public.observation_role_matches where canonical_role_id = $1 and evidence_kind = 'observation_resolution'`, [id]);
      const provenance = await one(`select count(*)::int n from public.forecast_provenance where forecast_id = (select id from public.forecasts where canonical_role_id = $1 order by forecasted_at desc, id limit 1)`, [id]);
      const m = /(\d+) exact · (\d+) bounded · (\d+) observed-by/.exec(text);
      check(`/roles/${id.slice(0, 8)}`, "exact openings", m ? Number(m[1]) : null, counts.exact);
      check(`/roles/${id.slice(0, 8)}`, "bounded openings", m ? Number(m[2]) : null, counts.bounded);
      check(`/roles/${id.slice(0, 8)}`, "observed-by openings", m ? Number(m[3]) : null, counts.observed);
      check(`/roles/${id.slice(0, 8)}`, "linked observations", num(text, /Linked observations ([\d,]+)/), observations.n);
      check(`/roles/${id.slice(0, 8)}`, "contributions", num(text, /over all ([\d,]+) contributions/), provenance.n);
    }

    const wrong = results.filter((row) => !row.ok);
    assert.ok(results.length >= 40, `the audit read ${results.length} claims`);
    assert.deepEqual(wrong.map((row) => `${row.surface}: ${row.claim} shows ${row.shown}, the database says ${row.truth}`), []);
  } finally {
    await sql.end();
  }
});
