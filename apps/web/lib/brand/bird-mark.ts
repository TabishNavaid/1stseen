// Written by scripts/build-brand-art.mjs. Run `npm run build:brand-art` after changing a pose or a mark.

import type { BirdShape } from "./bird-art.ts";

/** One arrangement of the mark: the box it is drawn in and the shapes it is made of. */
export type BirdMarkArt = { viewBox: string; shapes: readonly BirdShape[] };

/**
 * The bird's head at mark weight, in the two arrangements it is ever drawn in.
 *
 * On paper the ink outline is the drawing. On the accent tile the outline is dropped, because a dark line on a dark
 * ground is nothing: there the paper shape is the whole silhouette, and the crest, the eye and the beak are the only
 * marks on it. The same two arrangements make apps/web/public/favicon.svg and apple-touch-icon.png.
 */
export const BIRD_MARK = {
  paper: {
    "viewBox": "6 2 33 34",
    "shapes": [
      {
        "tag": "ellipse",
        "fill": "var(--color-drawn-paper)",
        "cx": 19.3,
        "cy": 23.2,
        "rx": 13.4,
        "ry": 12.3
      },
      {
        "tag": "path",
        "fill": "var(--color-drawn-ink)",
        "d": "M 29.2 31.7 L 27.5 33.3 L 24.9 34.8 L 22.6 35.7 L 20.1 36.1 L 17.6 36.3 L 15.1 36 L 12.6 35.4 L 10.2 34.2 L 8.1 32.7 L 6.4 30.6 L 5.1 28.3 L 4.5 25.8 L 4.3 23.3 L 4.7 20.8 L 5.4 18.5 L 6.5 16.3 L 8 14.2 L 9.8 12.4 L 12 10.9 L 14.4 9.8 L 17.1 9.1 L 19.9 9.1 L 22.6 9.5 L 25.1 10.4 L 27.4 11.7 L 29.4 13.3 L 31.1 15.1 L 32.4 17.2 L 33.4 19.4 L 34 21.8 L 34 24.3 L 33.4 26.8 L 32.3 29 L 30.7 30.9 L 28.8 32.4 L 25.5 33.9 L 25.5 33.9 L 25.5 33.8 L 28.2 31.8 L 29.7 30.1 L 30.8 28.3 L 31.4 26.3 L 31.6 24.3 L 31.4 22.4 L 30.8 20.5 L 29.9 18.8 L 28.7 17.1 L 27.3 15.7 L 25.7 14.5 L 23.9 13.5 L 21.9 12.8 L 19.8 12.4 L 17.7 12.5 L 15.7 13 L 13.8 13.8 L 12.1 14.9 L 10.7 16.3 L 9.5 17.9 L 8.6 19.6 L 8 21.4 L 7.7 23.3 L 7.8 25.2 L 8.2 27 L 9 28.8 L 10.2 30.3 L 11.7 31.7 L 13.5 32.8 L 15.6 33.6 L 17.7 34.1 L 20 34.3 L 22.2 34.2 L 24.5 33.8 L 27.1 32.7 L 29.2 31.7 Z"
      },
      {
        "tag": "path",
        "fill": "var(--color-drawn-sage)",
        "d": "M 19.6 16.4 Q 18.3 8.9 9.8 6.2 Q 12.1 14.7 19.6 16.4 Z M 20.6 15.6 Q 21.4 8.8 15.4 3.4 Q 15.1 11.5 20.6 15.6 Z M 21.8 16.6 Q 25 11.5 22.6 4.8 Q 19.3 11.1 21.8 16.6 Z"
      },
      {
        "tag": "ellipse",
        "fill": "var(--color-drawn-beak)",
        "cx": 22.6,
        "cy": 27.4,
        "rx": 3,
        "ry": 1.8
      },
      {
        "tag": "circle",
        "fill": "var(--color-drawn-ink)",
        "cx": 23.8,
        "cy": 20.8,
        "r": 2.2
      },
      {
        "tag": "path",
        "fill": "var(--color-drawn-beak)",
        "d": "M 29.8 21 L 37.4 24.6 L 29.6 26.8 Z"
      }
    ]
  },
  tile: {
    "viewBox": "6 2 33 34",
    "shapes": [
      {
        "tag": "ellipse",
        "fill": "var(--color-drawn-paper)",
        "cx": 19.3,
        "cy": 23.2,
        "rx": 13.4,
        "ry": 12.3
      },
      {
        "tag": "path",
        "fill": "var(--color-drawn-sage)",
        "d": "M 19.6 16.4 Q 18.3 8.9 9.8 6.2 Q 12.1 14.7 19.6 16.4 Z M 20.6 15.6 Q 21.4 8.8 15.4 3.4 Q 15.1 11.5 20.6 15.6 Z M 21.8 16.6 Q 25 11.5 22.6 4.8 Q 19.3 11.1 21.8 16.6 Z"
      },
      {
        "tag": "circle",
        "fill": "var(--color-drawn-ink)",
        "cx": 23.8,
        "cy": 20.8,
        "r": 2.2
      },
      {
        "tag": "path",
        "fill": "var(--color-drawn-beak)",
        "d": "M 29.8 21 L 37.4 24.6 L 29.6 26.8 Z"
      }
    ]
  },
} as const satisfies Record<string, BirdMarkArt>;

export type BirdMarkGround = keyof typeof BIRD_MARK;
