/**
 * Integration test: a role the model declined has no current forecast until the model forecasts it again
 * (migration 202608140043).
 *
 * Needs the local rig. Everything happens in one transaction that is always rolled back.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { loadDotEnv, sqlClient } from "../../../../scripts/lib/db.mjs";

loadDotEnv();

test("a refusal after a role's latest forecast takes it off every read path, and a newer forecast restores it", async () => {
  const sql = await sqlClient();
  assert.ok(sql, "SUPABASE_DB_URL is not set. Start the local rig first: scripts/local-rig.sh up");
  try {
    await sql.query("begin");
    const { rows: [role] } = await sql.query(
      `select s.role_id, f.id as forecast_id, f.forecasted_at
         from public.forecast_role_states(now()) s
         join lateral (select id, forecasted_at from public.forecasts where canonical_role_id = s.role_id
                       order by forecasted_at desc, id limit 1) f on true
        where s.has_forecast and s.role_id not in (select id from public.canonical_roles where forecast_refused_at is not null)
        order by s.role_id limit 1`,
    );
    assert.ok(role, "the rig has a role with a current forecast");
    const state = async () => (await sql.query("select has_forecast, window_start from public.forecast_role_states(now()) where role_id = $1", [role.role_id])).rows[0];
    const basis = async () => (await sql.query("select count(*)::int as n from public.forecast_basis(array[$1]::uuid[])", [role.role_id])).rows[0].n;
    const listed = async () => (await sql.query("select count(*)::int as n from public.dashboard_role_facts(now(), null) where role_id = $1 and forecastable", [role.role_id])).rows[0].n;

    assert.equal((await state()).has_forecast, true);
    assert.equal(await basis(), 1);

    await sql.query(
      "update public.canonical_roles set forecast_refused_at = $2::timestamptz + interval '1 second', forecast_refusal_reason = 'Sparse role history requires a sourced company or role-family seasonal prior' where id = $1",
      [role.role_id, role.forecasted_at],
    );
    assert.deepEqual(await state(), { has_forecast: false, window_start: null }, "the old window is not shown as current");
    assert.equal(await basis(), 0, "and has no basis");
    assert.equal(await listed(), 0, "and the dashboard does not list it as forecastable");

    // The model forecasts the role again: a version newer than the refusal is current, with nothing to clear.
    await sql.query(
      `insert into public.forecasts (canonical_role_id, as_of, point_date, window_start, window_end, confidence, calibrated_probability,
         confidence_factors, feature_contributions, method, model_version, forecasted_at, history_count, prior_effective_sample_size,
         prediction_interval_coverage, input_fingerprint)
       select canonical_role_id, as_of, point_date, window_start, window_end, confidence, calibrated_probability, confidence_factors,
         feature_contributions, method, model_version, now() + interval '1 hour', history_count, prior_effective_sample_size,
         prediction_interval_coverage, md5(input_fingerprint) || md5(input_fingerprint || 'again')
       from public.forecasts where id = $1`,
      [role.forecast_id],
    );
    assert.equal((await state()).has_forecast, true);
    assert.equal(await basis(), 1);
  } finally {
    await sql.query("rollback").catch(() => undefined);
    await sql.end();
  }
});
