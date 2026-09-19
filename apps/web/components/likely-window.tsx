import { formatDay, formatShortDay } from "@/lib/dates";
import { cn } from "@/lib/utils";

export type Outlook = { expected: string; start: string; end: string };

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
 * A forecast in plain words: "Likely around" the expected opening, large, with its window small underneath. The date is
 * underlined with a dashed line, the product's mark for a prediction as opposed to a confirmed date. A fixture carries
 * only its window, so it shows the window and nothing it does not have.
 */
export function LikelyWindow({ outlook, window, size = "md", className }: { outlook: Outlook | null; window?: string; size?: keyof typeof SIZES; className?: string }) {
  const style = SIZES[size];
  if (!outlook) {
    return window ? (
      <div className={className}>
        <p className={cn("font-semibold text-ink-subtle", style.label)}>Predicted window</p>
        <p className={cn("mt-0.5 tabular text-ink", style.date)}>{window}</p>
      </div>
    ) : null;
  }
  return (
    <div className={className}>
      <p className={cn("font-semibold text-ink-subtle", style.label)}>Likely around</p>
      <p className={cn("mt-0.5 tabular text-ink underline decoration-date-predicted-line decoration-dashed decoration-2 underline-offset-[6px]", style.date)}>
        {formatDay(outlook.expected)}
      </p>
      <p className={cn("mt-1.5 tabular text-ink-muted", style.range)}>Window {windowRange(outlook.start, outlook.end)}</p>
    </div>
  );
}
