import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { fetchAll, fetchAllIn, IN_BATCH, MAX_ROWS, PAGE_SIZE } from "../lib/supabase/paging.ts";

/** A PostgREST stand-in that orders as asked and silently truncates every response at `cap` rows, as the real one does. */
function cappedTable(rows, cap) {
  const requests = [];
  const orders = [];
  return {
    requests,
    orders,
    query: (subset = rows) => {
      const order = [];
      const builder = {
        order(column, options = {}) {
          order.push(`${column}.${options.ascending === false ? "desc" : "asc"}`);
          return builder;
        },
        range(from, to) {
          requests.push([from, to]);
          orders.push([...order]);
          const sorted = [...subset].sort((a, b) => {
            for (const entry of order) {
              const [column, direction] = entry.split(".");
              const compared = String(a[column]).localeCompare(String(b[column]));
              if (compared) return direction === "desc" ? -compared : compared;
            }
            return 0;
          });
          const end = Math.min(to + 1, from + cap);
          return Promise.resolve({ data: sorted.slice(from, end), error: null });
        },
      };
      return builder;
    },
  };
}

const rows = (count, prefix = "row") => Array.from({ length: count }, (_, index) => ({ id: `${prefix}-${index}` }));

test("reads every row of a table larger than the PostgREST row cap", async () => {
  const table = cappedTable(rows(2_345), 1_000);
  const result = await fetchAll(() => table.query(), "roles", "id");
  assert.equal(result.length, 2_345);
  assert.equal(new Set(result.map((row) => row.id)).size, 2_345);
});

test("does not mistake a server cap below the page size for the end of the table", async () => {
  // A project configured with max_rows = 250 returns short pages long before the end.
  const table = cappedTable(rows(1_100), 250);
  const result = await fetchAll(() => table.query(), "roles", "id");
  assert.equal(PAGE_SIZE > 250, true);
  assert.equal(result.length, 1_100);
});

test("batches id lists and reads every matching row in each batch", async () => {
  const all = rows(1_200, "role");
  const ids = all.map((row) => row.id);
  const seenBatchSizes = [];
  const result = await fetchAllIn((batch) => {
    seenBatchSizes.push(batch.length);
    return cappedTable(all.filter((row) => batch.includes(row.id)), 1_000).query();
  }, ids, "roles", "id");
  assert.equal(result.length, 1_200);
  assert.ok(seenBatchSizes.every((size) => size <= IN_BATCH));
});

test("a read error fails loudly with a label instead of returning partial rows", async () => {
  await assert.rejects(
    fetchAll(() => {
      const failing = { order: () => failing, range: () => Promise.resolve({ data: null, error: { message: "boom" } }) };
      return failing;
    }, "forecasts", "id"),
    /forecasts_read_failed/,
  );
});

test("the unique key is appended after the caller's order, so a tie cannot move a row between pages", async () => {
  // Forty rows share one weight. Ordered by weight alone, offset paging may return a row twice and skip another.
  const tied = Array.from({ length: 2_040 }, (_, index) => ({ id: `e-${String(index).padStart(5, "0")}`, weight: index < 40 ? "0.5" : String(index) }));
  const table = cappedTable(tied, 1_000);
  const result = await fetchAll(() => table.query().order("weight", { ascending: false }), "provenance", "id");
  assert.equal(new Set(result.map((row) => row.id)).size, 2_040);
  assert.ok(table.orders.every((order) => order.at(-1) === "id.asc" && order[0] === "weight.desc"));
});

test("a composite key orders by each of its columns", async () => {
  const table = cappedTable([{ observation_id: "o", canonical_role_id: "r" }], 1_000);
  await fetchAll(() => table.query(), "matches", ["observation_id", "canonical_role_id"]);
  assert.deepEqual(table.orders[0], ["observation_id.asc", "canonical_role_id.asc"]);
});

test("paging without a key is refused", async () => {
  await assert.rejects(fetchAll(() => cappedTable([], 1_000).query(), "roles", []), /unique key/);
});

test("a read that reaches the row ceiling throws instead of returning part of the table as all of it", async () => {
  const endless = { order: () => endless, range: (from, to) => Promise.resolve({ data: Array.from({ length: to - from + 1 }, (_, index) => ({ id: from + index })), error: null }) };
  await assert.rejects(fetchAll(() => endless, "events", "id"), new RegExp(`events_read_exceeded_${MAX_ROWS}_rows`));
});

/**
 * Every unbounded read in the loaders must page, not cap.
 *
 * `loadRealRoleView` read `forecast_provenance` with `.limit(60)`. On the rig the largest role's
 * forecast links 114 contributions, and 65 of the 179 forecast role pages link more than 60, so a
 * third of them rendered a truncated list under the heading "exactly what contributed to this
 * forecast" and said nothing about the rest. A literal `.limit()` on a read whose size follows the
 * data is that bug; `fetchAll` is the fix.
 */
test("no loader read caps a list whose length follows the data", async () => {
  const source = readFileSync(new URL("../lib/real-data.ts", import.meta.url), "utf8");
  // The read itself: from the table name to the end of its chained call.
  const start = source.indexOf('.from("forecast_provenance"');
  assert.ok(start > 0, "loadRealRoleView still reads forecast_provenance");
  const provenance = source.slice(start, source.indexOf("\n", source.indexOf('"forecast_provenance",', start) + 400));
  assert.doesNotMatch(provenance, /\.limit\(/, "the forecast's contributions are paged, never capped");
  assert.match(source.slice(start - 400, start), /fetchAll\(/);
});
