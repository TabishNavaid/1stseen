import { formatDay, formatShortDay } from "@/lib/dates";
import type { LandingOpening, LandingForecastWindow } from "@/lib/landing-data";

/**
 * The hero's picture of one program's rhythm: every past opening as a dot on a January-to-December axis, one row per
 * year, and the predicted window as a band across them. Because a program opens around the same time each year, the
 * dots line up in a column and the band sits under it; that is the whole product in one picture.
 *
 * Drawn from the program's own records: each dot is placed by the day of the year it opened, and each is a link to the
 * page it was seen on. Nothing is drawn that the data does not carry, so a program with no forecast shows its dots and
 * no band. The dots drop in one by one and the band fades in after them; under prefers-reduced-motion everything is
 * simply there (globals.css).
 */

const LEFT = 40;
const RIGHT = 548;
/** Room above the rows for the window's label. */
const TOP = 34;
const ROW = 30;
/** A program with one or two openings still gets a chart with presence. */
const MIN_ROWS = 3;
const MONTHS = ["J", "F", "M", "A", "M", "J", "J", "A", "S", "O", "N", "D"];

/** Where a date sits on the axis: its day of the year, as a fraction of the year. */
function dayOfYear(iso: string): number {
  const date = new Date(`${iso}T00:00:00Z`);
  const start = Date.UTC(date.getUTCFullYear(), 0, 1);
  const leap = (date.getUTCFullYear() % 4 === 0 && date.getUTCFullYear() % 100 !== 0) || date.getUTCFullYear() % 400 === 0;
  return (date.getTime() - start) / 86_400_000 / (leap ? 366 : 365);
}

const x = (iso: string) => LEFT + dayOfYear(iso) * (RIGHT - LEFT);

export function OpeningTimeline({ openings, forecast }: { openings: readonly LandingOpening[]; forecast: LandingForecastWindow | null }) {
  // Oldest first, so the rows read downwards in time and the band lands under the newest.
  const rows = [...openings].sort((a, b) => a.openedOn.localeCompare(b.openedOn));
  const height = TOP + Math.max(rows.length, MIN_ROWS) * ROW + 26;
  const axisY = height - 22;
  // A window that runs past New Year is drawn as two bands, one to the end of the axis and one from its start.
  const band = forecast
    ? (x(forecast.windowStart) <= x(forecast.windowEnd)
        ? [[x(forecast.windowStart), x(forecast.windowEnd)]]
        : [[x(forecast.windowStart), RIGHT], [LEFT, x(forecast.windowEnd)]])
    : [];
  const bandDelay = rows.length * 140 + 220;
  const label = forecast ? `Likely around ${formatDay(forecast.expectedOpening)}` : null;
  const description = [
    rows.length === 1 ? "One past opening" : `${rows.length} past openings`,
    rows.map((row) => formatDay(row.openedOn)).join(", "),
    forecast ? `Predicted window ${formatDay(forecast.windowStart)} to ${formatDay(forecast.windowEnd)}, most likely ${formatDay(forecast.expectedOpening)}` : "No predicted window yet",
  ].join(". ");

  return (
    <figure className="m-0">
      <svg viewBox={`0 0 560 ${height}`} className="w-full" role="group" aria-label={description}>
        <defs>
          <linearGradient id="window-band" x1="0" x2="0" y1="0" y2="1">
            <stop offset="0%" stopColor="var(--color-accent)" stopOpacity="0.28" />
            <stop offset="100%" stopColor="var(--color-warm)" stopOpacity="0.24" />
          </linearGradient>
          <filter id="window-glow" x="-40%" y="-40%" width="180%" height="180%">
            <feGaussianBlur stdDeviation="12" />
          </filter>
        </defs>

        {forecast && band.map(([from, to], index) => (
          <g key={`band-${index}`} className="fade-in" style={{ animationDelay: `${bandDelay}ms` }}>
            {/* A blurred copy under a soft one: the window reads as a glow, not a box. */}
            <rect x={from} y={TOP - 6} width={Math.max(to - from, 4)} height={axisY - TOP + 4} rx="14" fill="url(#window-band)" filter="url(#window-glow)" />
            <rect x={from} y={TOP - 6} width={Math.max(to - from, 4)} height={axisY - TOP + 4} rx="14" fill="url(#window-band)" />
            <line x1={x(forecast.expectedOpening)} x2={x(forecast.expectedOpening)} y1={TOP - 6} y2={axisY} stroke="var(--color-accent)" strokeOpacity="0.55" strokeWidth="1.5" strokeDasharray="3 4" />
          </g>
        ))}

        {/* The year rows: a faint rule, the year, and the opening itself. */}
        {rows.map((row, index) => {
          const y = TOP + index * ROW + 12;
          return (
            <g key={row.id}>
              <line x1={LEFT} x2={RIGHT} y1={y} y2={y} stroke="var(--color-line)" strokeWidth="1" strokeDasharray="2 5" />
              <text x={LEFT - 10} y={y + 4} textAnchor="end" className="fill-ink-subtle text-[11px] tabular">{row.openedOn.slice(0, 4)}</text>
              <a href={row.sourceUrl} target="_blank" rel="noreferrer" aria-label={`${formatDay(row.openedOn)}, on ${sourceLabel(row)}`}>
                <title>{`Opened ${formatDay(row.openedOn)} · ${sourceLabel(row)}`}</title>
                <circle cx={x(row.openedOn)} cy={y} r="11" fill="transparent" />
                <circle
                  cx={x(row.openedOn)}
                  cy={y}
                  r="6.5"
                  className="drop-in fill-accent"
                  style={{ animationDelay: `${index * 140}ms`, transformOrigin: `${x(row.openedOn)}px ${y}px` }}
                />
              </a>
            </g>
          );
        })}

        {forecast && label && (
          <text x={Math.min(Math.max(band[0][0] - 4, LEFT), RIGHT - 168).toFixed(0)} y={TOP - 16} className="fade-in fill-accent-ink text-[12.5px] font-semibold" style={{ animationDelay: `${bandDelay + 120}ms` }}>
            {label}
          </text>
        )}

        {/* The months, once, along the bottom. */}
        <line x1={LEFT} x2={RIGHT} y1={axisY} y2={axisY} stroke="var(--color-line-strong)" strokeWidth="1" />
        {MONTHS.map((month, index) => {
          const at = LEFT + ((index + 0.5) / 12) * (RIGHT - LEFT);
          return (
            <g key={`${month}-${index}`}>
              <line x1={at} x2={at} y1={axisY} y2={axisY + 4} stroke="var(--color-line-strong)" strokeWidth="1" />
              <text x={at} y={axisY + 16} textAnchor="middle" className="fill-ink-subtle text-[10px]">{month}</text>
            </g>
          );
        })}
      </svg>
      <figcaption className="mt-2 text-caption text-ink-muted">
        {forecast
          ? `Window ${formatShortDay(forecast.windowStart)} – ${formatDay(forecast.windowEnd)}. Each dot links to the page it was seen on.`
          : "Each dot links to the page it was seen on."}
      </figcaption>
    </figure>
  );
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
