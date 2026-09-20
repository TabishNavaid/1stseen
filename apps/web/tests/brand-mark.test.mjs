/**
 * The mark: the drawing from design-refs/icon, carried into the page and onto every icon a browser or a phone asks
 * for, unchanged, and fetched from nowhere.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { BIRD_MARK, MARK_ID_SLOT } from "../lib/brand/bird-mark.ts";

const asset = (name) => new URL(`../public/${name}`, import.meta.url);
const reference = (name) => readFileSync(new URL(`../../../design-refs/icon/${name}.svg`, import.meta.url), "utf8");
const colours = (svg) => [...new Set([...svg.matchAll(/#[0-9a-fA-F]{3,8}/g)].map((match) => match[0].toLowerCase()))].sort();

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

/** A PNG says its own size and whether it carries transparency in the IHDR chunk, which is always the first one. */
function png(name) {
  const bytes = readFileSync(asset(name));
  assert.equal(bytes.subarray(1, 4).toString("ascii"), "PNG", `${name} is a PNG`);
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20), colourType: bytes[25] };
}

test("the shipped mark is the drawing it came from, in both weights", () => {
  const sources = { mark: "icon-C", small: "favicon-C" };
  for (const [kind, name] of Object.entries(sources)) {
    const art = BIRD_MARK[kind];
    assert.ok(art.nodes.length > 0, kind);
    // Not one colour renamed, dropped or added between the drawing and what a page draws.
    assert.deepEqual(colours(JSON.stringify(art)), colours(reference(name).replace(/<metadata>[\s\S]*?<\/metadata>/g, "")), kind);
    assert.equal(art.viewBox, /viewBox="([^"]+)"/.exec(reference(name))[1], kind);
  }
  // The two weights are two drawings, not one drawing twice.
  assert.notDeepEqual(BIRD_MARK.mark.nodes, BIRD_MARK.small.nodes);
});

test("the tab's icon is the heavier drawing, plain vector, and carries no manifest", () => {
  const favicon = readFileSync(asset("favicon.svg"), "utf8");
  assert.doesNotMatch(favicon, /<script|href=|xlink:href|<image/i, "nothing to fetch and nothing to run");
  assert.doesNotMatch(favicon, /c2pa|<metadata/i, "the provenance stays in design-refs, with the drawing");
  assert.deepEqual(colours(favicon), colours(reference("favicon-C").replace(/<metadata>[\s\S]*?<\/metadata>/g, "")));
  // Optimised, not redrawn: smaller than the file it came from, and still the same box.
  assert.ok(favicon.length < reference("favicon-C").length / 2, "the icon is optimised");
  assert.match(favicon, /viewBox="0 0 120 120"/);
});

test("the raster icons are the sizes the browsers and the home screen ask for", () => {
  assert.deepEqual(png("icon-32.png"), { width: 32, height: 32, colourType: 6 });
  assert.deepEqual(png("og-image.png"), { width: 1200, height: 630, colourType: 2 });
  // A home screen rounds the icon itself and fills nothing behind it, so this one has no transparent corners.
  assert.deepEqual(png("apple-touch-icon.png"), { width: 180, height: 180, colourType: 2 });
});

test("a page names all three icons, draws the mark inline at both ends, and repeats no id", async () => {
  const html = await render("/", { FIRSTSEEN_DEMO_MODE: "true" });
  for (const icon of ["/favicon.svg", "/icon-32.png", "/apple-touch-icon.png"]) {
    assert.match(html, new RegExp(`<link[^>]*href="${icon.replace(/[/.]/g, "\\$&")}"`), icon);
  }
  const marks = [...html.matchAll(/<a href="\/" class="focus-ring[\s\S]*?<\/a>/g)].map((match) => match[0]);
  assert.equal(marks.length, 2, "the header and the footer, and nowhere else");
  for (const mark of marks) {
    assert.match(mark, /<svg[^>]*aria-hidden="true"/, "the drawing is in the page");
    assert.match(mark, />1stSeen<\/span>/, "the word is what names the link");
    assert.doesNotMatch(mark, /<img\b/, "nothing is fetched to draw the wordmark");
    assert.doesNotMatch(mark, new RegExp(MARK_ID_SLOT), "the clip's id was filled in");
  }
  // Two clips, two names: a document cannot hold the same id twice.
  const ids = [...html.matchAll(/\sid="([^"]+)"/g)].map((match) => match[1]);
  assert.deepEqual([...new Set(ids)].length, ids.length, ids.join(", "));
});
