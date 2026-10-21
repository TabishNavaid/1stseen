/**
 * Integration test: the guest cache version tracks what a guest can read, and nothing else.
 *
 * `public_data_version` is in the guest cache key, so a bump orphans every stored guest page at every colo. Three
 * relations bumped it that no guest page can read (migration 202608140062): `sources` and `source_fetches`, which
 * collection writes once per source per run -- 740 global invalidations in a 370-source run -- and `backtest_cases`.
 *
 * The two halves of the rule are checked against the live database, in both directions:
 *   - every relation in the guest read policy bumps the version when it changes, or a cached page goes stale;
 *   - no relation outside it bumps the version, or plumbing throws the cache away.
 *
 * Needs the local rig (`scripts/local-rig.sh up`). It reads catalogue state only and writes nothing.
 *
 * Proven to fail when the prevention is removed: re-creating the `source_fetches` trigger by hand makes the second
 * assertion name it; dropping `historical_opening_events`'s makes the first name that. The policy is read from
 * `public-read-policy.ts` rather than restated here, so adding a relation there fails this test until its trigger
 * exists.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { loadDotEnv, sqlClient } from "../../../../scripts/lib/db.mjs";

loadDotEnv();

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");

/** The guest-readable relations, read from the policy itself so the two cannot drift. */
function guestReadableTables() {
  const source = readFileSync(resolve(ROOT, "apps/web/lib/public-read-policy.ts"), "utf8");
  const block = source.slice(source.indexOf("PUBLIC_TABLE_COLUMNS"), source.indexOf("PUBLIC_FUNCTIONS"));
  const names = [...block.matchAll(/^\s{2}([a-z_]+):/gm)].map((match) => match[1]);
  assert.ok(names.length > 5, "the guest read policy's relations were not found");
  return new Set(names);
}

/**
 * A guest-readable name may be a view over a table; the version is bumped on the table underneath it.
 * `forecast_provenance` is the view over `forecast_evidence`.
 */
const TABLE_UNDER_VIEW = { forecast_provenance: "forecast_evidence" };

test("every guest-readable relation bumps the public data version, and nothing else does", async () => {
  const sql = await sqlClient();
  assert.ok(sql, "SUPABASE_DB_URL is not set. Start the local rig first: scripts/local-rig.sh up");
  try {
    const { rows } = await sql.query(
      `select c.relname as table_name
         from pg_trigger t
         join pg_class c on c.oid = t.tgrelid
         join pg_namespace n on n.oid = c.relnamespace
         join pg_proc p on p.oid = t.tgfoid
        where n.nspname = 'public' and not t.tgisinternal and p.proname = 'bump_public_data_version'`,
    );
    const bumping = new Set(rows.map((row) => row.table_name));
    const readable = new Set([...guestReadableTables()].map((name) => TABLE_UNDER_VIEW[name] ?? name));

    const notBumping = [...readable].filter((name) => !bumping.has(name)).sort();
    assert.deepEqual(
      notBumping,
      [],
      `guest-readable but does not bump public_data_version, so a cached guest page would not see its changes: ${notBumping.join(", ")}`,
    );

    const notReadable = [...bumping].filter((name) => !readable.has(name)).sort();
    assert.deepEqual(
      notReadable,
      [],
      `bumps public_data_version but no guest page can read it, so writing it throws away every cached guest page: ${notReadable.join(", ")}`,
    );
  } finally {
    await sql.end();
  }
});
