/**
 * The list, its pager, and the filter panel: the things a reader touches on every visit.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { guestCachePath } from "../cloudflare/guest-cache.ts";
import { JUST_OPENED_FACETS, justOpenedFilters, justOpenedHref } from "../lib/just-opened-filters.ts";
import { dashboardHref, parseDashboardFilters } from "../lib/dashboard-query.ts";
import { pageCount, pageNumbers, pageRangeLabel } from "../lib/pagination.ts";

const css = () => readFileSync(new URL("../app/globals.css", import.meta.url), "utf8");

async function render(pathname, env = {}) {
  const saved = Object.fromEntries(Object.keys(env).map((key) => [key, process.env[key]]));
  Object.assign(process.env, env);
  try {
    const workerUrl = new URL("../dist/server/index.js", import.meta.url);
    workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}-${Math.random()}`);
    const { default: worker } = await import(workerUrl.href);
    const response = await worker.fetch(
      new Request(`http://localhost${pathname}`, { headers: { accept: "text/html" } }),
      { ASSETS: { fetch: async () => new Response("Not found", { status: 404 }) } },
      { waitUntil() {}, passThroughOnException() {} },
    );
    return await response.text();
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test("the pager draws a short list whole and windows a long one", () => {
  assert.deepEqual(pageNumbers(1, 7), [1, 2, 3, 4, 5, 6, 7]);
  assert.deepEqual(pageNumbers(4, 7), [1, 2, 3, 4, 5, 6, 7]);
  // Long lists keep the ends, the page being read, and one either side of it.
  assert.deepEqual(pageNumbers(1, 20), [1, 2, "gap", 20]);
  assert.deepEqual(pageNumbers(10, 20), [1, "gap", 9, 10, 11, "gap", 20]);
  assert.deepEqual(pageNumbers(19, 20), [1, "gap", 18, 19, 20]);
  // A gap that would hide one number is that number instead.
  assert.deepEqual(pageNumbers(3, 20), [1, 2, 3, 4, "gap", 20]);
  // Out-of-range asks still draw something sensible rather than an empty row.
  assert.deepEqual(pageNumbers(0, 3), [1, 2, 3]);
  assert.deepEqual(pageNumbers(99, 3), [1, 2, 3]);
});

test("a page count is never zero, and the range says which rows these are", () => {
  assert.equal(pageCount(0, 20), 1);
  assert.equal(pageCount(20, 20), 1);
  assert.equal(pageCount(21, 20), 2);
  assert.equal(pageCount(128, 20), 7);
  assert.equal(pageRangeLabel(3, 20, 20, 128), "41–60 of 128");
  assert.equal(pageRangeLabel(7, 20, 8, 128), "121–128 of 128");
  assert.equal(pageRangeLabel(1, 20, 0, 0), "No programs on this page");
});

test("every page link carries the whole view: the tab, each filter and the sort", () => {
  const view = parseDashboardFilters({
    watched: "1", sort: "confidence", discipline: ["software_engineering", "data"], type: "internship",
    season: "summer", year: "2027", window: "30", confidence: "strong", cycles: "3", precision: "exact",
    listed: "1", location: "remote", q: "intern", page: "2",
  });
  for (const page of [1, 3, 7]) {
    const params = new URL(dashboardHref(view, { page }), "http://localhost").searchParams;
    assert.equal(params.get("watched"), "1");
    assert.equal(params.get("sort"), "confidence");
    assert.deepEqual(params.getAll("discipline"), ["software_engineering", "data"]);
    assert.equal(params.get("type"), "internship");
    assert.equal(params.get("season"), "summer");
    assert.equal(params.get("year"), "2027");
    assert.equal(params.get("window"), "30");
    assert.equal(params.get("confidence"), "strong");
    assert.equal(params.get("cycles"), "3");
    assert.equal(params.get("precision"), "exact");
    assert.equal(params.get("listed"), "1");
    assert.equal(params.get("location"), "remote");
    assert.equal(params.get("q"), "intern");
    assert.equal(params.get("page"), page === 1 ? null : String(page));
  }
  // Only the page differs: every other key is the same on every link in the row.
  const without = (page) => dashboardHref(view, { page }).replace(/[?&]page=\d+/, "");
  assert.equal(without(1), without(7));
});

test("a list that fits on one page draws no pager at all", async () => {
  const html = await render("/roles", { FIRSTSEEN_DEMO_MODE: "true" });
  assert.doesNotMatch(html, /aria-label="Pages"/, "three fixture roles are not seven pages");
});

test("the skip link is hidden by where it is, not by clipping a box that other utilities can grow", async () => {
  const styles = css();
  const start = styles.indexOf("@utility skip-link");
  const block = styles.slice(start, styles.indexOf("\n}", start) + 2);
  assert.ok(block, "the utility is defined");
  assert.match(block, /transform: translateY\(calc\(-100%/, "it sits above the screen by its own height");
  assert.match(block, /&:focus \{[\s\S]*transform: translateY\(0\)/, "and comes down when it is focused");
  assert.doesNotMatch(block, /clip-path/, "nothing about it depends on clip-path");
  // The markup is the utility alone: composing it with padding is what gave it a box to paint.
  for (const [path, env] of [["/roles", { FIRSTSEEN_DEMO_MODE: "true" }], ["/welcome", { FIRSTSEEN_DEMO_MODE: "true" }]]) {
    const html = await render(path, env);
    const link = /<a[^>]*>Skip to content<\/a>/.exec(html)?.[0] ?? "";
    assert.match(link, /class="skip-link"/, path);
    assert.doesNotMatch(link, /sr-only|px-\d|py-\d/, path);
  }
});

test("Just opened reads the filters that describe a program and ignores the ones that describe a forecast", () => {
  const filters = justOpenedFilters({
    q: "waymo", discipline: "software_engineering", type: "internship", season: "summer", location: "remote",
    // None of these mean anything to a list of openings that already happened.
    window: "30", confidence: "strong", cycles: "3", precision: "exact", listed: "1", watched: "1", year: "2027", sort: "confidence",
  });
  assert.equal(filters.query, "waymo");
  assert.deepEqual(filters.disciplines, ["software_engineering"]);
  assert.deepEqual(filters.types, ["internship"]);
  assert.deepEqual(filters.seasons, ["summer"]);
  assert.deepEqual(filters.locations, ["remote"]);
  assert.equal(filters.windowDays, null);
  assert.deepEqual(filters.confidence, []);
  assert.equal(filters.minCycles, null);
  assert.equal(filters.precision, null);
  assert.equal(filters.listedNow, false);
  assert.equal(filters.watchedOnly, false);
  assert.deepEqual(filters.years, []);
  assert.equal(filters.sort, "window", "the feed is newest first and offers no sort");
  // What it does read is what its bar offers, and nothing else.
  assert.deepEqual([...JUST_OPENED_FACETS], ["query", "discipline", "type", "season", "company", "location"]);
  assert.equal(justOpenedHref(filters, { page: 2 }).startsWith("/opened?"), true);
});

test("a guest page is stored under the filters it was rendered with, on both lists", () => {
  const page = (url) => guestCachePath(new Request(url, { headers: { accept: "text/html" } }));
  // The feed's filters are part of its key: without them one guest's filtered page was served to the next.
  assert.notEqual(page("http://localhost/opened?type=internship"), page("http://localhost/opened"));
  assert.notEqual(page("http://localhost/opened?type=internship"), page("http://localhost/opened?type=co_op"));
  assert.equal(page("http://localhost/opened?type=internship&discipline=data"), page("http://localhost/opened?discipline=data&type=internship"));
  assert.equal(page("http://localhost/opened?sort=confidence"), page("http://localhost/opened"), "a key it does not read does not split the cache");
  assert.notEqual(page("http://localhost/opened?page=2"), page("http://localhost/opened"));
  // The roles view already worked this way; it still does.
  assert.notEqual(page("http://localhost/roles?page=2"), page("http://localhost/roles"));
  assert.notEqual(page("http://localhost/roles?discipline=data"), page("http://localhost/roles"));
});
