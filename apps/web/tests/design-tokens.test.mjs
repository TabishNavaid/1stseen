/**
 * The design tokens in app/globals.css meet WCAG 2.1 AA, in both themes.
 *
 * Reads the hex color tokens straight from the stylesheet, so a token changed without checking its contrast
 * fails here. Text needs 4.5:1; UI component boundaries, focus indicators, evidence-class borders, calendar
 * marks, and confidence rings need 3:1 (WCAG 1.4.3 and 1.4.11).
 *
 * A themed token is written `light-dark(light, dark)`, so each rule below is checked twice, once per theme, and a
 * failure says which one it is. A token written as one hex is the same colour in both — the navigation surfaces are
 * dark in either theme, and inverse text on a filled accent is white in either.
 */

import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const css = readFileSync(new URL("../app/globals.css", import.meta.url), "utf8");
const DECLARATION = /--color-([a-z-]+):\s*(?:(#[0-9a-f]{6})|light-dark\(\s*(#[0-9a-f]{6})\s*,\s*(#[0-9a-f]{6})\s*\))\s*;/gi;

/** Every color token as this theme resolves it. */
function palette(theme) {
  return Object.fromEntries(
    [...css.matchAll(DECLARATION)].map(([, name, single, light, dark]) => [name, (single ?? (theme === "dark" ? dark : light)).toLowerCase()]),
  );
}

const THEMES = { light: palette("light"), dark: palette("dark") };

function luminance(hex) {
  const channels = hex.slice(1).match(/../g).map((part) => Number.parseInt(part, 16) / 255);
  const [r, g, b] = channels.map((value) => (value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(tokens, foreground, background) {
  const [lighter, darker] = [luminance(tokens[foreground]), luminance(tokens[background])].sort((a, b) => b - a);
  return (lighter + 0.05) / (darker + 0.05);
}

function expectContrast(pairs, minimum, themes = ["light", "dark"]) {
  const failures = Object.entries(THEMES).filter(([theme]) => themes.includes(theme)).flatMap(([theme, tokens]) => pairs
    .map(([foreground, background]) => {
      assert.ok(tokens[foreground], `missing token --color-${foreground}`);
      assert.ok(tokens[background], `missing token --color-${background}`);
      return [foreground, background, contrast(tokens, foreground, background)];
    })
    .filter(([, , ratio]) => ratio < minimum)
    .map(([foreground, background, ratio]) => `${theme}: ${foreground} on ${background}: ${ratio.toFixed(2)}:1`));
  assert.deepEqual(failures, [], `below ${minimum}:1`);
}

const SURFACES = ["canvas", "surface", "surface-sunken", "surface-hover", "surface-selected"];
const GROUPS = [
  "success", "warning", "danger", "info",
  "evidence-exact", "evidence-bounded", "evidence-observed", "basis-own", "basis-borrowed",
  "date-confirmed", "date-predicted", "date-preparation",
  "source-official", "source-archive", "source-signal", "source-community",
];

/**
 * The tokens that are one colour in both themes, and why. Everything else has to name both, so a colour added
 * without a dark value cannot reach a dark page as a light one.
 */
const SAME_IN_BOTH = {
  "ink-inverse": "text on a filled accent, which is a deep green in either theme",
  nav: "the workspace navigation is a dark surface in the light theme already",
  "nav-hover": "part of that same dark surface",
  "nav-active": "part of that same dark surface",
  "nav-line": "part of that same dark surface",
  "nav-ink": "light text, already on a dark surface",
  "nav-muted": "light text, already on a dark surface",
  "nav-subtle": "light text, already on a dark surface",
  "nav-accent": "the focus ring on that dark surface",
  "drawn-ink": "the line the bird is inked in, which sits inside its own paper fill and never on the page",
  "drawn-beak": "a fill inside the drawing, legible on either page",
};

test("the theme is one property, and every colour that differs between themes says so", () => {
  // light-dark() needs a used color scheme, and the appearance control holds one by writing data-theme.
  assert.match(css, /:root \{ color-scheme: light dark; \}/, "the root follows the reader's system setting");
  assert.match(css, /:root\[data-theme="light"\] \{ color-scheme: light; \}/);
  assert.match(css, /:root\[data-theme="dark"\] \{ color-scheme: dark; \}/);

  const single = [...css.matchAll(DECLARATION)].filter(([, , one]) => one).map(([, name]) => name);
  const unexplained = single.filter((name) => !(name in SAME_IN_BOTH));
  assert.deepEqual(unexplained, [], "a token with one value needs a reason in SAME_IN_BOTH, or a dark value");
  for (const [name, reason] of Object.entries(SAME_IN_BOTH)) {
    assert.ok(single.includes(name), `--color-${name} now names two themes, so it is no longer one of these`);
    assert.ok(reason.length > 20, `${name} needs a reason, not a note`);
  }
});

/** Every .tsx under the app, for the rules that read what the product actually wrote. */
function sourceFiles(dir, found = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) sourceFiles(path, found);
    else if (entry.name.endsWith(".tsx")) found.push([path, readFileSync(path, "utf8")]);
  }
  return found;
}

test("a colour that is a fill is not used as text", () => {
  // These are grounds: each is dark on paper and dark again on a dark page, because what sits on them is inverse or
  // light ink. Used as a text colour one of the two themes always loses, which is how the landing page's one word
  // came to be a dark green on a dark hero. The text greens are accent-ink and warm-ink, and they are checked above.
  const FILLS = ["accent", "accent-hover", "accent-soft", "warm", "warm-soft", "canvas", "surface", "surface-sunken", "surface-hover", "surface-selected"];
  const web = fileURLToPath(new URL("..", import.meta.url));
  const offenders = [];
  for (const [path, source] of [...sourceFiles(join(web, "components")), ...sourceFiles(join(web, "app"))]) {
    for (const fill of FILLS) {
      const used = new RegExp(`(?<![-a-z])text-${fill}(?![-a-z])`);
      if (used.test(source)) offenders.push(`${path.slice(web.length)}: text-${fill}`);
    }
  }
  assert.deepEqual(offenders, [], "use the -ink token beside it");
});

test("body text tokens reach 4.5:1 on every surface", () => {
  expectContrast(["ink", "ink-muted", "ink-subtle", "accent-ink"].flatMap((ink) => SURFACES.map((surface) => [ink, surface])), 4.5);
});

test("every semantic ink reaches 4.5:1 on its own surface and on the page surface", () => {
  expectContrast(GROUPS.flatMap((group) => [[`${group}-ink`, `${group}-surface`], [`${group}-ink`, "surface"]]), 4.5);
});

test("inverse text reaches 4.5:1 on filled accents and navigation", () => {
  expectContrast(
    [
      ["ink-inverse", "accent"], ["ink-inverse", "accent-hover"], ["ink-inverse", "nav-active"],
      ["nav-ink", "nav"], ["nav-muted", "nav"], ["nav-subtle", "nav"], ["nav-muted", "nav-hover"], ["nav-subtle", "nav-hover"],
    ],
    4.5,
  );
});

test("component boundaries, focus, evidence borders, marks, and confidence rings reach 3:1", () => {
  expectContrast(
    [
      ["line-strong", "surface"], ["line-strong", "canvas"], ["focus", "surface"], ["focus", "canvas"], ["nav-accent", "nav"],
      ...GROUPS.map((group) => [`${group}-line`, "surface"]),
      ...["confirmed", "predicted", "preparation"].map((kind) => [`date-${kind}-mark`, "surface"]),
      ...["strong", "moderate", "limited"].flatMap((tone) => [[`confidence-${tone}`, "surface"], [`confidence-${tone}`, "confidence-track"]]),
    ],
    3,
  );
});

test("the three evidence classes and the three date kinds never rely on color alone", () => {
  for (const [name, style] of [
    ["evidence-exact", "solid"], ["evidence-bounded", "dashed"], ["evidence-observed", "dotted"],
    ["date-confirmed", "solid"], ["date-predicted", "dashed"], ["date-preparation", "dotted"],
  ]) {
    const block = css.match(new RegExp(`@utility ${name} \\{([^}]*)\\}`))?.[1] ?? "";
    assert.match(block, new RegExp(`border-style:\\s*${style};`), `${name} must set border-style ${style}`);
  }
});

test("the bands the landing page changes colour with keep every ink on them legible", () => {
  const bands = ["butter", "butter-deep", "sage", "sage-deep"];
  expectContrast(bands.flatMap((band) => [["ink", band], ["ink-muted", band], ["accent-ink", band]]), 4.5);
  // A note or a link on a band is the warm ink, so it has to hold up there too.
  expectContrast(bands.map((band) => ["warm-ink", band]), 4.5);
  // A section fills with a light band and can hold a bordered control. The deep pair fills a small block behind a
  // number and a word and never holds one, so it is asked for legible ink and nothing else.
  expectContrast([["line-strong", "butter"], ["line-strong", "sage"]], 3);
});

test("the warm accent is legible: its text on its own surface and the page, ink on its fill, and its line on a panel", () => {
  expectContrast([["warm-ink", "warm-soft"], ["warm-ink", "surface"], ["warm-ink", "canvas"]], 4.5);
  expectContrast([["warm-line", "surface"], ["warm-line", "warm-soft"]], 3);
  // The fill carries ink on paper. On a dark page it carries none — it is an underline, a pinging dot, a glow — so
  // what it owes there is 1.4.11: a graphic that holds against the page it is drawn on.
  expectContrast([["ink", "warm"]], 4.5, ["light"]);
  expectContrast([["warm", "canvas"], ["warm", "surface"]], 3, ["dark"]);
});

test("element defaults sit under the utilities, so a button's or a field's own type classes apply", () => {
  const css = readFileSync(new URL("../app/globals.css", import.meta.url), "utf8");
  // Everything outside @layer blocks: an element rule there outranks every utility class.
  let depth = 0;
  let inLayer = false;
  let outside = "";
  for (let index = 0; index < css.length; index += 1) {
    if (!inLayer && css.startsWith("@layer base", index)) { inLayer = true; depth = 0; }
    const char = css[index];
    if (inLayer) {
      if (char === "{") depth += 1;
      if (char === "}") { depth -= 1; if (depth === 0) inLayer = false; }
      continue;
    }
    outside += char;
  }
  assert.match(css, /@layer base \{[\s\S]*button, input, select, textarea \{ font: inherit; \}/);
  assert.doesNotMatch(outside, /^\s*button[^{]*\{[^}]*font:/m, "no button font reset outside the base layer");
  assert.doesNotMatch(outside, /^\s*(?:body|html)\s*\{/m, "no body or html defaults outside the base layer");
  // The one deliberate exception: a phone zooms into a field under 16px.
  assert.match(outside, /@media \(max-width: 639px\) \{\s*input:not\(\[type="checkbox"\]\)[^{]*\{ font-size: 16px; \}/);
});
