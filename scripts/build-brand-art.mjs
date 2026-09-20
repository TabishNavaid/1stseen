#!/usr/bin/env node
/**
 * Build the drawn art the product ships, once, into source it can inline.
 *
 * Two kinds come out of here, and neither is ever fetched by a browser:
 *
 *  - The bird, from `design-refs/bird/*.svg`, in the poses the product draws. Those files are the record and are not written to; what is
 *    written is their geometry with the palette's own names in place of the hex values, so a pose can never drift from
 *    the tokens. Their C2PA manifests stay in `design-refs`, which is where the provenance of the drawing belongs; the
 *    copy that goes inside a page carries only the drawing, the way docs/credits.md records for the Open Doodles.
 *  - The hand marks: arrows, a stamp ring, a sticker edge, section dividers. Drawn here with perfect-freehand, the
 *    same outline-of-a-stroke the bird is drawn with, so a mark beside the bird looks like the same hand made it.
 *  - The mark itself: the bird's head, drawn here rather than cropped out of a pose, because a pose has legs, a tail
 *    and a wing that turn to mud at 16 pixels. It goes beside the wordmark, and on the tile a tab and a home screen
 *    show, where the outline is dropped and the paper shape is the whole silhouette.
 *
 * Run it with `npm run build:brand-art` after changing a pose or a mark. Output is committed, icons included.
 */

import { getStroke } from "perfect-freehand";
import sharp from "sharp";
import { optimize } from "svgo";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
// The poses the product actually draws. design-refs/bird holds all six; a pose nobody shows is 10 KB of a page for
// nothing, so it is not written out until something asks for it.
const BIRDS = ["lookout", "happy", "confused", "letter"];

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
    { name: "preset-default", params: { overrides: { removeUnknownsAndDefaults: { keepAriaAttrs: true, keepRoleAttr: true } } } },
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

/**
 * The mark, from `design-refs/icon/`. Two drawings, not one: `icon-C.svg` is the mark itself, and `favicon-C.svg` is
 * the same bird with the line weight a browser tab needs. They arrive finished, so nothing here redraws them. What
 * this does is take the provenance manifest off the copy that ships, shrink the file, and hand the elements to the
 * page as elements rather than as a string of markup.
 *
 * The tile is part of the drawing, so the wordmark no longer supplies one.
 */
const MARK_SOURCES = { mark: "icon-C", small: "favicon-C" };

/** What the clip's id becomes, so a page that draws the mark twice can give each copy an id of its own. */
const ID_SLOT = "__id__";

function markSvg(name) {
  const source = readFileSync(resolve(ROOT, "design-refs/icon", `${name}.svg`), "utf8");
  const drawing = source.replace(/<metadata>[\s\S]*?<\/metadata>/g, "").replace(/\s*xmlns:c2pa="[^"]*"/g, "");
  // Size only: nothing that would move a point or merge two shapes into one.
  return optimize(drawing, {
    multipass: true,
    floatPrecision: 2,
    plugins: [
      {
        name: "preset-default",
        params: {
          overrides: {
            mergePaths: false,
            convertShapeToPath: false,
            convertPathData: { floatPrecision: 2, forceAbsolutePath: false, makeArcs: false },
            cleanupIds: false,
          },
        },
      },
      { name: "removeDimensions" },
    ],
  }).data;
}

const camel = (name) => name.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());

/**
 * The drawing as a tree of elements, so the page can render each one. Every attribute is carried over as it is; the
 * only thing changed is the clip's id, which becomes a slot the component fills.
 */
function markTree(svg) {
  const viewBox = /viewBox="([^"]+)"/.exec(svg)?.[1] ?? "0 0 120 120";
  const body = svg.replace(/^[\s\S]*?<svg[^>]*>/, "").replace(/<\/svg>\s*$/, "");
  const roots = [];
  const stack = [{ children: roots }];
  const token = /<(\/?)([a-zA-Z][\w:-]*)((?:\s+[\w:-]+="[^"]*")*)\s*(\/?)>/g;
  let read = 0;
  for (const match of body.matchAll(token)) {
    const [whole, closing, tag, attributes, selfClosing] = match;
    read += whole.length;
    if (closing) {
      stack.pop();
      continue;
    }
    const attrs = {};
    for (const pair of attributes.matchAll(/([\w:-]+)="([^"]*)"/g)) {
      if (pair[1] === "xmlns") continue;
      const value = pair[2].replace(/url\(#[^)]*\)/, `url(#${ID_SLOT})`);
      attrs[camel(pair[1])] = pair[1] === "id" ? ID_SLOT : value;
    }
    const node = { tag, attrs };
    stack[stack.length - 1].children.push(node);
    if (!selfClosing) {
      node.children = [];
      stack.push(node);
    }
  }
  if (read !== body.length) throw new Error(`mark: read ${read} of ${body.length} characters`);
  if (stack.length !== 1) throw new Error("mark: a tag was left open");
  return { viewBox, nodes: roots };
}

const marks = Object.fromEntries(Object.entries(MARK_SOURCES).map(([key, name]) => [key, markTree(markSvg(name))]));

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

writeFileSync(resolve(ROOT, "apps/web/lib/brand/bird-mark.ts"), `${banner}

/** One element of the drawing, with its attributes as React spells them, and whatever it holds. */
export type MarkNode = { tag: string; attrs: Readonly<Record<string, string>>; children?: readonly MarkNode[] };

/** One drawing: the box it was made in, and the elements it is made of. */
export type MarkArt = { viewBox: string; nodes: readonly MarkNode[] };

/**
 * The mark, from design-refs/icon. \`mark\` is icon-C, which the header, the footer, the home-screen icon and the
 * corner of a link preview draw; \`small\` is favicon-C, the same bird with the heavier line a browser tab needs, and
 * it draws the tab's icon and the 32 pixel copy of it.
 *
 * The drawings are carried over as they are. Nothing here moves a point, merges two shapes or renames a colour: the
 * build takes off the provenance manifest, shrinks the file, and hands over the elements. The tile belongs to the
 * drawing, so the wordmark does not supply one.
 *
 * \`${ID_SLOT}\` is where the clip's id goes. A page that draws the mark at both of its ends needs two of them, so
 * every copy is given an id of its own (components/brand/bird-mark.tsx).
 */
export const BIRD_MARK = ${JSON.stringify(marks, null, 2)} as const satisfies Record<string, MarkArt>;

export type BirdMarkKind = keyof typeof BIRD_MARK;

/** The placeholder a caller replaces with the id it has chosen for its copy. */
export const MARK_ID_SLOT = ${JSON.stringify(ID_SLOT)};

/**
 * What each drawing was when this was written. design-refs is not in the repository, so a checkout without it cannot
 * compare the two; one with it can, and tests/brand-mark.test.mjs does.
 */
export const MARK_SOURCES: Readonly<Record<BirdMarkKind, { file: string; sha256: string }>> = ${JSON.stringify(
  Object.fromEntries(Object.entries(MARK_SOURCES).map(([key, name]) => [key, {
    file: `design-refs/icon/${name}.svg`,
    sha256: createHash("sha256").update(readFileSync(resolve(ROOT, "design-refs/icon", `${name}.svg`))).digest("hex"),
  }])),
  null,
  2,
)};
`);

const markFile = (name) => `${markSvg(name)}\n`;
const markBuffer = (name) => Buffer.from(markSvg(name));

// The tab's icon, scalable, and a 32 pixel copy for the browsers that still want a raster one. Both are the heavier
// drawing, which is what it is for.
writeFileSync(resolve(ROOT, "apps/web/public/favicon.svg"), markFile(MARK_SOURCES.small));
await sharp(markBuffer(MARK_SOURCES.small)).resize(32, 32).png({ compressionLevel: 9 }).toFile(resolve(ROOT, "apps/web/public/icon-32.png"));

/**
 * A home screen rounds the icon itself and fills nothing behind it, so a tile with its own rounded corners would
 * show four dark ones. The drawing is left alone and its own tile colour is put behind it instead, which is the
 * colour those corners would have been.
 */
const TILE = /<rect[^>]*fill="(#[0-9a-f]{3,6})"/i.exec(markSvg(MARK_SOURCES.mark))?.[1];
if (!TILE) throw new Error("mark: no tile colour to fill the home screen's corners with");
await sharp(markBuffer(MARK_SOURCES.mark))
  .resize(180, 180)
  .flatten({ background: TILE })
  .png({ compressionLevel: 9 })
  .toFile(resolve(ROOT, "apps/web/public/apple-touch-icon.png"));

/**
 * The link preview: the landing page as it was on the day it was photographed. Retake it from the live site into
 * scripts/assets/og-source.png at 1200 by 630, which is the size a preview is cropped to, and run this again; the
 * source is never written to, so a later change to this step does not need another photograph.
 *
 * The mark is no longer set into a corner. It was put there when the photograph was of a site whose header carried
 * no mark at all; now the header in the photograph is the mark, drawn larger and in its right place, and a second
 * copy in the corner only covered the card it sat on. Turn CORNER_MARK back on to have both.
 *
 * A screenshot of this page is a few flat colours, a gradient and the page's grain, so a palette of 128 holds it at
 * a mean error of 1.3 of 255 and about a tenth of the bytes. What that costs is a little dither in the warm wash on
 * the right, which at preview size reads as the grain that is already there.
 */
const CORNER_MARK = false;
const OG_MARK = 96;
const preview = sharp(resolve(ROOT, "scripts/assets/og-source.png"));
if (CORNER_MARK) {
  preview.composite([{ input: await sharp(markBuffer(MARK_SOURCES.mark)).resize(OG_MARK, OG_MARK).png().toBuffer(), top: 630 - OG_MARK - 28, left: 1200 - OG_MARK - 28 }]);
}
await preview
  // A photograph has nothing to see through, and an alpha channel it never uses is a tenth of the file.
  .flatten({ background: "#f3f1eb" })
  .removeAlpha()
  .png({ compressionLevel: 9, palette: true, colours: 128, dither: 1 })
  .toFile(resolve(ROOT, "apps/web/public/og-image.png"));

const size = (value) => `${(value / 1024).toFixed(1)} KB`;
for (const [name, art] of Object.entries(birds)) process.stdout.write(`bird ${name.padEnd(9)} ${art.shapes.length} shapes, ${size(JSON.stringify(art.shapes).length)}\n`);
for (const [name, mark] of Object.entries(MARKS)) process.stdout.write(`mark ${name.padEnd(13)} ${size(mark.d.length)}\n`);
for (const [key, name] of Object.entries(MARK_SOURCES)) process.stdout.write(`mark ${key.padEnd(13)} ${name}, ${size(markSvg(name).length)} from ${size(readFileSync(resolve(ROOT, "design-refs/icon", `${name}.svg`), "utf8").length)}\n`);
