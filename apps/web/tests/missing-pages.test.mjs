/**
 * The not-found and error pages: a real 404 or 500 (never 200), never stored anywhere, one clear way on, a character
 * whose one movement stops under reduced motion, and nothing from inside the machine on the page.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { CACHE_STATUS_HEADER, serveGuestPage } from "../cloudflare/guest-cache.ts";
import { NOT_FOUND_MARKER, pageStatus, withPageStatus } from "../cloudflare/page-status.ts";
import { NOT_FOUND_ROTATION, pickNotFoundArt } from "../lib/not-found-art.ts";
import { pageLanguageLeaks, visibleText } from "./support/page-language.mjs";

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
    return { status: response.status, headers: response.headers, html: await response.text() };
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

const DEMO = { FIRSTSEEN_DEMO_MODE: "true" };
// A deployment whose database cannot be reached: every read fails, as on a real outage.
const OUTAGE = { SUPABASE_URL: "http://127.0.0.1:9", SUPABASE_SERVICE_ROLE_KEY: "an-unused-test-value", FIRSTSEEN_DEMO_MODE: "" };

/** The page's own column: from the illustrated message to its end, without the site header's navigation. */
const column = (html) => html.slice(html.indexOf('aria-labelledby="missing-title"'), html.indexOf("</main>"));

test("an address that is not a page answers 404 with its headline, one sentence, one button, and one small link", async () => {
  for (const path of ["/this-page-does-not-exist", "/roles/northstar-swe-intern/extra"]) {
    const { status, headers, html } = await render(path, DEMO);
    assert.equal(status, 404, path);
    assert.equal(headers.get("cache-control"), "no-store", path);
    const text = visibleText(column(html));
    assert.match(text, /This page hasn’t opened yet\./);
    assert.match(text, /We’ve checked every cycle\. No sign of it\./);
    assert.match(column(html), /<a[^>]*href="\/"[^>]*>Take me home<\/a>/);
    assert.match(column(html), /<a[^>]*href="\/roles"[^>]*>or browse all roles<\/a>/);
    // One way on, not a menu: no search box and no row of links.
    assert.doesNotMatch(column(html), /<form|<input|Just opened|Explore roles/);
    assert.equal((column(html).match(/<a /g) ?? []).length, 2, path);
    assert.match(html, /<title>Page not found · 1stSeen<\/title>/);
  }
});

test("a program the product does not list answers 404, says so, and sends the visitor to every role", async () => {
  for (const path of ["/roles/00000000-0000-4000-8000-000000000000", "/roles/not-a-program"]) {
    const { status, headers, html } = await render(path, DEMO);
    assert.equal(status, 404, path);
    assert.equal(headers.get("cache-control"), "no-store", path);
    assert.match(visibleText(column(html)), /This program isn’t tracked anymore\./);
    // With no company known, the button is every role and the small link goes home.
    assert.match(column(html), /<a[^>]*href="\/roles"[^>]*>Browse all roles<\/a>/);
    assert.match(column(html), /<a[^>]*href="\/"[^>]*>or go home<\/a>/);
    assert.match(html, /<title>Program no longer tracked · 1stSeen<\/title>/);
  }
  // Without demo mode, a fixture id is not a program either.
  assert.equal((await render("/roles/northstar-swe-intern", { FIRSTSEEN_DEMO_MODE: "" })).status, 404);
});

test("a page that fails on the server answers 500, is not stored, and shows nothing from inside the machine", async () => {
  for (const path of ["/roles", "/opened", "/roles/1f8c981b-96a3-578a-b901-3a1272c45743"]) {
    const { status, headers, html } = await render(path, OUTAGE);
    assert.equal(status, 500, path);
    assert.equal(headers.get("cache-control"), "no-store", path);
    const text = visibleText(html);
    assert.deepEqual(pageLanguageLeaks(html), [], path);
    assert.doesNotMatch(text, /read_failed|at [A-Za-z]+ \(|Error:|stack/i, path);
  }
  // The error view names no error: no message, digest, or trace reaches it.
  const view = readFileSync(new URL("../components/broken-page.tsx", import.meta.url), "utf8");
  assert.match(view, /Well, that tripped us up\./);
  assert.match(view, /Something broke on our side\. Give it a minute and try again\./);
  assert.match(view, /onClick=\{reset\}[^>]*>(?:<[^>]+>)*Try again/);
  assert.match(view, /href="\/"[^>]*>Go home</);
  assert.match(view, /ILLUSTRATIONS\.clumsy/);
  assert.doesNotMatch(view, /\.(?:digest|message|stack)\b|\berror\.\w/);
  for (const file of ["../app/error.tsx", "../app/global-error.tsx"]) {
    const source = readFileSync(new URL(file, import.meta.url), "utf8");
    assert.match(source, /\{ reset \}/, `${file} takes only reset`);
    assert.doesNotMatch(source, /\.(?:digest|message|stack)\b|\berror\.\w/, file);
  }
});

test("a page reads its own status: the marker, React's error template, and nothing a title could fake", () => {
  assert.equal(pageStatus(`<main ${NOT_FOUND_MARKER}>`), 404);
  assert.equal(pageStatus('<template data-dgst="2452668864"></template>'), 500);
  // A read that gave up after the page's loading state was sent fails the boundary later, in a script.
  assert.equal(pageStatus('<script>$RX=function(b,c){};;$RX("B:0","2761999608")</script>'), 500);
  assert.equal(pageStatus('<script>$RX("B:1","BAILOUT_TO_CLIENT_SIDE_RENDERING")</script>'), 200);
  assert.equal(pageStatus('<script>$RX("B:0")</script>'), 200);
  assert.equal(pageStatus('<template data-dgst="NEXT_HTTP_ERROR_FALLBACK;404"></template>'), 404);
  assert.equal(pageStatus('<template data-dgst="NEXT_REDIRECT;replace;/roles;307;"></template>'), 200);
  assert.equal(pageStatus("<main><h1>Software Engineer Intern</h1></main>"), 200);
  // React escapes text and attribute values, so data can never write either marker.
  assert.equal(pageStatus('<h1>data-page-status=&quot;404&quot;</h1><p>&lt;template data-dgst=&quot;1&quot;&gt;</p><p>$RX(&quot;B:0&quot;,&quot;1&quot;)</p>'), 200);
  assert.equal(pageStatus(String.raw`<script>self.push("1:[\"$RX(\"B:0\",\"1\")\"]")</script>`), 200, "escaped inside the page data");
  assert.equal(readFileSync(new URL("../components/missing-page.tsx", import.meta.url), "utf8").includes(NOT_FOUND_MARKER), true, "the page carries the marker the Worker reads");
});

test("the Worker marks every 404 and 500 no-store, and leaves other responses alone", async () => {
  const html = (body, status = 200, headers = {}) => new Response(body, { status, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "private, no-cache", ...headers } });
  const missing = await withPageStatus(html(`<main ${NOT_FOUND_MARKER}></main>`));
  assert.equal(missing.status, 404);
  assert.equal(missing.headers.get("cache-control"), "no-store");
  const broken = await withPageStatus(html('<template data-dgst="7"></template>'));
  assert.equal(broken.status, 500);
  assert.equal(broken.headers.get("cache-control"), "no-store");
  const already = await withPageStatus(html("<p>gone</p>", 404));
  assert.equal(already.headers.get("cache-control"), "no-store");
  const fine = await withPageStatus(html("<p>ok</p>"));
  assert.equal(fine.status, 200);
  assert.equal(fine.headers.get("cache-control"), "private, no-cache");
  const redirect = new Response(null, { status: 307, headers: { location: "/roles" } });
  assert.equal(await withPageStatus(redirect), redirect);
  const payload = new Response("0:{}", { headers: { "content-type": "text/x-component" } });
  assert.equal(await withPageStatus(payload), payload, "a client navigation's payload streams through");
});

test("the guest edge cache stores neither a 404 nor a 500", async () => {
  const store = new Map();
  const cache = { store, match: async (request) => store.get(request.url)?.clone(), put: async (request, response) => { store.set(request.url, response.clone()); } };
  const pending = [];
  for (const status of [404, 500]) {
    const response = await serveGuestPage({
      request: new Request("https://firstseen.test/roles/00000000-0000-4000-8000-000000000000", { headers: { accept: "text/html" } }),
      path: "/roles/00000000-0000-4000-8000-000000000000",
      version: 1,
      build: "b",
      nonce: "n".repeat(24),
      cache,
      render: async () => new Response("<p>not here</p>", { status, headers: { "content-type": "text/html", "cache-control": "no-store" } }),
      waitUntil: (promise) => pending.push(promise),
    });
    assert.equal(response.status, status);
    assert.equal(response.headers.get(CACHE_STATUS_HEADER), "bypass");
  }
  await Promise.all(pending);
  assert.equal(store.size, 0);
});

test("the character leads the page, large and decorative, and bobs once unless motion is reduced", async () => {
  const { html } = await render("/this-page-does-not-exist", DEMO);
  const image = /<img[^>]*src="\/illustrations\/([a-z-]+)\.svg"[^>]*>/.exec(column(html));
  assert.ok(image, "the page draws an illustration");
  assert.match(image[0], /alt=""/, "the headline carries the meaning");
  assert.match(image[0], /class="[^"]*\bbob-once\b/);
  // 240px tall on a phone and 360px from md up, ahead of the headline.
  assert.match(column(html), /class="[^"]*\bh-60\b[^"]*md:h-\[360px\]/);
  assert.ok(column(html).indexOf("<img") < column(html).indexOf("<h1"), "the illustration comes first");
  const credits = readFileSync(new URL("../../../docs/credits.md", import.meta.url), "utf8");
  assert.match(credits, new RegExp(`illustrations/${image[1]}\\.svg`));

  const css = readFileSync(new URL("../app/globals.css", import.meta.url), "utf8");
  assert.match(css, /@utility bob-once \{[^}]*animation: bob-once [^;]* 1 both;/, "it plays once");
  assert.doesNotMatch(css, /animation: bob-once[^;]*infinite/);
  const reduced = css.slice(css.indexOf("@media (prefers-reduced-motion: reduce)"));
  assert.match(reduced, /\.bob-once[^}]*\{ animation: none; \}/);
});

test("each visit to a not-found page gets one of the three characters, at random", async () => {
  assert.deepEqual(
    [0, 0.34, 0.67, 0.9999, 1].map((value) => pickNotFoundArt(() => value)),
    ["unboxing", "reading", "zombieing", "zombieing", "zombieing"],
  );
  const seen = new Set();
  for (let visit = 0; visit < 24; visit += 1) {
    const { status, html } = await render("/this-page-does-not-exist", DEMO);
    assert.equal(status, 404);
    seen.add(/<img[^>]*src="\/illustrations\/([a-z-]+)\.svg"/.exec(column(html))?.[1]);
  }
  assert.ok([...seen].every((name) => NOT_FOUND_ROTATION.includes(name)), [...seen].join(", "));
  // Twenty-four visits showing one character only would happen about once in 10^11 runs.
  assert.ok(seen.size >= 2, `every visit showed ${[...seen].join(", ")}`);
});

test("the not-found pages read as product copy", async () => {
  for (const path of ["/this-page-does-not-exist", "/roles/00000000-0000-4000-8000-000000000000"]) {
    const { html } = await render(path, DEMO);
    assert.deepEqual(pageLanguageLeaks(html, { allow: ["Development fixture", "development fixture"] }), [], path);
  }
});
