/**
 * The landing page's motion is the only animation library in the product, and these are the bounds it ships under.
 */

import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const web = fileURLToPath(new URL("..", import.meta.url));
const motion = readFileSync(join(web, "components/landing/landing-motion.tsx"), "utf8");

function sourceFiles(dir, found = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) sourceFiles(path, found);
    else if (/\.tsx?$/.test(entry.name)) found.push([path, readFileSync(path, "utf8")]);
  }
  return found;
}

test("nothing is imported when the reader asked for less motion", () => {
  // The check has to come before the imports, or a reader who wants no motion still pays for the library.
  const guard = motion.indexOf("prefers-reduced-motion");
  const firstImport = motion.indexOf('import("gsap")');
  assert.ok(guard > 0 && firstImport > guard, "the import sits after the check, not beside it");
  assert.match(motion.slice(guard, firstImport), /if \(reduced\.matches\) return;/);
});

test("every beat animates from a start state, so the page is complete without the library", () => {
  // `gsap.from` ends at the rendered value. Nothing may set an element to hidden and rely on script to reveal it,
  // because a failed chunk, a blocked request or no script at all would then leave the page empty.
  assert.doesNotMatch(motion, /gsap\.(to|set)\(/, "a beat that is set or tweened to needs a visible start");
  assert.match(motion, /\.from\(/);
  assert.doesNotMatch(motion, /opacity:\s*0\s*}\s*\)\s*;?\s*\/\/\s*set/);
});

test("the libraries are landing-route only, and bundled rather than fetched", () => {
  const offenders = sourceFiles(join(web, "components"))
    .concat(sourceFiles(join(web, "app")))
    .filter(([path, source]) => !path.endsWith("landing-motion.tsx") && /from "(gsap|lenis)|import\("(gsap|lenis)/.test(source));
  assert.deepEqual(offenders.map(([path]) => path.slice(web.length)), [], "only the landing motion names an animation library");

  // Mounted by the landing page and nowhere else.
  const mounts = sourceFiles(join(web, "components")).concat(sourceFiles(join(web, "app")))
    .filter(([, source]) => /<LandingMotion\s*\/>/.test(source));
  assert.deepEqual(mounts.map(([path]) => path.slice(web.length).replace(/^\//, "")), ["components/landing/landing-page.tsx"]);

  // Bundled: an import specifier, never a URL. The policy is script-src 'self' and there is no CDN.
  assert.doesNotMatch(motion, /https?:\/\//);
});

test("what it starts, it stops", () => {
  for (const teardown of ["cancelAnimationFrame", "lenis.destroy()", "context.revert()", "trigger.kill()"]) {
    assert.ok(motion.includes(teardown), `${teardown} runs when the page is left`);
  }
});

test("the hero's three beats are in the order the card argues them", () => {
  const card = readFileSync(join(web, "components/landing/role-preview-card.tsx"), "utf8");
  // The record, then the date: the date is last and it is the large one, which is the whole point of the change.
  assert.ok(card.indexOf('data-beat="record"') < card.indexOf('data-beat="date"'));
  assert.match(card, /<LikelyWindow[\s\S]*?size="lg"/);
  // The record beat starts at 0 and the date beat after it, not alongside.
  const record = /hero\.from\(record, \{[^}]*\}, (\d+(?:\.\d+)?)\)/.exec(motion);
  const date = /hero\.from\(date, \{[^}]*\}, (\d+(?:\.\d+)?)\)/.exec(motion);
  assert.ok(record && date, "both beats are on the timeline");
  assert.ok(Number(date[1]) > Number(record[1]), "the date resolves after the record");
});
