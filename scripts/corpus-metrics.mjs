#!/usr/bin/env node
/**
 * Emit the corpus table from the system of record.
 *
 * Every row below is a direct aggregate over persisted evidence. The four
 * cycle-derived rows (model-ready cycles, roles by cycle count) are deliberately
 * NOT computed here: cohort collapse and repost exclusion live in
 * `worker/src/firstseen/cycles.py`, and reimplementing them in SQL would create a
 * second, silently divergent definition. Those rows are reported as pending with
 * the command that produces them.
 *
 * Verified against the local validation corpus: this query set reproduces the
 * published §5 numbers exactly.
 *
 * Usage: SUPABASE_DB_URL=... npm run metrics:corpus
 */

import { loadDotEnv, sqlClient, safeDbTarget } from "./lib/db.mjs";

loadDotEnv();

const fmt = (n) => (n === null || n === undefined ? "—" : Number(n).toLocaleString("en-US"));
const day = (v) => (v ? new Date(v).toISOString().slice(0, 10) : "—");

async function main() {
  const sql = await sqlClient();
  if (!sql) {
    process.stderr.write(
      "\nSUPABASE_DB_URL is not set.\n"
        + "Corpus aggregates need a direct Postgres session; PostgREST cannot express them.\n"
        + "  SUPABASE_DB_URL='postgres://postgres:<db-password>@db.<ref>.supabase.co:5432/postgres' npm run metrics:corpus\n\n",
    );
    process.exitCode = 1;
    return;
  }

  try {
    const one = async (text) => (await sql.query(text)).rows[0];
    const many = async (text) => (await sql.query(text)).rows;

    const c = await one(`select
      (select count(*) from companies)                                                    companies,
      (select count(*) from sources)                                                      sources,
      (select count(*) from raw_job_observations)                                         observations,
      (select count(*) from raw_job_observations where archive_capture_at is not null)    archive_observations,
      (select count(*) from archive_captures)                                             captures,
      (select count(*) from canonical_roles)                                              roles,
      (select count(*) from canonical_roles where level in ('internship','new_grad'))     early_career_roles,
      (select count(*) from observation_role_matches)                                     evidence_rows,
      (select count(*) from observation_role_matches
         where evidence_kind = 'archive_page_attribution')                                archive_attributions,
      (select count(*) from historical_opening_events)                                    events,
      (select count(*) from forecasts)                                                    forecasts,
      (select count(*) from signals)                                                      signals`);

    const multi = await one(`select count(*)::int multi, coalesce(max(n), 0)::int max_roles from (
      select observation_id, count(*) n from observation_role_matches group by 1 having count(*) > 1) s`);

    const precision = Object.fromEntries(
      (await many(`select date_precision, count(*)::int n from historical_opening_events group by 1`))
        .map((r) => [r.date_precision, r.n]),
    );

    const forecast = await one(
      `select max(confidence) max_confidence, max(history_count) max_history from forecasts`,
    );
    const earlyForecasts = await one(
      `select count(*)::int n from forecasts f
         join canonical_roles r on r.id = f.canonical_role_id
        where r.level in ('internship','new_grad')`,
    );
    const span = await one(
      `select min(opened_on) lo, max(opened_on) hi
         from historical_opening_events where date_precision = 'exact'`,
    );
    const adapters = await many(
      `select adapter, count(*)::int n from sources group by 1 order by n desc, adapter`,
    );

    /*
     * Two role matches for the same (observation, role) pair that disagree on the
     * decision would be contradictory evidence under one identity. The composite
     * primary key makes that unrepresentable, so this is an assertion, not an
     * estimate — it should always be zero.
     */
    const conflicts = await one(
      `select count(*)::int n from (
         select observation_id, canonical_role_id
           from observation_role_matches
          group by 1, 2
         having count(distinct decision) > 1) s`,
    );

    const adapterSummary = adapters.map((a) => `${a.adapter} ${a.n}`).join(", ");
    const rows = [
      ["Companies", fmt(c.companies)],
      ["Observations", `${fmt(c.observations)} (${fmt(c.archive_observations)} archive)`],
      ["Archive captures", fmt(c.captures)],
      ["Canonical roles", `${fmt(c.roles)} (${fmt(c.early_career_roles)} early-career)`],
      ["Role-evidence rows", `${fmt(c.evidence_rows)} (${fmt(c.archive_attributions)} archive attributions)`],
      ["Multi-role observations / max per observation", `${fmt(multi.multi)} / **${fmt(multi.max_roles)}**`],
      ["Conflicts", `**${fmt(conflicts.n)}**`],
      [
        "Historical events",
        `${fmt(c.events)} — **${fmt(precision.exact ?? 0)} exact**, ${fmt(precision.observed_by ?? 0)} \`observed_by\`, `
          + `**${fmt(precision.bounded ?? 0)} \`bounded\`**`,
      ],
      ["Model-ready cycles", "_pending — `.venv/bin/firstseen backtest --cutoff-days 60` reports the target count_"],
      ["Roles ≥2 cycles", "_pending — cycle counts come from `cycles.py`, not SQL_"],
      ["Early-career ≥2 cycles / ≥3", "_pending — same source_"],
      [
        "Forecasts",
        // A confidence score is a score out of 100, not a probability, so it is never written as a percentage.
        `${fmt(c.forecasts)} (${fmt(earlyForecasts.n)} early-career), max confidence score `
          + `${forecast.max_confidence === null ? "—" : `${Number(forecast.max_confidence).toFixed(0)} of 100`}`
          + `, max \`history_count\` ${fmt(forecast.max_history)}`,
      ],
      ["Configured sources", `${fmt(c.sources)} (${adapterSummary})`],
      [
        "Signals collected",
        Number(c.signals) === 0
          ? "**0** — signal collection has not been run against this corpus"
          : fmt(c.signals),
      ],
      ["Exact-event span", `${day(span.lo)} → ${day(span.hi)}`],
    ];

    process.stdout.write(`\nCorpus metrics — ${safeDbTarget(process.env.SUPABASE_DB_URL)}\n`);
    process.stdout.write(`Measured ${new Date().toISOString().slice(0, 10)}\n\n`);
    process.stdout.write("| Metric | Value |\n|---|---|\n");
    for (const [k, v] of rows) process.stdout.write(`| ${k} | ${v} |\n`);
    process.stdout.write("\n");

    if (conflicts.n > 0) {
      process.stderr.write(
        `WARNING: ${conflicts.n} observation/role pairs carry conflicting decisions. `
          + "That is invalid input, not multiple confidence votes — investigate before trusting forecasts.\n\n",
      );
      process.exitCode = 1;
    }
  } finally {
    await sql.end();
  }
}

main().catch((error) => {
  process.stderr.write(`\ncorpus-metrics failed: ${error.message}\n\n`);
  process.exitCode = 1;
});
