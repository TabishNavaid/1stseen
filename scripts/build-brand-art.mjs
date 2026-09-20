#!/usr/bin/env node
/**
 * Build the drawn art the product ships, once, into source it can inline.
 *
 * Two kinds come out of here, and neither is ever fetched by a browser:
 *
 *  - The bird, six poses, from `design-refs/bird/*.svg`. Those files are the record and are not written to; what is
 *    written is their geometry with the palette's own names in place of the hex values, so a pose can never drift from
 *    the tokens. Their C2PA manifests stay in `design-refs`, which is where the provenance of the drawing belongs; the
 *    copy that goes inside a page carries only the drawing, the way docs/credits.md records for the Open Doodles.
 *  - The hand marks: arrows, a stamp ring, a sticker edge, section dividers. Drawn here with perfect-freehand, the
 *    same outline-of-a-stroke the bird is drawn with, so a mark beside the bird looks like the same hand made it.
 *
 * Run it with `npm run build:brand-art` after changing a pose or a mark. Output is committed.
 */

import { getStroke } from "perfect-freehand";
import { optimize } from "svgo";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const BIRDS = ["lookout", "happy", "confused", "sleeping", "waving", "letter"];

/** The drawing's own colours, and the token each becomes. The bird keeps its palette; the page keeps one source of it. */
const PALETTE = [
  ["#23332c", "var(--color-drawn-ink)"],
  ["#fffdf8", "var(--color-drawn-paper)"],
  ["#fff", "var(--color-drawn-paper)"],
  ["#e8826a", "var(--color-drawn-beak)"],
  ["#b9d4be", "var(--color-drawn-sage)"],
  // One pose carries a cool mark, the small blue question over the confused bird's head.
  ["#6fb1cf", "var(--color-drawn-cool)"],
];

const svgo = (svg, precision) => optimize(svg, {
  multipass: true,
  floatPrecision: precision,
  plugins: [
    { name: "preset-default", params: { overrides: { removeViewBox: false, removeUnknownsAndDefaults: { keepAriaAttrs: true, keepRoleAttr: true } } } },
    { name: "removeDimensions" },
  ],
}).data;

function birdArt(name) {
  const source = readFileSync(resolve(ROOT, "design-refs/bird", `bird-${name}.svg`), "utf8");
  // The manifest is the file's provenance, not the drawing; design-refs keeps it, the page carries the drawing.
  const drawing = source.replace(/<metadata>[\s\S]*?<\/metadata>/g, "").replace(/\s*xmlns:c2pa="[^"]*"/g, "");
  const optimised = svgo(drawing, 1);
  const viewBox = /viewBox="([^"]+)"/.exec(optimised)?.[1] ?? "0 0 200 200";
  const label = /aria-label="([^"]+)"/.exec(optimised)?.[1] ?? "";
  let body = optimised.replace(/^[\s\S]*?<svg[^>]*>/, "").replace(/<\/svg>\s*$/, "");
  for (const [hex, token] of PALETTE) body = body.replaceAll(hex, token).replaceAll(hex.toUpperCase(), token);
  const unmapped = [...body.matchAll(/#[0-9a-fA-F]{3,8}/g)].map((match) => match[0]);
  if (unmapped.length) throw new Error(`bird-${name}: colours with no token: ${[...new Set(unmapped)].join(", ")}`);

  // Shapes, not markup: the page renders elements it can see, and nothing sets inner HTML from a string.
  const shapes = [];
  for (const match of body.matchAll(/<(path|circle|ellipse)\b([^>]*)\/?>/g)) {
    const [, tag, attributes] = match;
    const attribute = (key) => new RegExp(`${key}="([^"]*)"`).exec(attributes)?.[1];
    const fill = attribute("fill");
    if (!fill) throw new Error(`bird-${name}: a ${tag} with no fill`);
    if (tag === "path") shapes.push({ tag, fill, d: attribute("d") });
    else if (tag === "circle") shapes.push({ tag, fill, cx: Number(attribute("cx")), cy: Number(attribute("cy")), r: Number(attribute("r")) });
    else shapes.push({ tag, fill, cx: Number(attribute("cx")), cy: Number(attribute("cy")), rx: Number(attribute("rx")), ry: Number(attribute("ry")) });
  }
  const drawn = (body.match(/<(path|circle|ellipse)\b/g) ?? []).length;
  if (shapes.length !== drawn) throw new Error(`bird-${name}: read ${shapes.length} of ${drawn} shapes`);
  return { viewBox, label, shapes };
}

/** One freehand stroke, as the filled outline of a pen that thins at both ends. */
function stroke(points, { size = 6, thinning = 0.62, streamline = 0.42, smoothing = 0.55, taperStart = 22, taperEnd = 34 } = {}) {
  const outline = getStroke(points, {
    size,
    thinning,
    streamline,
    smoothing,
    simulatePressure: true,
    start: { taper: taperStart, cap: false },
    end: { taper: taperEnd, cap: false },
  });
  if (outline.length === 0) return "";
  const round = (value) => Math.round(value * 10) / 10;
  const head = `M ${round(outline[0][0])} ${round(outline[0][1])}`;
  const rest = outline.slice(1).map(([x, y]) => `L ${round(x)} ${round(y)}`).join(" ");
  return `${head} ${rest} Z`;
}

/** Points along a quadratic curve, with a little wobble, so no two marks are mechanically identical. */
function curve(from, control, to, steps = 26, wobble = 0) {
  const points = [];
  for (let step = 0; step <= steps; step += 1) {
    const t = step / steps;
    const x = (1 - t) ** 2 * from[0] + 2 * (1 - t) * t * control[0] + t ** 2 * to[0];
    const y = (1 - t) ** 2 * from[1] + 2 * (1 - t) * t * control[1] + t ** 2 * to[1];
    const drift = wobble ? Math.sin(t * 7.3) * wobble : 0;
    points.push([x + drift, y - drift * 0.6]);
  }
  return points;
}

/** An arrow: one curved shaft and two short barbs, each its own stroke, the way a pen would draw it. */
function arrow({ from, control, to, size = 5, barb = 9, spread = 0.5 }) {
  const shaft = curve(from, control, to, 30, 0.35);
  const tip = shaft[shaft.length - 1];
  const before = shaft[shaft.length - 6] ?? shaft[0];
  const angle = Math.atan2(tip[1] - before[1], tip[0] - before[0]);
  const barbAt = (turn) => stroke([tip, [tip[0] - Math.cos(angle + turn) * barb, tip[1] - Math.sin(angle + turn) * barb]], { size: size * 0.8, taperStart: 4, taperEnd: 16 });
  return [stroke(shaft, { size }), barbAt(spread), barbAt(-spread)].filter(Boolean).join(" ");
}

function ring({ cx, cy, rx, ry, size = 4.5, from = -0.2, turns = 1.04 }) {
  const points = [];
  const steps = 74;
  for (let step = 0; step <= steps; step += 1) {
    const angle = from * Math.PI * 2 + (step / steps) * turns * Math.PI * 2;
    const wobble = 1 + Math.sin(angle * 3.1) * 0.02;
    points.push([cx + Math.cos(angle) * rx * wobble, cy + Math.sin(angle) * ry * wobble]);
  }
  return stroke(points, { size, taperStart: 30, taperEnd: 40 });
}

function line(from, to, options) {
  return stroke(curve(from, [(from[0] + to[0]) / 2, (from[1] + to[1]) / 2 - 3], to, 24, 0.3), options);
}

/**
 * Every mark the product draws beside its own words. A mark is a path and the box it lives in; the page picks its
 * colour, because the same arrow is coral on the chart and sage on a divider.
 */
const MARKS = {
  /** The chart's two notes point at what they name: one down onto a dot, one along to the window. */
  arrowToDot: { viewBox: "0 0 60 44", d: arrow({ from: [6, 6], control: [30, 10], to: [48, 34], size: 4.4, barb: 10 }) },
  arrowToWindow: { viewBox: "0 0 72 40", d: arrow({ from: [66, 8], control: [36, 4], to: [8, 28], size: 4.4, barb: 10 }) },
  /** The ring a save is stamped with, and the tick inside it. */
  stampRing: { viewBox: "0 0 96 96", d: ring({ cx: 48, cy: 48, rx: 40, ry: 38, size: 5 }) },
  stampTick: { viewBox: "0 0 96 96", d: [stroke(curve([30, 50], [38, 62], [43, 62], 14), { size: 5.5 }), stroke(curve([43, 62], [54, 46], [68, 34], 18), { size: 5.5 })].join(" ") },
  /** The edge a "new!" sticker is torn along. */
  stickerEdge: { viewBox: "0 0 120 44", d: ring({ cx: 60, cy: 22, rx: 54, ry: 17, size: 3.4, turns: 1.02 }) },
  /** A rule between two sections of the landing page, drawn rather than ruled. */
  divider: { viewBox: "0 0 320 16", d: line([8, 9], [312, 7], { size: 3.6, taperStart: 60, taperEnd: 70 }) },
  /** Two small sparks, for the moment something lands. */
  sparks: {
    viewBox: "0 0 48 48",
    d: [
      line([10, 16], [18, 22], { size: 3, taperStart: 8, taperEnd: 10 }),
      line([38, 12], [31, 19], { size: 3, taperStart: 8, taperEnd: 10 }),
      line([24, 6], [24, 15], { size: 3, taperStart: 8, taperEnd: 10 }),
    ].join(" "),
  },
  /** An underline a hand would put beneath a word it meant. */
  underline: { viewBox: "0 0 140 14", d: line([6, 8], [134, 6], { size: 4, taperStart: 40, taperEnd: 55 }) },
};

const birds = Object.fromEntries(BIRDS.map((name) => [name, birdArt(name)]));
const banner = "// Written by scripts/build-brand-art.mjs. Run `npm run build:brand-art` after changing a pose or a mark.";

writeFileSync(resolve(ROOT, "apps/web/lib/brand/bird-art.ts"), `${banner}

/** One shape of the drawing, with the palette's own name for its fill. */
export type BirdShape =
  | { tag: "path"; fill: string; d: string }
  | { tag: "circle"; fill: string; cx: number; cy: number; r: number }
  | { tag: "ellipse"; fill: string; cx: number; cy: number; rx: number; ry: number };

/** One pose of the bird: the box it is drawn in, what it is doing, and the shapes it is made of. */
export type BirdArt = { viewBox: string; label: string; shapes: readonly BirdShape[] };

export const BIRD_ART = ${JSON.stringify(birds, null, 2)} as const satisfies Record<string, BirdArt>;

export type BirdPose = keyof typeof BIRD_ART;
`);

writeFileSync(resolve(ROOT, "apps/web/lib/brand/hand-art.ts"), `${banner}

/** One mark made by the same pen the bird is drawn with: a filled outline, and the box it was drawn in. */
export type HandMark = { viewBox: string; d: string };

export const HAND_MARKS = ${JSON.stringify(MARKS, null, 2)} as const satisfies Record<string, HandMark>;

export type HandMarkName = keyof typeof HAND_MARKS;
`);

const size = (value) => `${(value / 1024).toFixed(1)} KB`;
for (const [name, art] of Object.entries(birds)) process.stdout.write(`bird ${name.padEnd(9)} ${art.shapes.length} shapes, ${size(JSON.stringify(art.shapes).length)}\n`);
for (const [name, mark] of Object.entries(MARKS)) process.stdout.write(`mark ${name.padEnd(13)} ${size(mark.d.length)}\n`);
