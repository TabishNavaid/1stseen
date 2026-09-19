/**
 * The landing page's and the first run's pictograms render from their own sprite, generated like the icon sprite.
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const WEB = fileURLToPath(new URL("..", import.meta.url));

function sources(directory) {
  return readdirSync(directory).flatMap((entry) => {
    const path = join(directory, entry);
    return statSync(path).isDirectory() ? sources(path) : /\.(ts|tsx)$/.test(entry) ? [path] : [];
  });
}

test("the committed pictogram sprite and names match the generator", () => {
  const output = execFileSync(process.execPath, [join(WEB, "tools/build-pictograms.mjs"), "--check"], { encoding: "utf8" });
  assert.match(output, /pictogram sprite up to date/);
});

test("every pictogram a surface names is in the sprite", () => {
  // Names reached through a PictogramName-typed value are checked by the typechecker; these are the literal ones.
  const sprite = readFileSync(join(WEB, "public/pictograms.svg"), "utf8");
  const symbols = new Set([...sprite.matchAll(/<symbol id="([a-z0-9-]+)"/g)].map((match) => match[1]));
  const unknown = [];
  for (const file of ["app", "components", "lib"].flatMap((directory) => sources(join(WEB, directory)))) {
    for (const match of readFileSync(file, "utf8").matchAll(/(?:<Pictogram\s+name=|pictogram:\s*)"([a-z0-9-]+)"/g)) {
      if (!symbols.has(match[1])) unknown.push(`${file}: ${match[1]}`);
    }
  }
  assert.deepEqual(unknown, []);
});

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
