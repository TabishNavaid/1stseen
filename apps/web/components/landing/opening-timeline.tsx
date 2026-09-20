import { formatDay, formatShortDay } from "@/lib/dates";
import type { LandingOpening, LandingForecastWindow } from "@/lib/landing-data";

/**
 * The hero's picture of one program's rhythm: a January-to-December axis, one row per year of its openings, every
 * opening a dot on the day it went up, and the predicted window a tinted band across them all. Because a program
 * opens around the same time each year, the dots line up in a column and the band sits under them; that is the whole
 * product in one picture.
 *
 * Drawn in ordinary elements rather than one scaled drawing, so the year labels, the months, and the dots keep the
 * size they are given at every width: an SVG with a view box shrinks its own text on a narrow card, and this chart
 * has to stay readable at 390px. Nothing is drawn that the data does not carry, so a program with no forecast shows
 * its dots and no band, and each dot is a link to the page the opening was seen on.
 *
 * The dots drop in one by one and the band fades in after them; under prefers-reduced-motion everything is simply
 * there (globals.css).
 */

/** A program with one or two years of openings still gets a chart with presence. */
const MIN_ROWS = 3;
const MONTHS = ["J", "F", "M", "A", "M", "J", "J", "A", "S", "O", "N", "D"];

/** Where a date sits on the axis: its day of the year, as a percentage across it. */
function acrossYear(iso: string): number {
  const date = new Date(`${iso}T00:00:00Z`);
  const year = date.getUTCFullYear();
  const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
  return ((date.getTime() - Date.UTC(year, 0, 1)) / 86_400_000 / (leap ? 366 : 365)) * 100;
}

/** The openings of one year, oldest year first, so the rows read downwards in time. */
type YearRow = { year: string; openings: LandingOpening[] };

function byYear(openings: readonly LandingOpening[]): YearRow[] {
  const rows = new Map<string, LandingOpening[]>();
  for (const opening of [...openings].sort((a, b) => a.openedOn.localeCompare(b.openedOn))) {
    const year = opening.openedOn.slice(0, 4);
    rows.set(year, [...(rows.get(year) ?? []), opening]);
  }
  return [...rows].map(([year, ofYear]) => ({ year, openings: ofYear }));
}

function sourceLabel(opening: LandingOpening): string {
  const host = (() => {
    try {
      return new URL(opening.sourceUrl).hostname.replace(/^www\./, "");
    } catch {
      return "the source page";
    }
  })();
  return opening.archive ? `${host} (archive)` : host;
}

/** The window as the stretches of the axis it covers: two when it runs past New Year, one otherwise. */
function bands(forecast: LandingForecastWindow): { left: number; width: number }[] {
  const from = acrossYear(forecast.windowStart);
  const to = acrossYear(forecast.windowEnd);
  if (from <= to) return [{ left: from, width: Math.max(to - from, 1.5) }];
  return [{ left: from, width: 100 - from }, { left: 0, width: Math.max(to, 1.5) }];
}

export function OpeningTimeline({ openings, forecast }: { openings: readonly LandingOpening[]; forecast: LandingForecastWindow | null }) {
  const rows = byYear(openings);
  const blanks = Math.max(MIN_ROWS - rows.length, 0);
  const expected = forecast ? acrossYear(forecast.expectedOpening) : null;
  // The band waits for the dots, so the picture reads as history first and the prediction second.
  const bandDelay = rows.length * 140 + 220;
  const description = [
    rows.length === 1 ? "Openings in one year" : `Openings in ${rows.length} years`,
    openings.map((opening) => formatDay(opening.openedOn)).join(", "),
    forecast
      ? `Predicted window ${formatDay(forecast.windowStart)} to ${formatDay(forecast.windowEnd)}, most likely ${formatDay(forecast.expectedOpening)}`
      : "No predicted window yet",
  ].join(". ");

  return (
    <figure className="m-0">
      <p className="sr-only">{description}</p>

      {/* The window's label sits over the band, and keeps its line's height whether or not there is one. */}
      <div className="relative h-5 pl-9 sm:pl-10" aria-hidden="true">
        {/* A label anchored left of a late window runs off the card, so past halfway it grows leftwards instead. */}
        {forecast && expected !== null && (
          <span
            className="fade-in absolute whitespace-nowrap text-xs font-semibold text-accent-ink"
            style={{
              ...(expected <= 52 ? { left: `${Math.max(expected - 1, 0)}%` } : { right: `${Math.max(99 - expected, 0)}%` }),
              animationDelay: `${bandDelay + 120}ms`,
            }}
          >
            Likely around {formatDay(forecast.expectedOpening)}
          </span>
        )}
      </div>

      <div className="relative">
        {/* The predicted window: one tinted band with its own edges, across every year the chart draws. */}
        {forecast && (
          <div className="pointer-events-none absolute inset-y-0 left-9 right-0 sm:left-10" aria-hidden="true">
            {bands(forecast).map((band, index) => (
              <span
                key={`band-${index}`}
                className="fade-in absolute inset-y-0 rounded-control border border-dashed border-date-predicted-line bg-accent-soft/70"
                style={{ left: `${band.left}%`, width: `${band.width}%`, animationDelay: `${bandDelay}ms` }}
              />
            ))}
            {expected !== null && (
              <span
                className="fade-in absolute inset-y-0 border-l border-accent/70"
                style={{ left: `${expected}%`, animationDelay: `${bandDelay}ms` }}
              />
            )}
          </div>
        )}

        <ol className="relative m-0 list-none p-0">
          {rows.map((row, index) => (
            <li key={row.year} className="flex h-9 items-center">
              <span className="w-9 shrink-0 pr-2 text-right text-xs tabular text-ink-muted sm:w-10">{row.year}</span>
              <span className="relative h-px flex-1 bg-line">
                {row.openings.map((opening, position) => (
                  <a
                    key={opening.id}
                    href={opening.sourceUrl}
                    target="_blank"
                    rel="noreferrer"
                    aria-label={`${formatDay(opening.openedOn)}, on ${sourceLabel(opening)}`}
                    title={`Opened ${formatDay(opening.openedOn)} · ${sourceLabel(opening)}`}
                    className="focus-ring absolute top-1/2 grid size-9 -translate-x-1/2 -translate-y-1/2 place-items-center rounded-full"
                    style={{ left: `${acrossYear(opening.openedOn)}%` }}
                  >
                    <span
                      className="drop-in size-3 rounded-full bg-accent ring-2 ring-surface"
                      style={{ animationDelay: `${(index + position) * 140}ms` }}
                    />
                  </a>
                ))}
              </span>
            </li>
          ))}
          {/* Blank years keep a short history from drawing a chart with nothing in it. */}
          {Array.from({ length: blanks }, (_unused, index) => (
            <li key={`blank-${index}`} className="flex h-9 items-center" aria-hidden="true">
              <span className="w-9 shrink-0 sm:w-10" />
              <span className="h-px flex-1 bg-line" />
            </li>
          ))}
        </ol>
      </div>

      {/* The months, once, along the bottom. */}
      <div className="pl-9 sm:pl-10">
        <span className="block h-px w-full bg-line-strong" />
        <div className="flex" aria-hidden="true">
          {MONTHS.map((month, index) => (
            <span key={`${month}-${index}`} className="flex-1 pt-1 text-center text-xs tabular text-ink-subtle">{month}</span>
          ))}
        </div>
      </div>

      <figcaption className="mt-3 text-caption text-ink-muted">
        {forecast
          ? `Window ${formatShortDay(forecast.windowStart)} – ${formatDay(forecast.windowEnd)}. Each dot links to the page it was seen on.`
          : "Each dot links to the page it was seen on."}
      </figcaption>
    </figure>
  );
}
