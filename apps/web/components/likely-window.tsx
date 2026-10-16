import { formatDay, formatShortDay } from "@/lib/dates";
import { outlookLabel, outlookNote, windowState, type Outlook } from "@/lib/forecast-window";
import { cn } from "@/lib/utils";

export type { Outlook };

/** "Jun 20 – Sep 10, 2027", or both years when the window crosses one. */
export function windowRange(start: string, end: string): string {
  return start.slice(0, 4) === end.slice(0, 4) ? `${formatShortDay(start)} – ${formatDay(end)}` : `${formatDay(start)} – ${formatDay(end)}`;
}

const SIZES = {
  lg: { label: "text-caption", date: "heading-display text-3xl sm:text-4xl", range: "text-sm" },
  md: { label: "text-micro", date: "heading-display text-xl", range: "text-caption" },
  sm: { label: "text-micro", date: "text-base font-semibold", range: "text-caption" },
} as const;

/**
 * A forecast in plain words: the expected opening, large, with its window small underneath. The date is underlined
 * with a dashed line, the product's mark for a prediction as opposed to a confirmed date. A fixture carries only its
 * window, so it shows the window and nothing it does not have.
 *
 * What the date is called depends on where today falls in the window (lib/forecast-window.ts). A window still ahead
 * is "Likely around"; one that has begun is "Expected around"; and one whose expected date has gone by says so,
 * because a past date under a future-tense label reads as a date still to come.
 */
export function LikelyWindow({
  outlook,
  today,
  window,
  size = "md",
  className,
}: {
  outlook: Outlook | null;
  /** Today as `YYYY-MM-DD`. The state is a comparison against it, so every surface naming a date names the day. */
  today: string;
  window?: string;
  size?: keyof typeof SIZES;
  className?: string;
}) {
  const style = SIZES[size];
  if (!outlook) {
    return window ? (
      <div className={className}>
        <p className={cn("font-semibold text-ink-subtle", style.label)}>Predicted window</p>
        <p className={cn("mt-0.5 tabular text-ink", style.date)}>{window}</p>
      </div>
    ) : null;
  }
  const state = windowState(outlook, today);
  const note = outlookNote(state);
  return (
    <div className={className}>
      <p className={cn("font-semibold text-ink-subtle", style.label)}>{outlookLabel(state)}</p>
      <p className={cn("mt-0.5 tabular text-ink underline decoration-date-predicted-line decoration-dashed decoration-2 underline-offset-[6px]", style.date)}>
        {formatDay(outlook.expected)}
      </p>
      <p className={cn("mt-1.5 tabular text-ink-muted", style.range)}>
        {note ? <><span className="font-semibold text-warm-ink">{note}</span> · window {windowRange(outlook.start, outlook.end)}</> : <>Window {windowRange(outlook.start, outlook.end)}</>}
      </p>
    </div>
  );
}
