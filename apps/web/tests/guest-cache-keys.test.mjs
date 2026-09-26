/**
 * What a guest page is stored under.
 *
 * The rule is one line long: a cached page's key must name every query parameter the route renders differently for.
 * It has been broken twice — Just opened was keyed on the company and the page while reading six filters, and a role
 * page was keyed on its address while reading which page of the evidence to show — and both times the result was one
 * guest being served a page another guest had asked for. So this checks every cached route, not the two that broke.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { guestCachePath } from "../cloudflare/guest-cache.ts";
import { DASHBOARD_PARAMS } from "../lib/dashboard-query.ts";
import { JUST_OPENED_PARAMS } from "../lib/just-opened-filters.ts";
import { ROLE_PAGE_PARAMS } from "../lib/role-page-params.ts";

const ROLE_ID = "1f6881fa-2e9e-5b71-ae8f-625c14c3dfb2";
const key = (url) => guestCachePath(new Request(url, { headers: { accept: "text/html" } }));
const source = (file) => readFileSync(new URL(`../app/${file}`, import.meta.url), "utf8");

/**
 * Every route the guest cache stores, what it reads, and a value that must change its key. `ignored` is a parameter
 * the route reads but cannot render differently for a guest; each one carries the reason it is safe.
 */
const ROUTES = [
  {
    name: "landing",
    file: "page.tsx",
    url: "http://localhost/",
    reads: [],
    // Any roles parameter on the front page is a redirect to the roles view, and guestCachePath refuses to store one.
    varies: [],
    refuses: ["?discipline=data", "?watched=1"],
  },
  {
    name: "roles",
    file: "roles/page.tsx",
    url: "http://localhost/roles",
    reads: DASHBOARD_PARAMS,
    varies: ["?q=intern", "?discipline=data", "?company=1f6881fa-2e9e-5b71-ae8f-625c14c3dfb2", "?type=internship",
      "?season=summer", "?year=2027", "?window=30", "?confidence=strong", "?cycles=3", "?precision=exact",
      "?location=remote", "?listed=1", "?watched=1", "?sort=confidence", "?page=2"],
    ignored: { welcome: "only rendered for a signed-in reader, and a request with a session is never stored" },
  },
  {
    name: "methodology",
    file: "methodology/page.tsx",
    url: "http://localhost/methodology",
    reads: [],
    varies: [],
  },
  {
    name: "just opened",
    file: "opened/page.tsx",
    url: "http://localhost/opened",
    reads: JUST_OPENED_PARAMS,
    varies: ["?q=waymo", "?discipline=data", "?type=internship", "?season=summer",
      "?company=1f6881fa-2e9e-5b71-ae8f-625c14c3dfb2", "?location=remote", "?page=2"],
  },
  {
    name: "role page",
    file: "roles/[roleId]/page.tsx",
    url: `http://localhost/roles/${ROLE_ID}`,
    reads: ROLE_PAGE_PARAMS,
    varies: ["?evidence=2"],
    ignored: { welcome: "the first run's note needs the reader to follow this role, which a guest cannot do" },
  },
];

test("every cached route is stored under each parameter it reads", () => {
  for (const route of ROUTES) {
    const base = key(route.url);
    assert.ok(base, `${route.name} is cached`);
    for (const query of route.varies) {
      assert.notEqual(key(route.url + query), base, `${route.name}${query} must not share ${route.name}'s key`);
    }
    for (const query of route.refuses ?? []) {
      assert.equal(key(route.url + query), null, `${route.name}${query} must not be stored at all`);
    }
    // Reordering or repeating a filter is the same view, so it is the same key.
    assert.equal(key(route.url), key(`${route.url}?`), route.name);
  }
});

test("a route that grows a parameter has to say so here", () => {
  for (const route of ROUTES) {
    const text = source(route.file);
    // Every `params.x` / `query.x` the route reads by hand, and every key it asks a search string for.
    const direct = new Set([
      ...[...text.matchAll(/\b(?:params|query|searchParams)\.(\w+)\b/g)].map((match) => match[1]),
      ...[...text.matchAll(/\bsearchParams\.get\("(\w+)"\)/g)].map((match) => match[1]),
    ]);
    for (const name of ["get", "has", "entries", "keys", "values", "toString", "append", "set", "size", "then", "catch"]) direct.delete(name);
    const known = new Set([...route.reads, ...Object.keys(route.ignored ?? {})]);
    const unknown = [...direct].filter((name) => !known.has(name));
    assert.deepEqual(unknown, [], `${route.file} reads ${unknown.join(", ")}, which the cache key does not know about`);
  }
});

test("a parameter a route reads but cannot render differently for a guest carries its reason", () => {
  for (const route of ROUTES) {
    for (const [name, reason] of Object.entries(route.ignored ?? {})) {
      assert.ok(reason.length > 20, `${route.name}: ${name} needs a reason, not a note`);
    }
  }
  // The one there is: a guest never sees it, because a request carrying a session is never cached at all.
  const signedIn = new Request("http://localhost/roles", { headers: { accept: "text/html", cookie: "sb-abc-auth-token=x" } });
  assert.equal(guestCachePath(signedIn), null);
});
