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
| Confidence | `confidence-strong`, `confidence-moderate`, `confidence-limited`, `confidence-track` | The ring around forecasting.py's number |
| Type | `text-micro` (10px), `text-caption` (11px), then Tailwind's `xs` and up; `tracking-label`, `tracking-title` | Dense evidence tables, labels, titles |
| Spacing | `control` (36px), `control-sm` (32px), `touch` (44px), `gutter`, `gutter-wide` | `h-control`, `min-h-touch`, `size-touch`, `p-gutter` |
| Radii | `rounded-control`, `rounded-panel`, `rounded-overlay`, `rounded-chip` | Controls, panels, popovers and dialogs, chips |
| Elevation | `shadow-raised`, `shadow-popover`, `shadow-dialog` | Floating layers only |

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
| `date-preparation` | dotted | A readiness milestone |

Do not merge these into a single "quality" scale or a single confidence color.

### Composite utilities

`panel`, `label-caps`, `control`, `focus-ring`, `link-accent`, `skeleton`, `icon`, `tabular`, and the
semantic utilities above. A composite sets no property a caller would commonly override: `label-caps` sets no color
and `control` no horizontal padding, so `label-caps text-ink-subtle` and `control pl-3 pr-8` never depend on utility
order.

## Icons

Icons render from `apps/web/public/icons.svg` with `<Icon name="calendar-days" />` (`components/ui/icon.tsx`). An
inline lucide-react component put each icon's paths into every render: 43.6 KiB of the dashboard's HTML before the single sprite.
A sprite reference costs about 130 bytes and the sprite (61 icons, 12.8 KB) is fetched once.

To add an icon, add its lucide-react export name to `scripts/build-icon-sprite.mjs`, run the script, and commit the
sprite and `components/ui/icon-names.ts`. `icon-sprite.test.mjs` fails if either is stale, and ESLint forbids importing
`lucide-react` in `app`, `components`, or `lib`. Icons are decorative by default; pass `label` only when the icon alone
carries meaning.

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
| `EmptyState` | `status.tsx` | A heading, a reason, and a next step: a deliberate state, never a blank panel or an error |

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

  A role's "Model details" keeps the exact field names.

### Frames

| Frame | File | Used by |
| --- | --- | --- |
| Workspace sidebar | `forecast-dashboard.tsx` | The dashboard |
| Workspace header | `workspace-header.tsx` | Role pages, calendar, replay, digests: back to Intelligence, the mark, a status badge hidden on a phone, the page's action |
| Focused shell | `focused-shell.tsx` | Single-purpose flows: first run, settings, sign-in, confirmation, password reset |
| Document page | `document-page.tsx` | Pages that are read rather than used: methodology and accuracy, terms, privacy, data sources, contact |
| Site footer | `site-footer.tsx` | Every page, from the root layout: the one product-wide disclosure and the links in `lib/site-links.ts` |

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
- **Role pages:** the section navigation scrolls sideways within itself; the page does not.

### Help

The dashboard's help button opens `ForecastGuide`, a `Dialog` titled "How to read a forecast". It covers:

- the window;
- the confidence score, in `CONFIDENCE_MEANING` (`lib/confidence.ts`);
- the three evidence classes, as their chips;
- what "no forecast yet" means.

## Uncertainty and disclosure

Two different things, kept apart:

- **What is true of every forecast** is said once, in the site footer on every page: opening dates are predictions from
  public posting history, their accuracy is not yet validated, and 1stSeen is not affiliated with or endorsed by any
  company it lists. It links `/methodology`, which carries the detail and the live backtest position. No card, header,
  panel, or empty state repeats it, and `rendered-html.test.mjs` fails if one of the old repetitions returns.
- **Uncertainty that belongs to one forecast** is data and stays on it: the prediction interval, each date's evidence
  class, the recruiting cycles behind it, and the confidence score with what the number means. A bare date without its
  interval would be a false claim, not a cleaner page.

A role the model did not forecast is a plain panel stating why (`lib/forecast-gap.ts`), not a warning. Development
fixtures keep their own label, because that says which data is on screen, not how reliable a forecast is.

### Forecast basis

`ForecastBasisChip` (`components/forecast-basis-chip.tsx`, `lib/forecast-basis.ts`) shows which evidence a forecast's
window mainly rests on: **Own history** (the `history` icon, `basis-own`) or **Borrowed timing** (the `git-merge` icon,
`basis-borrowed`), always with that basis's share of the window's weight. The weights are forecasting.py's, summed in
SQL by `forecast_basis`. It appears on every forecast: the dashboard card and drawer, the role page, the landing forecast,
calendar boundaries (and so the synced Google Calendar event), the first-run proposals, the digest, the agent's forecast,
and a replayed forecast. It is a kind of evidence, like a date's precision, so it is never folded into the confidence
ring or coloured like an evidence class.
