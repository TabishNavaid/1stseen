"use client";

import { Icon } from "@/components/ui/icon";
import { Tooltip } from "@/components/ui/overlay";
import { confidenceExplanation, confidenceTone, confidenceWord } from "@/lib/confidence";
import { cn } from "@/lib/utils";

/**
 * A mark only where the evidence is there to mark. Low is the common case on a young corpus, and a red dot on every
 * card read as a warning about the product rather than a statement about one window, so Low is the plain chip and says
 * so in words; the tone is kept for the two bands that earned one.
 */
const DOT = { strong: "bg-confidence-strong", moderate: "bg-confidence-moderate", limited: null } as const;

/**
 * forecasting.py's confidence score as one word (Low, Medium, High) with a tooltip that says what it means and gives the
 * score itself. The word is a button so the explanation is reachable by keyboard and by tap as well as by pointer; its
 * hit area reaches 44px on a phone without drawing a big pill.
 */
export function ConfidenceWord({ value, align = "center", variant = "chip", className }: { value: number; align?: "center" | "start" | "end"; variant?: "chip" | "plain"; className?: string }) {
  const word = confidenceWord(value);
  const dot = DOT[confidenceTone(value)];
  // `plain` is the same word and the same explanation without the chip around it, for a list row where a bordered
  // pill on every line is the chrome the row is trying not to have.
  const plain = variant === "plain";
  return (
    <Tooltip content={confidenceExplanation(value)} align={align}>
      <button
        type="button"
        className={cn(
          "focus-ring relative inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-chip",
          plain
            ? "text-caption font-medium text-ink-muted hover:text-ink"
            : "h-8 border border-line bg-surface px-2.5 text-xs font-semibold text-ink hover:border-line-strong",
          "before:absolute before:-inset-y-1.5 before:inset-x-0 before:content-['']  sm:before:hidden",
          !dot && !plain && "border-line-strong text-ink-muted",
          className,
        )}
      >
        {dot && <span className={cn("size-2 rounded-full", dot)} aria-hidden="true" />}
        {word} confidence
        <Icon name="info" size={12} className="text-ink-subtle" />
      </button>
    </Tooltip>
  );
}
