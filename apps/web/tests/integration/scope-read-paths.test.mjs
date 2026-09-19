/**
 * Integration test: product read paths return in-scope roles only.
 *
 * Needs a real Postgres with every migration applied: the local rig (`scripts/local-rig.sh up`)
 * or CI's Supabase service. It runs in `npm run test:integration`, not `npm run check`.
 *
 * Every synthetic row is written inside one transaction that is always rolled back. Domains use the
 * reserved `.invalid` TLD.
 *
 * Five otherwise identical roles, each with two exact openings, a stored forecast, and a company
 * follow: one in scope, one out of scope, one ambiguous, one never classified, and one in scope but
 * retired (`active = false`, as a re-resolution or a company withdrawal leaves it; migration
 * 202608140036). Only the first may reach the dashboard, its counts and filter options, a watchlist,
 * or Forecast Replay.
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

const SCOPES = {
  inScope: ["in_scope", "in_scope", "software_engineering", "internship"],
  outOfScope: ["out_of_scope", "non_technical_function", null, "internship"],
  ambiguous: ["ambiguous", "discipline_unknown", null, "internship"],
  unclassified: null,
  retired: ["in_scope", "in_scope", "software_engineering", "internship"],
};

test("out-of-scope, ambiguous, unclassified, and retired roles never reach a product read path", async () => {
  const connectionString = process.env.SUPABASE_DB_URL;
  assert.ok(connectionString, "SUPABASE_DB_URL is not set. Start the local rig first: scripts/local-rig.sh up");

  const client = await connectPg(connectionString);
  const one = async (sql, params = []) => (await client.query(sql, params)).rows[0];
  const all = async (sql, params = []) => (await client.query(sql, params)).rows;
  try {
    await client.query("begin");
    const now = new Date();
    const tag = `scope read test ${randomUUID().slice(0, 8)}`;
    const slug = tag.replace(/\W+/g, "-");
    const { id: companyId } = await one("insert into companies (name, domain) values ($1, $2) returning id", [tag, `${slug}.invalid`]);
    const { id: sourceId } = await one(
      "insert into sources (company_id, url, kind) values ($1, $2, 'ats') returning id",
      [companyId, `https://${slug}.invalid/jobs`],
    );
    const { id: observationId } = await one(
      `insert into raw_job_observations (source_id, observed_at, content_hash, extraction_method, raw_text)
       values ($1, now(), $2, 'api', 'synthetic row for a rolled-back integration test') returning id`,
      [sourceId, createHash("sha256").update(tag).digest("hex")],
    );

    const roles = {};
    for (const [name, scope] of Object.entries(SCOPES)) {
      const [status, reason, discipline, earlyCareerType] = scope ?? [null, null, null, null];
      const { id } = await one(
        `insert into canonical_roles
           (company_id, canonical_title, track, location_scope, recurrence_key, company_normalized, normalized_title, level,
            scope_status, scope_reason, discipline, early_career_type, scope_method, scope_classifier_version, scope_classified_at)
         values ($1, $2, 'internship', 'remote', $3, $4, lower($2), 'internship',
                 $5::public.role_scope_status, $6::text, $7::public.role_discipline, $8::public.early_career_type,
                 case when $5::public.role_scope_status is null then null else 'deterministic' end,
                 case when $5::public.role_scope_status is null then null else 'integration-test' end,
                 case when $5::public.role_scope_status is null then null else now() end)
         returning id`,
        [companyId, `Synthetic ${name} software engineer intern`, `synthetic_scope_${name.toLowerCase()}`, tag, status, reason, discipline, earlyCareerType],
      );
      roles[name] = id;
      await client.query(
        `insert into historical_opening_events
           (canonical_role_id, observation_id, opened_on, opening_window_start, opening_window_end,
            evidence_quote, source_quality, extraction_version, date_precision, provenance)
         select $1, $2, d.opened_on, d.opened_on, d.opened_on, 'synthetic', 0.9, 'integration-test', 'exact',
                '[{"kind":"integration_test"}]'::jsonb
         from (values (date '2024-06-01'), (date '2025-06-01')) as d(opened_on)`,
        [id, observationId],
      );
      await client.query(
        `insert into forecasts
           (canonical_role_id, as_of, point_date, window_start, window_end, confidence, confidence_factors,
            method, model_version, history_count, input_fingerprint, calibrated_probability)
         values ($1, current_date, current_date + 40, current_date + 30, current_date + 50, 40, '{}'::jsonb,
                 'integration-test', 'integration-test', 2, encode(sha256(convert_to($1::uuid::text, 'UTF8')), 'hex'), 0.4)`,
        [id],
      );
    }

    await client.query("update canonical_roles set active = false where id = $1", [roles.retired]);

    const userId = randomUUID();
    await client.query("insert into auth.users (id, email) values ($1, $2)", [userId, `${userId}@integration-test.invalid`]);
    await client.query("insert into profiles (id) values ($1) on conflict (id) do nothing", [userId]);
    await client.query("insert into watchlist_items (user_id, target_type, company_id) values ($1, 'company', $2)", [userId, companyId]);

    const states = await all("select role_id, forecastable from forecast_role_states($1) where company_name = $2", [now, tag]);
    assert.deepEqual(states, [{ role_id: roles.inScope, forecastable: true }]);

    const summary = await one("select * from dashboard_role_summary($1, $2, p_query => $3)", [now, userId, tag]);
    assert.equal(Number(summary.matching_roles), 1);
    const watched = await one("select * from dashboard_role_summary($1, $2, p_watched_only => true)", [now, userId]);
    assert.equal(Number(watched.followed_roles), 1);

    const page = await all(
      "select role_id from dashboard_role_page($1, $2, p_query => $3, p_per_company => 0, p_limit => 100)",
      [now, userId, tag],
    );
    assert.deepEqual(page.map((row) => row.role_id), [roles.inScope]);

    const followed = await all("select role_id from followed_role_ids($1)", [userId]);
    assert.deepEqual(followed.map((row) => row.role_id), [roles.inScope]);
    const alerting = await all("select role_id from followed_role_ids($1, true)", [userId]);
    assert.deepEqual(alerting.map((row) => row.role_id), [roles.inScope]);

    const options = await one("select roles from dashboard_filter_options() where facet = 'company' and value = $1", [companyId]);
    assert.equal(Number(options.roles), 1, "the company filter counts the one active in-scope role");

    const replay = await all("select role_id from replay_candidates($1, null, null, null)", [tag]);
    assert.deepEqual(replay.map((row) => row.role_id), [roles.inScope]);
    const replaySummary = await one("select matching from replay_candidate_summary($1, null, null, null)", [tag]);
    assert.equal(Number(replaySummary.matching), 1);

    // The table itself refuses an in-scope role without an evidenced discipline and type.
    await client.query("savepoint unevidenced");
    await assert.rejects(
      client.query(
        `update canonical_roles set discipline = null where id = $1`,
        [roles.inScope],
      ),
      /canonical_roles_in_scope_is_evidenced/,
    );
    await client.query("rollback to savepoint unevidenced");
  } finally {
    await client.query("rollback");
    await client.end();
  }
});
