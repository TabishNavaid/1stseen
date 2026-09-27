/**
 * Light and dark: what the page is served as, what a held choice does to it, and what it must not cost.
 */

import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { guestCachePath } from "../cloudflare/guest-cache.ts";
import { APPEARANCES, APPEARANCE_SCRIPT, APPEARANCE_STORAGE_KEY, applyAppearance, isAppearance } from "../lib/appearance.ts";

function sourceFiles(dir, found = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) sourceFiles(path, found);
    else if (/\.(tsx?|mjs)$/.test(entry.name)) found.push([path, readFileSync(path, "utf8")]);
  }
  return found;
}

async function render(pathname, env = {}, headers = {}) {
  const saved = Object.fromEntries(Object.keys(env).map((key) => [key, process.env[key]]));
  Object.assign(process.env, env);
  try {
    const workerUrl = new URL("../dist/server/index.js", import.meta.url);
    workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}-${Math.random()}`);
    const { default: worker } = await import(workerUrl.href);
    const response = await worker.fetch(
      new Request(`http://localhost${pathname}`, { headers: { accept: "text/html", ...headers } }),
      { ASSETS: { fetch: async () => new Response("Not found", { status: 404 }) } },
      { waitUntil() {}, passThroughOnException() {} },
    );
    return { html: await response.text(), headers: response.headers };
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test("the stylesheet is the theme: a reader's system setting needs no script at all", () => {
  const css = readFileSync(new URL("../app/globals.css", import.meta.url), "utf8");
  assert.match(css, /:root \{ color-scheme: light dark; \}/);
  // And the colours are written for both, which design-tokens.test.mjs checks for contrast in each.
  assert.ok(css.match(/light-dark\(/g).length > 60, "every themed token names both");
});

test("a held theme is on the document before the first paint, under the request's own nonce", async () => {
  const { html } = await render("/roles", { FIRSTSEEN_DEMO_MODE: "true" });
  const script = /<script[^>]*nonce="[^"]+"[^>]*>([^<]*localStorage[^<]*)<\/script>/.exec(html);
  assert.ok(script, "the inline script carries the nonce the response's policy names");
  assert.equal(script[1], APPEARANCE_SCRIPT);
  assert.ok(html.indexOf(script[0]) < html.indexOf("<body"), "it runs before the body is parsed");
  // It reads one key and writes one attribute. Anything more in the first script of every page needs saying.
  assert.match(APPEARANCE_SCRIPT, /^try\{/, "a browser that refuses storage still gets a page");
  assert.equal(APPEARANCE_SCRIPT.includes(APPEARANCE_STORAGE_KEY), true);
  assert.doesNotMatch(APPEARANCE_SCRIPT, /fetch|document\.write|innerHTML/);
});

test("the control offers the reader's system setting and the two themes, on every page", async () => {
  assert.deepEqual(APPEARANCES.map(([value]) => value), ["system", "light", "dark"]);
  for (const path of ["/", "/roles", "/signin"]) {
    const { html } = await render(path, { FIRSTSEEN_DEMO_MODE: "true" });
    const control = /<fieldset[^>]*>[\s\S]*?Appearance[\s\S]*?<\/fieldset>/.exec(html);
    assert.ok(control, `${path} carries the appearance control`);
    for (const [value, label] of APPEARANCES) {
      assert.match(control[0], new RegExp(`value="${value}"`), `${path}: ${value}`);
      assert.match(control[0], new RegExp(`>${label}<`), `${path}: ${label}`);
    }
    // System is the one a page is rendered as, because the server has no browser to ask.
    const system = /<input[^>]*value="system"[^>]*>/.exec(control[0]);
    assert.ok(system && /\bchecked\b/.test(system[0]), `${path}: system is the rendered choice`);
  }
});

test("system is the absence of a choice, so it hands the page back to the reader's own setting", () => {
  const root = { dataset: { theme: "dark" } };
  applyAppearance("system", root);
  assert.equal("theme" in root.dataset, false);
  applyAppearance("dark", root);
  assert.equal(root.dataset.theme, "dark");
  assert.equal(isAppearance("dark"), true);
  assert.equal(isAppearance("sepia"), false);
});

test("the theme costs the guest cache nothing, because the page is the same page in both", async () => {
  // The choice lives in the browser, never in a cookie, so two signed-out readers in different themes are served
  // the same bytes and one key. A theme that travelled in a request would be a parameter the key has to name.
  const withTheme = new Request("http://localhost/roles", { headers: { accept: "text/html", cookie: `${APPEARANCE_STORAGE_KEY}=dark` } });
  const plain = new Request("http://localhost/roles", { headers: { accept: "text/html" } });
  assert.equal(guestCachePath(withTheme), guestCachePath(plain));
  // And the server never decides the theme: the document leaves it with no theme held, whatever it was sent.
  for (const headers of [{}, { cookie: `${APPEARANCE_STORAGE_KEY}=dark` }]) {
    const { html } = await render("/roles", { FIRSTSEEN_DEMO_MODE: "true" }, headers);
    assert.match(html, /<html[^>]*>/);
    assert.doesNotMatch(/<html[^>]*>/.exec(html)[0], /data-theme/, "the theme is applied in the browser, not chosen here");
  }
  // Nothing on the server reads the choice: it is not a request header, so it cannot be one reader's page.
  const server = [...sourceFiles(fileURLToPath(new URL("../app", import.meta.url))), ...sourceFiles(fileURLToPath(new URL("../cloudflare", import.meta.url)))];
  for (const [path, source] of server) {
    if (source.includes(APPEARANCE_STORAGE_KEY)) assert.fail(`${path} reads the appearance choice on the server`);
  }
});
