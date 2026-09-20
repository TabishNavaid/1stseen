/**
 * The mark: one drawing, in the page and on every tile a browser or a phone asks for, drawn from the palette and
 * fetched from nowhere.
 */

import assert from "node:assert/strict";
import { readFileSync, statSync } from "node:fs";
import test from "node:test";
import { BIRD_MARK } from "../lib/brand/bird-mark.ts";

const asset = (name) => new URL(`../public/${name}`, import.meta.url);

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

/** A PNG says its own size in the IHDR chunk, which is always the first one. */
function pngSize(name) {
  const bytes = readFileSync(asset(name));
  assert.equal(bytes.subarray(1, 4).toString("ascii"), "PNG", `${name} is a PNG`);
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

test("the mark is drawn from the palette and nothing else, in both arrangements", () => {
  for (const [ground, art] of Object.entries(BIRD_MARK)) {
    assert.ok(art.shapes.length > 0, ground);
    for (const shape of art.shapes) assert.match(shape.fill, /^var\(--color-drawn-[a-z]+\)$/, `${ground}: ${shape.fill}`);
  }
  // On a dark tile an ink outline is nothing, so the tile arrangement is the smaller one: the paper shape carries it.
  assert.ok(BIRD_MARK.tile.shapes.length < BIRD_MARK.paper.shapes.length);
});

test("the tab's icon is plain vector, on the accent green the rest of the product uses", () => {
  const favicon = readFileSync(asset("favicon.svg"), "utf8");
  assert.doesNotMatch(favicon, /<script|href=|xlink:href|<image/i, "nothing to fetch and nothing to run");
  const tile = /<rect[^>]*fill="(#[0-9a-f]{6})"/i.exec(favicon);
  assert.ok(tile, "the icon is a tile");
  const tokens = readFileSync(new URL("../app/globals.css", import.meta.url), "utf8");
  const accent = /--color-accent:\s*(#[0-9a-f]{6})/i.exec(tokens)?.[1];
  assert.equal(tile[1].toLowerCase(), accent.toLowerCase(), "the tile drifted from --color-accent");
  // Small enough that it is never worth a second thought, and written by the build rather than by hand.
  assert.ok(statSync(asset("favicon.svg")).size < 2048, "the icon stays small");
});

test("the raster icons are the sizes the browsers and the home screen ask for", () => {
  assert.deepEqual(pngSize("icon-32.png"), { width: 32, height: 32 });
  assert.deepEqual(pngSize("apple-touch-icon.png"), { width: 180, height: 180 });
  assert.deepEqual(pngSize("og-image.png"), { width: 1200, height: 630 });
});

test("a page names all three icons, and draws the wordmark's bird inline", async () => {
  const html = await render("/", { FIRSTSEEN_DEMO_MODE: "true" });
  for (const icon of ["/favicon.svg", "/icon-32.png", "/apple-touch-icon.png"]) {
    assert.match(html, new RegExp(`<link[^>]*href="${icon.replace(/[/.]/g, "\\$&")}"`), icon);
  }
  // The wordmark: a link home whose picture is in the page, not fetched. Both ends of the page wear one.
  const marks = [...html.matchAll(/<a href="\/" class="focus-ring[\s\S]*?<\/a>/g)].map((match) => match[0]);
  assert.equal(marks.length, 2, "the header and the footer, and nowhere else");
  for (const mark of marks) {
    assert.match(mark, /<svg[^>]*aria-hidden="true"/, "the bird is drawn inline");
    assert.match(mark, />1stSeen<\/span>/, "the word is what names the link");
    assert.doesNotMatch(mark, /<img\b/, "nothing is fetched to draw the wordmark");
  }
});
