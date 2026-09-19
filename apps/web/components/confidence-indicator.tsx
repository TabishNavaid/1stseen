import { confidenceOutOf, confidencePhrase, confidenceTone } from "@/lib/confidence";
import { cn } from "@/lib/utils";

const RING = { strong: "var(--color-confidence-strong)", moderate: "var(--color-confidence-moderate)", limited: "var(--color-confidence-limited)" };

/** forecasting.py's confidence score, 0 to 100: how much consistent evidence backs the window, never a probability. */
export function ConfidenceIndicator({ value, compact = false }: { value: number; compact?: boolean }) {
  const tone = confidenceTone(value);
  const size = compact ? 42 : 54;

  return (
    <div className="flex items-center gap-2.5" role="img" aria-label={`${confidencePhrase(value)}, ${tone}`} title={confidenceOutOf(value)}>
      <div
        className="relative grid shrink-0 place-items-center rounded-full"
        style={{ width: size, height: size, background: `conic-gradient(${RING[tone]} ${value * 3.6}deg, var(--color-confidence-track) 0deg)` }}
        aria-hidden="true"
      >
        <div className={cn("grid place-items-center rounded-full bg-surface font-semibold tabular", compact ? "h-8 w-8 text-caption" : "h-10 w-10 text-sm")}>
          {Math.round(value)}
        </div>
      </div>
      {!compact && <div aria-hidden="true"><p className="label-caps text-ink-subtle">Confidence</p><p className="mt-0.5 text-xs font-semibold capitalize text-ink-muted">{tone}</p></div>}
    </div>
  );
}
