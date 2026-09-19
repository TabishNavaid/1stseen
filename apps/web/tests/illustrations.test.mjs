/**
 * The landing page's and the first run's illustrations are self-hosted vector art, recoloured to the palette, and
 * credited in docs/credits.md.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const WEB = fileURLToPath(new URL("..", import.meta.url));

test("the illustrations are self-hosted, recoloured to the palette, and credited", () => {
  const credits = readFileSync(join(WEB, "..", "..", "docs", "credits.md"), "utf8");
  for (const name of ["sprinting", "jumping", "reading-side"]) {
    const svg = readFileSync(join(WEB, "public", "illustrations", `${name}.svg`), "utf8");
    assert.doesNotMatch(svg, /<script|href=|xlink:href|<image/i, `${name}.svg is plain vector art`);
    assert.doesNotMatch(svg, /#000000|#FF5678/i, `${name}.svg is recoloured`);
    assert.match(credits, new RegExp(`illustrations/${name}\\.svg`));
  }
  assert.match(credits, /CC0 1\.0/);
  assert.match(credits, /Open Doodles/);
});
