/**
 * Integration test: a stored forecast is shown wherever it exists (migration 202608140035).
 *
 * Needs a real Postgres with every migration applied: the local rig (`scripts/local-rig.sh up`) or CI's Supabase
 * service. It runs in `npm run test:integration`, not `npm run check`.
 *
 * The dashboard used to list a one-cycle forecast as "a role without enough history" while its role page, the calendar
 * and the readiness planner showed the same forecast. Three otherwise identical in-scope roles: one whose stored forecast
 * rests on one recruiting cycle, one on two, and one that forecasting.py refused and has no forecast. The first two are
 * forecasts on the dashboard; only the third is listed without a window, and the methodology page's depth count
 * places each where it belongs.
 *
 * Every synthetic row is written inside one transaction that is always rolled back. Domains use the reserved `.invalid`
 * TLD.
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

const ROLES = { oneCycle: 1, twoCycles: 2, refused: null };

test("a one-cycle forecast is a forecast on the dashboard, and only a refused role has no window", async () => {
  const connectionString = process.env.SUPABASE_DB_URL;
  assert.ok(connectionString, "SUPABASE_DB_URL is not set. Start the local rig first: scripts/local-rig.sh up");

  const client = await connectPg(connectionString);
  const one = async (sql, params = []) => (await client.query(sql, params)).rows[0];
  const all = async (sql, params = []) => (await client.query(sql, params)).rows;
  const depth = async (now) => Object.fromEntries(
    (await all("select history_count, roles from forecast_history_depth($1)", [now])).map((row) => [String(row.history_count), Number(row.roles)]),
  );
  try {
    await client.query("begin");
    const now = new Date();
    const before = await depth(now);
    const tag = `forecast shown test ${randomUUID().slice(0, 8)}`;
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

    const ids = {};
    for (const [name, historyCount] of Object.entries(ROLES)) {
      const { id } = await one(
        `insert into canonical_roles
           (company_id, canonical_title, track, location_scope, recurrence_key, company_normalized, normalized_title, level,
            scope_status, scope_reason, discipline, early_career_type, scope_method, scope_classifier_version, scope_classified_at)
         values ($1, $2, 'internship', 'remote', $3, $4, lower($2), 'internship',
                 'in_scope', 'in_scope', 'software_engineering', 'internship', 'deterministic', 'integration-test', now())
         returning id`,
        [companyId, `Synthetic ${name} software engineer intern`, `synthetic_shown_${name.toLowerCase()}`, tag],
      );
      ids[name] = id;
      await client.query(
        `insert into historical_opening_events
           (canonical_role_id, observation_id, opened_on, opening_window_start, opening_window_end,
            evidence_quote, source_quality, extraction_version, date_precision, provenance)
         values ($1, $2, date '2025-06-01', date '2025-06-01', date '2025-06-01', 'synthetic', 0.9, 'integration-test', 'exact',
                 '[{"kind":"integration_test"}]'::jsonb)`,
        [id, observationId],
      );
      if (historyCount === null) continue;
      await client.query(
        `insert into forecasts
           (canonical_role_id, as_of, point_date, window_start, window_end, confidence, confidence_factors,
            method, model_version, history_count, input_fingerprint, calibrated_probability)
         values ($1, current_date, current_date + 40, current_date + 10, current_date + 70, 44, '{}'::jsonb,
                 'integration-test', 'integration-test', $2, encode(sha256(convert_to($1::uuid::text, 'UTF8')), 'hex'), 0.44)`,
        [id, historyCount],
      );
    }

    const states = await all(
      "select role_id, forecastable, has_forecast, history_count from forecast_role_states($1) where company_name = $2 order by canonical_title",
      [now, tag],
    );
    const byId = new Map(states.map((row) => [row.role_id, row]));
    assert.equal(byId.get(ids.oneCycle).forecastable, true, "a one-cycle stored forecast is a forecast");
    assert.equal(byId.get(ids.twoCycles).forecastable, true);
    assert.equal(byId.get(ids.refused).forecastable, false, "a role forecasting.py refused has no window");
    for (const row of states) assert.equal(row.forecastable, row.has_forecast, "shown exactly when a forecast is stored");

    const listed = await all(
      "select role_id, forecastable, window_start from dashboard_role_page($1, null, p_companies => $2::uuid[], p_per_company => 0, p_limit => 10, p_offset => 0)",
      [now, [companyId]],
    );
    assert.deepEqual(listed.map((row) => row.forecastable), [true, true, false], "forecasts first, then the refused role");
    assert.ok(listed.slice(0, 2).every((row) => row.window_start !== null));

    const summary = await one("select matching_forecastable, matching_insufficient from dashboard_role_summary($1, null, p_companies => $2::uuid[])", [now, [companyId]]);
    assert.equal(Number(summary.matching_forecastable), 2);
    assert.equal(Number(summary.matching_insufficient), 1);

    const narrowed = await all(
      "select role_id from dashboard_role_page($1, null, p_companies => $2::uuid[], p_min_cycles => 2, p_per_company => 0, p_limit => 10, p_offset => 0)",
      [now, [companyId]],
    );
    assert.deepEqual(narrowed.map((row) => row.role_id), [ids.twoCycles], "the cycles filter is how a reader narrows to deeper histories");

    const after = await depth(now);
    const delta = (bucket) => (after[bucket] ?? 0) - (before[bucket] ?? 0);
    assert.equal(delta("1"), 1);
    assert.equal(delta("2"), 1);
    assert.equal(delta("null"), 1);
  } finally {
    await client.query("rollback").catch(() => {});
    await client.end();
  }
});
