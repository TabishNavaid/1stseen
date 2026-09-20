# Credits

Third-party artwork, typefaces, and icons the web app ships, where each came from, and its license. Every file listed
here is served from 1stSeen's own origin; nothing is loaded from a third-party host at run time.

## Illustrations

From **Open Doodles** by Pablo Stanley, <https://www.opendoodles.com/>, released under
[CC0 1.0 Universal](https://creativecommons.org/publicdomain/zero/1.0/) (public domain dedication; no attribution
required, credited here anyway).

| File | Source file | Where it appears |
| --- | --- | --- |
| `apps/web/public/illustrations/chilling.svg` | `https://opendoodles.s3-us-west-1.amazonaws.com/chilling.svg` | Just opened, when nothing has opened in the last 45 days |
| `apps/web/public/illustrations/clumsy.svg` | `https://opendoodles.s3-us-west-1.amazonaws.com/clumsy.svg` | The error page |
| `apps/web/public/illustrations/coffee.svg` | `https://opendoodles.s3-us-west-1.amazonaws.com/coffee.svg` | First run, question two (which fields) |
| `apps/web/public/illustrations/dancing.svg` | `https://opendoodles.s3-us-west-1.amazonaws.com/dancing.svg` | First run, the confirmation after a save to the watchlist |
| `apps/web/public/illustrations/float.svg` | `https://opendoodles.s3-us-west-1.amazonaws.com/float.svg` | Password reset, while the link is on its way |
| `apps/web/public/illustrations/groovy.svg` | `https://opendoodles.s3-us-west-1.amazonaws.com/groovy.svg` | A confirmed email address |
| `apps/web/public/illustrations/jumping.svg` | `https://opendoodles.s3-us-west-1.amazonaws.com/jumping.svg` | First-run payoff (the celebration) |
| `apps/web/public/illustrations/laying.svg` | `https://opendoodles.s3-us-west-1.amazonaws.com/laying.svg` | A recruiting calendar with no dates on it yet |
| `apps/web/public/illustrations/meditating.svg` | `https://opendoodles.s3-us-west-1.amazonaws.com/meditating.svg` | First run, question one (what you are looking for) |
| `apps/web/public/illustrations/plant.svg` | `https://opendoodles.s3-us-west-1.amazonaws.com/plant.svg` | A watchlist with nothing on it yet |
| `apps/web/public/illustrations/reading.svg` | `https://opendoodles.s3-us-west-1.amazonaws.com/reading.svg` | Not-found pages (one of three, picked at random for each visit) |
| `apps/web/public/illustrations/reading-side.svg` | `https://opendoodles.s3-us-west-1.amazonaws.com/reading-side.svg` | Explore, when a search or a filter matches none; the first-run payoff with no matches |
| `apps/web/public/illustrations/sitting.svg` | `https://opendoodles.s3-us-west-1.amazonaws.com/sitting.svg` | The sign-in page, beside the form |
| `apps/web/public/illustrations/sitting-reading.svg` | `https://opendoodles.s3-us-west-1.amazonaws.com/sitting-reading.svg` | Landing page, "How it works" |
| `apps/web/public/illustrations/sprinting.svg` | `https://opendoodles.s3-us-west-1.amazonaws.com/sprinting.svg` | Landing page, the closing call to action |
| `apps/web/public/illustrations/strolling.svg` | `https://opendoodles.s3-us-west-1.amazonaws.com/strolling.svg` | First run, question three (companies you watch) |
| `apps/web/public/illustrations/swinging.svg` | `https://opendoodles.s3-us-west-1.amazonaws.com/swinging.svg` | Ask, before the first question |
| `apps/web/public/illustrations/unboxing.svg` | `https://opendoodles.s3-us-west-1.amazonaws.com/unboxing.svg` | Not-found pages (one of three, picked at random for each visit) |
| `apps/web/public/illustrations/zombieing.svg` | `https://opendoodles.s3-us-west-1.amazonaws.com/zombieing.svg` | Not-found pages (one of three, picked at random for each visit) |

Changes from the originals, all mechanical: black recolored to the brand's deep green (`#1b3a31`), the pink recolored
to the warm accent (`#f28b6b`), the view box cropped to the figure's own bounds, Sketch metadata, titles, and ids
removed, path coordinates rounded to whole units, and the result run through svgo. Whole units are under a tenth of a
percent of a view box that is around 900 wide, so nothing moves at the sizes these are drawn. Every file is between 4
and 22 KB; the page that asks for the most characters asks for about 30 KB of them.

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
