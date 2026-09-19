# Credits

Third-party artwork, typefaces, and icons the web app ships, where each came from, and its license. Every file listed
here is served from 1stSeen's own origin; nothing is loaded from a third-party host at run time.

## Illustrations

From **Open Doodles** by Pablo Stanley, <https://www.opendoodles.com/>, released under
[CC0 1.0 Universal](https://creativecommons.org/publicdomain/zero/1.0/) (public domain dedication; no attribution
required, credited here anyway).

| File | Source file | Where it appears |
| --- | --- | --- |
| `apps/web/public/illustrations/sprinting.svg` | `https://opendoodles.s3-us-west-1.amazonaws.com/sprinting.svg` | Landing page hero |
| `apps/web/public/illustrations/jumping.svg` | `https://opendoodles.s3-us-west-1.amazonaws.com/jumping.svg` | First-run payoff (the celebration) |
| `apps/web/public/illustrations/reading-side.svg` | `https://opendoodles.s3-us-west-1.amazonaws.com/reading-side.svg` | Teaching empty states |

Changes from the originals, all mechanical: black recolored to the brand's deep green (`#1b3a31`), the pink recolored
to the warm accent (`#f28b6b`), the view box cropped to the figure, Sketch metadata and ids removed, and path
coordinates rounded to one decimal place.

## Typefaces

Both are downloaded at build time by `next/font/google` and served from this origin (the Content-Security-Policy is
`font-src 'self'`).

| Typeface | Designer | License | Use |
| --- | --- | --- | --- |
| Fraunces | Undercase Type (Phaedra Charles, Flavia Zimbardi) | SIL Open Font License 1.1 | Display headings |
| Geist and Geist Mono | Vercel | SIL Open Font License 1.1 | Body text and code |

## Icons

**Lucide**, <https://lucide.dev/>, ISC License. The icons the product draws are compiled into one sprite,
`apps/web/public/icons.svg`, by `scripts/build-icon-sprite.mjs`.
