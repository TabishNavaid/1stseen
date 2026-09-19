/**
 * Integration test: the bounded read paths stay complete past the PostgREST row cap.
 *
 * Needs a real Postgres with every migration applied: the local rig
 * (`scripts/local-rig.sh up`) or CI's Supabase service. It runs in `npm run
 * test:integration`, not `npm run check`, because the gate runs without a database.
 *
 * Every synthetic row is written inside one transaction that is always rolled back,
 * so nothing is committed and no real read path can ever see these rows. Domains use
 * the reserved `.invalid` TLD.
 *
 * What it proves, with more rows than PostgREST returns in one response:
 *   - dashboard counts are exact, never capped, and roles without a forecast are counted
 *   - paging the role list reaches every matching role once, forecasts first in window
 *     order, and a single call can never ask for more than the clamp
 *   - the default per-company collapse folds a company's roles and counts every one
 *   - follow expansion covering more roles than the cap is read completely when paged
 *     the way the loaders page it (limit/offset in cap-sized steps)
 *   - every Forecast Replay candidate is reachable by paging
 */

import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import test from "node:test";

import { connectPg, loadDotEnv } from "../../../../scripts/lib/db.mjs";

loadDotEnv();
const require = createRequire(import.meta.url);
const pg = require("pg");
pg.types.setTypeParser(1082, (value) => value);

const FORECASTABLE = 1_200;
const INSUFFICIENT = 1_050;
/** PostgREST's default db.max_rows, which supabase/config.toml also sets locally. */
const ROW_CAP = 1_000;

test("bounded read paths return complete results past the PostgREST row cap", async () => {
  const connectionString = process.env.SUPABASE_DB_URL;
  assert.ok(connectionString, "SUPABASE_DB_URL is not set. Start the local rig first: scripts/local-rig.sh up");

  const client = await connectPg(connectionString);
  const one = async (sql, params = []) => (await client.query(sql, params)).rows[0];
  try {
    await client.query("begin");
    const now = new Date();
    const before = {
      summary: await one("select * from dashboard_role_summary($1)", [now]),
      replay: await one("select * from replay_candidate_summary(null, null, null, null)"),
    };

    const tag = `bounded read test ${randomUUID().slice(0, 8)}`;
    const slug = tag.replace(/\W+/g, "-");
    const { id: companyId } = await one(
      "insert into companies (name, domain) values ($1, $2) returning id",
      [tag, `${slug}.invalid`],
    );
    const { id: sourceId } = await one(
      "insert into sources (company_id, url, kind) values ($1, $2, 'ats') returning id",
      [companyId, `https://${slug}.invalid/jobs`],
    );
    const { id: observationId } = await one(
      `insert into raw_job_observations (source_id, observed_at, content_hash, extraction_method, raw_text)
       values ($1, now(), $2, 'api', 'synthetic row for a rolled-back integration test') returning id`,
      [sourceId, createHash("sha256").update(tag).digest("hex")],
    );

    await client.query(
      `insert into canonical_roles
         (company_id, canonical_title, track, location_scope, recurrence_key, company_normalized, normalized_title, level,
          scope_status, scope_reason, discipline, early_career_type, scope_method, scope_classifier_version, scope_classified_at)
       select $1, 'Synthetic role ' || n, 'internship', 'remote', 'synthetic_role_' || n, $2, 'synthetic role ' || n, 'internship',
              'in_scope', 'in_scope', 'software_engineering', 'internship', 'deterministic', 'integration-test', now()
       from generate_series(1, $3::int) as n`,
      [companyId, tag, FORECASTABLE + INSUFFICIENT],
    );
    // The first FORECASTABLE roles by id get two exact cycles and a stored forecast.
    await client.query(
      `with forecastable as (
         select id from canonical_roles where company_id = $1 order by id limit $2
       )
       insert into historical_opening_events
         (canonical_role_id, observation_id, opened_on, opening_window_start, opening_window_end,
          evidence_quote, source_quality, extraction_version, date_precision, provenance)
       select f.id, $3, d.opened_on, d.opened_on, d.opened_on, 'synthetic', 0.9, 'integration-test', 'exact',
              '[{"kind":"integration_test"}]'::jsonb
       from forecastable f cross join (values (date '2024-06-01'), (date '2025-06-01')) as d(opened_on)`,
      [companyId, FORECASTABLE, observationId],
    );
    await client.query(
      `with forecastable as (
         select id, row_number() over (order by id) as n from canonical_roles where company_id = $1 order by id limit $2
       )
       insert into forecasts
         (canonical_role_id, as_of, point_date, window_start, window_end, confidence, confidence_factors,
          method, model_version, history_count, input_fingerprint, calibrated_probability)
       select id, current_date, current_date + (n % 400)::int, current_date + (n % 400)::int - 10,
              current_date + (n % 400)::int + 10, 40, '{}'::jsonb, 'integration-test', 'integration-test', 2,
              encode(sha256(convert_to(id::text, 'UTF8')), 'hex'), 0.4
       from forecastable`,
      [companyId, FORECASTABLE],
    );

    const userId = randomUUID();
    await client.query("insert into auth.users (id, email) values ($1, $2)", [userId, `${userId}@integration-test.invalid`]);
    await client.query("insert into profiles (id) values ($1) on conflict (id) do nothing", [userId]);
    await client.query(
      "insert into watchlist_items (user_id, target_type, company_id) values ($1, 'company', $2)",
      [userId, companyId],
    );

    // Counts are exact, not capped, and roles without a forecast are counted, not dropped.
    const matching = await one("select * from dashboard_role_summary($1, $2, p_query => $3, p_per_company => 0)", [now, userId, tag]);
    assert.equal(Number(matching.matching_roles), FORECASTABLE + INSUFFICIENT);
    assert.equal(Number(matching.matching_forecastable), FORECASTABLE);
    assert.equal(Number(matching.matching_insufficient), INSUFFICIENT);
    const after = await one("select * from dashboard_role_summary($1)", [now]);
    assert.equal(Number(after.forecastable_roles) - Number(before.summary.forecastable_roles), FORECASTABLE);
    assert.equal(Number(after.insufficient_roles) - Number(before.summary.insufficient_roles), INSUFFICIENT);
    const watched = await one("select * from dashboard_role_summary($1, $2, p_watched_only => true, p_per_company => 0)", [now, userId]);
    assert.equal(Number(watched.followed_roles), FORECASTABLE + INSUFFICIENT);
    assert.equal(Number(watched.followed_forecastable), FORECASTABLE);
    assert.equal(Number(watched.matching_roles), FORECASTABLE + INSUFFICIENT);

    // The default collapse lists three of the company's roles and counts the rest.
    const collapsed = await one("select * from dashboard_role_summary($1, $2, p_query => $3)", [now, userId, tag]);
    assert.equal(Number(collapsed.shown_roles), 3);
    assert.equal(Number(collapsed.collapsed_roles), FORECASTABLE + INSUFFICIENT - 3);
    assert.equal(Number(collapsed.collapsed_companies), 1);
    const firstScreen = await client.query("select company_rank, company_total from dashboard_role_page($1, $2, p_query => $3)", [now, userId, tag]);
    assert.deepEqual(firstScreen.rows.map((row) => [row.company_rank, row.company_total]), [1, 2, 3].map((rank) => [rank, FORECASTABLE + INSUFFICIENT]));

    // Paging the company view reaches every matching role exactly once: forecasts soonest first, then the rest.
    const listed = [];
    for (let offset = 0; ; offset += 100) {
      const { rows } = await client.query(
        `select role_id, canonical_title, forecastable, days_until
         from dashboard_role_page($1, $2, p_query => $3, p_per_company => 0, p_limit => 100, p_offset => $4)`,
        [now, userId, tag, offset],
      );
      if (rows.length === 0) break;
      listed.push(...rows);
    }
    assert.equal(listed.length, FORECASTABLE + INSUFFICIENT);
    assert.equal(new Set(listed.map((row) => row.role_id)).size, FORECASTABLE + INSUFFICIENT);
    assert.ok(listed.slice(0, FORECASTABLE).every((row) => row.forecastable), "forecasts come first");
    assert.ok(listed.slice(FORECASTABLE).every((row) => !row.forecastable), "then roles without enough history");
    for (let index = 1; index < FORECASTABLE; index += 1) {
      const [previous, current] = [listed[index - 1], listed[index]];
      assert.ok(
        previous.days_until < current.days_until
          || (previous.days_until === current.days_until && previous.canonical_title <= current.canonical_title),
        `forecast order broken at ${index}`,
      );
    }
    for (let index = FORECASTABLE + 1; index < listed.length; index += 1) {
      assert.ok(listed[index - 1].canonical_title <= listed[index].canonical_title, `insufficient order broken at ${index}`);
    }
    const clamped = await one(
      "select count(*)::int as n from dashboard_role_page($1, $2, p_query => $3, p_per_company => 0, p_limit => 5000)",
      [now, userId, tag],
    );
    assert.equal(clamped.n, 100, "a single page request is clamped far below the row cap");

    // Follow expansion larger than the cap, paged the way fetchAll pages it.
    const followed = new Set();
    for (let offset = 0; ; offset += ROW_CAP) {
      const { rows } = await client.query(
        `select role_id from followed_role_ids($1) order by role_id limit ${ROW_CAP} offset $2`,
        [userId, offset],
      );
      if (rows.length === 0) break;
      for (const row of rows) followed.add(row.role_id);
    }
    assert.ok(followed.size > ROW_CAP);
    assert.equal(followed.size, FORECASTABLE + INSUFFICIENT);

    // Every replay candidate is reachable, each held out on its most recent exact opening.
    const replayAfter = await one("select * from replay_candidate_summary(null, null, null, null)");
    assert.equal(Number(replayAfter.candidates) - Number(before.replay.candidates), FORECASTABLE);
    const syntheticTargets = [];
    for (let offset = 0; ; offset += 100) {
      const { rows } = await client.query("select * from replay_candidate_page(null, null, null, null, 100, $1)", [offset]);
      if (rows.length === 0) break;
      syntheticTargets.push(...rows.filter((row) => row.company_name === tag));
    }
    assert.equal(syntheticTargets.length, FORECASTABLE);
    assert.ok(syntheticTargets.every((row) => row.opened_on === "2025-06-01" && row.date_precision === "exact"));
  } finally {
    await client.query("rollback");
    await client.end();
  }
});
