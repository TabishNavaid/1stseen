/**
 * Integration test: evidence that moves or goes marks its roles for regeneration (migration 202608140042).
 *
 * Needs the local rig (`scripts/local-rig.sh up`). Everything happens in one transaction that is always rolled back, so
 * the corpus is untouched. It moves a real opening event to another role, re-writes one unchanged, changes one, and
 * deletes one, and reads what role_evidence_changes recorded for each.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { loadDotEnv, sqlClient } from "../../../../scripts/lib/db.mjs";

loadDotEnv();

test("a moved, changed, or deleted opening marks the roles it left and joined, and a no-op marks none", async () => {
  const sql = await sqlClient();
  assert.ok(sql, "SUPABASE_DB_URL is not set. Start the local rig first: scripts/local-rig.sh up");
  try {
    await sql.query("begin");
    const since = (await sql.query("select clock_timestamp() as at")).rows[0].at;
    const recorded = async () => (await sql.query(
      "select canonical_role_id::text as role, change, relation from public.role_evidence_changes where changed_at > $1 order by id",
      [since],
    )).rows;

    const { rows: events } = await sql.query(
      "select id, canonical_role_id::text as role from public.historical_opening_events order by id limit 2",
    );
    assert.equal(events.length, 2, "the rig has opening events to move");
    const [event, other] = events;
    const { rows: [target] } = await sql.query(
      "select id::text as role from public.canonical_roles where id <> $1 order by id limit 1",
      [event.role],
    );

    await sql.query("update public.historical_opening_events set opened_on = opened_on where id = $1", [event.id]);
    assert.deepEqual(await recorded(), [], "rewriting an event with its own values records nothing");

    await sql.query("update public.historical_opening_events set canonical_role_id = $2 where id = $1", [event.id, target.role]);
    assert.deepEqual(await recorded(), [
      { role: event.role, change: "moved_out", relation: "historical_opening_events" },
      { role: target.role, change: "moved_in", relation: "historical_opening_events" },
    ]);

    // Any real change to the row counts, as a corrected quote or date from reconstruction would.
    await sql.query("update public.historical_opening_events set evidence_quote = evidence_quote || ' ' where id = $1", [other.id]);
    assert.deepEqual((await recorded()).slice(2), [{ role: other.role, change: "updated", relation: "historical_opening_events" }]);

    await sql.query("delete from public.historical_opening_events where id = $1", [other.id]);
    assert.deepEqual((await recorded()).slice(3), [{ role: other.role, change: "deleted", relation: "historical_opening_events" }]);
  } finally {
    await sql.query("rollback").catch(() => undefined);
    await sql.end();
  }
});
