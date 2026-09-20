# Design system

A token system, one icon sprite, and the primitives the product layer builds on, applied
to every surface. This page is the contract for both.

## Tokens

All tokens live in `apps/web/app/globals.css` under `@theme`, so Tailwind 4 generates a utility for each
(`--color-ink-subtle` is `text-ink-subtle`, `bg-ink-subtle`, `border-ink-subtle`). A class names what a thing is, not
a hex value. New surfaces use tokens only; an arbitrary `[#hex]` value in new code is a review finding.

| Group | Tokens | Use |
| --- | --- | --- |
| Surfaces | `canvas`, `surface`, `surface-sunken`, `surface-hover`, `surface-selected`, `scrim` | Page, panels, table heads, hover and selected rows, modal backdrop |
| Text | `ink`, `ink-muted`, `ink-subtle`, `ink-inverse` | Primary, secondary, and tertiary text; text on filled accents |
| Lines | `line`, `line-strong` | Decorative dividers; control and component boundaries |
| Interaction | `accent`, `accent-hover`, `accent-ink`, `accent-soft`, `focus` | Primary actions, links, selected backgrounds, focus indicators |
| Navigation | `nav`, `nav-hover`, `nav-active`, `nav-line`, `nav-ink`, `nav-muted`, `nav-subtle`, `nav-accent` | The dark workspace sidebar |
| Status | `success-*`, `warning-*`, `danger-*`, `info-*` (each `-ink`, `-surface`, `-line`) | Notices and states |
| Evidence classes | `evidence-exact-*`, `evidence-bounded-*`, `evidence-observed-*` | Date precision of an opening event |
| Forecast basis | `basis-own-*`, `basis-borrowed-*` | Whether a window rests mainly on the program's own openings or on comparable programs |
| Date kinds | `date-confirmed-*`, `date-predicted-*`, `date-preparation-*` (plus `-mark`) | Calendar entries |
| Sources | `source-official-*`, `source-archive-*`, `source-signal-*`, `source-community-*` | Where evidence came from |
| Confidence | `confidence-strong`, `confidence-moderate`, `confidence-limited`, `confidence-track` | The confidence word's dot, and Replay's ring around forecasting.py's number |
| Type | `text-micro` (10px), `text-caption` (11px), then Tailwind's `xs` and up; `tracking-label`, `tracking-title` | Dense evidence tables, labels, titles |
| Spacing | `control` (36px), `control-sm` (32px), `touch` (44px), `gutter`, `gutter-wide` | `h-control`, `min-h-touch`, `size-touch`, `p-gutter` |
| Warm accent | `warm`, `warm-soft`, `warm-line`, `warm-ink` | Highlights and celebration moments only; never an evidence class or a status. `warm` is a fill that only sits behind `ink` |
| Radii | `rounded-control` (10px), `rounded-panel` (16px), `rounded-card` (20px), `rounded-overlay`, `rounded-chip` | Controls, panels, cards, popovers and dialogs, chips and pill buttons |
| Elevation | `shadow-raised`, `shadow-card`, `shadow-lift`, `shadow-popover`, `shadow-dialog` | Panels, cards, a hovered card, floating layers |
| Display type | `heading-display` | Page and section headings in Fraunces (self-hosted by `next/font`); body text stays Geist |
| Motion | `lift`, `press`, `rise`, `fade-in`, `drop-in`, `drift-track`, `bob-once`, `step-in`, `pop-in`, `confetti-piece` | A hovered card, a pressed button, hero text entering, the hero chart's openings dropping in and its window fading in, the Just opened strip drifting, every hand-drawn character's single bob as it arrives (`--bob` sets how far, 8px by default and 4px on a small one), a first-run step entering, the payoff's burst. Every one stops under `prefers-reduced-motion`, the burst is not drawn at all, and the strip does not move |
| Depth | `glow` with `glow-accent` or `glow-warm`, and the page's grain | A blurred radial wash behind the hero and the closing call to action, mixed from `focus` and `warm` so it is a colour rather than grey haze, and a fixed grain over the page background at 3.5% so large flat areas are not perfectly flat |
| Mascot | `Bird` in `brand/bird.tsx`, sizes `moment` (176 to 208px), `confirm` (96 to 112px), `tucked` (56 to 72px) | One character, six poses, inline (`lib/brand/bird-art.ts`, written by `scripts/build-brand-art.mjs`). It appears only where a person feels something: the hero chart, a save, a page that is not there, an empty watchlist or calendar, the way in and the end of the first run, a digest. Decoration unless given a `label` |
| Hand marks | `HandMark` in `brand/hand-mark.tsx` | Arrows, the stamp ring and tick, a sticker's torn edge, a section rule. Drawn at build time with perfect-freehand and written out as geometry; `fill-current`, so a caller sets one text colour. Always decoration |
| Handwriting | the `hand` utility, Caveat | A note on the chart, a sticker, a stamp, a step number. Never a heading, never body text, and never the only place a fact appears |
| Bands | `bg-butter`, `bg-butter-deep`, `bg-sage`, `bg-sage-deep` | The colour a landing section changes to. Every ink on them is checked at 4.5:1 in `design-tokens.test.mjs`; the light pair also holds a bordered control at 3:1 |
| Company mark | `CompanyMark` in `brand/company-mark.tsx` | The company's own favicon, self-hosted (`scripts/fetch-company-logos.mjs`), or its initials. Decoration: the name is written beside it |
| Characters | `Doodle` in `doodle.tsx`, sizes `hero` (240 to 320px), `empty` (160 to 200px), `small` (96 to 120px) | Open Doodles recoloured to the palette (`docs/credits.md`), one per moment and never two on one screenful: the landing page's "How it works" and closing call to action, each first-run step and its payoff, every empty state, each confirmation, the sign-in form, and the not-found and error pages. Each is `aria-hidden` with an empty alt, because the words beside it carry the meaning; `hideOnPhone` leaves out the ones that would push those words below the fold |

### Contrast

`apps/web/tests/design-tokens.test.mjs` reads the stylesheet and fails if a token pair falls below WCAG 2.1 AA: 4.5:1
for every text token on every surface and on its own semantic surface, 3:1 for control borders, focus, semantic
lines and marks, and confidence rings. Before the token system, the tertiary grey most surfaces used for labels (#748079 and its
neighbours) was 3.8 to 4.1:1 on the panel surface, and control borders were 1.5:1. `ink-subtle` and `line-strong`
replace them.

### Evidence classes and date kinds are semantic

They are never decoration, and color is never their only signal. The utilities set a border style
as well as colors, and the product always pairs them with a label:

| Utility | Border | Meaning |
| --- | --- | --- |
| `evidence-exact` | solid | The source supplied the publication date |
| `evidence-bounded` | dashed | A complete earlier capture proved absence and a later one presence |
| `evidence-observed` | dotted | Visible by that date; it may have opened earlier |
| `date-confirmed` | solid | A source-supplied opening |
| `date-predicted` | dashed | A statistical interval boundary, never a confirmed date |
| `date-preparation` | dotted | A prep step |

Do not merge these into a single "quality" scale or a single confidence color.

### Composite utilities

Element defaults (box sizing, the body's colours and font, `font: inherit` on buttons and fields) are in `@layer base`,
under every utility, so a button's or a field's own text size and weight classes apply. Outside a layer they outranked
the utilities, and every button drew at 16px regular. Below `sm` a field is 16px whatever its class says, because a
phone zooms into a field with smaller text; that one rule sits outside a layer on purpose.

`panel`, `label-caps`, `control`, `focus-ring`, `link-accent`, `skeleton`, `icon`, `tabular`, and the
semantic utilities above. A composite sets no property a caller would commonly override: `label-caps` sets no color
and `control` no horizontal padding, so `label-caps text-ink-subtle` and `control pl-3 pr-8` never depend on utility
order.

## Icons

Icons render from `apps/web/public/icons.svg` with `<Icon name="calendar-days" />` (`components/ui/icon.tsx`). An
inline lucide-react component put each icon's paths into every render: 43.6 KiB of the dashboard's HTML before the single sprite.
A sprite reference costs about 130 bytes and the sprite (81 icons, 18.6 KB) is fetched once.

To add an icon, add its lucide-react export name to `scripts/build-icon-sprite.mjs`, run the script, and commit the
sprite and `components/ui/icon-names.ts`. `icon-sprite.test.mjs` fails if either is stale, and ESLint forbids importing
`lucide-react` in `app`, `components`, or `lib`. Icons are decorative by default; pass `label` only when the icon alone
carries meaning.

The landing page's steps and the first run's choice cards use the same sprite at a larger size; there is no second
sprite. Illustrations are a handful of self-hosted Open Doodles SVGs in `apps/web/public/illustrations`, recoloured to
the palette; `docs/credits.md` records their source and license, and `illustrations.test.mjs` checks both.

## Primitives

All are in `apps/web/components/ui`. Each handles its own keyboard and screen-reader behavior, so a surface never has to
re-solve it. `/design-system` renders every one of them for verification; it exists only under the fixture gate
(`FIRSTSEEN_DEMO_MODE=true` and no database) and is a 404 everywhere else.

| Primitive | File | Keyboard and screen reader |
| --- | --- | --- |
| `Field` | `field.tsx` | Real `<label for>`; description and error tied with `aria-describedby`; error sets `aria-invalid` |
| `Input`, `Select` | `input.tsx` | Native elements on the `control` token; submit with a GET form |
| `Combobox` | `combobox.tsx` | ARIA 1.2 combobox with listbox: typing filters, arrows move and stop at the ends, Enter chooses, Escape closes then clears, focus stays in the input via `aria-activedescendant`, a polite live region counts matches, `name` submits the value |
| `Checkbox`, `RadioGroup` | `choice.tsx` | Native inputs; radios in a fieldset with a legend; 44px rows with the label in the hit area |
| `Chip` | `status.tsx` | Remove control named "Remove <label>", as a button (`onRemove`) or a link (`removeHref`, for URL-state filters) |
| `Popover` | `overlay.tsx` | `aria-expanded` and `aria-controls`; focus moves in on open; Escape closes and returns focus; outside press and focus leaving close it |
| `Dialog` | `overlay.tsx` | Native `<dialog>` with `showModal()`: top layer, inert background, Escape and backdrop close, focus returns to the opener; labelled by title, described by description |
| `Tooltip` | `overlay.tsx` | `role="tooltip"` tied with `aria-describedby`; shows on hover and focus, hoverable, Escape dismisses (WCAG 1.4.13); description only |
| `Tabs` | `tabs.tsx` | Roving tabindex, arrows wrap, Home and End, automatic activation; panels labelled by their tabs and focusable |
| `DateRangeField` | `tabs.tsx` | Two native date inputs in a fieldset; each end bounds the other; a problem is text, tied to both inputs and announced politely |
| `Skeleton`, `LoadingRegion` | `status.tsx` | Shapes hidden from assistive technology; the region is one `role="status"` with a label; motion stops under reduced motion |
| `EmptyState` | `status.tsx` | A heading, a reason, and a next step: a deliberate state, never a blank panel or an error. One mark above the words, either a `doodle` or an `icon`, never both |

The pure logic behind them (option filtering, arrow-key movement, date-range validation) is in `apps/web/lib/ui` and is
unit-tested in `ui-primitives.test.mjs`, which also checks the rendered wiring of every primitive on `/design-system`.

## Applied to every surface

Every product surface now uses tokens only: no `[#hex]` class or inline hex color remains outside `/design-system`.

### Confidence and model fields

- **Confidence is a score, never a percentage.** Write it with `lib/confidence.ts`:
  - `formatConfidence` gives "48";
  - `confidenceOutOf` gives "48 / 100" for a cell;
  - `confidencePhrase` gives "confidence score 48 of 100" for prose, email, calendar events, and screen readers.

  forecasting.py's number scores how much consistent evidence backs a window; a percent sign reads as the chance the
  window is right. `presentation.test.mjs` and the role page render test fail on a percentage.
- **Model fields read as plain words** through `lib/presentation.ts`:
  - `factorLabel` and `factorTone`, whose tone follows the formula: signals against and signal conflict lower the
    score, so a conflict of 0.00 is not a warning;
  - `locationLabel` ("Location not stated");
  - `contributionLabel` ("An opening of this program").

  A role's "Model details" names each field in words too. No user page shows an identifier, a hash, a timing, a tool
  name, or a field name: `tests/support/page-language.mjs` scans the rendered text, in `rendered-html.test.mjs` for the
  development pages and in `integration/page-language.test.mjs` for real ones.

### Frames

| Frame | File | Used by |
| --- | --- | --- |
| Site header | `site-header.tsx`, `site-header-bar.tsx` | Every app page and the landing page: the mark, the navigation from `lib/site-nav.ts`, the page's action, the account. A guest sees Explore, Just opened, and Ask, with Sign in and Get started; a signed-in user also sees Watchlist and Calendar. Replay and digests are not in the navigation |
| Landing page | `landing/landing-page.tsx` | `/` for a first-time visitor: the site header, a hero with one followed program's chart, the Just opened strip, how it works, Opening soon, the questions people ask, and one way in |
| Opening chart | `landing/opening-timeline.tsx` | The hero card's picture of one program's rhythm: a January-to-December axis, one row per year of its openings, each opening a 12px dot linking to the page it was seen on, and the predicted window a tinted band with dashed edges. Ordinary elements, not a scaled drawing, so the 12px labels stay 12px at 390px. The featured program is chosen by `lib/landing-data.ts`: of the current forecasts, the most distinct years of openings, then the soonest window |
| First run | `onboarding/onboarding-flow.tsx` | `/welcome`: full screen, progress dots, a sticky action bar, "Skip, just browse" on every step |
| Focused shell | `focused-shell.tsx` | Single-purpose pages: settings, sign-in, confirmation, password reset |
| Document page | `document-page.tsx` | Pages that are read rather than used: methodology and accuracy, terms, privacy, data sources, contact |
| Site footer | `site-footer.tsx` | Every page, from the root layout: the one product-wide disclosure and the links in `lib/site-links.ts` |
| Not found | `missing-page.tsx` | `app/not-found.tsx` ("This page hasn't opened yet.") and a program the product no longer lists ("This program isn't tracked anymore.", with a button to the company's other roles when it has any). Laid out by `illustrated-message.tsx`: one centered column with a large Open Doodles character first (one of three, picked at random for each visit by `lib/not-found-art.ts`) (240px tall on a phone, 360px from `md`), then a headline, one sentence, one button, and one small link, filling the space between header and footer. The character bobs once as the page appears (`bob-once`), and not under reduced motion |
| Something broke | `broken-page.tsx` | `app/error.tsx` and `app/global-error.tsx`, in the same layout with the tripping character: "Well, that tripped us up.", "Try again", and "Go home". It shows no message, digest, or trace |

Every frame starts with a "Skip to content" link to its `main`.

### Off-canvas panels

`useOffCanvas` (`components/ui/off-canvas.ts`) gives a panel that slides over the page at narrow widths the keyboard
behavior of a dialog:

- focus moves to its first control when it opens;
- Tab and Shift+Tab stay inside;
- Escape closes it, and focus returns to the opener.

The mobile navigation (below `lg`), the forecast detail drawer (below `xl`), the calendar event drawer, and the Google
Calendar sync panel use it. When closed, such a panel carries `invisible` below its breakpoint, so it leaves the tab
order and the accessibility tree. Transition `visibility` only while closing: a transition into `visible` starts at
`hidden`, and focus cannot move into it.

### Touch targets

Below 640 px every control meets 44 px from the system, not per surface:

- `control` (inputs and selects) and every `Button` size grow to `touch`;
- navigation links grow below `lg`, where the navigation is a drawer.

Links that are a row's only action carry `min-h-touch`. Links inside running text are exempt, as WCAG 2.5.8 exempts
them.

### Mobile treatments

- **Replay:** candidates are stacked rows below `md` and a table from `md` up. The page never scrolls sideways.
- **Calendar:** below `sm`, the month grid shows one marker per entry (its date-kind utility and glyph), and the
  month's entries follow as a day-by-day list.
- **Role pages:** one column at every width, in the order a person needs it: the likely date with its window,
  confidence word, and Save; History (when it opened before, with sources); the prep plan; Ask. Everything the model
  used (the window chart, sources and weights, earlier versions, model details, evidence-class counts) is in one
  collapsed "How this forecast was made" (or "Why there is no date yet"). A section with nothing in it is not drawn.

### Reading a forecast

A forecast reads the same everywhere it is shown in brief (a card, the landing page, the first run, an agent answer):

- `LikelyWindow` (`components/likely-window.tsx`): "Likely around", the expected date large, and the window's range
  small underneath. The date is never shown without its range.
- `ConfidenceWord` (`components/confidence-word.tsx`): one word, Low, Medium, or High (`confidenceWord` in
  `lib/confidence.ts`), with a tooltip that gives its meaning and the score out of 100 (`confidenceExplanation`).
- `EvidenceMark` (`components/evidence-mark.tsx`): a date's evidence class as its icon with a tooltip. It appears only
  in a role page's History section. Everywhere else an opening is plain words: "Opened Jul 3", "Opened between Jul 1
  and Jul 9", "Seen open by Jul 3".

The forecast's basis, its factors, and the score itself are one step away: in the card's "Why this date" drawer and in
the role page's "How this forecast was made". `/methodology` explains all of it at length.

## Voice

The product shows the thing rather than promising that the thing is real. That rules out a set of words, and
`tests/support/page-language.mjs` (`voiceLeaksInSource`) fails the build on them, reading the product's own source
strings rather than rendered pages, because a company's job title may legitimately carry any of them:

- reassurance: "real program", "real forecast", "real data", "honest", "evidence-first", "no language model",
  "never fake", "actually";
- marketing: "seamless", "unlock", "supercharge", "empower", "journey", "revolutionary", "game-changing";
- the em dash, which these sentences are short enough not to need.

The methodology and policy pages are exempt: saying that no language model picks a date, and how far the accuracy
position has been validated, is their job. Beyond the list: at most one small caps label per page, headings that say
what the section is ("How it works", "Opening soon", "Just opened"), second person, present tense, and no rhetorical
questions, exclamation marks, or emoji.

## Uncertainty and disclosure

Two different things, kept apart:

- **What is true of every forecast** is said once, in the site footer on every page: opening dates are predictions from
  public posting history, their accuracy is not yet validated, and 1stSeen is not affiliated with or endorsed by any
  company it lists. It links `/methodology`, which carries the detail and the live backtest position. No card, header,
  panel, or empty state repeats it, and `rendered-html.test.mjs` fails if one of the old repetitions returns.
- **Uncertainty that belongs to one forecast** is data and stays with it: the prediction interval is always under the
  date, and the confidence word always beside it, with its meaning one hover or tap away. The evidence class of each
  past date, the recruiting cycles behind the window, and its basis are on the role page and in the card's drawer. A
  bare date without its interval would be a false claim, not a cleaner page.

A role the model did not forecast is a plain panel stating why (`lib/forecast-gap.ts`), not a warning. Development
fixtures keep their own label, because that says which data is on screen, not how reliable a forecast is.

### Forecast basis

`ForecastBasisChip` (`components/forecast-basis-chip.tsx`, `lib/forecast-basis.ts`) shows which evidence a forecast's
window mainly rests on: **Own history** (the `history` icon, `basis-own`) or **Borrowed timing** (the `git-merge` icon,
`basis-borrowed`), always with that basis's share of the window's weight. The weights are forecasting.py's, summed in
SQL by `forecast_basis`. It is one step away from every forecast rather than on its face: in the card's drawer, the role
page's "How this forecast was made", a calendar boundary's drawer, and a replayed forecast. It is a kind of evidence,
like a date's precision, so it is never folded into the confidence word or coloured like an evidence class.
