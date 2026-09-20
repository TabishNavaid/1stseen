/**
 * The mark: the drawing from design-refs/icon, carried into the page and onto every icon a browser or a phone asks
 * for, unchanged, and fetched from nowhere.
 */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";
import { BIRD_MARK, MARK_ID_SLOT, MARK_SOURCES } from "../lib/brand/bird-mark.ts";

const asset = (name) => new URL(`../public/${name}`, import.meta.url);
const colours = (svg) => [...new Set([...svg.matchAll(/#[0-9a-fA-F]{3,8}/g)].map((match) => match[0].toLowerCase()))].sort();

// The drawings live in design-refs, which is not in the repository, so a checkout without it checks what shipped
// against itself and a checkout with it also checks that against the drawing.
const referencePath = (kind) => new URL(`../../../${MARK_SOURCES[kind].file}`, import.meta.url);
const haveReferences = Object.keys(MARK_SOURCES).every((kind) => existsSync(referencePath(kind)));

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

test("the shipped mark is one drawing at two weights, in the palette it arrived in", () => {
  const shipped = Object.entries(BIRD_MARK);
  for (const [kind, art] of shipped) {
    assert.ok(art.nodes.length > 0, kind);
    assert.equal(art.viewBox, "0 0 120 120", kind);
    // The clip is reached by a name, and the name is a slot until a page fills it.
    assert.match(JSON.stringify(art), new RegExp(MARK_ID_SLOT), kind);
  }
  // Two weights of one bird: the same colours, a different line.
  assert.deepEqual(colours(JSON.stringify(BIRD_MARK.mark)), colours(JSON.stringify(BIRD_MARK.small)));
  assert.notDeepEqual(BIRD_MARK.mark.nodes, BIRD_MARK.small.nodes);
  // The tab's icon is the heavier drawing itself, not a copy that drifted from it.
  assert.deepEqual(colours(readFileSync(asset("favicon.svg"), "utf8")), colours(JSON.stringify(BIRD_MARK.small)));
});

test("what shipped is the drawing it came from, where the drawing is at hand", { skip: haveReferences ? false : "design-refs is not in this checkout" }, () => {
  for (const [kind, source] of Object.entries(MARK_SOURCES)) {
    const file = readFileSync(referencePath(kind));
    assert.equal(createHash("sha256").update(file).digest("hex"), source.sha256, `${source.file} changed; run npm run build:brand-art`);
    const svg = file.toString("utf8").replace(/<metadata>[\s\S]*?<\/metadata>/g, "");
    // Not one colour renamed, dropped or added between the drawing and what a page draws.
    assert.deepEqual(colours(JSON.stringify(BIRD_MARK[kind])), colours(svg), kind);
    assert.equal(BIRD_MARK[kind].viewBox, /viewBox="([^"]+)"/.exec(svg)[1], kind);
  }
});

test("the tab's icon is plain vector, optimised, and carries no manifest", () => {
  const favicon = readFileSync(asset("favicon.svg"), "utf8");
  assert.doesNotMatch(favicon, /<script|href=|xlink:href|<image/i, "nothing to fetch and nothing to run");
  assert.doesNotMatch(favicon, /c2pa|<metadata/i, "the provenance stays in design-refs, with the drawing");
  assert.match(favicon, /viewBox="0 0 120 120"/);
  // Small enough to be worth no thought, and written by the build rather than by hand.
  assert.ok(favicon.length < 12_000, `the icon stays small: ${favicon.length} bytes`);
});

test("the raster icons are the sizes the browsers and the home screen ask for", () => {
  assert.deepEqual(png("icon-32.png"), { width: 32, height: 32, colourType: 6 });
  // A home screen rounds the icon itself and fills nothing behind it, so this one has no transparent corners.
  assert.deepEqual(png("apple-touch-icon.png"), { width: 180, height: 180, colourType: 2 });
});

test("the link preview is the size a preview is cropped to, opaque, and small enough to arrive", () => {
  const preview = png("og-image.png");
  assert.equal(preview.width, 1200);
  assert.equal(preview.height, 630);
  // 4 and 6 are the colour types that carry an alpha channel, and a photograph has nothing to see through.
  assert.ok(![4, 6].includes(preview.colourType), `og-image.png carries an alpha channel it never uses`);
  // A photograph of this page is a few flat colours, a gradient and the grain, so a palette holds it in a tenth
  // of the bytes; a full-colour screenshot of it is over half a megabyte in front of a link.
  assert.ok(readFileSync(asset("og-image.png")).length < 150_000, "the link preview stays small");
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
