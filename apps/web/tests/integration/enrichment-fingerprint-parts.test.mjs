/**
 * Integration test: the enrichment fingerprint moves for content, not for plumbing (migrations 202608140059/060).
 *
 * This is the premise the whole enrichment skip rests on, and nothing tested it. `worker/tests/test_enrichment_skip.py`
 * drives the loop with a fake repository and a fake service whose steady company's fingerprint is hard-coded never to
 * move, so it pins the loop's bookkeeping and says nothing about whether a real pass over real evidence leaves a real
 * fingerprint where it found it. On 2026-10-20 it did not: four completed collection runs each reported
 * companies_unchanged = 0 of 80, because `fetches` hashed the text of each source's latest fetch status and that text
 * moves whenever a collector emits a diagnostic, however unchanged the company's content is.
 *
 * The company here has an archive capture, which the earlier local fixture lacked and which is the only reason
 * `fetches` is in the fingerprint at all: a degraded source demotes its captures, so the resolver may then prove a
 * role was present but never that it was absent.
 *
 * Needs the local rig (`scripts/local-rig.sh up`). Everything happens in one transaction that is always rolled back.
 *
 * Proven to fail when the prevention is removed: 202608140059's definition was reapplied over 202608140060's, which
 * restores `coalesce(l.error ->> 'status', '')` in place of `= 'degraded'`, and this test went red on exactly the
 * assertion below that a diagnostic must not move the fetches component -- expected ee9b7607e59a41539a94845978a25c88,
 * got b655e789fd6be2e6f73ded4dfe5399c8. The discriminating case is specifically a *complete* fetch carrying a
 * diagnostic: a null error and a degraded error differ under both definitions, so only that one tells them apart.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { loadDotEnv, sqlClient } from "../../../../scripts/lib/db.mjs";

loadDotEnv();

const COMPANY = "1a111111-1111-4111-8111-111111111111";
const SOURCE = "1a222222-2222-4222-8222-222222222222";
const OBSERVATION = "1a333333-3333-4333-8333-000000000001";
const CAPTURE = "1a444444-4444-4444-8444-000000000001";

/** A 64-character lowercase hex string, which every content hash in the schema is checked against. */
const hex64 = (seed) => seed.padEnd(64, "0").slice(0, 64).replace(/[^a-f0-9]/g, "a");

async function buildCompany(sql) {
  await sql.query(
    `insert into public.companies (id, name, domain, careers_url, is_fixture)
     values ($1, 'Fingerprint Parts Example', 'fingerprint-parts.example',
             'https://fingerprint-parts.example/careers', true)`,
    [COMPANY],
  );
  await sql.query(
    `insert into public.sources (id, company_id, url, kind, adapter, enabled)
     values ($1, $2, 'https://fingerprint-parts.example/careers', 'careers_page', 'wayback', true)`,
    [SOURCE, COMPANY],
  );
  await sql.query(
    `insert into public.raw_job_observations
       (id, source_id, observed_at, content_hash, extraction_method, raw_text, source_url, raw_title, company_name,
        first_seen_at, last_seen_at, source_type, evidence_excerpt, archive_capture_at, archive_url,
        archive_original_url)
     values ($1, $2, '2024-09-09', $3, 'archive', 'Careers page capture',
             'https://fingerprint-parts.example/careers', 'Careers', 'Fingerprint Parts Example',
             '2024-09-09', '2024-09-09', 'archive', 'Software Engineer Intern', '2024-09-09',
             'https://web.archive.org/web/2024/fingerprint-parts.example/careers',
             'https://fingerprint-parts.example/careers')`,
    [OBSERVATION, SOURCE, hex64("cap")],
  );
  // The capture is what puts this source's fetch status into the fingerprint in the first place.
  await sql.query(
    `insert into public.archive_captures
       (id, source_id, observation_id, original_url, archive_url, captured_at, status_code, change_kind,
        completeness, is_partial, evidence_excerpt)
     values ($1, $2, $3, 'https://fingerprint-parts.example/careers',
             'https://web.archive.org/web/2024/fingerprint-parts.example/careers', '2024-09-09', 200,
             'meaningful_change', 1.0, false, 'Software Engineer Intern')`,
    [CAPTURE, SOURCE, OBSERVATION],
  );
}

/** Record one more fetch of the source, newest wins, and return the company's fingerprint and its components. */
async function fetched(sql, error, at) {
  await sql.query(
    `insert into public.source_fetches (source_id, fetched_at, content_hash, extraction_route, byte_count, error)
     values ($1, $2, $3, 'archive', 1000, $4)`,
    [SOURCE, at, hex64("fetch"), error],
  );
  return state(sql);
}

async function state(sql) {
  const { rows } = await sql.query(
    `select p.fingerprint, p.parts,
            (select count(*) from public.latest_source_fetch_errors(array[$2]::uuid[]) l
              where l.error ->> 'status' = 'degraded') as degraded
       from public.company_enrichment_fingerprint_parts(array[$1]::uuid[]) p`,
    [COMPANY, SOURCE],
  );
  assert.equal(rows.length, 1, "the company has exactly one fingerprint");
  return rows[0];
}

test("the fingerprint moves for content and for a degraded source, and not for a fetch diagnostic", async () => {
  const sql = await sqlClient();
  assert.ok(sql, "SUPABASE_DB_URL is not set. Start the local rig first: scripts/local-rig.sh up");
  try {
    await sql.query("begin");
    await buildCompany(sql);

    // The two functions must agree, or deploying the parts function would invalidate every stored no-op key and
    // throw away whatever convergence the corpus had.
    const complete = await fetched(sql, null, "2026-10-20T10:00:00Z");
    const { rows: [combined] } = await sql.query(
      "select fingerprint from public.company_enrichment_fingerprints(array[$1]::uuid[])",
      [COMPANY],
    );
    assert.equal(
      complete.fingerprint,
      combined.fingerprint,
      "company_enrichment_fingerprints must return exactly what the parts function does",
    );
    assert.equal(Number(complete.degraded), 0);

    // Plumbing. The source was fetched again, succeeded again, returned the same content, and the collector emitted
    // a diagnostic -- a sitemap hitting its page limit, say. Nothing enrichment reads has changed, and the degraded
    // verdict it does read is the same, so the company must still look unchanged.
    const noisy = await fetched(
      sql,
      JSON.stringify({ status: "complete", diagnostics: [{ code: "sitemap_limit_reached" }] }),
      "2026-10-20T22:00:00Z",
    );
    assert.equal(Number(noisy.degraded), 0, "a complete fetch with a diagnostic is not a degraded source");
    assert.equal(
      noisy.parts.fetches,
      complete.parts.fetches,
      "a diagnostic on a successful fetch must not move the fetches component",
    );
    assert.equal(
      noisy.fingerprint,
      complete.fingerprint,
      "a diagnostic on a successful fetch must not re-enrich the whole company",
    );

    // A real degradation. The captures are demoted, so the resolver's conclusions can change: this must move.
    const degraded = await fetched(
      sql,
      JSON.stringify({ status: "degraded", diagnostics: [{ code: "job_page_collection_failed" }] }),
      "2026-10-21T10:00:00Z",
    );
    assert.equal(Number(degraded.degraded), 1);
    assert.notEqual(degraded.parts.fetches, complete.parts.fetches, "a degraded source moves the fetches component");

    // And recovering moves it back to exactly the value it had, so the component is a verdict and not a history.
    const recovered = await fetched(sql, null, "2026-10-21T22:00:00Z");
    assert.equal(recovered.parts.fetches, complete.parts.fetches, "recovery returns the component to its value");
    assert.equal(recovered.fingerprint, complete.fingerprint);

    // Content. A changed posting must move `observations`, and only that component.
    await sql.query("update public.raw_job_observations set content_hash = $2 where id = $1", [
      OBSERVATION,
      hex64("fresh"),
    ]);
    const changed = await state(sql);
    assert.notEqual(changed.parts.observations, recovered.parts.observations, "a changed posting moves observations");
    assert.equal(changed.parts.fetches, recovered.parts.fetches, "and leaves the fetch verdict alone");
    assert.notEqual(changed.fingerprint, recovered.fingerprint, "so the company is re-enriched");
  } finally {
    await sql.query("rollback");
    await sql.end();
  }
});
