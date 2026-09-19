/**
 * Guest mode's edge: the public read allowlist, the guest page cache, and the guest agent limits. Everything here
 * runs without workerd; tests/integration/guest-boundary.test.mjs checks the same boundary against the rig.
 */

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { frontDoorRedirect } from "../cloudflare/front-door.ts";
import { GUEST_QUESTIONS_OVERALL, GUEST_QUESTIONS_PER_ADDRESS, guestAgentAllowance, guestLimitResponse } from "../cloudflare/guest-agent.ts";
import {
  CACHE_STATUS_HEADER,
  STORED_NONCE_HEADER,
  guestCachePath,
  hasSessionCookie,
  memoizedVersion,
  serveGuestPage,
} from "../cloudflare/guest-cache.ts";
import {
  NEVER_PUBLIC_RELATIONS,
  PUBLIC_FUNCTIONS,
  PUBLIC_TABLE_COLUMNS,
  PublicReadRefused,
  assertPublicRpc,
  assertPublicSelect,
} from "../lib/public-read-policy.ts";

const ROLE = "/roles/3bada2b6-e324-5c85-9f39-a3a89ee82e47";
const page = (path, init = {}) => new Request(`https://firstseen.test${path}`, { ...init, headers: { accept: "text/html", ...init.headers } });

function memoryCache() {
  const store = new Map();
  return {
    store,
    async match(request) {
      return store.get(request.url)?.clone();
    },
    async put(request, response) {
      store.set(request.url, response.clone());
    },
  };
}

test("every public read in the loaders is inside the allowlist", async () => {
  const sources = await Promise.all(["../lib/real-data.ts", "../lib/landing-data.ts", "../lib/methodology-data.ts"].map((path) => readFile(new URL(path, import.meta.url), "utf8")));
  const selects = sources.flatMap((source) => [...source.matchAll(/reader\s*\.from\(\s*"([a-z_]+)",\s*"([^"]+)"/g)]);
  const functions = sources.flatMap((source) => [...source.matchAll(/reader\.rpc\("([a-z_]+)"/g)].map((match) => match[1]));
  assert.ok(selects.length >= 15, `found ${selects.length} reader selects`);
  for (const [, table, columns] of selects) assert.doesNotThrow(() => assertPublicSelect(table, columns), `${table}: ${columns}`);
  for (const fn of functions) assert.ok(PUBLIC_FUNCTIONS.includes(fn), fn);
});

test("the allowlist refuses user-owned relations, raw content, and anything it cannot read column by column", () => {
  for (const relation of NEVER_PUBLIC_RELATIONS) {
    assert.ok(!(relation in PUBLIC_TABLE_COLUMNS), `${relation} is listed as public`);
    assert.throws(() => assertPublicSelect(relation, "id"), PublicReadRefused, relation);
  }
  for (const columns of Object.values(PUBLIC_TABLE_COLUMNS)) {
    assert.ok(!columns.some((column) => /user|raw_text|raw_payload|metadata|token|email/.test(column)), columns.join(","));
  }
  for (const [table, select] of [
    ["canonical_roles", "*"],
    ["raw_job_observations", "id,raw_text"],
    ["companies", "id,metadata->>company_size"],
    ["canonical_roles", "id,watchlist_items(user_id)"],
    ["canonical_roles", "id,followers:watchlist_items(user_id)"],
    ["forecasts", "id,canonical_roles!inner(id,readiness_milestones(due_on))"],
    ["canonical_roles", "id,...companies(name)"],
    ["canonical_roles", "id::text"],
    ["canonical_roles", "id,companies(name"],
    ["canonical_roles", "id,,canonical_title"],
  ]) {
    assert.throws(() => assertPublicSelect(table, select), PublicReadRefused, `${table}: ${select}`);
  }
  assert.doesNotThrow(() => assertPublicSelect("historical_opening_events", "id,raw_job_observations(apply_url),canonical_roles!inner(canonical_title,companies(name))"));
});

test("public functions are listed and never take a user", () => {
  assert.doesNotThrow(() => assertPublicRpc("dashboard_role_page", { p_user_id: null, p_limit: 20 }));
  assert.throws(() => assertPublicRpc("dashboard_role_page", { p_user_id: "00000000-0000-4000-8000-000000000001" }), PublicReadRefused);
  for (const fn of ["followed_role_ids", "onboarding_seed_roles", "dashboard_role_facts", "public_data_version"]) {
    assert.throws(() => assertPublicRpc(fn, {}), PublicReadRefused, fn);
  }
});

test("only a signed-out, whole-document GET of the landing page, the roles view, a role page, or the methodology page is cacheable", () => {
  assert.equal(guestCachePath(page("/")), "/");
  assert.equal(guestCachePath(page("/roles")), "/roles");
  assert.equal(guestCachePath(page(ROLE)), ROLE);
  // It reads the latest backtest and today's forecast counts, and both advance the public data version.
  assert.equal(guestCachePath(page("/methodology")), "/methodology");
  assert.equal(guestCachePath(page(`${ROLE}?welcome=ready`)), ROLE, "a role page ignores its query for guests");
  assert.equal(guestCachePath(page("/", { headers: { cookie: "theme=dark; sb-abc-auth-token.0=chunk" } })), null);
  assert.equal(guestCachePath(page("/", { headers: { cookie: "sb-abc-auth-token=token" } })), null);
  assert.equal(guestCachePath(page("/", { headers: { rsc: "1" } })), null);
  assert.equal(guestCachePath(page("/?_rsc=abc")), null);
  assert.equal(guestCachePath(page("/", { headers: { accept: "application/json" } })), null);
  assert.equal(guestCachePath(page("/", { method: "HEAD" })), null);
  assert.equal(guestCachePath(page("/roles", { headers: { cookie: "sb-abc-auth-token=token" } })), null);
  for (const path of ["/calendar", "/replay", "/welcome", "/settings", "/roles/not-a-uuid", "/api/health"]) {
    assert.equal(guestCachePath(page(path)), null, path);
  }
  assert.equal(hasSessionCookie(page("/", { headers: { cookie: "sb-x-code-verifier=1; other=2" } })), false);
});

test("the roles view key is canonical, so a random query string cannot force a render", () => {
  const a = guestCachePath(page("/roles?utm_source=x&discipline=data&discipline=quantitative&type=internship"));
  const b = guestCachePath(page("/roles?type=internship&zz=9&discipline=quantitative&discipline=data"));
  assert.equal(a, b);
  assert.doesNotMatch(a, /utm_source|zz=/);
  assert.equal(guestCachePath(page("/roles?nonsense=1")), "/roles");
  assert.equal(guestCachePath(page("/roles?page=2")), "/roles?page=2", "page 2 is never served page 1");
  assert.notEqual(guestCachePath(page("/roles?discipline=data&page=3")), guestCachePath(page("/roles?discipline=data")));
  assert.equal(guestCachePath(page("/roles?discipline=data&discipline=data")), "/roles?discipline=data");
});

test("the landing page is one key whatever its query, and an old dashboard link on it is rendered, never stored", () => {
  // The landing page takes no query, so marketing parameters cannot force a render.
  assert.equal(guestCachePath(page("/?utm_source=x&ref=y")), "/");
  // An old link to a filtered dashboard redirects to the roles view; a redirect is rendered each time and never stored.
  assert.equal(guestCachePath(page("/?discipline=data")), null);
  assert.equal(guestCachePath(page("/?page=2")), null);
});

test("a hit serves the stored page with the request's own nonce in every place", async () => {
  const cache = memoryCache();
  const pending = [];
  const oldNonce = "OLDnonceOLDnonceOLDnonce";
  const html = `<script nonce="${oldNonce}"></script><link nonce="${oldNonce}"><script>self.__n="${oldNonce}"</script>`;
  let renders = 0;
  const render = async () => {
    renders += 1;
    return new Response(html, { status: 200, headers: { "content-type": "text/html; charset=utf-8", vary: "RSC", "cache-control": "no-store, must-revalidate" } });
  };
  const request = page("/");
  const miss = await serveGuestPage({ request, path: "/", version: 7, nonce: oldNonce, cache, render, waitUntil: (p) => pending.push(p) });
  await Promise.all(pending);
  assert.equal(miss.headers.get(CACHE_STATUS_HEADER), "miss");
  assert.equal(await miss.text(), html);
  assert.equal(cache.store.size, 1);
  const stored = [...cache.store.values()][0];
  assert.equal(stored.headers.get("cache-control"), "public, max-age=300");
  assert.equal(stored.headers.get("vary"), null);

  const freshNonce = "NEWnonceNEWnonceNEWnonce";
  const hit = await serveGuestPage({ request, path: "/", version: 7, nonce: freshNonce, cache, render, waitUntil: (p) => pending.push(p) });
  const body = await hit.text();
  assert.equal(renders, 1, "a hit does not render");
  assert.equal(hit.headers.get(CACHE_STATUS_HEADER), "hit");
  assert.equal(body.split(freshNonce).length - 1, 3);
  assert.equal(body.includes(oldNonce), false, "no stored nonce survives");
  assert.equal(hit.headers.get(STORED_NONCE_HEADER), null);
  assert.equal(hit.headers.get("cache-control"), "no-store, must-revalidate");
});

test("a page stored by one Worker version is never served by another", async () => {
  const cache = memoryCache();
  const pending = [];
  let renders = 0;
  const render = async () => {
    renders += 1;
    return new Response(`<link rel="stylesheet" href="/assets/build-${renders}.css">`, { status: 200, headers: { "content-type": "text/html" } });
  };
  const serve = (build) => serveGuestPage({ request: page("/"), path: "/", version: 3, build, nonce: "n".repeat(24), cache, render, waitUntil: (p) => pending.push(p) });
  await serve("version-a");
  await Promise.all(pending);
  assert.equal((await serve("version-a")).headers.get(CACHE_STATUS_HEADER), "hit");
  const deployed = await serve("version-b");
  assert.equal(deployed.headers.get(CACHE_STATUS_HEADER), "miss", "a deploy renders afresh instead of serving the old build's page");
  assert.match(await deployed.text(), /build-2\.css/);
  await Promise.all(pending);
  assert.equal((await serve("version-a")).headers.get(CACHE_STATUS_HEADER), "hit", "a rollback finds its own build's pages");
});

test("only a 200 HTML page without a cookie is stored, and a new data version misses", async () => {
  const cache = memoryCache();
  const pending = [];
  const serve = (response, version = 1) => serveGuestPage({ request: page("/"), path: "/", version, nonce: "n".repeat(24), cache, render: async () => response(), waitUntil: (p) => pending.push(p) });
  for (const response of [
    () => new Response("<p>signed in</p>", { status: 200, headers: { "content-type": "text/html", "set-cookie": "sb-x-auth-token=1" } }),
    () => new Response("not found", { status: 404, headers: { "content-type": "text/html" } }),
    () => Response.json({ ok: true }),
  ]) {
    const result = await serve(response);
    assert.equal(result.headers.get(CACHE_STATUS_HEADER), "bypass");
  }
  await Promise.all(pending);
  assert.equal(cache.store.size, 0);

  const html = () => new Response("<p>guest</p>", { status: 200, headers: { "content-type": "text/html" } });
  await serve(html, 1);
  await Promise.all(pending);
  assert.equal((await serve(html, 1)).headers.get(CACHE_STATUS_HEADER), "hit");
  assert.equal((await serve(html, 2)).headers.get(CACHE_STATUS_HEADER), "miss", "a bumped version is a purge");
});

test("the data version is read at most once per window, and a failed read is not remembered", async () => {
  let now = 0;
  let reads = 0;
  let answer = 5;
  const version = memoizedVersion(async () => { reads += 1; return answer; }, 10_000, () => now);
  assert.equal(await version(), 5);
  answer = 6;
  now = 9_999;
  assert.equal(await version(), 5);
  assert.equal(reads, 1);
  now = 10_000;
  assert.equal(await version(), 6);
  answer = null;
  now = 30_000;
  assert.equal(await version(), null);
  answer = 8;
  assert.equal(await version(), 8, "a failure is retried on the next request");
  assert.equal(reads, 4);
});

test("guest questions fail closed without the limits and say which limit refused them", async () => {
  const allow = { limit: async () => ({ success: true }) };
  const refuse = { limit: async () => ({ success: false }) };
  const request = new Request("https://firstseen.test/api/recruiting-agent", { method: "POST", headers: { "cf-connecting-ip": "203.0.113.9" } });

  const missing = await guestAgentAllowance(request, {});
  assert.deepEqual(missing, { allowed: false, reason: "unavailable" });
  const unavailable = guestLimitResponse(missing);
  assert.equal(unavailable.status, 503);
  assert.equal((await unavailable.json()).error, "guest_agent_unavailable");

  const keys = [];
  const recording = { limit: async ({ key }) => { keys.push(key); return { success: false }; } };
  const address = await guestAgentAllowance(request, { GUEST_AGENT_ADDRESS_LIMIT: recording, GUEST_AGENT_OVERALL_LIMIT: allow });
  assert.deepEqual(keys, ["address:203.0.113.9"]);
  const limited = guestLimitResponse(address);
  assert.equal(limited.status, 429);
  assert.equal(limited.headers.get("retry-after"), "60");
  const body = await limited.json();
  assert.equal(body.scope, "address");
  assert.equal(body.limit, GUEST_QUESTIONS_PER_ADDRESS);
  assert.match(body.message, new RegExp(`${GUEST_QUESTIONS_PER_ADDRESS} questions a minute`));

  const overall = await guestAgentAllowance(request, { GUEST_AGENT_ADDRESS_LIMIT: allow, GUEST_AGENT_OVERALL_LIMIT: refuse });
  const overallBody = await guestLimitResponse(overall).json();
  assert.equal(overallBody.scope, "overall");
  assert.equal(overallBody.limit, GUEST_QUESTIONS_OVERALL);

  assert.deepEqual(await guestAgentAllowance(request, { GUEST_AGENT_ADDRESS_LIMIT: allow, GUEST_AGENT_OVERALL_LIMIT: allow }), { allowed: true });
});

test("a signed-in visit to the front page is sent to the roles view before anything renders", () => {
  const signedIn = { cookie: "sb-abc-auth-token=token" };
  assert.equal(frontDoorRedirect(page("/", { headers: signedIn })), "/roles");
  assert.equal(frontDoorRedirect(page("/?discipline=data&utm_source=x", { headers: signedIn })), "/roles?discipline=data", "an old dashboard link keeps its filters");
  assert.equal(frontDoorRedirect(page("/")), null, "a guest gets the landing page");
  assert.equal(frontDoorRedirect(page("/", { headers: { ...signedIn, rsc: "1" } })), null, "a client navigation follows the page's own redirect");
  assert.equal(frontDoorRedirect(page("/roles", { headers: signedIn })), null);
  assert.equal(frontDoorRedirect(page("/", { headers: signedIn, method: "POST" })), null);
});
