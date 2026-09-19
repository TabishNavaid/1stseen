/**
 * Integration test: a signed-in session writes only what the product writes through it (migration 202608140038).
 *
 * Needs a real Postgres (the local rig, `scripts/local-rig.sh up`). It runs in `npm run test:integration`, not
 * `npm run check`, because the gate runs without a database.
 *
 * Everything happens inside one transaction that is always rolled back: the migration's SQL, a synthetic user, and every
 * write. So it proves the migration on a database that has not applied it yet, and passes unchanged once it has, because
 * every statement in it is idempotent. Nothing is committed.
 *
 * What it proves:
 *   - after the migration, the catalog holds exactly the contract in scripts/lib/grant-contract.mjs — the same queries
 *     `npm run verify:supabase` runs — and no default privilege would grant a write to the next table;
 *   - those queries catch a regrant, table or column, and a default privilege that would grant one;
 *   - as `authenticated` with a user's JWT claims, the writes the personalization and onboarding routes perform succeed,
 *     in the shape PostgREST issues them;
 *   - every other write is refused with insufficient_privilege: evidence tables, TRUNCATE, profile and milestone columns,
 *     and a watchlist column the route never updates; and RLS still refuses a write to another user's rows.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import test from "node:test";

import { ROOT, connectPg, loadDotEnv } from "../../../../scripts/lib/db.mjs";
import {
  authenticatedSequenceWrites,
  authenticatedWriteViolations,
  browserDefaultPrivileges,
} from "../../../../scripts/lib/grant-contract.mjs";

loadDotEnv();

const MIGRATION = readFileSync(join(ROOT, "supabase/migrations/202608140038_revoke_authenticated_writes.sql"), "utf8");

test("authenticated writes only its own RLS-scoped rows, and only the ones the routes perform", async () => {
  const connectionString = process.env.SUPABASE_DB_URL;
  assert.ok(connectionString, "SUPABASE_DB_URL is not set. Start the local rig first: scripts/local-rig.sh up");

  const client = await connectPg(connectionString, { applicationName: "firstseen-grant-test" });
  const one = async (sql, params = []) => (await client.query(sql, params)).rows[0];
  let savepoint = 0;
  /** Runs `sql` in a savepoint and returns its SQLSTATE, or null when it succeeded. */
  const attempt = async (sql, params = []) => {
    const name = `attempt_${(savepoint += 1)}`;
    await client.query(`savepoint ${name}`);
    try {
      await client.query(sql, params);
      await client.query(`release savepoint ${name}`);
      return null;
    } catch (error) {
      await client.query(`rollback to savepoint ${name}`);
      return error.code;
    }
  };

  try {
    await client.query("begin");
    // A shared rig: never wait behind another session's lock, and never hold catalog locks for long.
    await client.query("set local lock_timeout = '5s'");
    await client.query("set local statement_timeout = '60s'");
    await client.query(MIGRATION);

    // 1. The catalog matches the contract, through the queries verify:supabase makes.
    assert.deepEqual(await authenticatedWriteViolations(client), { unexpected: [], missing: [] });
    assert.deepEqual(await authenticatedSequenceWrites(client), []);
    assert.deepEqual(await browserDefaultPrivileges(client), []);

    // 2. Those queries catch a regrant of each kind.
    await client.query("savepoint regrant");
    await client.query("grant truncate on public.companies to authenticated");
    await client.query("grant update (display_name) on public.profiles to authenticated");
    await client.query("grant update on public.watchlist_items to authenticated");
    await client.query("alter default privileges for role postgres in schema public grant insert on tables to authenticated");
    const regranted = await authenticatedWriteViolations(client);
    assert.deepEqual(regranted.unexpected, ["companies:TRUNCATE", "profiles:UPDATE (display_name)", "watchlist_items:UPDATE"]);
    // A table-level UPDATE covers the contract's column grant, so the contract's own entry is no longer held as such.
    assert.deepEqual(regranted.missing, ["watchlist_items:UPDATE (alerts_enabled)"]);
    assert.deepEqual(await browserDefaultPrivileges(client), ["authenticated:tables:INSERT"]);
    await client.query("rollback to savepoint regrant");
    assert.deepEqual(await authenticatedWriteViolations(client), { unexpected: [], missing: [] });

    // 3. A synthetic signed-in user, and a second one whose rows the first must not reach.
    const userId = randomUUID();
    const otherId = randomUUID();
    for (const id of [userId, otherId]) {
      await client.query("insert into auth.users (id, email) values ($1, $2)", [id, `${id}@integration-test.invalid`]);
    }
    const profile = await one("select id from public.profiles where id = $1", [userId]);
    assert.ok(profile, "the new-user trigger creates the profile");
    const { id: companyId } = await one("select id from public.companies order by name limit 1");
    const { id: roleId } = await one(
      "select id from public.canonical_roles where scope_status = 'in_scope' and active order by id limit 1",
    );
    await client.query(
      "insert into public.watchlist_items (user_id, target_type, company_id, alerts_enabled) values ($1, 'company', $2, true)",
      [otherId, companyId],
    );

    await client.query("set local role authenticated");
    await client.query("select set_config('request.jwt.claims', $1, true)", [
      JSON.stringify({ sub: userId, role: "authenticated", aud: "authenticated" }),
    ]);
    assert.equal((await one("select auth.uid()::text as uid")).uid, userId);

    // 4. What the routes perform succeeds. Onboarding and preferences: an upsert on user_id, twice.
    const upsert = `insert into public.recruiting_preferences (user_id, graduation_year, preferred_locations, onboarding_completed_at)
                    values ($1, 2027, array['Remote'], now())
                    on conflict (user_id) do update set graduation_year = excluded.graduation_year,
                      preferred_locations = excluded.preferred_locations, onboarding_completed_at = excluded.onboarding_completed_at
                    returning user_id`;
    assert.equal(await attempt(upsert, [userId]), null, "first preferences save");
    assert.equal(await attempt(upsert, [userId]), null, "second preferences save updates the row");
    // Saving preferences replaces the priority list.
    assert.equal(await attempt("delete from public.priority_companies where user_id = $1", [userId]), null);
    assert.equal(
      await attempt("insert into public.priority_companies (user_id, company_id, priority) values ($1, $2, 4)", [userId, companyId]),
      null,
    );
    // Follow, toggle alerts by following again, unfollow.
    const follow = await one(
      `insert into public.watchlist_items (user_id, target_type, canonical_role_id, alerts_enabled)
       values ($1, 'canonical_role', $2, true) returning id`,
      [userId, roleId],
    );
    assert.equal(
      await attempt("update public.watchlist_items set alerts_enabled = false where user_id = $1 and id = $2 returning *", [userId, follow.id]),
      null,
    );
    assert.equal((await one("select alerts_enabled from public.watchlist_items where id = $1", [follow.id])).alerts_enabled, false);
    assert.equal(await attempt("delete from public.watchlist_items where user_id = $1 and id = $2", [userId, follow.id]), null);

    // 5. Everything else is refused by privilege (42501), before RLS is consulted.
    const refused = {
      "insert a company": ["insert into public.companies (name, domain) values ('grant test', 'grant-test.invalid')"],
      "update a canonical role": ["update public.canonical_roles set canonical_title = canonical_title where id = $1", [roleId]],
      "delete a forecast": ["delete from public.forecasts where false"],
      "insert an opening event": ["insert into public.historical_opening_events (canonical_role_id) values ($1)", [roleId]],
      "truncate raw observations": ["truncate public.raw_job_observations"],
      "truncate own watchlist": ["truncate public.watchlist_items"],
      "insert a profile": ["insert into public.profiles (id) values ($1)", [randomUUID()]],
      "update own display name": ["update public.profiles set display_name = 'x' where id = $1", [userId]],
      "delete own profile": ["delete from public.profiles where id = $1", [userId]],
      "complete a milestone": ["update public.readiness_milestones set completed_at = now() where false"],
      "retarget a follow": ["update public.watchlist_items set canonical_role_id = $2 where user_id = $1", [userId, roleId]],
      "update a priority": ["update public.priority_companies set priority = 5 where user_id = $1", [userId]],
      "delete own preferences": ["delete from public.recruiting_preferences where user_id = $1", [userId]],
      "setval the public data version": ["select setval('public.public_data_version_seq', 1)"],
    };
    const outcomes = {};
    for (const [label, [sql, params]] of Object.entries(refused)) outcomes[label] = await attempt(sql, params);
    assert.deepEqual(
      outcomes,
      Object.fromEntries(Object.keys(refused).map((label) => [label, "42501"])),
      "every non-route write is refused with insufficient_privilege",
    );

    // 6. RLS still scopes the writes that remain: another user's rows are neither visible nor writable.
    assert.equal(
      await attempt(
        "insert into public.watchlist_items (user_id, target_type, company_id, alerts_enabled) values ($1, 'company', $2, true)",
        [otherId, companyId],
      ),
      "42501",
      "a row for another user fails the policy's with check",
    );
    const reached = await one("with gone as (delete from public.watchlist_items where user_id = $1 returning 1) select count(*)::int as n from gone", [otherId]);
    assert.equal(reached.n, 0, "another user's follow is invisible to delete");
  } finally {
    await client.query("rollback").catch(() => {});
    await client.end();
  }
});
