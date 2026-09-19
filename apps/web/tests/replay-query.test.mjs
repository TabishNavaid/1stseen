import assert from "node:assert/strict";
import test from "node:test";

import { defaultReplayFilters, parseReplayFilters, replayHref } from "../lib/replay-query.ts";

test("replay filters parse strictly: unknown precision and outcome values fall back to all", () => {
  assert.deepEqual(parseReplayFilters({}), defaultReplayFilters);
  assert.deepEqual(
    parseReplayFilters({ company: "Stripe", q: "intern", precision: "exact", outcome: "skipped", page: "3" }),
    { company: "Stripe", query: "intern", precision: "exact", outcome: "skipped", page: 3 },
  );
  // observed_by is never a candidate, so it is not accepted as a precision filter.
  assert.equal(parseReplayFilters({ precision: "observed_by" }).precision, "all");
  assert.equal(parseReplayFilters({ outcome: "passed" }).outcome, "all");
  assert.equal(parseReplayFilters({ page: "0" }).page, 1);
  assert.equal(parseReplayFilters({ page: "junk" }).page, 1);
  assert.equal(parseReplayFilters({ page: "999999" }).page, 10_000);
  assert.equal(parseReplayFilters({ q: "x".repeat(500) }).query.length, 200);
});

test("replay hrefs carry only non-default state and round-trip through the parser", () => {
  assert.equal(replayHref(defaultReplayFilters), "/replay");
  const filters = { company: "Notion", query: "new grad", precision: "exact", outcome: "other_event", page: 2 };
  const href = replayHref(filters);
  assert.equal(href, "/replay?company=Notion&q=new+grad&precision=exact&outcome=other_event&page=2");
  const params = Object.fromEntries(new URL(href, "http://localhost").searchParams);
  assert.deepEqual(parseReplayFilters(params), filters);
  // Changing a filter is a new query, so callers reset the page explicitly.
  assert.equal(replayHref(filters, { company: "", page: 1 }), "/replay?q=new+grad&precision=exact&outcome=other_event");
});
