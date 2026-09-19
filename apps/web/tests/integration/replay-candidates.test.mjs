/**
 * Integration test: Forecast Replay paging, filters, and backtest outcome labels
 * (supabase/migrations/202608140025_replay_paging_filters.sql).
 *
 * Same harness as bounded-read-paths.test.mjs: a real Postgres with every migration
 * applied, every synthetic row inside one transaction that is always rolled back, and
 * reserved `.invalid` domains. Runs in `npm run test:integration`, not the gate.
 *
 * What it proves:
 *   - a role whose openings are all `observed_by` is never a candidate, only an excluded count
 *   - the held-out target is the most recent exact or bounded opening
 *   - a candidate's outcome comes from the latest persisted backtest run and is matched on
 *     its exact held-out event: scored; skipped with that event's own reason; `other_event`
 *     when the run held out a different event of the same role and year (no borrowed
 *     reason); `not_in_run` otherwise
 *   - an older run never labels a candidate
 *   - the reason distribution is the latest run's, in the runner's words
 *   - company, literal search, precision, and outcome filters; paging; the page clamp;
 *     and service-only execution
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

const NO_EVIDENCE = "no temporal evidence was available by the forecast cutoff";
const SPARSE = "sparse role history had no sourced company or role-family prior";
const OLD_REASON = "reason from an older run that must never label a candidate";
const hex = (value) => createHash("sha256").update(value).digest("hex");
const REPLAY_FUNCTIONS = [
  "public.replay_latest_backtest_outcomes()",
  "public.replay_candidates(text, text, text, text)",
  "public.replay_candidate_page(text, text, text, text, integer, integer)",
  "public.replay_candidate_summary(text, text, text, text)",
  "public.replay_candidate_companies()",
  "public.replay_backtest_reasons()",
];

test("replay candidates are paged, filtered, and labelled from the latest backtest run by exact event", async () => {
  const connectionString = process.env.SUPABASE_DB_URL;
  assert.ok(connectionString, "SUPABASE_DB_URL is not set. Start the local rig first: scripts/local-rig.sh up");

  const client = await connectPg(connectionString);
  const one = async (sql, params = []) => (await client.query(sql, params)).rows[0];
  const all = async (sql, params = []) => (await client.query(sql, params)).rows;
  try {
    await client.query("begin");
    const before = await one("select * from replay_candidate_summary(null, null, null, null)");

    const tag = `replay candidates test ${randomUUID().slice(0, 8)}`;
    const slug = tag.replace(/\W+/g, "-");
    const { id: companyId } = await one("insert into companies (name, domain) values ($1, $2) returning id", [tag, `${slug}.invalid`]);
    const { id: sourceId } = await one(
      "insert into sources (company_id, url, kind) values ($1, $2, 'ats') returning id",
      [companyId, `https://${slug}.invalid/jobs`],
    );
    const { id: observationId } = await one(
      `insert into raw_job_observations (source_id, observed_at, content_hash, extraction_method, raw_text)
       values ($1, now(), $2, 'api', 'synthetic row for a rolled-back integration test') returning id`,
      [sourceId, hex(tag)],
    );

    const role = async (title) => (await one(
      `insert into canonical_roles
         (company_id, canonical_title, track, location_scope, recurrence_key, company_normalized, normalized_title, level,
          scope_status, scope_reason, discipline, early_career_type, scope_method, scope_classifier_version, scope_classified_at)
       values ($1, $2, 'internship', 'remote', $3, $4, lower($2), 'internship',
               'in_scope', 'in_scope', 'software_engineering', 'internship', 'deterministic', 'integration-test', now()) returning id`,
      [companyId, title, `synthetic_${hex(title).slice(0, 16)}`, tag],
    )).id;
    const event = async (roleId, openedOn, precision) => (await one(
      `insert into historical_opening_events
         (canonical_role_id, observation_id, opened_on, opening_window_start, opening_window_end,
          evidence_quote, source_quality, extraction_version, date_precision, provenance)
       values ($1, $2, $3::date,
               case $4 when 'exact' then $3::date when 'bounded' then $3::date - 10 else null end,
               $3::date, 'synthetic', 0.9, 'integration-test', $4, '[{"kind":"integration_test"}]'::jsonb)
       returning id`,
      [roleId, observationId, openedOn, precision],
    )).id;

    const roles = {
      scored: await role("Synthetic replay scored"),
      skipped: await role("Synthetic replay skipped"),
      other: await role("Synthetic replay other event"),
      absent: await role("Synthetic replay absent"),
      bounded: await role("Synthetic replay bounded"),
      literal: await role("Synthetic replay 50% literal"),
      observedOnly: await role("Synthetic replay observed only"),
    };
    const events = {
      scored: [await event(roles.scored, "2024-06-01", "exact"), await event(roles.scored, "2025-06-01", "exact")],
      skipped: [await event(roles.skipped, "2024-06-01", "exact"), await event(roles.skipped, "2025-06-01", "exact")],
      other: [
        await event(roles.other, "2024-06-01", "exact"),
        await event(roles.other, "2025-03-01", "exact"),
        await event(roles.other, "2025-06-01", "exact"),
      ],
      absent: [await event(roles.absent, "2024-06-01", "exact"), await event(roles.absent, "2025-05-01", "exact")],
      bounded: [await event(roles.bounded, "2024-06-01", "exact"), await event(roles.bounded, "2025-04-01", "bounded")],
      literal: [await event(roles.literal, "2024-06-01", "exact"), await event(roles.literal, "2025-02-01", "exact")],
      observedOnly: [await event(roles.observedOnly, "2024-06-01", "observed_by"), await event(roles.observedOnly, "2025-06-01", "observed_by")],
    };

    const skipped = (roleId, eventId, year, reason) => ({
      role_id: roleId, target_event_id: eventId, target_year: year, forecast_cutoff: `${year}-01-01`, reason,
    });
    const insertRun = async (finishedOffset, skippedTargets, completed) => (await one(
      `insert into backtest_runs
         (output_schema_version, model_version, model_versions, status, dataset_fingerprint, cutoff_days,
          started_at, finished_at, target_count, completed_cases, skipped_cases, aggregate_metrics, calibration_metrics)
       values ('integration-test', 'integration-test', '{integration-test}', 'succeeded', $1, 60,
               now() + $2::interval - interval '1 minute', now() + $2::interval, $3, $4, $5, '{}'::jsonb, $6::jsonb)
       returning id`,
      [hex(`${tag}${finishedOffset}`), finishedOffset, completed + skippedTargets.length, completed, skippedTargets.length,
        JSON.stringify({ skipped_targets: skippedTargets })],
    )).id;

    // An older run that skipped the scored role's target. It must never label anything.
    await insertRun("-2 days", [skipped(roles.scored, events.scored[1], 2025, OLD_REASON)], 0);
    // The latest run: scores one target, skips this exact event for one role, skips the
    // same role's 2024 target for another reason, and holds out a different 2025 event
    // for the "other" role.
    const latestRunId = await insertRun("1 day", [
      skipped(roles.skipped, events.skipped[1], 2025, NO_EVIDENCE),
      skipped(roles.skipped, events.skipped[0], 2024, SPARSE),
      skipped(roles.other, events.other[1], 2025, SPARSE),
    ], 1);
    await client.query(
      `insert into backtest_cases
         (run_id, canonical_role_id, target_event_id, target_year, forecast_cutoff, actual_opened_on,
          actual_interval_start, actual_interval_end, target_date_precision, expected_opening_date,
          interval_start, interval_end, confidence, absolute_error_days, inside_interval, interval_width_days,
          history_observations, target_source_quality, source_quality_bucket, company_prior_observations,
          role_family_prior_observations, model_version, input_fingerprint, input_event_ids, input_signal_ids,
          latest_input_available_at, latest_input_available_on)
       values ($1, $2, $3, 2025, '2025-04-02', '2025-06-01', '2025-06-01', '2025-06-01', 'exact', '2025-06-05',
               '2025-05-20', '2025-06-20', 50, 4, true, 31, 1, 0.9, 'high', 0, 0, 'integration-test', $4,
               array[$5::uuid], '{}', '2025-01-01T00:00:00Z', '2025-01-01')`,
      [latestRunId, roles.scored, events.scored[1], hex(`${tag}case`), events.scored[0]],
    );

    // Structural totals: six candidates, one exclusion.
    const after = await one("select * from replay_candidate_summary(null, null, null, null)");
    const delta = (column) => Number(after[column]) - Number(before[column]);
    assert.equal(delta("roles_with_history"), 7);
    assert.equal(delta("observed_by_only"), 1);
    assert.equal(delta("candidates"), 6);
    assert.equal(delta("exact_candidates"), 5);
    assert.equal(delta("bounded_candidates"), 1);

    // One page holds every synthetic candidate, most recent target first, ties by role id.
    const listed = await all("select * from replay_candidate_page($1, null, null, null, 100, 0)", [tag]);
    assert.equal(listed.length, 6);
    assert.ok(!listed.some((row) => row.role_id === roles.observedOnly), "an observed_by-only role became a candidate");
    for (let index = 1; index < listed.length; index += 1) {
      const [previous, current] = [listed[index - 1], listed[index]];
      assert.ok(
        previous.opened_on > current.opened_on || (previous.opened_on === current.opened_on && previous.role_id < current.role_id),
        `page order broken at ${index}`,
      );
    }

    const byRole = new Map(listed.map((row) => [row.role_id, row]));
    const expect = (key, targetEvent, outcome, reason, precision = "exact") => {
      const row = byRole.get(roles[key]);
      assert.ok(row, `${key} is missing`);
      assert.equal(row.target_event_id, targetEvent, `${key} held out the wrong event`);
      assert.equal(row.date_precision, precision, `${key} precision`);
      assert.equal(row.latest_outcome, outcome, `${key} outcome`);
      assert.equal(row.skip_reason, reason, `${key} reason`);
    };
    expect("scored", events.scored[1], "scored", null);
    expect("skipped", events.skipped[1], "skipped", NO_EVIDENCE);
    expect("other", events.other[2], "other_event", null);
    expect("absent", events.absent[1], "not_in_run", null);
    expect("bounded", events.bounded[1], "not_in_run", null, "bounded");
    expect("literal", events.literal[1], "not_in_run", null);

    // Filters.
    const matching = async (company, query, precision, outcome) =>
      Number((await one("select matching from replay_candidate_summary($1, $2, $3, $4)", [company, query, precision, outcome])).matching);
    assert.equal(await matching(tag, null, "bounded", null), 1);
    assert.equal(await matching(tag, null, "exact", null), 5);
    assert.equal(await matching(tag, null, "exact", "skipped"), 1);
    assert.equal(await matching(tag, null, null, "other_event"), 1);
    assert.equal(await matching(tag, null, null, "scored"), 1);
    assert.equal(await matching(tag, null, null, "not_in_run"), 3);
    assert.equal(await matching(tag, "50%", null, null), 1, "search is literal text");
    assert.equal(await matching(tag, "5_%", null, null), 0, "an underscore is not a wildcard");
    assert.equal(await matching(tag, "SYNTHETIC REPLAY 50%", null, null), 1, "search is case-insensitive");
    assert.equal(await matching(tag, "   ", null, null), 6, "a blank search is no search");
    assert.equal(await matching(`${tag} nobody`, null, null, null), 0);

    // Paging reaches each candidate exactly once, and a single page is clamped.
    const paged = [];
    for (let offset = 0; ; offset += 2) {
      const rows = await all("select role_id from replay_candidate_page($1, null, null, null, 2, $2)", [tag, offset]);
      if (rows.length === 0) break;
      assert.ok(rows.length <= 2);
      paged.push(...rows.map((row) => row.role_id));
    }
    assert.deepEqual(paged, listed.map((row) => row.role_id));
    const clamped = await one("select count(*)::int as n from replay_candidate_page(null, null, null, null, 5000, 0)");
    assert.ok(clamped.n <= 100, "a single page request is clamped");

    // The reason distribution is the latest run's, most frequent first.
    const reasons = await all("select * from replay_backtest_reasons()");
    assert.ok(reasons.every((row) => row.run_id === latestRunId), "reasons came from a run other than the latest");
    assert.deepEqual(
      reasons.map((row) => [row.reason, Number(row.targets)]),
      [[SPARSE, 2], [NO_EVIDENCE, 1]],
    );
    assert.equal(Number(reasons[0].target_count), 4);
    assert.equal(Number(reasons[0].completed_cases), 1);
    assert.ok(!listed.some((row) => row.skip_reason === OLD_REASON), "an older run labelled a candidate");

    const companies = await all("select * from replay_candidate_companies() where company_name = $1", [tag]);
    assert.deepEqual(companies.map((row) => [row.company_name, Number(row.candidates)]), [[tag, 6]]);

    for (const fn of REPLAY_FUNCTIONS) {
      const grants = await one(
        `select has_function_privilege('anon', $1, 'EXECUTE') as anon,
                has_function_privilege('authenticated', $1, 'EXECUTE') as authenticated,
                has_function_privilege('service_role', $1, 'EXECUTE') as service_role`,
        [fn],
      );
      assert.deepEqual(grants, { anon: false, authenticated: false, service_role: true }, `${fn} grants`);
    }
  } finally {
    await client.query("rollback");
    await client.end();
  }
});
