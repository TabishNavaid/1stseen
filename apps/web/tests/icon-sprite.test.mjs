/**
 * Icons render from one sprite, never inline.
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const WEB = fileURLToPath(new URL("..", import.meta.url));
const ROOT = join(WEB, "..", "..");

function sources(directory) {
  return readdirSync(directory).flatMap((entry) => {
    const path = join(directory, entry);
    return statSync(path).isDirectory() ? sources(path) : /\.(ts|tsx)$/.test(entry) ? [path] : [];
  });
}

test("the committed sprite and icon names match the generator", () => {
  const output = execFileSync(process.execPath, [join(ROOT, "scripts/build-icon-sprite.mjs"), "--check"], { encoding: "utf8" });
  assert.match(output, /icon sprite up to date/);
});

test("no surface imports lucide-react, and every icon name used is in the sprite", () => {
  const sprite = readFileSync(join(WEB, "public/icons.svg"), "utf8");
  const symbols = new Set([...sprite.matchAll(/<symbol id="([a-z0-9-]+)"/g)].map((match) => match[1]));
  const offenders = [];
  const unknown = [];
  for (const file of ["app", "components", "lib"].flatMap((directory) => sources(join(WEB, directory)))) {
    const source = readFileSync(file, "utf8");
    if (/from\s+["']lucide-react["']/.test(source)) offenders.push(file);
    for (const match of source.matchAll(/<Icon\s+name="([a-z0-9-]+)"/g)) {
      if (!symbols.has(match[1])) unknown.push(`${file}: ${match[1]}`);
    }
  }
  assert.deepEqual(offenders, []);
  assert.deepEqual(unknown, []);
});

test("the rendered dashboard references the sprite instead of inlining icon paths", async () => {
  process.env.FIRSTSEEN_DEMO_MODE = "true";
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}`);
  const { default: worker } = await import(workerUrl.href);
  const response = await worker.fetch(
    new Request("http://localhost/", { headers: { accept: "text/html" } }),
    { ASSETS: { fetch: async () => new Response("Not found", { status: 404 }) } },
    { waitUntil() {}, passThroughOnException() {} },
  );
  const html = await response.text();
  assert.match(html, /<use href="\/icons\.svg\?v=[0-9a-f]{10}#[a-z0-9-]+"/);
  assert.doesNotMatch(html, /class="lucide/);
});
