/**
 * The design tokens in app/globals.css meet WCAG 2.1 AA.
 *
 * Reads the hex color tokens straight from the stylesheet, so a token changed without checking its contrast
 * fails here. Text needs 4.5:1; UI component boundaries, focus indicators, evidence-class borders, calendar
 * marks, and confidence rings need 3:1 (WCAG 1.4.3 and 1.4.11).
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const css = readFileSync(new URL("../app/globals.css", import.meta.url), "utf8");
const tokens = Object.fromEntries([...css.matchAll(/--color-([a-z-]+):\s*(#[0-9a-f]{6})\s*;/gi)].map((match) => [match[1], match[2].toLowerCase()]));

function luminance(hex) {
  const channels = hex.slice(1).match(/../g).map((part) => Number.parseInt(part, 16) / 255);
  const [r, g, b] = channels.map((value) => (value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(foreground, background) {
  const [lighter, darker] = [luminance(tokens[foreground]), luminance(tokens[background])].sort((a, b) => b - a);
  return (lighter + 0.05) / (darker + 0.05);
}

function expectContrast(pairs, minimum) {
  const failures = pairs
    .map(([foreground, background]) => {
      assert.ok(tokens[foreground], `missing token --color-${foreground}`);
      assert.ok(tokens[background], `missing token --color-${background}`);
      return [foreground, background, contrast(foreground, background)];
    })
    .filter(([, , ratio]) => ratio < minimum)
    .map(([foreground, background, ratio]) => `${foreground} on ${background}: ${ratio.toFixed(2)}:1`);
  assert.deepEqual(failures, [], `below ${minimum}:1`);
}

const SURFACES = ["canvas", "surface", "surface-sunken", "surface-hover", "surface-selected"];
const GROUPS = [
  "success", "warning", "danger", "info",
  "evidence-exact", "evidence-bounded", "evidence-observed", "basis-own", "basis-borrowed",
  "date-confirmed", "date-predicted", "date-preparation",
  "source-official", "source-archive", "source-signal", "source-community",
];

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

test("the warm accent is legible: its text on its own surface and the page, ink on its fill, and its line on a panel", () => {
  expectContrast([["warm-ink", "warm-soft"], ["warm-ink", "surface"], ["warm-ink", "canvas"], ["ink", "warm"]], 4.5);
  expectContrast([["warm-line", "surface"], ["warm-line", "warm-soft"]], 3);
});
