#!/usr/bin/env node
/**
 * Draw every illustration a second time, for a dark page.
 *
 * The Open Doodles the product ships are two colours and nothing else: a coral, and the dark green everything is
 * inked and filled in. On paper the green is the drawing and the page is the light behind it. On a dark page that
 * reverses — the ink disappears into the ground and the coral is left floating — so the dark copy keeps the coral,
 * which holds against brown, and takes the ink up to a chalk tone that reads on it. The drawing is unchanged;
 * only its two colours are.
 *
 * Output is committed, beside the originals as `<name>-dark.svg`. Run it with `npm run build:doodle-dark` after
 * adding or replacing an illustration; `apps/web/tests/illustrations.test.mjs` fails when one has no dark copy,
 * or when a copy is anything but the same drawing in these colours.
 */

import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const DIR = resolve(dirname(fileURLToPath(import.meta.url)), "../apps/web/public/illustrations");

/** The two colours the drawings are made of, and what each becomes on a dark page. */
export const DARK_INK = [
  // The coral is already a colour on a dark ground, and it is the one thing carried straight across.
  ["#f28b6b", "#f28b6b"],
  // The ink: a chalk warm enough to belong to the same paper, dim enough not to glare where it fills a whole shape.
  ["#1b3a31", "#afa392"],
];

function darkCopy(svg) {
  return DARK_INK.reduce((text, [from, to]) => text.replaceAll(from, to), svg);
}

const sources = readdirSync(DIR).filter((name) => name.endsWith(".svg") && !name.endsWith("-dark.svg"));
for (const name of sources) {
  const svg = readFileSync(resolve(DIR, name), "utf8");
  const unknown = [...new Set(svg.match(/#[0-9a-f]{3,6}/gi) ?? [])].filter((hex) => !DARK_INK.some(([from]) => from === hex.toLowerCase()));
  if (unknown.length > 0) throw new Error(`${name} is drawn in ${unknown.join(", ")}, which has no dark value in DARK_INK`);
  writeFileSync(resolve(DIR, name.replace(/\.svg$/, "-dark.svg")), darkCopy(svg));
}
console.log(`${sources.length} illustrations, each with a dark copy`);
