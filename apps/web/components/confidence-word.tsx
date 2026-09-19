"use client";

import { Icon } from "@/components/ui/icon";
import { Tooltip } from "@/components/ui/overlay";
import { confidenceExplanation, confidenceTone, confidenceWord } from "@/lib/confidence";
import { cn } from "@/lib/utils";

const DOT = { strong: "bg-confidence-strong", moderate: "bg-confidence-moderate", limited: "bg-confidence-limited" } as const;

/**
 * forecasting.py's confidence score as one word (Low, Medium, High) with a tooltip that says what it means and gives the
 * score itself. The word is a button so the explanation is reachable by keyboard and by tap as well as by pointer; its
 * hit area reaches 44px on a phone without drawing a big pill.
 */
export function ConfidenceWord({ value, align = "center", className }: { value: number; align?: "center" | "start" | "end"; className?: string }) {
  const word = confidenceWord(value);
  return (
    <Tooltip content={confidenceExplanation(value)} align={align}>
      <button
        type="button"
        className={cn(
          "focus-ring relative inline-flex h-8 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-chip border border-line bg-surface px-2.5 text-xs font-semibold text-ink hover:border-line-strong",
          "before:absolute before:-inset-y-1.5 before:inset-x-0 before:content-[''] sm:before:hidden",
          className,
        )}
      >
        <span className={cn("size-2 rounded-full", DOT[confidenceTone(value)])} aria-hidden="true" />
        {word} confidence
        <Icon name="info" size={12} className="text-ink-subtle" />
      </button>
    </Tooltip>
  );
}
