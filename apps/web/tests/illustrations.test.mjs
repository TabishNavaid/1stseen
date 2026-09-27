/**
 * The landing page's and the first run's illustrations are self-hosted vector art, recoloured to the palette, and
 * credited in docs/credits.md. Each is drawn twice, once for a dark page (scripts/build-doodle-dark.mjs).
 */

import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { DARK_INK } from "../../../scripts/build-doodle-dark.mjs";

const WEB = fileURLToPath(new URL("..", import.meta.url));
const DIR = join(WEB, "public", "illustrations");
const read = (file) => readFileSync(join(DIR, file), "utf8");
const files = readdirSync(DIR).filter((file) => file.endsWith(".svg"));
const drawings = files.filter((file) => !file.endsWith("-dark.svg"));

test("the illustrations are self-hosted, recoloured to the palette, and credited", () => {
  const credits = readFileSync(join(WEB, "..", "..", "docs", "credits.md"), "utf8");
  assert.ok(drawings.length >= 3, drawings.join(", "));
  for (const file of drawings) {
    const svg = read(file);
    assert.doesNotMatch(svg, /<script|href=|xlink:href|<image/i, `${file} is plain vector art`);
    assert.doesNotMatch(svg, /#000000|#FF5678/i, `${file} is recoloured`);
    assert.match(credits, new RegExp(`illustrations/${file.slice(0, -4)}\\.svg`));
  }
  assert.match(credits, /CC0 1\.0/);
  assert.match(credits, /Open Doodles/);
});

test("every drawing has a dark copy, and it is the same drawing in the dark palette's two colours", () => {
  const dark = files.filter((file) => file.endsWith("-dark.svg")).map((file) => file.replace("-dark.svg", ".svg"));
  assert.deepEqual(dark.sort(), [...drawings].sort(), "run npm run build:doodle-dark");
  const geometry = (svg) => svg.replace(/#[0-9a-f]{3,6}/gi, "#");
  for (const file of drawings) {
    const light = read(file);
    const copy = read(file.replace(/\.svg$/, "-dark.svg"));
    assert.equal(geometry(copy), geometry(light), `${file} and its dark copy must differ only in their colours`);
    for (const [from, to] of DARK_INK) {
      if (from === to) continue;
      // The ink the light drawing is made of would disappear into a dark page; the dark copy must not still hold it.
      assert.doesNotMatch(copy, new RegExp(from, "i"), `${file}'s dark copy still has the light ink ${from}`);
      if (light.toLowerCase().includes(from)) assert.ok(copy.toLowerCase().includes(to), `${file}'s dark copy is missing ${to}`);
    }
  }
});
