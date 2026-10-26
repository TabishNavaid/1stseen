import { confidenceExplanation, confidenceTone, confidenceWord } from "@/lib/confidence";
import { cn } from "@/lib/utils";

/** How many of the three segments each band fills. The count is the signal; the colour carries nothing. */
const FILLED = { limited: 1, moderate: 2, strong: 3 } as const;

const SEGMENTS = [0, 1, 2];

/**
 * forecasting.py's confidence score as three segments, one filled for Low, two for Medium, three for High.
 *
 * It replaces the word in a pill on a list row. A pill reading "Low confidence" on every row was the loudest thing in
 * the row and said the same thing about all of them; three segments say the same thing quietly, and the word is kept
 * only where it is worth reading, which is High. The full explanation is still there at every level, as the title a
 * pointer finds and as the text a screen reader reads, and the role page still writes it out in words.
 */
export function ConfidenceMeter({ value, className }: { value: number; className?: string }) {
  const tone = confidenceTone(value);
  const filled = FILLED[tone];
  const word = confidenceWord(value);
  const explanation = confidenceExplanation(value);
  return (
    <span className={cn("inline-flex items-center gap-2", className)} title={explanation}>
      <span className="flex items-center gap-1" aria-hidden="true">
        {SEGMENTS.map((segment) => (
          <span key={segment} className={cn("h-1 w-6 rounded-full", segment < filled ? "bg-ink-muted" : "bg-confidence-track")} />
        ))}
      </span>
      {word === "High" && <span className="text-caption font-semibold text-ink-muted">High confidence</span>}
      <span className="sr-only">{explanation}</span>
    </span>
  );
}
